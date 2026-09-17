/**
 * validation.js — the "important small checks" that run before Start.
 *
 * The whole point of giving the team a UI is that a human gets to see the plan
 * before anything is submitted to a real vendor. These checks are ordered so
 * that configuration problems surface before data problems, and data problems
 * before session problems — otherwise a user fixes their sheet only to discover
 * they were signed out.
 */

import { REQUIRED_COLUMNS, FORECAST_KEYS, normaliseHeader, buildVendorCsv, ledgerKey } from './po-builder.js';
import { parseFlexibleDate, toDisplayDate, weekday } from './dates.js';
import { readLedger } from './ledger.js';

export const LEVELS = { error: 'error', warn: 'warn', info: 'info', ok: 'ok' };

/**
 * Run every check.
 *
 * @param {object} input
 * @param {object}   input.sheets   {forecast:{ok,tabs,error}, vendorTemplate:{ok,tabs,error}}
 * @param {object[]} input.forecastRows
 * @param {object[]} input.podRows
 * @param {Map<string,object[]>} input.vendorTabs  vendor name -> catalogue rows
 * @param {object[]} input.groups    output of groupForecast()
 * @param {object}   input.settings
 * @param {object|null} input.session  result of the SupplyNote ping, if available
 * @returns {Promise<{checks:object[], plan:object[], blocking:number, warnings:number}>}
 */
