/**
 * po-builder.js — the transformation half of the pipeline.
 *
 * This is a faithful JavaScript port of `prepare_csv_files_from_sheets()` from
 * Raise_PO_bulk_final.py. Same joins, same grouping, same 19-column output
 * contract, so a CSV produced here is byte-comparable with one produced by the
 * Python script for the same inputs.
 *
 * Input shapes:
 *   forecastRows  – objects from the PO_Status tab           (A:I)
 *   podRows       – objects from the Listed Pods tab         (A:C)
 *   vendorTabs    – Map<vendorName, objects from that vendor's tab>  (A:S)
 */

import { toCsv } from './csv.js';
import { parseFlexibleDate, toUsDate, toIsoDate } from './dates.js';

/** The exact column contract SupplyNote's Bulk Add upload expects. */
export const REQUIRED_COLUMNS = [
  'id',
  'priceContract',
  'minimumOrderQty',
  'skuProductCode',
  'category',
  'subCategory',
  'productTitle',
  'recommendedQty',
  'lastAuditedStock',
  'currentStock',
  'quantity',
  'baseUnit',
  'price',
  'conversion',
  'quantity2',
  'secondaryUnit',
  'secondaryUnitPrice',
  'discount',
  'tax'
];

/** Columns the forecast tab must contain. */
export const FORECAST_KEYS = ['SKUcode', 'Quantity', 'Vendor', 'Location', 'Date', 'Slot'];

/**
 * Normalise a header name for tolerant matching: lowercase, collapse spaces
 * and strip non-alphanumerics. Sheets in the wild have "SKU Code", "Skucode",
 * "sku_code" and trailing whitespace, and the Python version silently produced
 * empty columns for any of those.
 */
export function normaliseHeader(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.]+/g, '');
}

/**
 * Re-key a row object so that a set of wanted logical names resolve even when
 * the sheet header differs slightly. Returns {row, resolved, missing}.
 */
function projectRow(row, wantedNames) {
  const lookup = new Map();
  for (const [key, value] of Object.entries(row)) {
    lookup.set(normaliseHeader(key), { key, value });
  }
  const out = {};
  const resolved = {};
  const missing = [];
  for (const name of wantedNames) {
    const hit = lookup.get(normaliseHeader(name));
    if (hit) {
      out[name] = hit.value;
      resolved[name] = hit.key;
    } else {
      out[name] = '';
      missing.push(name);
    }
  }
  return { row: out, resolved, missing };
}

/**
 * Apply the "Listed Pods" filter, mirroring `pd.merge(..., how='left').dropna()`.
 *
 * The Python behaviour: rows whose Location is not present in Listed Pods are
 * dropped (they become NaN on the left join, then dropna removes them). Rows
 * with a blank Location are dropped as well.
 *
 * We additionally de-duplicate Listed Pods on Location, because a duplicated
 * location there would multiply every matching forecast row in pandas — a real
 * silent over-ordering bug.
 */
export function filterToActivePods(forecastRows, podRows) {
  const activeLocations = new Set();
  const duplicates = [];
  const seen = new Set();
  const locationColumn =
    podRows.length > 0
      ? Object.keys(podRows[0]).find((k) => normaliseHeader(k) === 'location') ?? 'Location'
      : 'Location';

  for (const pod of podRows) {
    const loc = String(pod[locationColumn] ?? '').trim();
    if (!loc) continue;
    if (seen.has(loc)) duplicates.push(loc);
    seen.add(loc);
    activeLocations.add(loc);
  }

  const kept = [];
  const dropped = [];
  for (const row of forecastRows) {
    const loc = String(row.Location ?? '').trim();
    if (!loc) {
      dropped.push({ row, reason: 'blank Location' });
    } else if (!activeLocations.has(loc)) {
      dropped.push({ row, reason: `Location "${loc}" is not in Listed Pods` });
    } else {
      kept.push(row);
    }
  }

  return { kept, dropped, activeLocations: [...activeLocations], duplicatePodLocations: duplicates };
}

