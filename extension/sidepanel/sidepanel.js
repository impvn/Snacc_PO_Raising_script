/**
 * sidepanel.js — the UI the team actually touches.
 *
 * Kept deliberately dumb: it renders state it receives and forwards intents to
 * the service worker. It never talks to Google or SupplyNote itself, so closing
 * the panel mid-run does not interrupt anything — the run lives in the worker.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  settings: null,
  plan: null,          // last buildPlan() result
  selection: new Set(), // ledgerKeys the user has ticked (empty = all)
  running: false,
  runState: null,
  log: [],
  pollTimer: null
};

const send = (action, args = {}) =>
  chrome.runtime.sendMessage({ action, ...args }).then((res) => {
    if (!res) throw new Error('The extension did not respond. Reload it and try again.');
    if (!res.ok) throw new Error(res.error);
    return res.result;
  });

/* ------------------------------------------------------------------ *
 * Small UI helpers
 * ------------------------------------------------------------------ */

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${kind ? ` is-${kind}` : ''}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, kind === 'err' ? 7000 : 3800);
}

function busy(button, isBusy, label) {
  if (!button) return;
  if (isBusy) {
    button.dataset.prevText = button.textContent;
    button.classList.add('is-busy');
    button.disabled = true;
  } else {
    button.classList.remove('is-busy');
    button.disabled = false;
    if (label !== undefined) button.textContent = label;
    else if (button.dataset.prevText) button.textContent = button.dataset.prevText;
  }
}

function setStatus(el, text, kind = '') {
  if (!el) return;
  el.textContent = text;
  el.className = `inline-status${kind ? ` is-${kind}` : ''}`;
}

