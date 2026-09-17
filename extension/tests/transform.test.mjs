/**
 * Unit tests for the transformation layer — the half of the pipeline where a
 * silent mistake sends the wrong quantity or the wrong price to a real vendor.
 *
 * Run with:  node --test extension/tests/
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

// lib/ledger.js reaches for chrome.storage at call time; stub it so the pure
// modules can be imported under plain Node.
globalThis.chrome = {
  storage: {
    local: {
      _d: {},
      async get(k) { return { [k]: this._d[k] }; },
      async set(o) { Object.assign(this._d, o); },
      async remove(k) { delete this._d[k]; }
    },
    session: { _d: {}, async get(k) { return { [k]: this._d[k] }; }, async set(o) { Object.assign(this._d, o); } },
    sync: { _d: {}, async get(k) { return { [k]: this._d[k] }; }, async set(o) { Object.assign(this._d, o); } }
  }
};

const { parseCsv, parseCsvObjects, toCsv, stripBom } = await import('../lib/csv.js');
const { parseFlexibleDate, toUsDate, toDisplayDate } = await import('../lib/dates.js');
const {
  REQUIRED_COLUMNS, groupForecast, buildVendorCsv, csvFilename, ledgerKey, filterToActivePods, normaliseHeader
} = await import('../lib/po-builder.js');
const { extractSpreadsheetId, listTabs, parseHtmlViewTabs, tabCsvUrl, driveExportUrlForTab } = await import('../lib/sheets.js');

/* ------------------------------------------------------------------ */

describe('csv', () => {
  test('parses quoted fields containing commas and newlines', () => {
    const rows = parseCsv('a,b\n"hello, world","line1\nline2"\n');
    assert.deepEqual(rows, [['a', 'b'], ['hello, world', 'line1\nline2']]);
  });

  test('handles escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b\r\n"say ""hi""",2\r\n');
    assert.deepEqual(rows, [['a', 'b'], ['say "hi"', '2']]);
  });

  test('drops trailing empty rows the way Google emits them', () => {
    const rows = parseCsv('a,b\n1,2\n\n\n');
    assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
  });

  test('strips a BOM so the first header is not corrupted', () => {
    const { headers } = parseCsvObjects('\ufeffSKUcode,Quantity\nA,1\n');
    assert.equal(headers[0], 'SKUcode');
  });

  test('disambiguates duplicate headers instead of losing a column', () => {
    const { headers, rows } = parseCsvObjects('price,price\n1,2\n');
    assert.deepEqual(headers, ['price', 'price__1']);
    assert.equal(rows[0].price__1, '2');
  });

  test('round-trips values that need quoting', () => {
    const csv = toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }]);
    const back = parseCsvObjects(csv);
    assert.equal(back.rows[0].a, 'x,y');
    assert.equal(back.rows[0].b, 'say "hi"');
  });

  test('stripBom is a no-op on clean input', () => {
    assert.equal(stripBom('abc'), 'abc');
  });
});

/* ------------------------------------------------------------------ */

describe('dates', () => {
  test('reads the sheet convention dd/mm/yyyy', () => {
    const d = parseFlexibleDate('15/04/2025');
    assert.equal(d.iso, '2025-04-15');
    assert.equal(d.ambiguous, false);
    assert.equal(toUsDate(d.iso), '04/15/2025');
  });

  test('resolves order from evidence when one half exceeds 12', () => {
    assert.equal(parseFlexibleDate('04/15/2025').iso, '2025-04-15');
  });

  test('flags a genuinely ambiguous date instead of silently guessing', () => {
    const d = parseFlexibleDate('05/04/2025');
    assert.equal(d.iso, '2025-04-05'); // dd/mm honoured
    assert.equal(d.ambiguous, true);   // but reported
  });

  test('accepts ISO, dashes, dots and two-digit years', () => {
    assert.equal(parseFlexibleDate('2025-04-15').iso, '2025-04-15');
    assert.equal(parseFlexibleDate('15-04-2025').iso, '2025-04-15');
    assert.equal(parseFlexibleDate('15.04.2025').iso, '2025-04-15');
    assert.equal(parseFlexibleDate('15/04/25').iso, '2025-04-15');
  });

  test('accepts month names and Excel serials', () => {
    assert.equal(parseFlexibleDate('15 Apr 2025').iso, '2025-04-15');
    assert.equal(parseFlexibleDate('Apr 15, 2025').iso, '2025-04-15');
    assert.equal(parseFlexibleDate('45762').iso, '2025-04-15');
  });

  test('rejects impossible and unparseable dates', () => {
    assert.equal(parseFlexibleDate('31/02/2025'), null);
    assert.equal(parseFlexibleDate('not a date'), null);
    assert.equal(parseFlexibleDate(''), null);
  });

  test('displays back in Indian order for the ops team', () => {
    assert.equal(toDisplayDate('2025-04-15'), '15/04/2025');
  });
});

