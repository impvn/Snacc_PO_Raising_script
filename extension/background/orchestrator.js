/**
 * orchestrator.js — owns the automation tab, the bridge protocol and the run loop.
 *
 * Runs in the MV3 service worker. Three responsibilities:
 *
 *   1. Bridge transport. Correlate request/response between the worker and the
 *      MAIN-world bridge, including streaming per-step progress.
 *   2. Per-PO submission. Navigate, ensure the bridge is injected, run the PO,
 *      then *verify* the outcome before calling it a success.
 *   3. The run loop. Bounded retries with backoff, a duplicate ledger, and
 *      state persisted after every PO so a crashed or evicted worker can
 *      resume instead of restarting — and, critically, never re-submit.
 *
 * The service worker can be terminated at any time, so nothing important lives
 * only in memory here.
 */

import { SUPPLYNOTE, DEFAULT_TIMINGS, DEFAULT_RETRY, withDefaults } from '../lib/defaults.js';
import { recordSuccess, readLedger } from '../lib/ledger.js';
import { ledgerKey } from '../lib/po-builder.js';

const STATE_KEY = 'runState.v1';
const SETTINGS_KEY = 'settings.v1';
const TAB_KEY = 'automationTabId';
const WATCHDOG_ALARM = 'snacc-run-watchdog';

/* ------------------------------------------------------------------ *
 * Event bus -> side panel
 * ------------------------------------------------------------------ */

const listeners = new Set();

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Emit to in-worker listeners and persist a rolling log for the UI. */
export async function emit(type, data = {}) {
  const event = { type, at: Date.now(), ...data };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* a closed side panel must not break the run */
    }
  }
  await appendLog(event);
}

const LOG_KEY = 'runLog.v1';
const LOG_MAX = 600;

async function appendLog(event) {
  try {
    const stored = await chrome.storage.session.get(LOG_KEY);
    const log = stored[LOG_KEY] ?? [];
    log.push(event);
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    await chrome.storage.session.set({ [LOG_KEY]: log });
  } catch {
    /* storage.session can throw during teardown; logging is best-effort */
  }
}

export async function getLog() {
  const stored = await chrome.storage.session.get(LOG_KEY);
  return stored[LOG_KEY] ?? [];
}

export async function clearLog() {
  await chrome.storage.session.remove(LOG_KEY);
}

/* ------------------------------------------------------------------ *
 * Settings & state persistence
 * ------------------------------------------------------------------ */

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return withDefaults(stored[SETTINGS_KEY]);
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

async function loadState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] ?? null;
}

async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

export async function clearState() {
  await chrome.storage.local.remove(STATE_KEY);
}

export async function getState() {
  return loadState();
}

/* ------------------------------------------------------------------ *
 * Bridge transport
 * ------------------------------------------------------------------ */

let seq = 0;
const pending = new Map();

/** Register the relay/bridge message handler. Call once at worker start. */
export function installBridgeListener(onProgressEvent) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.kind !== 'bridge-response') return;
    const payload = message.payload;
    if (!payload) return;

    // Streaming step updates: forward, do not resolve.
    if (payload.partial && payload.progress) {
      onProgressEvent?.(payload.progress, payload.tabId ?? sender?.tab?.id);
      return;
    }
    if (payload.broadcast === 'bridge-ready') return;

    const entry = payload.id !== null && payload.id !== undefined ? pending.get(payload.id) : null;
    if (!entry) return;
    pending.delete(payload.id);
    clearTimeout(entry.timer);
    if (payload.ok) entry.resolve(payload.result);
    else entry.reject(new Error(payload.error || 'Unknown page-side error'));
  });
}

/**
 * Send a command to the bridge in `tabId` and await its result.
 *
 * If the relay is not listening (fresh navigation, page reload, worker
 * restart) we inject both scripts and retry once. Injection is idempotent.
 */