export async function runChecks(input) {
  const checks = [];
  const add = (id, group, level, title, detail) => checks.push({ id, group, level, title, detail });

  /* ---------------- 1. Connectivity & configuration ---------------- */

  for (const sheet of [
    ['forecast', 'Forecast spreadsheet', input.sheets?.forecast],
    ['vendor', 'Vendor template spreadsheet', input.sheets?.vendorTemplate]
  ]) {
    const [key, label, info] = sheet;
    if (!info) {
      add(key, 'Configuration', LEVELS.error, `${label} not configured`, 'Paste the spreadsheet URL in Settings.');
    } else if (info.error) {
      add(key, 'Configuration', LEVELS.error, `${label} could not be read`, info.error);
    } else {
      add(key, 'Configuration', LEVELS.ok, `${label} connected`, `${info.tabs?.length ?? 0} tab(s) visible to you.`);
    }
  }

  if (input.sheets?.forecast?.error || input.sheets?.vendorTemplate?.error) {
    // Everything downstream depends on these; stop early with a clear message.
    return summarise(checks, [], input);
  }

  /* ---------------- 2. Tab resolution ---------------- */

  const settings = input.settings ?? {};
  const forecastTab = resolveTab(input.sheets.forecast.tabs, settings.forecastTab, ['po_status', 'transformeddata']);
  const podsTab = resolveTab(input.sheets.forecast.tabs, settings.podsTab, ['listedpods']);

  if (!forecastTab) {
    add('tab-forecast', 'Configuration', LEVELS.error, 'Forecast tab not found',
      `No tab matches "${settings.forecastTab || '(not set)'}". Pick one in Settings.`);
  } else {
    add('tab-forecast', 'Configuration', LEVELS.ok, 'Forecast tab resolved', `"${forecastTab.name}"`);
  }

  if (!podsTab) {
    add('tab-pods', 'Configuration', LEVELS.error, 'Listed Pods tab not found',
      `No tab matches "${settings.podsTab || 'Listed Pods'}". Every forecast row would be filtered out.`);
  } else {
    add('tab-pods', 'Configuration', LEVELS.ok, 'Listed Pods tab resolved', `"${podsTab.name}"`);
  }

  /* ---------------- 3. Column contracts ---------------- */

  const forecastHeaders = input.forecastRows?.[0] ? Object.keys(input.forecastRows[0]) : [];
  const missingForecast = FORECAST_KEYS.filter(
    (k) => !forecastHeaders.some((h) => normaliseHeader(h) === normaliseHeader(k))
  );
  if (!forecastHeaders.length) {
    add('cols-forecast', 'Data', LEVELS.error, 'Forecast tab is empty', 'No rows were read.');
  } else if (missingForecast.length) {
    add('cols-forecast', 'Data', LEVELS.error, 'Forecast tab is missing columns',
      `Missing: ${missingForecast.join(', ')}. Found: ${forecastHeaders.join(', ')}`);
  } else {
    add('cols-forecast', 'Data', LEVELS.ok, 'Forecast columns present',
      `${forecastHeaders.length} columns, ${input.forecastRows.length} rows.`);
  }

  const podHeaders = input.podRows?.[0] ? Object.keys(input.podRows[0]) : [];
  if (!podHeaders.some((h) => normaliseHeader(h) === 'location')) {
    add('cols-pods', 'Data', LEVELS.error, 'Listed Pods has no "Location" column',
      `Found: ${podHeaders.join(', ') || '(empty)'}`);
  } else {
    add('cols-pods', 'Data', LEVELS.ok, 'Listed Pods columns present', podHeaders.join(', '));
  }

  /* ---------------- 4. Vendor catalogue coverage ---------------- */

  const groups = input.groups ?? [];
  const vendorsNeeded = [...new Set(groups.map((g) => g.vendor))];
  const vendorsMissing = vendorsNeeded.filter((v) => !input.vendorTabs?.has(v));

  if (vendorsNeeded.length === 0) {
    add('vendors', 'Data', LEVELS.warn, 'No POs to raise',
      'After filtering against Listed Pods there is nothing left. Check your filters and the pods tab.');
  } else if (vendorsMissing.length) {
    add('vendors', 'Data', LEVELS.error, 'Missing vendor catalogue tabs',
      `${vendorsMissing.length} of ${vendorsNeeded.length} vendor(s) have no tab in the vendor template spreadsheet: ${vendorsMissing.join(', ')}. Those POs cannot be priced and will be skipped.`);
  } else {
    add('vendors', 'Data', LEVELS.ok, 'All vendor catalogues found',
      `${vendorsNeeded.length} vendor tab(s) resolved for ${vendorsNeeded.join(', ')}.`);
  }

  /* ---------------- 5. Per-PO build + line-level checks ---------------- */

  const plan = [];
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const group of groups) {
    const built = buildVendorCsv(group, input.vendorTabs?.get(group.vendor) ?? [], group.vendor);
    const errors = built.issues.filter((i) => i.level === 'error');
    const warns = built.issues.filter((i) => i.level === 'warn');

    // Date sanity, per PO.
    const parsed = parseFlexibleDate(group.dateRaw);
    if (!parsed) {
      errors.push({ level: 'error', code: 'BAD_DATE', message: `Delivery date "${group.dateRaw}" could not be parsed.` });
    } else {
      if (parsed.ambiguous) {
        warns.push({
          level: 'warn',
          code: 'AMBIGUOUS_DATE',
          message: `"${group.dateRaw}" is ambiguous (day ≤ 12). Read as ${toDisplayDate(parsed.iso)} assuming dd/mm/yyyy.`
        });
      }
      if (parsed.iso < todayIso) {
        errors.push({
          level: 'error',
          code: 'PAST_DATE',
          message: `Delivery date ${toDisplayDate(parsed.iso)} (${weekday(parsed.iso)}) is in the past.`
        });
      } else if (parsed.iso === todayIso) {
        warns.push({
          level: 'warn',
          code: 'SAME_DAY',
          message: `Delivery date is today (${weekday(parsed.iso)}). Confirm the slot is still achievable.`
        });
      }
    }

    // Exact-duplicate PO across the plan (same vendor/pod/date/slot twice).
    plan.push({
      ...group,
      ledgerKey: ledgerKey(group),
      filename: built.filename,
      csv: built.csv,
      headers: built.headers,
      lineCount: built.rows.length,
      totalQuantity: built.rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0),
      estimatedValue: built.rows.reduce(
        (s, r) => s + (Number(String(r.price ?? '').replace(/,/g, '')) || 0) * (Number(r.quantity) || 0),
        0
      ),
      errors,
      warnings: warns,
      blocked: errors.length > 0
    });
  }

  // Aggregate the most common line-level problems into top-level checks so the
  // user is not forced to expand 24 rows to understand what is wrong.
  const codeCounts = countCodes(plan);
  if (codeCounts.SKU_NOT_IN_CATALOGUE) {
    add('sku-missing', 'Data', LEVELS.error, 'SKUs missing from vendor catalogues',
      `${codeCounts.SKU_NOT_IN_CATALOGUE} line(s) reference a SKU the vendor's tab does not list. These lines are excluded, which would under-order.`);
  }
  if (codeCounts.BAD_QUANTITY) {
    add('qty-bad', 'Data', LEVELS.error, 'Invalid quantities',
      `${codeCounts.BAD_QUANTITY} line(s) have a blank, zero or non-numeric quantity.`);
  }
  if (codeCounts.MISSING_COLUMNS) {
    add('vendor-cols', 'Data', LEVELS.error, 'Vendor tabs missing required columns',
      `${codeCounts.MISSING_COLUMNS} vendor tab(s) lack one of the ${REQUIRED_COLUMNS.length} columns SupplyNote's bulk upload needs.`);
  }
  if (codeCounts.BELOW_MOQ) {
    add('moq', 'Data', LEVELS.warn, 'Lines below minimum order quantity',
      `${codeCounts.BELOW_MOQ} line(s) order less than the contracted minimum. SupplyNote may reject or amend them.`);
  }
  if (codeCounts.DUPLICATE_FORECAST_SKU) {
    add('dup-sku', 'Data', LEVELS.warn, 'Repeated SKUs within a PO',
      `${codeCounts.DUPLICATE_FORECAST_SKU} SKU(s) appear twice in the same PO; quantities were summed.`);
  }
  if (codeCounts.AMBIGUOUS_DATE) {
    add('date-ambiguous', 'Data', LEVELS.warn, 'Ambiguous delivery dates',
      `${codeCounts.AMBIGUOUS_DATE} PO(s) have a date where day ≤ 12. Interpreted as dd/mm/yyyy — verify before submitting.`);
  }
  if (codeCounts.PAST_DATE) {
    add('date-past', 'Data', LEVELS.error, 'Delivery dates in the past',
      `${codeCounts.PAST_DATE} PO(s) are dated before today and will be rejected or, worse, accepted for the wrong day.`);
  }

  /* ---------------- 6. Duplicate-PO ledger ---------------- */

  const ledger = await readLedger();
  let alreadyRaised = 0;
  for (const po of plan) {
    po.prior = ledger[po.ledgerKey] ?? null;
    if (po.prior) alreadyRaised++;
  }

  if (alreadyRaised > 0) {
    add('ledger', 'Safety', LEVELS.error, 'Already raised from this browser',
      `${alreadyRaised} PO(s) in this plan were submitted before and are recorded in the local ledger. ` +
      (settings.skipAlreadyRaised
        ? 'They will be skipped. Untick "Skip already-raised" in Settings only if you are certain they need re-raising.'
        : 'Skipping is currently DISABLED in Settings — re-raising these would send duplicate orders to vendors.'));
  } else {
    add('ledger', 'Safety', LEVELS.ok, 'No duplicates detected',
      'None of these POs have been submitted from this browser before.');
  }

  /* ---------------- 7. SupplyNote session ---------------- */

  if (!input.session) {
    add('session', 'SupplyNote', LEVELS.warn, 'Session not checked yet',
      'Run "Check SupplyNote login" to confirm you are signed in and the order form loads with the expected fields.');
  } else if (input.session.error) {
    add('session', 'SupplyNote', LEVELS.error, 'SupplyNote check failed', input.session.error);
  } else if (input.session.signedOut) {
    add('session', 'SupplyNote', LEVELS.error, 'You are signed out of SupplyNote',
      'Sign in at supplynote.in in this browser, then re-run the checks. The extension uses your own session — it never stores a password.');
  } else {
    add('session', 'SupplyNote', LEVELS.ok, 'Signed in to SupplyNote',
      `Form loaded${input.session.angular ? ` (AngularJS ${input.session.angularVersion ?? ''})` : ''}. ${input.session.fieldCount ?? 0} input field(s) detected.`);
    if ((input.session.fieldCount ?? 0) < 3) {
      add('session-fields', 'SupplyNote', LEVELS.error, 'Order form looks different than expected',
        'Fewer input fields than expected were found. SupplyNote may have changed their layout — re-map fields in Settings.');
    }
  }

  return summarise(checks, plan, input);
}

