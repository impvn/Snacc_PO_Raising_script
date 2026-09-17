/**
 * service-worker.js — extension entry point and message router.
 *
 * Deliberately thin: all interesting logic lives in lib/ and orchestrator.js.
 * Everything the side panel needs arrives as an {action, ...} message and
 * returns {ok, result|error}, so the UI never touches Chrome APIs directly.
 */

import {
  installBridgeListener,
  routeProgress,
  loadSettings,
  saveSettings,
  checkSession,
  startRun,
  getState,
  clearState,
  getLog,
  clearLog,
  getAutomationTab,
  ensureBridge,
  callBridge,
  reconcileInterruptedRun,
  WATCHDOG_ALARM
} from './orchestrator.js';

import { extractSpreadsheetId, listTabs, readTabCsv } from '../lib/sheets.js';
import { parseCsvObjects } from '../lib/csv.js';
import { groupForecast, buildVendorCsv, ledgerKey } from '../lib/po-builder.js';
import { runChecks, resolveVendorTab } from '../lib/validation.js';
import { readLedger, exportLedger, forget, clearLedger } from '../lib/ledger.js';
import { SUPPLYNOTE } from '../lib/defaults.js';

const PLAN_KEY = 'plan.v1';

installBridgeListener(routeProgress);

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      /* Older Chrome builds lack setPanelBehavior; the action still opens it. */
    });
  await reconcileInterruptedRun();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  reconcileInterruptedRun();
});

// Watchdog: the alarm keeps the worker reachable during a long run and lets us
// notice a run that was abandoned mid-flight.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const state = await getState();
  if (!state || state.status !== 'running') {
    await chrome.alarms.clear(WATCHDOG_ALARM);
  }
});

/* ------------------------------------------------------------------ *
 * Fetching sheets with the user's own Google session
 * ------------------------------------------------------------------ */

/**
 * Fetch text from a Google endpoint. Runs in the service worker, which holds
 * host_permissions for docs.google.com, so credentials: 'include' attaches the
 * user's Google cookies and no OAuth client is needed.
 */