export async function callBridge(tabId, type, args = {}, timeoutMs = 60000, onProgress) {
  const attempt = async () => {
    const id = `c${Date.now()}_${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Page did not respond to "${type}" within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

      chrome.tabs.sendMessage(tabId, { kind: 'bridge-command', id, type, args, tabId }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error(err.message || 'Could not reach the page.'));
        }
        // Response arrives asynchronously via installBridgeListener.
        void response;
      });
    });
  };

  if (onProgress) {
    // Progress for this specific call is routed by the caller's wrapper.
    progressRouter.set(currentCallKey(tabId), onProgress);
  }

  try {
    return await attempt();
  } catch (err) {
    if (/Could not reach|Receiving end does not exist|message port closed/i.test(String(err.message))) {
      await ensureBridge(tabId);
      return attempt();
    }
    throw err;
  } finally {
    progressRouter.delete(currentCallKey(tabId));
  }
}

const currentCallKey = (tabId) => `tab:${tabId}`;
const progressRouter = new Map();

/** Forward streaming progress to whichever call is active for that tab. */
export function routeProgress(progress, tabId) {
  const fn = progressRouter.get(currentCallKey(tabId));
  if (fn) fn(progress);
}

/**
 * Make sure both content scripts exist on the tab.
 * Safe to call repeatedly: the bridge guards against double-installation.
 */
export async function ensureBridge(tabId) {
  for (const file of ['content/relay.js', 'content/bridge.js']) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [file],
        world: file.endsWith('bridge.js') ? 'MAIN' : 'ISOLATED',
        injectImmediately: true
      });
    } catch (err) {
      throw new Error(
        `Could not inject into the SupplyNote tab (${err.message}). ` +
        `Make sure the tab is on https://www.supplynote.in and not a Chrome error page.`
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * Automation tab
 * ------------------------------------------------------------------ */

async function tabExists(tabId) {
  if (tabId === null || tabId === undefined) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab;
  } catch {
    return false;
  }
}

/** Get the dedicated automation tab, creating it if necessary. */
export async function getAutomationTab({ create = true, url = SUPPLYNOTE.createOrderUrl } = {}) {
  const stored = await chrome.storage.local.get(TAB_KEY);
  let tabId = stored[TAB_KEY] ?? null;

  if (await tabExists(tabId)) return tabId;

  // Fall back to any existing SupplyNote tab the user already has open.
  const tabs = await chrome.tabs.query({ url: 'https://www.supplynote.in/*' });
  if (tabs.length > 0) {
    tabId = tabs[0].id;
    await chrome.storage.local.set({ [TAB_KEY]: tabId });
    return tabId;
  }

  if (!create) return null;

  const tab = await chrome.tabs.create({ url, active: true });
  tabId = tab.id;
  await chrome.storage.local.set({ [TAB_KEY]: tabId });
  await waitForTabComplete(tabId);
  return tabId;
}

export function waitForTabComplete(tabId, timeoutMs = DEFAULT_TIMINGS.pageLoadTimeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('SupplyNote took too long to load. Check your connection and try again.'));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    // The page may already be complete before we started listening.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('The SupplyNote tab was closed.'));
    });

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
  // Give the Angular app a beat to bootstrap before we poke at it.
  await sleep(1200);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Session check
 * ------------------------------------------------------------------ */

/**
 * Verify the user is signed in and the order form exposes what we expect.
 * Returns a shape consumable by validation.js.
 */
export async function checkSession() {
  try {
    const tabId = await getAutomationTab({ url: SUPPLYNOTE.createOrderUrl });
    await navigate(tabId, SUPPLYNOTE.createOrderUrl);
    await ensureBridge(tabId);

    const ping = await callBridge(tabId, 'ping', {}, 15000);
    if (ping.signedOut) {
      return { signedOut: true, error: null, angular: ping.angular, fieldCount: 0 };
    }

    const inspection = await callBridge(tabId, 'inspect', {}, 20000);
    return {
      signedOut: false,
      error: null,
      angular: ping.angular,
      angularVersion: ping.angularVersion,
      fieldCount: inspection.fields.length,
      url: ping.url,
      inspection
    };
  } catch (err) {
    return { signedOut: false, error: String(err.message || err) };
  }
}

/* ------------------------------------------------------------------ *
 * Single PO submission
 * ------------------------------------------------------------------ */

/**
 * Submit one PO and *verify* it.
 *
 * Verification is the important change from the original script, whose
 * `submit()` returned True merely because a JS click did not throw. Here a PO
 * is only `success` when SupplyNote confirms it; otherwise it is `unverified`
 * and is deliberately NOT retried automatically, because retrying an
 * unconfirmed submission is exactly how duplicate orders reach vendors.
 */