const inr = (n) =>
  `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

const VIEWS = ['connect', 'checks', 'run', 'ledger', 'settings'];
const STEP_OF = { connect: 0, checks: 1, run: 2, ledger: 3, settings: -1 };

function show(view) {
  if (!VIEWS.includes(view)) view = 'connect';
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  $$('.step').forEach((s) => {
    s.classList.toggle('is-active', s.dataset.step === view);
  });
  if (view === 'run') startPolling();
  if (view === 'ledger') renderLedger();
  if (view === 'settings') renderSettings();
}

$$('.step').forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.step)));
$$('[data-goto]').forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.goto)));
$('#btn-settings').addEventListener('click', () => show('settings'));
$('#btn-close-settings').addEventListener('click', () => show(state.plan ? 'checks' : 'connect'));

/* ------------------------------------------------------------------ *
 * Connect
 * ------------------------------------------------------------------ */

async function loadSettingsIntoForm() {
  state.settings = await send('getSettings');
  const s = state.settings;
  $('#forecast-url').value = s.forecastUrl || '';
  $('#vendor-url').value = s.vendorTemplateUrl || '';
  $('#pods-tab').value = s.podsTab || 'Listed Pods';
  $('#filter-vendors').value = (s.filters?.vendors ?? []).join(', ');
  $('#filter-locations').value = (s.filters?.locations ?? []).join(', ');
  $('#filter-slots').value = (s.filters?.slots ?? []).join(', ');
  $('#filter-from').value = s.filters?.dateFrom ?? '';
  $('#filter-to').value = s.filters?.dateTo ?? '';
  updateWhoami();
}

function updateWhoami() {
  const hasUrls = !!$('#forecast-url').value.trim();
  $('#whoami').textContent = hasUrls ? 'Spreadsheet linked — run Connect' : 'Not connected';
}

['#forecast-url', '#vendor-url'].forEach((sel) =>
  $(sel).addEventListener('input', updateWhoami)
);

async function persistFilters() {
  const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const patch = {
    forecastUrl: $('#forecast-url').value.trim(),
    vendorTemplateUrl: $('#vendor-url').value.trim(),
    podsTab: $('#pods-tab').value || 'Listed Pods',
    filters: {
      vendors: list($('#filter-vendors').value),
      locations: list($('#filter-locations').value),
      slots: list($('#filter-slots').value),
      dateFrom: $('#filter-from').value,
      dateTo: $('#filter-to').value
    }
  };
  state.settings = await send('saveSettings', { patch });
  return patch;
}

$('#btn-connect').addEventListener('click', async () => {
  const btn = $('#btn-connect');
  busy(btn, true);
  setStatus($('#connect-status'), 'Reading your spreadsheets…');
  try {
    const patch = await persistFilters();
    if (!patch.forecastUrl) throw new Error('Paste the forecast spreadsheet URL first.');

    const forecast = await send('discoverTabs', { url: patch.forecastUrl });
    const vendorUrl = patch.vendorTemplateUrl || patch.forecastUrl;
    const vendor = await send('discoverTabs', { url: vendorUrl });

    populateTabSelect($('#forecast-tab'), forecast.tabs, state.settings.forecastTab, ['po_status', 'transformeddata']);
    populateTabSelect($('#pods-tab'), forecast.tabs, patch.podsTab, ['listedpods']);

    // Vendor tabs: show which of the discovered tabs look like vendor catalogues.
    const list = $('#vendor-tab-list');
    list.innerHTML = '';
    const vendorNames = new Set(
      vendor.tabs
        .map((t) => t.name)
        .filter((n) => !['listed pods', 'po_status'].includes(n.trim().toLowerCase()))
    );
    for (const name of vendorNames) {
      list.append(el('span', { class: 'chip is-ok', text: name }));
    }
    if (vendorNames.size === 0) {
      list.append(el('span', { class: 'chip is-missing', text: 'No tabs found' }));
    }

    $('#tabs-card').hidden = false;
    await persistSettingsFromTabs();

    setStatus($('#connect-status'), `Connected — ${forecast.tabs.length} + ${vendor.tabs.length} tab(s) visible.`, 'ok');
    $('#btn-to-checks').disabled = false;
    toast('Connected. Now run the checks.', 'ok');
  } catch (err) {
    setStatus($('#connect-status'), err.message, 'err');
    toast(err.message, 'err');
  } finally {
    busy(btn, false);
  }
});

function populateTabSelect(select, tabs, configured, heuristics) {
  select.innerHTML = '';
  const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_\-.]+/g, '');
  let best = null;
  if (configured) {
    best = tabs.find((t) => t.name === configured)
      ?? tabs.find((t) => norm(t.name) === norm(configured))
      ?? tabs.find((t) => norm(t.name).includes(norm(configured)));
  }
  if (!best) {
    for (const h of heuristics) {
      best = tabs.find((t) => norm(t.name).startsWith(h));
      if (best) break;
    }
  }
  for (const t of tabs) {
    select.append(el('option', { value: t.name, text: t.name, selected: best?.name === t.name }));
  }
  if (best) select.value = best.name;
}

async function persistSettingsFromTabs() {
  const patch = {
    forecastTab: $('#forecast-tab').value,
    podsTab: $('#pods-tab').value
  };
  state.settings = await send('saveSettings', { patch });
}

$('#forecast-tab').addEventListener('change', persistSettingsFromTabs);
$('#pods-tab').addEventListener('change', persistSettingsFromTabs);
['#filter-vendors', '#filter-locations', '#filter-slots', '#filter-from', '#filter-to'].forEach((s) =>
  $(s).addEventListener('change', () => persistFilters().catch((e) => toast(e.message, 'err')))
);

/* ---------------- SupplyNote session ---------------- */

$('#btn-open-sn').addEventListener('click', async () => {
  try {
    await send('openSupplyNote');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-check-session').addEventListener('click', async () => {
  const btn = $('#btn-check-session');
  busy(btn, true);
  setStatus($('#session-status'), 'Opening the order form…');
  try {
    const s = await send('checkSession');
    if (s.error) {
      setStatus($('#session-status'), s.error, 'err');
    } else if (s.signedOut) {
      setStatus($('#session-status'), 'You are signed out — sign in to SupplyNote first.', 'err');
    } else {
      setStatus($('#session-status'), `Signed in · ${s.fieldCount} field(s) detected`, 'ok');
    }
  } catch (err) {
    setStatus($('#session-status'), err.message, 'err');
  } finally {
    busy(btn, false);
  }
});

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

$('#btn-to-checks').addEventListener('click', runChecksFlow);
$('#btn-recheck').addEventListener('click', runChecksFlow);

async function runChecksFlow() {
  show('checks');
  $('#checks-empty').classList.add('empty');
  $('#checks-empty').hidden = false;
  $('#checks-content').hidden = true;
  $('#checks-empty').innerHTML = '<p>Reading the sheets and validating every PO…</p>';

  try {
    await persistFilters();
    const report = await send('buildPlan');
    state.plan = report;
    state.selection = new Set(
      report.plan.filter((p) => !p.blocked && !(state.settings.skipAlreadyRaised && p.prior)).map((p) => p.ledgerKey)
    );
    renderChecks(report);
    $('#checks-empty').hidden = true;
    $('#checks-content').hidden = false;
  } catch (err) {
    $('#checks-empty').innerHTML = '';
    $('#checks-empty').append(
      el('p', { class: 'check-detail', text: err.message }),
      el('button', { class: 'btn btn-primary', text: 'Back to Connect', onclick: () => show('connect') })
    );
    toast(err.message, 'err');
  }
}

const CHECK_ICON = { error: '!', warn: '!', info: 'i', ok: '✓' };

function renderChecks(report) {
  const s = report.summary;
  $('#sum-pos').textContent = s.raisablePos;
  $('#sum-lines').textContent = s.totalLines;
  $('#sum-vendors').textContent = s.vendors;
  $('#sum-value').textContent = inr(s.estimatedValue);

  const verdict = $('#verdict');
  verdict.className = 'verdict';
  if (report.blocking > 0) {
    verdict.classList.add('err');
    verdict.textContent = `${report.blocking} blocking problem${report.blocking === 1 ? '' : 's'} to fix before you can start.`;
  } else if (report.warnings > 0) {
    verdict.classList.add('warn');
    verdict.textContent = `Ready, with ${report.warnings} warning${report.warnings === 1 ? '' : 's'} worth a glance.`;
  } else {
    verdict.classList.add('ok');
    verdict.textContent = 'All checks passed.';
  }

  const list = $('#checks-list');
  list.innerHTML = '';
  for (const c of report.checks) {
    if (c.level === 'ok' && report.checks.filter((x) => x.level === 'ok').length > 4) {
      // Keep the list scannable: passing checks are collapsed into one row.
      continue;
    }
    list.append(renderCheck(c));
  }
  const okCount = report.checks.filter((c) => c.level === 'ok').length;
  if (okCount > 0 && list.children.length < report.checks.length) {
    list.append(
      el('li', { class: 'check ok' }, [
        el('span', { class: 'check-mark', text: '✓' }),
        el('div', { class: 'check-body' }, [
          el('div', { class: 'check-title', text: `${okCount} checks passed` })
        ])
      ])
    );
  }

  renderPoList(report.plan);

  const canStart = report.canStart && s.raisablePos > 0;
  $('#btn-start').disabled = !canStart;
  $('#btn-dry-run').disabled = s.raisablePos === 0;
  $('#dry-run-toggle').checked = !!state.settings.dryRunFirstPo;
}

function renderCheck(c) {
  return el('li', { class: `check ${c.level}` }, [
    el('span', { class: 'check-mark', text: CHECK_ICON[c.level] ?? '•' }),
    el('div', { class: 'check-body' }, [
      el('div', { class: 'check-title', text: c.title }),
      c.detail ? el('div', { class: 'check-detail', text: c.detail }) : null,
      el('div', { class: 'check-group', text: c.group })
    ])
  ]);
}

function renderPoList(plan) {
  const wrap = $('#po-list');
  wrap.innerHTML = '';

  if (plan.length === 0) {
    wrap.append(el('p', { class: 'hint', text: 'No purchase orders found after filtering.' }));
    return;
  }

  for (const po of plan) {
    const isDupe = !!po.prior;
    const selectable = !po.blocked && !(state.settings.skipAlreadyRaised && isDupe);

    const tick = el('input', {
      type: 'checkbox',
      class: 'po-tick',
      checked: state.selection.has(po.ledgerKey),
      disabled: !selectable,
      onclick: (e) => {
        e.stopPropagation();
        if (e.target.checked) state.selection.add(po.ledgerKey);
        else state.selection.delete(po.ledgerKey);
        updateStartButton();
      }
    });

    const badges = [];
    if (po.blocked) badges.push(el('span', { class: 'badge error', text: `${po.errors.length} blocking` }));
    if (isDupe) badges.push(el('span', { class: 'badge dupe', text: 'Already raised' }));
    if (!po.blocked && po.warnings.length) badges.push(el('span', { class: 'badge warn', text: `${po.warnings.length} warning${po.warnings.length === 1 ? '' : 's'}` }));
    if (!po.blocked && !isDupe && !po.warnings.length) badges.push(el('span', { class: 'badge ok', text: 'Ready' }));

    const body = el('div', { class: 'po-body' }, [
      el('div', { class: 'badge-row' }, badges),
      el('div', { class: 'po-meta', text: `File: ${po.filename}` }),
      po.errors.length
        ? el('ul', { class: 'issue-list' }, po.errors.map((i) => el('li', { class: 'error', text: i.message })))
        : null,
      po.warnings.length
        ? el('ul', { class: 'issue-list' }, po.warnings.map((i) => el('li', { text: i.message })))
        : null,
      isDupe
        ? el('div', { class: 'po-meta', text: `Previously submitted ${new Date(po.prior.submittedAt).toLocaleString()}${po.prior.poNumber ? ` · PO ${po.prior.poNumber}` : ''}` })
        : null,
      po.csv
        ? el('div', {}, [
            el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
              el('button', {
                class: 'btn btn-sm',
                text: 'Download CSV',
                onclick: async (e) => {
                  e.stopPropagation();
                  try {
                    await send('downloadCsv', { filename: po.filename, csv: po.csv });
                    toast(`Saved ${po.filename}`, 'ok');
                  } catch (err) {
                    toast(err.message, 'err');
                  }
                }
              })
            ]),
            el('pre', { class: 'csv-preview', text: po.csv.split('\n').slice(0, 6).join('\n') + (po.csv.split('\n').length > 6 ? '\n…' : '') })
          ])
        : null
    ]);

    const head = el('div', { class: 'po-head' }, [
      tick,
      el('div', { class: 'po-title' }, [
        el('div', { class: 'po-vendor', text: po.vendor }),
        el('div', { class: 'po-meta', text: `${po.location} · ${po.slot} · ${formatDisplayDate(po.dateIso)}` })
      ]),
      el('div', { class: 'po-right' }, [
        el('div', { class: 'po-lines', text: `${po.lineCount} line${po.lineCount === 1 ? '' : 's'}` }),
        el('div', { class: 'po-value', text: inr(po.estimatedValue) })
      ]),
      el('span', { class: 'po-chevron', text: '▶' })
    ]);

    const row = el('div', {
      class: `po${po.blocked ? ' is-blocked' : ''}${isDupe ? ' is-duplicate' : ''}`,
      onclick: () => row.classList.toggle('is-open')
    }, [head, body]);

    wrap.append(row);
  }
}

function formatDisplayDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

$('#btn-expand-all').addEventListener('click', () => {
  const rows = $$('.po');
  const anyClosed = rows.some((r) => !r.classList.contains('is-open'));
  rows.forEach((r) => r.classList.toggle('is-open', anyClosed));
  $('#btn-expand-all').textContent = anyClosed ? 'Collapse all' : 'Expand all';
});

$('#btn-download-all').addEventListener('click', async () => {
  try {
    const r = await send('downloadAllCsvs');
    toast(`Saved ${r.count} CSV(s) to your Downloads/snacc-po folder.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