/** Stable group key, mirroring pandas groupby(['Vendor','Location','Date','Slot']). */
export function groupKey(vendor, location, dateIso, slot) {
  return [vendor, location, dateIso, slot].join('\u0001');
}

/**
 * Group the filtered forecast into one PO per (Vendor, Location, Date, Slot),
 * preserving first-seen order so the UI lists POs predictably.
 */
export function groupForecast(rows) {
  const groups = new Map();
  for (const raw of rows) {
    const { row, missing } = projectRow(raw, FORECAST_KEYS);
    if (missing.length > 0) {
      // Keep going: validation reports this properly, we just flag it here.
      row.__missingColumns = missing;
    }

    const vendor = String(row.Vendor ?? '').trim();
    const location = String(row.Location ?? '').trim();
    const slot = String(row.Slot ?? '').trim();
    const rawDate = String(row.Date ?? '').trim();
    const parsed = parseFlexibleDate(rawDate);

    if (!vendor || !location || !slot || !parsed) continue;

    const key = groupKey(vendor, location, parsed.iso, slot);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        vendor,
        location,
        slot,
        dateRaw: rawDate,
        dateIso: parsed.iso,
        dateUs: toUsDate(parsed.iso),
        lines: [],
        problems: []
      });
    }
    groups.get(key).lines.push({
      sku: String(row.SKUcode ?? '').trim(),
      quantityRaw: String(row.Quantity ?? '').trim(),
      sourceRow: raw
    });
  }
  return groups;
}

/**
 * Join a group's lines against that vendor's catalogue tab and build the CSV,
 * mirroring the pandas merge on SKUcode -> skuProductCode.
 *
 * @returns {{filename:string, csv:string, headers:string[], rows:object[], issues:object[]}}
 */
