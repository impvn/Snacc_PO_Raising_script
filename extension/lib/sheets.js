/**
 * sheets.js — reading shared Google Sheets using the *user's own* Google session.
 *
 * Design note: we deliberately avoid the OAuth / API-key route. The whole team
 * already has these spreadsheets shared with their Google accounts and is
 * already signed in to Google in this browser, so we can read the data with
 * plain credentialed HTTP. That means the zip we hand out needs no client ID,
 * no API key and no service-account JSON — it works the moment it is loaded.
 *
 * Three fetch strategies, tried in order:
 *   1. Direct fetch from the service worker with credentials: 'include'
 *      (works because we hold host_permissions for docs.google.com).
 *   2. Same request relayed through a background tab that is *on* google.com,
 *      so it is same-origin and guaranteed to carry session cookies.
 *   3. The Drive export endpoint, which is more forgiving about sheet
 *      visibility settings.
 */

const GVIZ_BASE = 'https://docs.google.com/spreadsheets/d';
const DRIVE_EXPORT = 'https://drive.google.com/spreadsheet/ccc';

/** Known shapes of a Google Sheets URL. */
const ID_PATTERNS = [
  /\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9-_]{20,})/,
  /[?&]key=([a-zA-Z0-9-_]{20,})/,
  /\/d\/([a-zA-Z0-9-_]{20,})/
];

/**
 * Pull the spreadsheet id out of any URL a user is likely to paste.
 * @param {string} url
 * @returns {string|null}
 */
export function extractSpreadsheetId(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return null;
  // A bare id is acceptable too.
  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;
  for (const re of ID_PATTERNS) {
    const m = raw.match(re);
    if (m) return m[1];
  }
  return null;
}

// gviz wraps its payload in a JSONP-ish envelope:
//     <slash><star>O_o<star><slash>
//     google.visualization.Query.setResponse({ ... });
// Strip everything before the first "{" and after the last "}".
function unwrapGvizJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('Unexpected response from Google (not JSON). You may be signed out of Google.');
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * List every tab in a spreadsheet, without downloading any of them.
 *
 * Primary route is the gviz metadata endpoint, which returns a `sig` array of
 * {name, id, index} for every sheet. If that shape is unavailable we fall back
 * to scraping the HTML viewer, which lists the tab names in its sheet picker.
 *
 * @param {string} spreadsheetId
 * @param {(url:string)=>Promise<string>} fetchText
 * @returns {Promise<Array<{name:string, id?:number, index:number}>>}
 */
export async function listTabs(spreadsheetId, fetchText) {
  const url = `${GVIZ_BASE}/${spreadsheetId}/gviz/tq?tqx=out:json`;
  let text;
  try {
    text = await fetchText(url);
  } catch (err) {
    const viaHtml = await listTabsFromHtmlView(spreadsheetId, fetchText);
    if (viaHtml.length > 0) return viaHtml;
    throw err;
  }

  // A signed-out or unshared sheet comes back as an HTML login page.
  if (/^\s*</.test(text)) {
    const viaHtml = await listTabsFromHtmlView(spreadsheetId, fetchText).catch(() => []);
    if (viaHtml.length > 0) return viaHtml;
    throw new Error(
      'Google returned a sign-in page. Make sure you are signed in to Google in this browser ' +
      'and that the spreadsheet is shared with your account.'
    );
  }

  const json = unwrapGvizJson(text);
  const sig = json?.table?.sig;
  if (!Array.isArray(sig) || sig.length === 0) {
    const viaHtml = await listTabsFromHtmlView(spreadsheetId, fetchText).catch(() => []);
    if (viaHtml.length > 0) return viaHtml;
    throw new Error('Could not read the tab list. Check the spreadsheet URL and your access to it.');
  }
  return sig.map((s) => ({ name: s.name, id: s.id, index: s.index }));
}

/**
 * Fallback: the HTML viewer embeds the sheet list as JSON-ish data in its
 * picker markup. We only get names this way (no numeric gid), which is enough
 * to read tabs by name via gviz — readTabCsv falls back to the name-based URL
 * when a gid is unknown.
 */
export async function listTabsFromHtmlView(spreadsheetId, fetchText) {
  const url = `${GVIZ_BASE}/${spreadsheetId}/htmlview`;
  const html = await fetchText(url);
  if (/^\s*</.test(html) && /Sign in|accounts\.google/i.test(html) && !/sheet-button/i.test(html)) {
    throw new Error('Google returned a sign-in page while listing tabs.');
  }

  return parseHtmlViewTabs(html);
}

/**
 * Pull tab names out of htmlview markup. Exported so it can be unit-tested
 * against both the old and new picker markup without a network call.
 */
export function parseHtmlViewTabs(html) {
  const names = new Set();

  // Newer markup: <div class="sheet-button" ...><span ...>Name</span>
  for (const m of String(html).matchAll(/sheet-button[^>]*>[\s\S]{0,400}?>([^<>]{1,120})</g)) {
    const name = decodeEntities(m[1]).trim();
    if (name) names.add(name);
  }
  // Older markup: <option value="gid">Name</option>
  for (const m of String(html).matchAll(/<option[^>]*>([^<>]{1,120})<\/option>/g)) {
    const name = decodeEntities(m[1]).trim();
    if (name) names.add(name);
  }

  return [...names].map((name, index) => ({ name, index }));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Build the CSV download URL for one tab. */
export function tabCsvUrl(spreadsheetId, tabName) {
  return (
    `${GVIZ_BASE}/${spreadsheetId}/gviz/tq?tqx=out:csv` +
    `&sheet=${encodeURIComponent(tabName)}`
  );
}

/**
 * Drive's export endpoint wants a numeric gid, not a tab name, so we resolve
 * the name -> gid mapping from listTabs() first. Returns null when the gid is
 * unknown, which makes readTabCsv fall back to the gviz URL.
 */
export function driveExportUrlForTab(spreadsheetId, tab) {
  if (!tab || tab.id === undefined || tab.id === null) return null;
  return `${DRIVE_EXPORT}?key=${spreadsheetId}&exportFormat=csv&gid=${tab.id}`;
}

/**
 * Read one tab as CSV text.
 *
 * @param {string} spreadsheetId
 * @param {{name:string, id?:number}} tab
 * @param {(url:string)=>Promise<string>} fetchText
 * @returns {Promise<string>}
 */
export async function readTabCsv(spreadsheetId, tab, fetchText) {
  const primary = tabCsvUrl(spreadsheetId, tab.name);
  try {
    const text = await fetchText(primary);
    assertNotHtml(text, tab.name);
    return text;
  } catch (err) {
    const fallback = driveExportUrlForTab(spreadsheetId, tab);
    if (!fallback) throw err;
    try {
      const text = await fetchText(fallback);
      assertNotHtml(text, tab.name);
      return text;
    } catch {
      // Re-throw the original, more informative error.
      throw err;
    }
  }
}

function assertNotHtml(text, tabName) {
  if (/^\s*</.test(text)) {
    throw new Error(
      `Google returned a sign-in page while reading "${tabName}". ` +
      `Sign in to Google in this browser and confirm the spreadsheet is shared with you.`
    );
  }
}
