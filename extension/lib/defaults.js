/**
 * defaults.js — every tunable in one place.
 *
 * These values are persisted to chrome.storage on first run and are editable
 * from Settings in the side panel. Nothing here is a secret; the point is that
 * when SupplyNote ships a frontend change, an ops user can re-point a selector
 * in the UI instead of the team waiting on a new zip.
 */

export const SUPPLYNOTE = {
  signInUrl: 'https://www.supplynote.in/signin',
  createOrderUrl: 'https://www.supplynote.in/orders/create'
};

/**
 * Default field/button selectors.
 *
 * Fields keep the locators used by Raise_PO_bulk_final.py. Buttons deliberately
 * prefer a `text=` label match over the original absolute XPath
 * (/html/body/md-content/.../button[2]/span), because a label survives a
 * redesign and a positional path does not. The XPath is kept as a fallback so
 * behaviour matches the old script if the wording ever changes.
 */
export const DEFAULT_SELECTORS = {
  vendor: ['input[placeholder="e.g Local Vendor"]'],
  pod: ['input[placeholder="e.g Bagmane"]'],
  billing: ['input[placeholder="e.g Bagmane"]'],
  suggestions: ['ul.md-autocomplete-suggestions li'],
  dateInputs: ['.md-datepicker-input'],
  bulkAddButton: [
    'text=Bulk Add',
    "//button[.//span[text()='Bulk Add']]"
  ],
  fileInput: ['#fileInput', 'input[type="file"]'],
  uploadButton: [
    'text=Upload',
    "//button[.//span[text()='Upload']]"
  ],
  submitButton: [
    'text=Save and Send',
    'text=Save & Send',
    "//button[.//span[contains(text(),'Save and Send')]]",
    "/html/body/md-content/section/ui-view/section/div/div/div/md-toolbar[2]/div/div[2]/button[2]/span"
  ],
  signedInProbe: ['#id_password'],
  confirmation: ['md-toast', '.md-toast-content', '[role="alert"]']
};

/** Delivery date field: index 0 = order date, index 1 = expected delivery. */
export const DEFAULT_DATE_INDEX = 1;

export const DEFAULT_TIMINGS = {
  pageLoadTimeoutMs: 25000,
  elementTimeoutMs: 20000,
  suggestionTimeoutMs: 10000,
  suggestionSettleMs: 900,
  afterSelectMs: 600,
  afterAttachMs: 1200,
  afterUploadMs: 2500,
  confirmationTimeoutMs: 12000,
  betweenPoMs: 1500
};

/** Retry policy — bounded, unlike the original `while len(failed) != 0`. */
export const DEFAULT_RETRY = {
  maxAttemptsPerPo: 2,
  backoffMs: [0, 4000, 15000],
  maxConsecutiveFailures: 3 // stop the run early rather than hammering the site
};

export const DEFAULT_SETTINGS = {
  // Spreadsheet wiring. Tab *names* are stored here; ids come from the URLs.
  forecastUrl: '',
  vendorTemplateUrl: '',
  forecastTab: '',
  podsTab: 'Listed Pods',
  // Vendors whose tabs live in the same spreadsheet as the forecast, if any.
  vendorTabsInForecastSheet: false,

  selectors: DEFAULT_SELECTORS,
  dateIndex: DEFAULT_DATE_INDEX,
  timings: DEFAULT_TIMINGS,
  retry: DEFAULT_RETRY,

  // Safety.
  dryRunFirstPo: true,       // stop after the first PO until the user confirms
  requireConfirmation: true, // show a summary and require an explicit Start
  skipAlreadyRaised: true,   // honour the duplicate ledger
  stopOnUnverified: false,   // halt if a submit cannot be confirmed
  maxPosPerRun: 200,

  // Filters applied before validation.
  filters: {
    vendors: [],   // empty = all
    locations: [],
    slots: [],
    dateFrom: '',  // ISO, inclusive
    dateTo: ''     // ISO, inclusive
  },

  automationTabUrl: 'https://www.supplynote.in/orders/create'
};

/** Deep-merge persisted settings over the defaults. */
export function withDefaults(stored) {
  const out = structuredClone(DEFAULT_SETTINGS);
  if (!stored) return out;
  for (const [key, value] of Object.entries(stored)) {
    if (value === undefined || value === null) continue;
    const base = out[key];
    if (isPlainObject(base) && isPlainObject(value)) {
      out[key] = { ...base, ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Convert a user-typed selector string (one per line) into an array. */
export function parseSelectorList(text) {
  return String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