export function buildVendorCsv(group, vendorRows, vendorTabName) {
  const issues = [];

  if (!vendorRows || vendorRows.length === 0) {
    return {
      filename: csvFilename(group),
      csv: '',
      headers: [],
      rows: [],
      issues: [{ level: 'error', code: 'NO_VENDOR_TAB', message: `No tab found for vendor "${group.vendor}" in the vendor template spreadsheet.` }]
    };
  }

  // Find the vendor's SKU column, tolerating header spelling differences.
  const sample = vendorRows[0];
  const skuColumn =
    Object.keys(sample).find((k) => normaliseHeader(k) === 'skuproductcode') ?? null;

  if (!skuColumn) {
    return {
      filename: csvFilename(group),
      csv: '',
      headers: [],
      rows: [],
      issues: [{
        level: 'error',
        code: 'NO_SKU_COLUMN',
        message: `Vendor tab "${vendorTabName}" has no skuProductCode column, so SKUs cannot be matched.`
      }]
    };
  }

  // Index the catalogue by SKU. pandas would *expand* rows on a duplicate key,
  // silently multiplying the order; we instead keep the first and report it.
  const index = new Map();
  const duplicateSkus = new Set();
  for (const vr of vendorRows) {
    const sku = String(vr[skuColumn] ?? '').trim();
    if (!sku) continue;
    if (index.has(sku)) {
      duplicateSkus.add(sku);
      continue;
    }
    index.set(sku, vr);
  }
  if (duplicateSkus.size > 0) {
    issues.push({
      level: 'warn',
      code: 'DUPLICATE_VENDOR_SKUS',
      message: `Vendor tab "${vendorTabName}" lists ${duplicateSkus.size} SKU(s) more than once: ${[...duplicateSkus].slice(0, 5).join(', ')}${duplicateSkus.size > 5 ? '…' : ''}. First occurrence used.`
    });
  }

  // Which of the 19 required columns does this vendor tab actually supply?
  const byNormalised = new Map();
  for (const key of Object.keys(sample)) byNormalised.set(normaliseHeader(key), key);
  const missingColumns = REQUIRED_COLUMNS.filter(
    (c) => c !== 'quantity' && !byNormalised.has(normaliseHeader(c))
  );
  if (missingColumns.length > 0) {
    issues.push({
      level: 'error',
      code: 'MISSING_COLUMNS',
      message: `Vendor tab "${vendorTabName}" is missing required column(s): ${missingColumns.join(', ')}`
    });
  }

  const outRows = [];

  // Pass 1 — accumulate quantities per SKU.
  //
  // pandas `merge` would *expand* rows when a forecast SKU repeats, quietly
  // sending the vendor two lines for the same product. Two lines for one SKU in
  // one PO is almost always a copy-paste duplicate in the sheet, so we sum them
  // and tell the user we did.
  const accumulated = new Map(); // sku -> {qty, firstIndex}
  const rejected = [];

  for (const line of group.lines) {
    const qty = Number(String(line.quantityRaw).replace(/,/g, ''));

    if (!line.sku) {
      issues.push({ level: 'error', code: 'BLANK_SKU', message: 'A forecast row has a blank SKUcode.' });
      rejected.push(line);
      continue;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      issues.push({
        level: 'error',
        code: 'BAD_QUANTITY',
        message: `SKU ${line.sku} has a non-numeric or non-positive quantity: "${line.quantityRaw}"`,
        sku: line.sku
      });
      rejected.push(line);
      continue;
    }

    const existing = accumulated.get(line.sku);
    if (existing) {
      existing.qty += qty;
      issues.push({
        level: 'warn',
        code: 'DUPLICATE_FORECAST_SKU',
        message: `SKU ${line.sku} appears more than once in this PO; quantities were summed to ${existing.qty}.`,
        sku: line.sku
      });
      continue;
    }
    accumulated.set(line.sku, { qty, line });
  }

  // Pass 2 — join each accumulated SKU onto the vendor catalogue.
  for (const [sku, { qty, line }] of accumulated) {
    const catalogue = index.get(sku);
    if (!catalogue) {
      issues.push({
        level: 'error',
        code: 'SKU_NOT_IN_CATALOGUE',
        message: `SKU ${sku} is not listed in vendor "${group.vendor}"'s tab, so it cannot be priced.`,
        sku
      });
      continue;
    }

    const out = {};
    for (const col of REQUIRED_COLUMNS) {
      if (col === 'quantity') continue;
      const srcKey = byNormalised.get(normaliseHeader(col));
      out[col] = srcKey ? catalogue[srcKey] : '';
    }

    // Minimum-order-quantity sanity check — the platform will reject or amend.
    const moq = Number(String(out.minimumOrderQty ?? '').replace(/,/g, ''));
    if (Number.isFinite(moq) && moq > 0 && qty < moq) {
      issues.push({
        level: 'warn',
        code: 'BELOW_MOQ',
        message: `SKU ${sku}: ordering ${qty} but the contract minimum is ${moq}.`,
        sku
      });
    }

    if (!String(out.price ?? '').trim()) {
      issues.push({
        level: 'warn',
        code: 'NO_PRICE',
        message: `SKU ${sku} has no price in the vendor tab.`,
        sku
      });
    }

    out.quantity = qty;
    outRows.push(out);
    void line;
  }

  if (outRows.length === 0 && issues.every((i) => i.level !== 'error')) {
    issues.push({ level: 'error', code: 'EMPTY_PO', message: 'This PO has no orderable lines.' });
  }

  return {
    filename: csvFilename(group),
    headers: REQUIRED_COLUMNS,
    rows: outRows,
    csv: toCsv(REQUIRED_COLUMNS, outRows),
    issues
  };
}

/** Mirrors the Python filename scheme exactly. */
export function csvFilename(group) {
  const formattedDate = String(group.dateRaw).replace(/-/g, '_').replace(/\//g, '_');
  return `${group.vendor}_${group.slot}_${group.location}_${formattedDate}.csv`.replace(/ /g, '_');
}

/** Unique, stable idempotency key for one PO. */
export function ledgerKey(group) {
  return [group.vendor, group.location, toIsoDate(group.dateIso), group.slot]
    .map((s) => String(s).trim().toLowerCase())
    .join('|');
}
