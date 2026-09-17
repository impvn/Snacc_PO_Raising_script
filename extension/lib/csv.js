/**
 * csv.js — RFC4180 CSV parsing and serialisation.
 *
 * We need our own parser (rather than String.split) because Google's CSV
 * exports quote fields containing commas, quotes and newlines, and because
 * the vendor catalogue CSVs we emit must round-trip exactly.
 */

/** Strip a UTF-8 BOM, which Google's export endpoints sometimes prepend. */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into an array of row arrays (all values are strings).
 * Handles quoted fields, escaped quotes (""), CRLF and embedded newlines.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const src = stripBom(String(text ?? ''));
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\r') {
      // Swallow the \r of a CRLF pair; the \n terminates the row.
      if (src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // Flush the final field/row (a file with no trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank lines, which Google emits for empty sheet rows.
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) {
    rows.pop();
  }

  return rows;
}

/**
 * Parse CSV text into an array of objects keyed by the header row.
 * Header cells are trimmed; duplicate headers get a numeric suffix so no
 * column is silently lost.
 *
 * @param {string} text
 * @returns {{headers: string[], rows: Record<string,string>[]}}
 */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { headers: [], rows: [] };

  const seen = new Map();
  const headers = rows[0].map((raw) => {
    const name = String(raw ?? '').trim();
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return n === 0 ? name : `${name}__${n}`;
  });

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip wholly-empty rows.
    if (cells.every((c) => String(c ?? '').trim() === '')) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = cells[c] !== undefined ? String(cells[c]).trim() : '';
    }
    out.push(obj);
  }

  return { headers, rows: out };
}

/** Quote a single CSV field only when required. */
function encodeField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialise rows to CSV text.
 *
 * @param {string[]} headers
 * @param {Array<Record<string, any>>} rows
 * @returns {string}
 */
export function toCsv(headers, rows) {
  const lines = [headers.map(encodeField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => encodeField(row[h])).join(','));
  }
  return lines.join('\r\n');
}