/* ------------------------------------------------------------------ */

const FORECAST = [
  { SKUcode: 'SKU1001', Quantity: '4', Vendor: 'Fresh Harvest', Location: 'Bagmane', Date: '15/04/2025', Slot: 'Morning' },
  { SKUcode: 'SKU1002', Quantity: '2', Vendor: 'Fresh Harvest', Location: 'Bagmane', Date: '15/04/2025', Slot: 'Morning' },
  { SKUcode: 'SKU1001', Quantity: '7', Vendor: 'Daily Dairy', Location: 'Ecospace', Date: '16/04/2025', Slot: 'Evening' }
];

const PODS = [
  { Location: 'Bagmane', PodCode: 'BLR-01', Zone: 'East' },
  { Location: 'Ecospace', PodCode: 'BLR-02', Zone: 'North' }
];

const CATALOGUE = [
  {
    id: '11', priceContract: 'C-1', minimumOrderQty: '3', skuProductCode: 'SKU1001',
    category: 'Produce', subCategory: 'Vegetables', productTitle: 'Tomato', recommendedQty: '5',
    lastAuditedStock: '2', currentStock: '3', baseUnit: 'kg', price: '40', conversion: '1',
    quantity2: '', secondaryUnit: 'crate', secondaryUnitPrice: '480', discount: '0', tax: '5'
  },
  {
    id: '12', priceContract: 'C-1', minimumOrderQty: '1', skuProductCode: 'SKU1002',
    category: 'Dairy', subCategory: 'Milk', productTitle: 'Milk 1L', recommendedQty: '8',
    lastAuditedStock: '4', currentStock: '5', baseUnit: 'ltr', price: '58', conversion: '12',
    quantity2: '', secondaryUnit: 'crate', secondaryUnitPrice: '696', discount: '0', tax: '0'
  }
];

describe('pod filter', () => {
  test('drops rows whose location is not in Listed Pods, like merge+dropna', () => {
    const rows = [...FORECAST, { ...FORECAST[0], Location: 'Closed Pod' }];
    const { kept, dropped } = filterToActivePods(rows, PODS);
    assert.equal(kept.length, 3);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].reason, /not in Listed Pods/);
  });

  test('drops rows with a blank location', () => {
    const { kept, dropped } = filterToActivePods([{ ...FORECAST[0], Location: '' }], PODS);
    assert.equal(kept.length, 0);
    assert.equal(dropped.length, 1);
  });

  test('reports duplicated pod locations, which would multiply orders in pandas', () => {
    const { duplicatePodLocations } = filterToActivePods(FORECAST, [...PODS, PODS[0]]);
    assert.deepEqual(duplicatePodLocations, ['Bagmane']);
  });
});

describe('grouping', () => {
  test('produces one PO per vendor/location/date/slot, in first-seen order', () => {
    const groups = [...groupForecast(FORECAST).values()];
    assert.equal(groups.length, 2);
    assert.equal(groups[0].vendor, 'Fresh Harvest');
    assert.equal(groups[0].location, 'Bagmane');
    assert.equal(groups[0].dateIso, '2025-04-15');
    assert.equal(groups[0].dateUs, '04/15/2025');
    assert.equal(groups[0].lines.length, 2);
    assert.equal(groups[1].vendor, 'Daily Dairy');
  });

  test('tolerates header spelling differences', () => {
    const loose = [{ 'sku code': 'SKU1001', quantity: '3', vendor: 'V', location: 'L', date: '15/04/2025', slot: 'AM' }];
    const groups = [...groupForecast(loose).values()];
    assert.equal(groups.length, 1);
    assert.equal(groups[0].lines[0].sku, 'SKU1001');
  });

  test('ignores rows with an unparseable date rather than mis-scheduling them', () => {
    const groups = groupForecast([{ ...FORECAST[0], Date: 'whenever' }]);
    assert.equal(groups.size, 0);
  });
});