async function fetchGoogleText(url) {
  const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Google refused access (HTTP ${res.status}). Sign in to Google in this browser and make sure the spreadsheet is shared with your account.`
      );
    }
    throw new Error(`Google returned HTTP ${res.status}.`);
  }
  return res.text();
}

/**
 * Fallback for the case where third-party cookie blocking stops the worker
 * fetch from carrying the Google session: relay the same request through a tab
 * that is *on* docs.google.com, making it same-origin.
 */
async function fetchGoogleTextViaTab(url) {
  const tab = await chrome.tabs.create({ url: 'https://docs.google.com/spreadsheets/u/0/', active: false });
  try {
    for (let i = 0; i < 40; i++) {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === 'complete') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (target) => {
        try {
          const res = await fetch(target, { credentials: 'include' });
          return { ok: res.ok, status: res.status, text: await res.text() };
        } catch (err) {
          return { ok: false, status: 0, text: String(err && err.message ? err.message : err) };
        }
      },
      args: [url]
    });
    const out = injection?.result;
    if (!out?.ok) {
      throw new Error(
        `Could not read the spreadsheet even from a Google tab (HTTP ${out?.status ?? 'n/a'}): ${out?.text ?? ''}`.slice(0, 400)
      );
    }
    return out.text;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function fetchSheetText(url) {
  try {
    return await fetchGoogleText(url);
  } catch (err) {
    // Retry through a Google-origin tab before giving up.
    if (/sign-in|401|403|Failed to fetch|NetworkError/i.test(String(err.message))) {
      return fetchGoogleTextViaTab(url);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Building the plan
 * ------------------------------------------------------------------ */

async function buildPlan() {
  const settings = await loadSettings();

  if (!settings.forecastUrl) throw new Error('Add the forecast spreadsheet URL in Settings first.');

  const forecastId = extractSpreadsheetId(settings.forecastUrl);
  if (!forecastId) throw new Error('That does not look like a Google Sheets URL. Paste the full link from the address bar.');

  // One spreadsheet or two? Vendors may live in the forecast file itself.
  const vendorUrl = settings.vendorTemplateUrl || settings.forecastUrl;
  const vendorId = extractSpreadsheetId(vendorUrl);
  if (!vendorId) throw new Error('The vendor template spreadsheet URL is not valid.');

  /* --- tabs --- */
  const forecastTabs = await listTabs(forecastId, fetchSheetText);
  const vendorTabsList = vendorId === forecastId ? forecastTabs : await listTabs(vendorId, fetchSheetText);

  const forecastTab = pickTab(forecastTabs, settings.forecastTab, ['po_status', 'transformeddata']);
  const podsTab = pickTab(forecastTabs, settings.podsTab, ['listedpods']);

  if (!forecastTab) {
    throw new Error(
      `Could not find the forecast tab "${settings.forecastTab || ''}". Available tabs: ${forecastTabs.map((t) => t.name).join(', ')}`
    );
  }
  if (!podsTab) {
    throw new Error(
      `Could not find the Listed Pods tab "${settings.podsTab || ''}". Available tabs: ${forecastTabs.map((t) => t.name).join(', ')}`
    );
  }

  /* --- data --- */
  const forecastCsv = await readTabCsv(forecastId, forecastTab, fetchSheetText);
  const podsCsv = await readTabCsv(forecastId, podsTab, fetchSheetText);

  const forecast = parseCsvObjects(forecastCsv);
  const pods = parseCsvObjects(podsCsv);

  // Resolve every vendor referenced by the forecast to its catalogue tab, then
  // download only those. Fetching all 40 tabs when 4 are needed is slow and
  // risks tripping Google's rate limits.
  const groups = groupForecast(forecast.rows);
  const vendorsNeeded = [...new Set([...groups.values()].map((g) => g.vendor))];

  const vendorTabs = new Map();
  const vendorTabErrors = [];
  for (const vendor of vendorsNeeded) {
    const tab = resolveVendorTab(vendor, vendorTabsList);
    if (!tab) {
      vendorTabErrors.push(vendor);
      continue;
    }
    try {
      const csv = await readTabCsv(vendorId, tab, fetchSheetText);
      vendorTabs.set(vendor, parseCsvObjects(csv).rows);
    } catch (err) {
      vendorTabErrors.push(`${vendor} (${err.message})`);
    }
  }

  /* --- checks --- */
  const plan = [...groups.values()];
  const report = await runChecks({
    sheets: {
      forecast: { ok: true, tabs: forecastTabs, error: null },
      vendorTemplate: {
        ok: vendorTabErrors.length === 0,
        tabs: vendorTabsList,
        error: vendorTabErrors.length ? `Missing vendor tabs: ${vendorTabErrors.join(', ')}` : null
      }
    },
    forecastRows: forecast.rows,
    podRows: pods.rows,
    vendorTabs,
    groups: plan,
    settings
  });

  // The ledger key must be on every PO before it reaches the run loop.
  for (const po of report.plan) {
    if (!po.ledgerKey) po.ledgerKey = ledgerKey(po);
  }

  // Persist the CSVs so the run loop does not have to re-read Google, and so
  // the user can download exactly what will be uploaded.
  const serialisable = report.plan.map((po) => ({
    vendor: po.vendor,
    location: po.location,
    slot: po.slot,
    dateRaw: po.dateRaw,
    dateIso: po.dateIso,
    dateUs: po.dateUs,
    filename: po.filename,
    csv: po.csv,
    headers: po.headers,
    lineCount: po.lineCount,
    totalQuantity: po.totalQuantity,
    estimatedValue: po.estimatedValue,
    ledgerKey: po.ledgerKey,
    blocked: po.blocked,
    prior: po.prior,
    errors: po.errors,
    warnings: po.warnings
  }));

  await chrome.storage.session.set({
    [PLAN_KEY]: { ...report, plan: serialisable, tabs: { forecast: forecastTabs, vendor: vendorTabsList } }
  });

  return {
    ...report,
    plan: serialisable,
    tabs: { forecast: forecastTabs, vendor: vendorTabsList },
    resolved: {
      forecastTab: forecastTab.name,
      podsTab: podsTab.name,
      vendorTabNames: [...vendorTabs.keys()]
    },
    vendorTabErrors
  };
}

function pickTab(tabs, configured, heuristics) {
  const wanted = String(configured ?? '').trim();
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_\-.]+/g, '');
  if (wanted) {
    const exact = tabs.find((t) => t.name === wanted);
    if (exact) return exact;
    const loose = tabs.find((t) => norm(t.name) === norm(wanted));
    if (loose) return loose;
    const partial = tabs.find((t) => norm(t.name).includes(norm(wanted)));
    if (partial) return partial;
  }
  for (const h of heuristics) {
    const hit = tabs.find((t) => norm(t.name).startsWith(h));
    if (hit) return hit;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

const actions = {
  async getSettings() {
    return loadSettings();
  },

  async saveSettings({ patch }) {
    return saveSettings(patch ?? {});
  },

  async discoverTabs({ url }) {
    const id = extractSpreadsheetId(url);
    if (!id) throw new Error('That does not look like a Google Sheets URL.');
    const tabs = await listTabs(id, fetchSheetText);
    return { spreadsheetId: id, tabs };
  },

  async buildPlan() {
    return buildPlan();
  },

  async checkSession() {
    return checkSession();
  },

  async startRun({ dryRun = false, onlyKeys = null, force = false } = {}) {
    const stored = await chrome.storage.session.get(PLAN_KEY);
    const cached = stored[PLAN_KEY];
    if (!cached) throw new Error('Build the plan first (Connect → Checks).');

    let plan = cached.plan.filter((po) => !po.blocked);
    if (Array.isArray(onlyKeys) && onlyKeys.length > 0) {
      const wanted = new Set(onlyKeys);
      plan = plan.filter((po) => wanted.has(po.ledgerKey));
    }
    if (plan.length === 0) throw new Error('Nothing to raise: every PO in the plan is blocked by a check.');

    await clearState();
    return startRun(plan, { dryRun, force });
  },

  async stopRun() {
    const state = await getState();
    if (state && state.status === 'running') {
      state.status = 'stopping';
      await chrome.storage.local.set({ 'runState.v1': state });
    }
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return { stopping: true };
  },

  async getState() {
    return getState();
  },

  async clearState() {
    await clearState();
    return { cleared: true };
  },

  async getLog() {
    return getLog();
  },

  async clearLog() {
    await clearLog();
    return { cleared: true };
  },

  async getLedger() {
    return exportLedger();
  },

  async forgetLedgerEntry({ key }) {
    await forget(key);
    return { forgotten: key };
  },

  async clearLedger({ confirmText }) {
    await clearLedger(confirmText);
    return { cleared: true };
  },

  async downloadCsv({ filename, csv }) {
    const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    const id = await chrome.downloads.download({
      filename: `snacc-po/${filename}`,
      url: dataUrl,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    return { downloadId: id };
  },

  async downloadAllCsvs() {
    const stored = await chrome.storage.session.get(PLAN_KEY);
    const cached = stored[PLAN_KEY];
    if (!cached) throw new Error('Build the plan first.');
    const ids = [];
    for (const po of cached.plan) {
      if (po.blocked || !po.csv) continue;
      const id = await chrome.downloads.download({
        filename: `snacc-po/${po.filename}`,
        url: `data:text/csv;charset=utf-8,${encodeURIComponent(po.csv)}`,
        saveAs: false,
        conflictAction: 'uniquify'
      });
      ids.push(id);
    }
    return { count: ids.length };
  },

  async openSupplyNote() {
    const tabId = await getAutomationTab({ url: SUPPLYNOTE.createOrderUrl });
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true });
    return { tabId };
  },

  async inspectPage() {
    const tabId = await getAutomationTab({ url: SUPPLYNOTE.createOrderUrl });
    await ensureBridge(tabId);
    return callBridge(tabId, 'inspect', {}, 25000);
  },

  async debugSnapshot() {
    const tabId = await getAutomationTab({ url: SUPPLYNOTE.createOrderUrl });
    await ensureBridge(tabId);
    return callBridge(tabId, 'debugSnapshot', {}, 20000);
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = message?.action;
  if (!action || typeof actions[action] !== 'function') return false;

  (async () => {
    try {
      const { action: _a, ...args } = message;
      const result = await actions[action](args);
      sendResponse({ ok: true, result });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // keep the channel open for the async reply
});
