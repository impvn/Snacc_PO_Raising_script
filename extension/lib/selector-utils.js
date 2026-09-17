/**
 * selector-utils.js — locator strategy, as pure functions.
 *
 * The automation has to find elements on a page it does not control, using
 * selectors that an ops user can edit in Settings. Three syntaxes are
 * supported, tried in the order they are listed:
 *
 *   text=Save and Send                 exact visible label
 *   text~=button|Save and Send         substring label, scoped to a selector
 *   /html/body/.../button[2]/span      XPath (what the original script used)
 *   input[placeholder="e.g Bagmane"]   CSS
 *
 * Classifying the string is pure, so it lives here where it can be unit-tested
 * without a DOM. bridge.js keeps its own inline copy because it is injected
 * into the page as a standalone classic script.
 */

export const TEXT_EXACT_RE = /^text=(.+)$/i;
export const TEXT_SCOPED_RE = /^text~=\s*([^|]+)\|(.+)$/i;

export const SELECTOR_KIND = {
  text: 'text',
  textScoped: 'text-scoped',
  xpath: 'xpath',
  css: 'css',
  empty: 'empty'
};

/** Decide how a selector string should be evaluated. */
export function selectorKind(selector) {
  const s = String(selector ?? '').trim();
  if (!s) return SELECTOR_KIND.empty;
  if (TEXT_SCOPED_RE.test(s)) return SELECTOR_KIND.textScoped;
  if (TEXT_EXACT_RE.test(s)) return SELECTOR_KIND.text;
  if (looksLikeXPath(s)) return SELECTOR_KIND.xpath;
  return SELECTOR_KIND.css;
}

/**
 * True for XPath expressions.
 *
 * Detecting these matters: querySelectorAll throws on `/html/body/...`, and a
 * thrown error inside a fallback chain would look like "element not found"
 * rather than "bad selector".
 */
export function looksLikeXPath(selector) {
  const s = String(selector ?? '').trim();
  return s.startsWith('/') || s.startsWith('(') || /^\.\.?\//.test(s);
}

/**
 * Split a `text=` / `text~=` selector into its parts.
 *
 * @returns {{scope:string, wanted:string, exact:boolean}|null}
 */
export function parseTextSelector(selector) {
  const s = String(selector ?? '').trim();

  const scoped = s.match(TEXT_SCOPED_RE);
  if (scoped) {
    return {
      scope: scoped[1].trim(),
      wanted: normaliseLabel(scoped[2]),
      exact: false
    };
  }

  const exact = s.match(TEXT_EXACT_RE);
  if (exact) {
    return {
      scope: 'button, md-button, [role="button"], a, span',
      wanted: normaliseLabel(exact[1]),
      exact: true
    };
  }

  return null;
}

/** Collapse whitespace and lowercase, so "Save  and\nSend" matches "save and send". */
export function normaliseLabel(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Whether a candidate element's label satisfies a parsed text selector. */
export function labelMatches(elementText, parsed) {
  const actual = normaliseLabel(elementText);
  if (!actual) return false;
  return parsed.exact ? actual === parsed.wanted : actual.includes(parsed.wanted);
}

/**
 * Rank a discovered input's candidate selectors, best first.
 *
 * Order matters: an id is stable across redesigns, a placeholder is what the
 * current script relies on, and an auto-generated Angular Material id
 * (input-18, input-21) changes whenever the page gains a field — the notebook
 * used those, which is why it was so fragile.
 */
export function suggestSelectors(field) {
  const out = [];
  const model = field.ngModel || '';
  const placeholder = field.placeholder || '';
  const id = field.id || '';

  if (model) out.push(`input[ng-model="${model}"]`);
  if (placeholder) out.push(`input[placeholder="${placeholder}"]`);
  if (id && !/^input-\d+$/.test(id)) out.push(`#${id}`);
  if (field.name) out.push(`input[name="${field.name}"]`);
  // Deliberately last, and only when nothing better exists.
  if (out.length === 0 && id) out.push(`#${id}`);

  return [...new Set(out)];
}

/** Parse a Settings textarea (one selector per line) into a list. */
export function parseSelectorList(text) {
  return String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Render a list back into Settings textarea form. */
export function formatSelectorList(list) {
  return (Array.isArray(list) ? list : []).join('\n');
}