export async function submitPurchaseOrder(po, { settings, dryRun = false, onProgress } = {}) {
  const timings = { ...DEFAULT_TIMINGS, ...(settings.timings ?? {}) };
  const selectors = settings.selectors;
  const tabId = await getAutomationTab({ url: SUPPLYNOTE.createOrderUrl });

  await navigate(tabId, SUPPLYNOTE.createOrderUrl);
  await ensureBridge(tabId);

  const result = await callBridge(
    tabId,
    'runPo',
    {
      po: {
        vendor: po.vendor,
        location: po.location,
        slot: po.slot,
        dateUs: po.dateUs,
        filename: po.filename,
        csv: po.csv,
        expectedLines: po.lineCount
      },
      selectors,
      timings,
      dateIndex: settings.dateIndex ?? 1,
      skipSubmit: dryRun
    },
    // Generous: a slow upload plus the confirmation wait.
    Math.max(120000, (timings.elementTimeoutMs ?? 20000) * 8),
    onProgress
  );

  if (dryRun) {
    return { status: 'dry-run', uploadedLines: result.uploadedLines, message: 'Form filled and verified; nothing submitted.' };
  }

  // Save & Send usually navigates away, which destroys the bridge. Re-inject
  // on whatever page we landed on and read the confirmation there.
  await sleep(1500);
  await waitForTabComplete(tabId, 20000).catch(() => {});
  await ensureBridge(tabId);

  let confirmation;
  try {
    confirmation = await callBridge(tabId, 'readConfirmation', { cfg: timings }, timings.confirmationTimeoutMs + 8000);
  } catch (err) {
    return {
      status: 'unverified',
      message: `Submitted, but confirmation could not be read (${err.message}). Check SupplyNote before retrying — the PO may already exist.`
    };
  }

  if (confirmation?.ok) {
    return {
      status: 'success',
      poNumber: confirmation.poNumber ?? null,
      message: confirmation.message || 'Confirmed by SupplyNote.'
    };
  }

  return {
    status: 'unverified',
    message:
      'Save & Send was clicked but no confirmation appeared. ' +
      'The PO may or may not have been created — check the Orders list in SupplyNote before retrying.',
    unverified: true
  };
}

/* ------------------------------------------------------------------ *
 * Run loop
 * ------------------------------------------------------------------ */

/**
 * Raise every PO in `plan`.
 *
 * @param {object[]} plan  validated PO objects from validation.js
 * @param {object}   opts  {dryRun, onlyKeys}
 */
