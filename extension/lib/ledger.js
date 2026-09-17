/**
 * ledger.js — the duplicate-PO guard.
 *
 * The single most expensive failure mode in this workflow is raising the same
 * PO twice: real vendors receive real orders. Automated retries make that easy
 * to do by accident, and the original Python had no protection at all (its
 * `submit()` returned True merely because a JS click did not throw).
 *
 * Every successful submission is recorded here, keyed by
 * (vendor | location | iso-date | slot). Before submitting we consult the
 * ledger and require an explicit human override to proceed.
 *
 * Storage: chrome.storage.local, capped to the most recent N entries.
 * This is per-browser, which is exactly right — each teammate raises their own
 * POs from their own machine, so a local ledger is the correct scope.
 */

const KEY = 'ledger.v1';
const MAX_ENTRIES = 5000;

/** @returns {Promise<Record<string, object>>} */
export async function readLedger() {
  const stored = await chrome.storage.local.get(KEY);
  return stored[KEY] || {};
}

/**
 * Record a successful submission.
 * @param {string} ledgerKey
 * @param {object} info  {vendor, location, dateIso, slot, poNumber?, filename, lineCount, submittedAt}
 */
export async function recordSuccess(ledgerKey, info) {
  const ledger = await readLedger();
  const previous = ledger[ledgerKey];
  ledger[ledgerKey] = {
    ...info,
    submittedAt: new Date().toISOString(),
    attempts: (previous?.attempts ?? 0) + 1,
    history: [...(previous?.history ?? []), { at: new Date().toISOString(), poNumber: info.poNumber ?? null }]
      .slice(-10)
  };

  // Trim oldest entries so storage cannot grow without bound.
  const keys = Object.keys(ledger);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (ledger[a].submittedAt || '').localeCompare(ledger[b].submittedAt || ''))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete ledger[k]);
  }

  await chrome.storage.local.set({ [KEY]: ledger });
  return ledger[ledgerKey];
}

/** Look up a single PO. */
export async function lookup(ledgerKey) {
  const ledger = await readLedger();
  return ledger[ledgerKey] ?? null;
}

/** Bulk lookup, used by the Checks step to annotate the whole plan at once. */
export async function annotate(groups, keyFn) {
  const ledger = await readLedger();
  return groups.map((g) => ({ ...g, prior: ledger[keyFn(g)] ?? null }));
}

/** Forget one entry (e.g. a PO the user cancelled on the platform). */
export async function forget(ledgerKey) {
  const ledger = await readLedger();
  delete ledger[ledgerKey];
  await chrome.storage.local.set({ [KEY]: ledger });
}

/** Forget everything. Deliberately requires an explicit confirmation string. */
export async function clearLedger(confirmText) {
  if (confirmText !== 'CLEAR') {
    throw new Error('Refusing to clear the ledger without the confirmation word CLEAR.');
  }
  await chrome.storage.local.remove(KEY);
}

/** Export as CSV-ish text for audit purposes. */
export async function exportLedger() {
  const ledger = await readLedger();
  const rows = Object.entries(ledger).map(([k, v]) => ({
    key: k,
    vendor: v.vendor,
    location: v.location,
    date: v.dateIso,
    slot: v.slot,
    poNumber: v.poNumber ?? '',
    lineCount: v.lineCount ?? '',
    attempts: v.attempts ?? 1,
    submittedAt: v.submittedAt ?? ''
  }));
  rows.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  return rows;
}
