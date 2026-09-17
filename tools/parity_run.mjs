/**
 * parity_run.mjs — run the extension's transformation over a fixture and emit
 * the CSVs it would upload, as JSON on stdout.
 *
 * Used by tools/parity_check.py to prove the JavaScript pipeline produces the
 * same bytes as the pandas pipeline in Raise_PO_bulk_final.py.
 *
 *   node tools/parity_run.mjs tools/fixture_clean.json
 */

import { readFileSync } from 'node:fs';
import { parseCsvObjects, toCsv } from '../extension/lib/csv.js';
import { groupForecast, buildVendorCsv, ledgerKey } from '../extension/lib/po-builder.js';
import { filterToActivePods } from '../extension/lib/po-builder.js';

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error('usage: node parity_run.mjs <fixture.json>');
  process.exit(2);
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

/** Turn a {headers, rows} fixture block into the object rows the lib expects. */
function toObjects(block) {
  // Round-trip through our own CSV writer/parser so the JS sees exactly the
  // same string-typed data it would get from a Google Sheets CSV export.
  const csv = toCsv(
    block.headers,
    block.rows.map((r) => Object.fromEntries(block.headers.map((h, i) => [h, r[i] ?? ''])))
  );
  return parseCsvObjects(csv).rows;
}

const forecastRows = toObjects(fixture.forecast);
const podRows = toObjects(fixture.pods);

const vendorTabs = new Map();
for (const [vendor, block] of Object.entries(fixture.vendors ?? {})) {
  vendorTabs.set(vendor, toObjects(block));
}

const { kept } = filterToActivePods(forecastRows, podRows);
const groups = [...groupForecast(kept).values()];

const out = [];
for (const group of groups) {
  const built = buildVendorCsv(group, vendorTabs.get(group.vendor) ?? [], group.vendor);
  out.push({
    filename: built.filename,
    ledgerKey: ledgerKey(group),
    vendor: group.vendor,
    location: group.location,
    dateIso: group.dateIso,
    dateUs: group.dateUs,
    slot: group.slot,
    csv: built.csv,
    lineCount: built.rows.length,
    issues: built.issues
  });
}

process.stdout.write(JSON.stringify({ pos: out }, null, 2));