describe('vendor CSV build', () => {
  const group = () => [...groupForecast(FORECAST).values()][0];

  test('emits exactly the 19-column contract in order', () => {
    const built = buildVendorCsv(group(), CATALOGUE, 'Fresh Harvest');
    assert.deepEqual(built.headers, REQUIRED_COLUMNS);
    assert.equal(built.rows.length, 2);
    const firstLine = built.csv.split('\r\n')[0];
    assert.equal(firstLine, REQUIRED_COLUMNS.join(','));
  });

  test('maps forecast Quantity onto the lowercase quantity column', () => {
    const built = buildVendorCsv(group(), CATALOGUE, 'Fresh Harvest');
    assert.equal(built.rows[0].quantity, 4);
    assert.equal(built.rows[1].quantity, 2);
  });

  test('carries catalogue fields through untouched', () => {
    const built = buildVendorCsv(group(), CATALOGUE, 'Fresh Harvest');
    assert.equal(built.rows[0].productTitle, 'Tomato');
    assert.equal(built.rows[0].price, '40');
    assert.equal(built.rows[0].minimumOrderQty, '3');
  });

  test('flags a SKU that the vendor does not list, instead of pricing it as blank', () => {
    const g = group();
    g.lines.push({ sku: 'UNKNOWN-1', quantityRaw: '5' });
    const built = buildVendorCsv(g, CATALOGUE, 'Fresh Harvest');
    const issue = built.issues.find((i) => i.code === 'SKU_NOT_IN_CATALOGUE');
    assert.ok(issue, 'expected a SKU_NOT_IN_CATALOGUE issue');
    assert.equal(built.rows.find((r) => r.skuProductCode === 'UNKNOWN-1'), undefined);
  });

  test('refuses to emit a PO with no orderable lines', () => {
    const g = group();
    g.lines = [{ sku: 'NOPE', quantityRaw: '1' }];
    const built = buildVendorCsv(g, CATALOGUE, 'Fresh Harvest');
    assert.equal(built.rows.length, 0);
    assert.ok(built.issues.some((i) => i.code === 'SKU_NOT_IN_CATALOGUE'));
  });

  test('rejects blank, zero and non-numeric quantities', () => {
    for (const bad of ['', '0', '-2', 'abc']) {
      const g = group();
      g.lines = [{ sku: 'SKU1001', quantityRaw: bad }];
      const built = buildVendorCsv(g, CATALOGUE, 'Fresh Harvest');
      assert.ok(
        built.issues.some((i) => i.code === 'BAD_QUANTITY'),
        `quantity "${bad}" should be rejected`
      );
    }
  });

  test('warns when ordering below the contracted minimum', () => {
    const g = group();
    g.lines = [{ sku: 'SKU1001', quantityRaw: '1' }]; // MOQ is 3
    const built = buildVendorCsv(g, CATALOGUE, 'Fresh Harvest');
    assert.ok(built.issues.some((i) => i.code === 'BELOW_MOQ'));
  });

  test('sums a repeated SKU instead of duplicating the line as pandas would', () => {
    const g = group();
    g.lines = [
      { sku: 'SKU1001', quantityRaw: '4' },
      { sku: 'SKU1001', quantityRaw: '6' }
    ];
    const built = buildVendorCsv(g, CATALOGUE, 'Fresh Harvest');
    assert.equal(built.rows.length, 1);
    assert.equal(built.rows[0].quantity, 10);
    assert.ok(built.issues.some((i) => i.code === 'DUPLICATE_FORECAST_SKU'));
  });

  test('reports a duplicated catalogue SKU rather than silently expanding rows', () => {
    const built = buildVendorCsv(group(), [...CATALOGUE, CATALOGUE[0]], 'Fresh Harvest');
    assert.ok(built.issues.some((i) => i.code === 'DUPLICATE_VENDOR_SKUS'));
    assert.equal(built.rows.length, 2);
  });

  test('errors clearly when the vendor tab is missing entirely', () => {
    const built = buildVendorCsv(group(), [], 'Fresh Harvest');
    assert.equal(built.csv, '');
    assert.equal(built.issues[0].code, 'NO_VENDOR_TAB');
  });

  test('errors when the vendor tab lacks required columns', () => {
    const built = buildVendorCsv(group(), [{ skuProductCode: 'SKU1001', price: '40' }], 'Fresh Harvest');
    assert.ok(built.issues.some((i) => i.code === 'MISSING_COLUMNS'));
  });

  test('matches the catalogue key even if the header is spelled differently', () => {
    const renamed = CATALOGUE.map((r) => ({ ...r, 'SKU Product Code': r.skuProductCode, skuProductCode: undefined }));
    const cleaned = renamed.map((r) => {
      const { skuProductCode, ...rest } = r;
      void skuProductCode;
      return rest;
    });
    const built = buildVendorCsv(group(), cleaned, 'Fresh Harvest');
    assert.equal(built.rows.length, 2);
  });
});

