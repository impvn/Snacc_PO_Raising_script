/**
 * dates.js — date handling.
 *
 * This deserves its own module because it is the quietest way to lose money in
 * the whole pipeline. The forecasting sheet writes dates in Indian order
 * (dd/mm/yyyy) while SupplyNote's datepicker expects US order (mm/dd/yyyy).
 * The original Python did a blind `strptime('%d/%m/%Y')`, which throws on an
 * ISO date and silently misreads any day-of-month <= 12 that arrived in US
 * order. Here we parse defensively and *report* ambiguity instead of guessing.
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function pad(n) {
  return String(n).padStart(2, '0');
}

/** @returns {{iso:string, ambiguous:boolean, assumedFormat:string}|null} */
export function parseFlexibleDate(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // Excel/Sheets serial number (days since 1899-12-30).
  if (/^\d{4,6}(\.0+)?$/.test(raw)) {
    const serial = Math.floor(Number(raw));
    if (serial > 20000 && serial < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return {
        iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        ambiguous: false,
        assumedFormat: 'excel-serial'
      };
    }
  }

  // ISO: 2025-04-15 or 2025/04/15
  let m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    return finish(Number(m[1]), Number(m[2]), Number(m[3]), false, 'iso');
  }

  // dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy  (also accepts dd/mm/yy)
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;

    // If one half is unambiguously a month (>12) the order resolves itself.
    let day, month, ambiguous = false, format;
    if (a > 12 && b <= 12) {
      day = a; month = b; format = 'dd/mm/yyyy';
    } else if (b > 12 && a <= 12) {
      day = b; month = a; format = 'mm/dd/yyyy';
      ambiguous = false; // resolved by evidence
    } else if (a <= 12 && b <= 12) {
      // Genuinely ambiguous. The sheet's convention is dd/mm/yyyy, so honour
      // that but flag it so the Checks step can surface it to the user.
      day = a; month = b; format = 'dd/mm/yyyy';
      ambiguous = true;
    } else {
      return null;
    }
    return finish(year, month, day, ambiguous, format);
  }

  // "15 Apr 2025" / "Apr 15, 2025"
  m = raw.match(/^(\d{1,2})\s+([a-zA-Z]{3,9})\.?,?\s+(\d{4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return finish(Number(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]), false, 'd-mon-yyyy');
  }
  m = raw.match(/^([a-zA-Z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return finish(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]), false, 'mon-d-yyyy');
  }

  return null;
}

function finish(year, month, day, ambiguous, assumedFormat) {
  if (!year || !month || !day) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  // Reject impossible dates like 31/02 by round-tripping.
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== day || d.getUTCMonth() + 1 !== month) {
    return null;
  }
  return { iso, ambiguous, assumedFormat };
}

/** ISO -> the mm/dd/yyyy string SupplyNote's datepicker wants. */
export function toUsDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

/** ISO -> dd/mm/yyyy for human display to an Indian ops team. */
export function toDisplayDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Pass-through for already-ISO input; used by ledgerKey. */
export function toIsoDate(iso) {
  return iso;
}

/** Human-friendly weekday, handy when sanity-checking delivery slots. */
export function weekday(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}