function selectedPos() {
  if (!state.plan) return [];
  return state.plan.plan.filter((p) => state.selection.has(p.ledgerKey) && !p.blocked);
}

function updateStartButton() {
  const chosen = selectedPos();
  const btn = $('#btn-start');
  btn.disabled = chosen.length === 0;
  btn.textContent = chosen.length > 0 ? `Start raising ${chosen.length} PO${chosen.length === 1 ? '' : 's'}` : 'Start raising POs';
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

$('#btn-dry-run').addEventListener('click', () => beginRun(true));
$('#btn-start').addEventListener('click', () => beginRun(false));

async function beginRun(dryRun) {
  const chosen = selectedPos();
  if (chosen.length === 0) {
    toast('Nothing selected to raise.', 'err');
    return;
  }

  if (!dryRun) {
    const ok = await confirmSubmission(chosen);
    if (!ok) return;
  }

  show('run');
  resetRunView();
  $('#run-label').textContent = dryRun ? 'Dry run starting…' : 'Starting…';
  $('#btn-stop').hidden = false;

  try {
    await send('startRun', { dryRun, onlyKeys: chosen.map((p) => p.ledgerKey) });
    state.running = true;
    startPolling();
  } catch (err) {
    toast(err.message, 'err');
    $('#run-label').textContent = 'Failed to start';
    $('#btn-stop').hidden = true;
  }
}

function resetRunView() {
  $('#run-idle').hidden = true;
  $('#run-live').hidden = false;
  $('#results').innerHTML = '';
  $('#log').textContent = '';
  $('#progress-bar').style.width = '0%';
  $('#progress-bar').className = 'progress-bar';
  $('#run-count').textContent = '0 / 0';
  $('#current-po').innerHTML = '';
}

$('#btn-stop').addEventListener('click', async () => {
  try {
    await send('stopRun');
    toast('Stopping after the current PO…');
    $('#btn-stop').disabled = true;
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-clear-log').addEventListener('click', async () => {
  await send('clearLog');
  $('#log').textContent = '';
});

function startPolling() {
  stopPolling();
  poll();
  state.pollTimer = setInterval(poll, 900);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function poll() {
  try {
    const [runState, log] = await Promise.all([send('getState'), send('getLog')]);
    state.runState = runState;
    renderRun(runState, log);
    if (runState && ['complete', 'stopped', 'interrupted', 'nothing-to-do'].includes(runState.status)) {
      state.running = false;
      stopPolling();
      $('#btn-stop').hidden = true;
      $('#btn-stop').disabled = false;
    }
  } catch {
    /* the worker may be mid-restart; the next tick will pick it up */
  }
}

function renderRun(runState, log) {
  if (!runState) return;

  const total = runState.total ?? 0;
  const done = runState.results?.length ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  $('#run-count').textContent = `${done} / ${total}`;
  const bar = $('#progress-bar');
  bar.style.width = `${pct}%`;
  bar.className = 'progress-bar';
  if (runState.status === 'complete') bar.classList.add('is-done');
  if (['interrupted', 'stopped'].includes(runState.status)) bar.classList.add('is-halted');

  const labels = {
    running: runState.dryRun ? 'Dry run in progress…' : 'Raising purchase orders…',
    stopping: 'Stopping…',
    stopped: 'Stopped by you',
    complete: runState.dryRun ? 'Dry run finished' : 'Run finished',
    interrupted: 'Run interrupted'
  };
  $('#run-label').textContent = labels[runState.status] ?? runState.status;

  // Results
  const box = $('#results');
  const existing = box.children.length;
  const results = runState.results ?? [];
  if (results.length !== existing) {
    box.innerHTML = '';
    for (const r of results) box.append(renderResult(r, runState.queue));
  }
  if (runState.status === 'complete' && box.children.length === 0) {
    box.append(el('div', { class: 'hint', text: 'Nothing was submitted.' }));
  }

  // Log tail
  const logEl = $('#log');
  const lines = (log ?? [])
    .slice(-140)
    .map((e) => `${new Date(e.at).toLocaleTimeString()}  ${e.type.padEnd(18)} ${summariseEvent(e)}`)
    .join('\n');
  if (logEl.textContent !== lines) {
    logEl.textContent = lines;
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Current PO panel
  const cur = $('#current-po');
  const lastEvent = (log ?? []).slice(-1).find((e) => e.type.startsWith('po:'));
  if (runState.status === 'running' && lastEvent) {
    const q = runState.queue?.[lastEvent.index] ?? {};
    cur.innerHTML = '';
    cur.append(
      el('div', { class: 'cp-title', text: `${q.vendor ?? ''} → ${q.location ?? ''} · ${q.slot ?? ''}` }),
      el('div', { class: 'cp-step' }, [
        el('span', { class: 'cp-dot' }),
        el('span', { text: lastEvent.detail || lastEvent.step || lastEvent.error || '' })
      ])
    );
    cur.hidden = false;
  } else if (runState.status !== 'running') {
    cur.hidden = true;
  }
}

function summariseEvent(e) {
  switch (e.type) {
    case 'po:start': return `${e.vendor} → ${e.location} (${e.lineCount} lines)`;
    case 'po:step': return `${e.step}: ${e.detail ?? ''}`;
    case 'po:success': return `SUCCESS ${e.poNumber ? `PO ${e.poNumber}` : ''}`;
    case 'po:dry-run': return 'DRY RUN ok — nothing submitted';
    case 'po:unverified': return `UNVERIFIED: ${e.message ?? ''}`;
    case 'po:failed': return `FAILED: ${e.error ?? ''}`;
    case 'po:attempt-failed': return `attempt ${e.attempt} failed: ${e.error ?? ''}`;
    case 'po:backoff': return `waiting ${Math.round(e.ms / 1000)}s before retry`;
    case 'run:start': return `run started (${e.total} POs${e.dryRun ? ', dry run' : ''})`;
    case 'run:complete': return e.message ?? 'run complete';
    case 'run:halted': return `HALTED: ${e.reason ?? ''}`;
    case 'run:stopped': return e.message ?? 'stopped';
    case 'run:interrupted': return e.message ?? 'interrupted';
    default: return JSON.stringify(e).slice(0, 110);
  }
}

const RESULT_ICON = { success: '✓', 'dry-run': '◐', unverified: '?', failed: '✕' };

function renderResult(r, queue) {
  const meta = queue?.find((q) => q.key === r.key) ?? {};
  return el('div', { class: `result ${r.status}` }, [
    el('span', { class: 'result-icon', text: RESULT_ICON[r.status] ?? '•' }),
    el('div', { class: 'result-body' }, [
      el('div', {
        class: 'result-title',
        text: `${meta.vendor ?? r.key} → ${meta.location ?? ''} · ${meta.slot ?? ''}${r.poNumber ? ` · PO ${r.poNumber}` : ''}`
      }),
      el('div', { class: 'result-msg', text: r.message || r.error || r.status })
    ])
  ]);
}

/* ---------------- confirmation dialog ---------------- */

function confirmSubmission(chosen) {
  return new Promise((resolve) => {
    const overlay = $('#confirm-overlay');
    const body = $('#confirm-body');
    body.innerHTML = '';

    const lines = chosen.reduce((s, p) => s + (p.lineCount || 0), 0);
    const value = chosen.reduce((s, p) => s + (p.estimatedValue || 0), 0);

    body.append(
      el('p', { class: 'hint', text: 'These purchase orders will be submitted to SupplyNote under your account, and vendors will receive them.' }),
      el('div', { class: 'confirm-stats' }, [
        stat('POs', chosen.length),
        stat('Line items', lines),
        stat('Vendors', new Set(chosen.map((p) => p.vendor)).size),
        stat('Est. value', inr(value))
      ]),
      el('ul', { class: 'confirm-list' }, chosen.slice(0, 40).map((p) =>
        el('li', { text: `${p.vendor} → ${p.location} · ${p.slot} · ${formatDisplayDate(p.dateIso)} · ${p.lineCount} lines` })
      )),
      chosen.length > 40 ? el('p', { class: 'fineprint', text: `…and ${chosen.length - 40} more.` }) : null
    );

    overlay.hidden = false;
    const done = (v) => {
      overlay.hidden = true;
      $('#confirm-ok').removeEventListener('click', okFn);
      $('#confirm-cancel').removeEventListener('click', cancelFn);
      resolve(v);
    };
    const okFn = () => done(true);
    const cancelFn = () => done(false);
    $('#confirm-ok').addEventListener('click', okFn);
    $('#confirm-cancel').addEventListener('click', cancelFn);
  });
}

const stat = (label, value) =>
  el('div', { class: 'stat' }, [el('b', { text: value }), el('span', { text: label })]);

/* ------------------------------------------------------------------ *
 * Ledger
 * ------------------------------------------------------------------ */

async function renderLedger() {
  const wrap = $('#ledger-list');
  wrap.innerHTML = '';
  try {
    const rows = await send('getLedger');
    if (rows.length === 0) {
      wrap.append(el('p', { class: 'hint', text: 'Nothing raised from this browser yet.' }));
      return;
    }
    for (const r of rows) {
      wrap.append(
        el('div', { class: 'ledger-row' }, [
          el('div', { class: 'ledger-main' }, [
            el('div', { class: 'ledger-title', text: `${r.vendor} → ${r.location}` }),
            el('div', {
              class: 'ledger-meta',
              text: `${r.slot} · ${formatDisplayDate(r.date)} · ${r.lineCount} lines · ${new Date(r.submittedAt).toLocaleString()}`
            })
          ]),
          r.poNumber ? el('span', { class: 'po-number', text: r.poNumber }) : null,
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Forget',
            title: 'Allow this PO to be raised again',
            onclick: async () => {
              try {
                await send('forgetLedgerEntry', { key: r.key });
                renderLedger();
              } catch (err) {
                toast(err.message, 'err');
              }
            }
          })
        ])
      );
    }
  } catch (err) {
    wrap.append(el('p', { class: 'check-detail', text: err.message }));
  }
}

$('#btn-clear-ledger').addEventListener('click', async () => {
  const word = prompt('This lets every PO be raised again, including duplicates. Type CLEAR to confirm.');
  if (word !== 'CLEAR') return;
  try {
    await send('clearLedger', { confirmText: word });
    renderLedger();
    toast('Ledger cleared.');
  } catch (err) {
    toast(err.message, 'err');
  }
});

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const SELECTOR_LABELS = {
  vendor: 'Vendor field',
  pod: 'Delivery location field',
  billing: 'Billing address field',
  suggestions: 'Autocomplete suggestion items',
  dateInputs: 'Date picker inputs',
  bulkAddButton: 'Bulk Add button',
  fileInput: 'Hidden CSV file input',
  uploadButton: 'Upload button',
  submitButton: 'Save & Send button',
  confirmation: 'Confirmation / toast container'
};

function renderSettings() {
  const s = state.settings;
  if (!s) return;

  $('#set-dry-first').checked = !!s.dryRunFirstPo;
  $('#set-skip-raised').checked = !!s.skipAlreadyRaised;
  $('#set-stop-unverified').checked = !!s.stopOnUnverified;
  $('#set-max-attempts').value = s.retry?.maxAttemptsPerPo ?? 2;
  $('#set-max-consec').value = s.retry?.maxConsecutiveFailures ?? 3;
  $('#set-date-index').value = s.dateIndex ?? 1;
  $('#set-max-pos').value = s.maxPosPerRun ?? 200;

  const wrap = $('#selector-fields');
  if (wrap.children.length === 0) {
    for (const [key, label] of Object.entries(SELECTOR_LABELS)) {
      const ta = el('textarea', {
        rows: 2,
        id: `sel-${key}`,
        value: (s.selectors?.[key] ?? []).join('\n')
      });
      ta.value = (s.selectors?.[key] ?? []).join('\n');
      wrap.append(el('label', { class: 'field' }, [el('span', { text: `${label}` }), ta]));
    }
  } else {
    for (const key of Object.keys(SELECTOR_LABELS)) {
      const ta = $(`#sel-${key}`);
      if (ta) ta.value = (s.selectors?.[key] ?? []).join('\n');
    }
  }
}

async function persistSettingsForm() {
  const selectors = {};
  for (const key of Object.keys(SELECTOR_LABELS)) {
    const ta = $(`#sel-${key}`);
    if (!ta) continue;
    selectors[key] = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
  }
  const patch = {
    dryRunFirstPo: $('#set-dry-first').checked,
    skipAlreadyRaised: $('#set-skip-raised').checked,
    stopOnUnverified: $('#set-stop-unverified').checked,
    dateIndex: Number($('#set-date-index').value) || 0,
    maxPosPerRun: Number($('#set-max-pos').value) || 200,
    retry: {
      ...(state.settings.retry ?? {}),
      maxAttemptsPerPo: Math.max(1, Number($('#set-max-attempts').value) || 2),
      maxConsecutiveFailures: Math.max(1, Number($('#set-max-consec').value) || 3)
    },
    selectors: { ...(state.settings.selectors ?? {}), ...selectors }
  };
  state.settings = await send('saveSettings', { patch });
  toast('Settings saved.', 'ok');
}

// Delegated, because the selector textareas are created after first render.
document.addEventListener('change', (e) => {
  if (e.target.matches('[id^="set-"], #selector-fields textarea')) {
    persistSettingsForm().catch((err) => toast(err.message, 'err'));
  }
});

$('#btn-reset-selectors').addEventListener('click', async () => {
  if (!confirm('Restore all field selectors to their defaults?')) return;
  try {
    const defaults = await send('getSettings');
    // The worker merges over defaults, so clearing forces them back.
    await send('saveSettings', { patch: { selectors: null } });
    state.settings = await send('getSettings');
    void defaults;
    for (const key of Object.keys(SELECTOR_LABELS)) {
      const ta = $(`#sel-${key}`);
      if (ta) ta.value = (state.settings.selectors?.[key] ?? []).join('\n');
    }
    toast('Selectors restored.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-inspect').addEventListener('click', async () => {
  const btn = $('#btn-inspect');
  busy(btn, true);
  const panel = $('#inspector');
  panel.hidden = false;
  panel.innerHTML = '<p class="hint">Opening SupplyNote and reading the form…</p>';
  try {
    const insp = await send('inspectPage');
    panel.innerHTML = '';
    panel.append(el('h4', { text: `Input fields (${insp.fields.length})` }));
    if (insp.fields.length === 0) {
      panel.append(el('p', { class: 'hint', text: 'No visible inputs found — are you signed out, or on a different page?' }));
    }
    for (const f of insp.fields.slice(0, 25)) {
      const best = f.selectorSuggestions?.[0] ?? '';
      panel.append(
        el('div', { class: 'insp-row' }, [
          el('div', { class: 'insp-desc' }, [
            el('div', { class: 'insp-ph', text: f.placeholder || f.label || f.id || '(no label)' }),
            el('div', { class: 'insp-model', text: f.ngModel || best })
          ]),
          best
            ? el('button', {
                class: 'btn btn-sm insp-copy',
                text: 'Copy',
                onclick: async () => {
                  await navigator.clipboard.writeText(best);
                  toast(`Copied ${best}`, 'ok');
                }
              })
            : null
        ])
      );
    }

    panel.append(el('h4', { text: `Buttons (${insp.buttons.length})`, style: 'margin-top:12px' }));
    for (const b of insp.buttons.slice(0, 20)) {
      panel.append(el('div', { class: 'insp-row' }, [el('div', { class: 'insp-desc' }, [el('div', { class: 'insp-ph', text: b.text })])]));
    }

    panel.append(el('h4', { text: `Date fields (${insp.dateInputs.length})`, style: 'margin-top:12px' }));
    for (const d of insp.dateInputs) {
      panel.append(
        el('div', { class: 'insp-row' }, [
          el('div', { class: 'insp-desc' }, [
            el('div', { class: 'insp-ph', text: `index ${d.index} — "${d.value || '(empty)'}"` }),
            el('div', { class: 'insp-model', text: d.ngModel || d.placeholder || '' })
          ])
        ])
      );
    }
  } catch (err) {
    panel.innerHTML = '';
    panel.append(el('p', { class: 'check-detail', text: err.message }));
  } finally {
    busy(btn, false);
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

(async function init() {
  try {
    await loadSettingsIntoForm();
    renderSettings();

    // A run may have been in flight when the panel was closed.
    const existing = await send('getState');
    if (existing && ['running', 'complete', 'stopped', 'interrupted'].includes(existing.status)) {
      state.runState = existing;
      if (existing.status === 'running') {
        show('run');
        startPolling();
        $('#btn-stop').hidden = false;
        return;
      }
      // Offer the previous results without forcing the view.
      resetRunView();
      renderRun(existing, await send('getLog'));
    }
    show('connect');
  } catch (err) {
    toast(err.message, 'err');
    show('connect');
  }
})();