function summarise(checks, plan, input) {
  const blocking = checks.filter((c) => c.level === LEVELS.error).length;
  const warnings = checks.filter((c) => c.level === LEVELS.warn).length;

  const raisable = plan.filter((p) => !p.blocked && !(input.settings?.skipAlreadyRaised && p.prior));
  const skipped = plan.filter((p) => p.blocked || (input.settings?.skipAlreadyRaised && p.prior));

  const groupsOrder = ['Configuration', 'Data', 'Safety', 'SupplyNote'];
  checks.sort((a, b) => {
    const g = groupsOrder.indexOf(a.group) - groupsOrder.indexOf(b.group);
    if (g !== 0) return g;
    const rank = { error: 0, warn: 1, info: 2, ok: 3 };
    return rank[a.level] - rank[b.level];
  });

  return {
    checks,
    plan,
    blocking,
    warnings,
    summary: {
      totalPos: plan.length,
      raisablePos: raisable.length,
      skippedPos: skipped.length,
      totalLines: raisable.reduce((s, p) => s + p.lineCount, 0),
      estimatedValue: raisable.reduce((s, p) => s + p.estimatedValue, 0),
      vendors: [...new Set(raisable.map((p) => p.vendor))].length,
      locations: [...new Set(raisable.map((p) => p.location))].length
    },
    canStart: blocking === 0 && raisable.length > 0,
    ranAt: new Date().toISOString()
  };
}