describe('filenames and ledger keys', () => {
  const g = [...groupForecast(FORECAST).values()][0];

  test('filename matches the Python scheme exactly', () => {
    assert.equal(csvFilename(g), 'Fresh_Harvest_Morning_Bagmane_15_04_2025.csv');
  });

  test('ledger key is case- and whitespace-insensitive', () => {
    const a = ledgerKey(g);
    const b = ledgerKey({ ...g, vendor: '  FRESH HARVEST ', slot: 'morning' });
    assert.equal(a, b);
  });

  test('different slots of the same pod are different POs', () => {
    assert.notEqual(
      ledgerKey({ ...g, slot: 'Morning' }),
      ledgerKey({ ...g, slot: 'Evening' })
    );
  });
});

describe('sheets', () => {
  test('extracts ids from the URL shapes people actually paste', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789';
    assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
    assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`), id);
    assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/u/1/d/${id}/edit`), id);
    assert.equal(extractSpreadsheetId(id), id);
    assert.equal(extractSpreadsheetId('https://example.com'), null);
    assert.equal(extractSpreadsheetId(''), null);
  });

  test('reads the tab list out of the gviz metadata envelope', async () => {
    const envelope =
      '/*O_o*/\ngoogle.visualization.Query.setResponse(' +
      JSON.stringify({
        status: 'ok',
        table: { sig: [{ name: 'PO_Status', id: 0, index: 0 }, { name: 'Listed Pods', id: 1234, index: 1 }] }
      }) +
      ');';
    const tabs = await listTabs('sheetid123456789012345', async () => envelope);
    assert.deepEqual(tabs.map((t) => t.name), ['PO_Status', 'Listed Pods']);
    assert.equal(tabs[1].id, 1234, 'the gid must survive so readTabCsv can use the export fallback');
  });

  test('a signed-out response is a clear error, not a parse failure', async () => {
    await assert.rejects(
      () => listTabs('sheetid123456789012345', async () => '<html><body>Sign in - Google Accounts</body></html>'),
      /sign-in page|Sign in/i
    );
  });

  test('falls back to htmlview when gviz returns no tab list', async () => {
    const html =
      '<html><body><div class="sheet-button"><span>PO_Status</span></div>' +
      '<div class="sheet-button"><span>Listed Pods</span></div></body></html>';
    let calls = 0;
    const tabs = await listTabs('sheetid123456789012345', async (url) => {
      calls++;
      if (url.includes('gviz')) return '{"unexpected":"shape"}';
      return html;
    });
    assert.deepEqual(tabs.map((t) => t.name), ['PO_Status', 'Listed Pods']);
    assert.equal(calls, 2, 'should have retried via htmlview');
  });

  test('parseHtmlViewTabs handles both picker markups and de-duplicates', () => {
    const modern = '<div class="sheet-button" data-x="1"><span class="n">Fresh Harvest</span></div>' +
      '<div class="sheet-button"><span>Daily Dairy</span></div>' +
      '<div class="sheet-button"><span>Fresh Harvest</span></div>';
    assert.deepEqual(parseHtmlViewTabs(modern).map((t) => t.name), ['Fresh Harvest', 'Daily Dairy']);

    const legacy = '<select><option value="0">PO_Status</option><option value="9">Listed&nbsp;Pods</option></select>';
    assert.deepEqual(parseHtmlViewTabs(legacy).map((t) => t.name), ['PO_Status', 'Listed Pods']);

    assert.deepEqual(parseHtmlViewTabs('<html>no picker here</html>'), []);
  });

  test('builds a name-based CSV URL, and a gid-based export URL when known', () => {
    assert.equal(
      tabCsvUrl('ID1', 'Listed Pods'),
      'https://docs.google.com/spreadsheets/d/ID1/gviz/tq?tqx=out:csv&sheet=Listed%20Pods'
    );
    assert.equal(
      driveExportUrlForTab('ID1', { name: 'Listed Pods', id: 1234 }),
      'https://drive.google.com/spreadsheet/ccc?key=ID1&exportFormat=csv&gid=1234'
    );
    // Without a gid the export route is unavailable and readTabCsv must not try it.
    assert.equal(driveExportUrlForTab('ID1', { name: 'Listed Pods' }), null);
  });
});

describe('header normalisation', () => {
  test('collapses the spellings that break naive lookups', () => {
    for (const variant of ['SKUcode', 'sku code', 'SKU Code', ' sku_code ', 'skucode']) {
      assert.equal(normaliseHeader(variant), 'skucode');
    }
  });
});