export async function startRun(plan, opts = {}) {
  const settings = await loadSettings();
  const ledger = await readLedger();
  const retry = { ...DEFAULT_RETRY, ...(settings.retry ?? {}) };

  // Build the work queue, honouring the duplicate ledger.
  const queue = [];
  const skippedLedger = [];
  for (const po of plan) {
    const key = po.ledgerKey ?? ledgerKey(po);
    if (settings.skipAlreadyRaised && ledger[key] && !opts.force) {
      skippedLedger.push({ key, po, prior: ledger[key] });
      continue;
    }
    queue.push({ key, po, attempts: 0, status: 'queued' });
  }

  if (queue.length === 0) {
    await emit('run:complete', {
      status: 'nothing-to-do',
      message: skippedLedger.length
        ? `All ${skippedLedger.length} PO(s) were already raised from this browser. Nothing to do.`
        : 'No POs in the plan.'
    });
    return { started: false, skippedLedger };
  }

  const state = {
    status: 'running',
    startedAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    total: queue.length,
    skippedAlreadyRaised: skippedLedger.length,
    index: 0,
    results: [],
    queue: queue.map((q) => ({ key: q.key, vendor: q.po.vendor, location: q.po.location, dateIso: q.po.dateIso, slot: q.po.slot, lineCount: q.po.lineCount }))
  };
  await saveState(state);

  // Keep the worker alive and let a dead worker be noticed.
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.4 });

  await emit('run:start', {
    total: queue.length,
    dryRun: !!opts.dryRun,
    skippedAlreadyRaised: skippedLedger.length,
    estimatedValue: queue.reduce((s, q) => s + (q.po.estimatedValue || 0), 0)
  });

  let consecutiveFailures = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    state.index = i;

    // Honour a Stop requested from the UI. We check between POs, never mid-PO,
    // so we can't abandon a form half-submitted.
    const fresh = await loadState();
    if (fresh?.status === 'stopping') {
      state.status = 'stopped';
      state.stoppedAt = new Date().toISOString();
      await saveState(state);
      await chrome.alarms.clear(WATCHDOG_ALARM);
      await emit('run:stopped', {
        index: i,
        total: queue.length,
        message: `Stopped by the user after ${state.results.length} of ${queue.length} PO(s).`
      });
      return { started: true, state, skippedLedger };
    }

    await saveState(state);

    await emit('po:start', {
      index: i,
      total: queue.length,
      vendor: item.po.vendor,
      location: item.po.location,
      slot: item.po.slot,
      dateIso: item.po.dateIso,
      lineCount: item.po.lineCount,
      filename: item.po.filename,
      estimatedValue: item.po.estimatedValue
    });

    let outcome = null;
    let lastError = null;

    for (let attempt = 1; attempt <= Math.max(1, retry.maxAttemptsPerPo); attempt++) {
      try {
        outcome = await submitPurchaseOrder(item.po, {
          settings,
          dryRun: !!opts.dryRun,
          onProgress: (p) => emit('po:step', { index: i, key: item.key, step: p.step, detail: p.detail })
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = String(err.message || err);
        await emit('po:attempt-failed', { index: i, key: item.key, attempt, error: lastError });

        const remaining = retry.maxAttemptsPerPo - attempt;
        if (remaining > 0) {
          const backoff = retry.backoffMs?.[attempt] ?? 5000;
          await emit('po:backoff', { index: i, key: item.key, ms: backoff });
          await sleep(backoff);
        }
      }
    }

    if (outcome?.status === 'success') {
      consecutiveFailures = 0;
      await recordSuccess(item.key, {
        vendor: item.po.vendor,
        location: item.po.location,
        dateIso: item.po.dateIso,
        slot: item.po.slot,
        poNumber: outcome.poNumber,
        filename: item.po.filename,
        lineCount: item.po.lineCount
      });
      state.results.push({ key: item.key, status: 'success', poNumber: outcome.poNumber, message: outcome.message });
      await emit('po:success', { index: i, key: item.key, poNumber: outcome.poNumber, message: outcome.message });
    } else if (outcome?.status === 'dry-run') {
      consecutiveFailures = 0;
      state.results.push({ key: item.key, status: 'dry-run', message: outcome.message, uploadedLines: outcome.uploadedLines });
      await emit('po:dry-run', { index: i, key: item.key, message: outcome.message, uploadedLines: outcome.uploadedLines });
    } else if (outcome?.status === 'unverified') {
      // Do NOT retry. An unconfirmed submit may have succeeded server-side.
      consecutiveFailures += 1;
      state.results.push({ key: item.key, status: 'unverified', message: outcome.message });
      await emit('po:unverified', { index: i, key: item.key, message: outcome.message });
      if (settings.stopOnUnverified) {
        await emit('run:halted', { reason: 'An unverified submission halted the run.', index: i });
        break;
      }
    } else {
      consecutiveFailures += 1;
      state.results.push({ key: item.key, status: 'failed', error: lastError });
      await emit('po:failed', { index: i, key: item.key, error: lastError });
    }

    await saveState(state);

    if (consecutiveFailures >= (retry.maxConsecutiveFailures ?? 3)) {
      await emit('run:halted', {
        reason: `${consecutiveFailures} POs failed in a row. Stopping rather than hammering SupplyNote — this usually means a selector changed or the session expired.`,
        index: i
      });
      break;
    }

    if (i < queue.length - 1) await sleep(settings.timings?.betweenPoMs ?? 1500);
  }

  state.status = 'complete';
  state.finishedAt = new Date().toISOString();
  await saveState(state);
  await chrome.alarms.clear(WATCHDOG_ALARM);

  const tally = state.results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  await emit('run:complete', {
    status: 'complete',
    dryRun: !!opts.dryRun,
    tally,
    skippedAlreadyRaised: skippedLedger.length,
    message: opts.dryRun
      ? `Dry run finished: ${tally['dry-run'] ?? 0} PO(s) filled and verified, nothing submitted.`
      : `${tally.success ?? 0} succeeded, ${tally.unverified ?? 0} unverified, ${tally.failed ?? 0} failed.`
  });

  return { started: true, state, skippedLedger };
}

/**
 * Called on worker startup: if a run was in flight when the worker died, mark
 * it interrupted rather than silently resuming. Auto-resuming a half-finished
 * submission loop is how duplicates happen, so a human decides.
 */
export async function reconcileInterruptedRun() {
  const state = await loadState();
  if (state && state.status === 'running') {
    state.status = 'interrupted';
    state.interruptedAt = new Date().toISOString();
    await saveState(state);
    await emit('run:interrupted', {
      index: state.index,
      total: state.total,
      results: state.results.length,
      message: `A run was interrupted after ${state.results.length} of ${state.total} PO(s). Review the log before restarting — some POs may already have been submitted.`
    });
    return state;
  }
  return null;
}

export { WATCHDOG_ALARM, STATE_KEY };