function countCodes(plan) {
  const counts = {};
  for (const po of plan) {
    for (const issue of [...po.errors, ...po.warnings]) {
      // Count affected lines where we have a SKU, otherwise count the PO.
      counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    }
  }
  return counts;
}

/** Fuzzy tab resolution: exact name, then normalised name, then heuristic. */
function resolveTab(tabs, configured, heuristicPrefixes = []) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  const wanted = String(configured ?? '').trim();

  if (wanted) {
    const exact = tabs.find((t) => t.name === wanted);
    if (exact) return exact;
    const loose = tabs.find((t) => normaliseHeader(t.name) === normaliseHeader(wanted));
    if (loose) return loose;
    const partial = tabs.find((t) => normaliseHeader(t.name).includes(normaliseHeader(wanted)));
    if (partial) return partial;
  }

  for (const prefix of heuristicPrefixes) {
    const hit = tabs.find((t) => normaliseHeader(t.name).startsWith(prefix));
    if (hit) return hit;
  }
  return null;
}

/** Resolve a vendor name to its catalogue tab, tolerating small differences. */
export function resolveVendorTab(vendor, tabs) {
  if (!vendor) return null;
  const wanted = normaliseHeader(vendor);
  const exact = tabs.find((t) => t.name === vendor);
  if (exact) return exact;
  const loose = tabs.find((t) => normaliseHeader(t.name) === wanted);
  if (loose) return loose;
  // Vendor names in the forecast often carry a suffix ("XYZ Foods Pvt Ltd").
  const partial = tabs.find(
    (t) => normaliseHeader(t.name).includes(wanted) || wanted.includes(normaliseHeader(t.name))
  );
  return partial ?? null;
}
