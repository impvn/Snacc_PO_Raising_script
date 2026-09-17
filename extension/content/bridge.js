/**
 * bridge.js — runs in the MAIN world of the SupplyNote page.
 *
 * Why MAIN world: SupplyNote is an AngularJS 1.x + Angular Material app. To
 * make its autocompletes and datepickers behave, you cannot simply assign
 * `input.value` — Angular's ng-model never hears about it. You have to either
 * dispatch synthetic DOM events that Angular is listening for, or reach into
 * the Angular scope directly. Only the MAIN world can see `window.angular`.
 *
 * This file is injected with chrome.scripting.executeScript({world:'MAIN'}),
 * so it must be a classic script: no import/export.
 *
 * Commands arrive via window.postMessage from content/relay.js (isolated
 * world). Replies and progress events go back the same way.
 */
(() => {
  if (window.__snaccBridgeInstalled) return;
  window.__snaccBridgeInstalled = true;

  const NS = 'SNACC_PO';
  const VERSION = '1.0.0';

  // Commands posted before we finish installing are buffered, not dropped.
  const pending = [];
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ns !== NS || data.__dir !== 'cmd') return;
    pending.push(data);
  });

  /* ------------------------------------------------------------------ *
   * Small DOM helpers
   * ------------------------------------------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el) return false;
    if (el.disabled) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function toArray(v) {
    return Array.isArray(v) ? v : [v];
  }

  /** True for XPath expressions (the config mixes XPath and CSS on purpose). */
  function looksLikeXPath(sel) {
    const s = String(sel).trim();
    return s.startsWith('/') || s.startsWith('(') || /^\.\.?\//.test(s);
  }

  const TEXT_RE = /^text=(.+)$/i;
  const TEXT_IN_RE = /^text~=([^|]+)\|(.+)$/i;

  /**
   * Find clickables by their visible label.
   *
   * This is the most durable locator available on this page: SupplyNote's
   * buttons have no ids and the original script pinned Save & Send with an
   * absolute XPath (`/html/body/md-content/.../button[2]/span`) that breaks the
   * moment anyone edits the toolbar. A label survives that.
   *
   *   text=Save and Send            exact, case-insensitive, whitespace-collapsed
   *   text~=button|Save and Send    exact label, restricted to a css selector
   */
  function findByText(spec, root = document) {
    const scoped = spec.match(TEXT_IN_RE);
    const scopeSelector = scoped ? scoped[1].trim() : 'button, md-button, [role="button"], a, span';
    const wanted = (scoped ? scoped[2] : spec.replace(TEXT_RE, '$1')).trim().toLowerCase();
    // `text=`  -> exact label match (safer for Submit-style buttons)
    // `text~=` -> substring match, optionally scoped to a css selector
    const exact = !scoped && !/^text~=/i.test(spec);

    const out = [];
    let nodes;
    try {
      nodes = root.querySelectorAll(scopeSelector);
    } catch {
      return [];
    }
    for (const n of nodes) {
      const text = (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text) continue;
      if (exact ? text === wanted : text.includes(wanted)) out.push(n);
    }
    return out;
  }

  /**
   * Resolve one selector to nodes, supporting CSS, XPath and text= matchers.
   *
   * XPath matters here: SupplyNote's Save & Send button has no id or class, so
   * the original automation located it with an absolute path. querySelectorAll
   * cannot evaluate that, so we dispatch on the shape of the string.
   */
  function resolveSelector(sel, root = document) {
    const s = String(sel ?? '').trim();
    if (!s) return [];
    if (TEXT_IN_RE.test(s)) return findByText(s, root);
    if (TEXT_RE.test(s)) return findByText(s, root);
    if (looksLikeXPath(s)) {
      const out = [];
      try {
        const snap = document.evaluate(
          s,
          root,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i));
      } catch {
        return []; // tolerate a bad user-supplied selector
      }
      return out;
    }
    try {
      return [...root.querySelectorAll(s)];
    } catch {
      return [];
    }
  }

  function firstVisible(selectors, root = document) {
    for (const sel of toArray(selectors)) {
      for (const n of resolveSelector(sel, root)) if (isVisible(n)) return n;
    }
    return null;
  }

  function allVisible(selectors, root = document) {
    const out = [];
    const seen = new Set();
    for (const sel of toArray(selectors)) {
      for (const n of resolveSelector(sel, root)) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (isVisible(n)) out.push(n);
      }
    }
    return out;
  }

  async function waitFor(selectors, { timeout = 20000, root = document, all = false } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = all ? allVisible(selectors, root) : firstVisible(selectors, root);
      if (all ? found.length > 0 : found) return found;
      await sleep(100);
    }
    throw new Error(
      `Timed out after ${Math.round(timeout / 1000)}s waiting for: ${toArray(selectors).join(' | ')}`
    );
  }

  /** Walk up to find a human-readable label, for the field inspector. */
  function describeField(el) {
    let label = '';
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) label = l.textContent.trim();
    }
    if (!label) {
      const wrap = el.closest('md-input-container, .form-group, label, div');
      if (wrap) {
        const l = wrap.querySelector('label');
        if (l) label = l.textContent.trim();
      }
    }
    return {
      placeholder: el.getAttribute('placeholder') || '',
      ngModel: el.getAttribute('ng-model') || '',
      id: el.id || '',
      label,
      type: el.type || '',
      classes: (el.className || '').toString().slice(0, 120)
    };
  }

  /* ------------------------------------------------------------------ *
   * Angular-aware input
   * ------------------------------------------------------------------ */

  /** The page's AngularJS, if present. */
  function ng() {
    try {
      return window.angular || null;
    } catch {
      return null;
    }
  }

  /**
   * Set a text input's value so that AngularJS actually registers it.
   *
   * Three escalating strategies, because Angular Material's autocomplete
   * listens in slightly different ways across versions:
   *   1. focus + native value setter + input/change/keydown/keyup events
   *   2. $scope.$apply with ngModelController.$setViewValue
   *   3. direct $scope assignment on the ng-model path
   */
  function setNgValue(el, value) {
    el.focus();

    // Clear first — appending to an existing value breaks the autocomplete query.
    const proto = el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));

    if (setter) setter.call(el, value);
    else el.value = value;

    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));

    const angular = ng();
    if (angular) {
      try {
        const $el = angular.element(el);
        const ctrl = $el.controller('ngModel');
        const scope = $el.scope();
        if (ctrl && scope) {
          ctrl.$setViewValue(value);
          ctrl.$render?.();
          if (!scope.$$phase && !scope.$root?.$$phase) scope.$apply();
          return 'ngModelController';
        }
        const model = el.getAttribute('ng-model');
        if (scope && model) {
          scope.$eval(`${model} = ${JSON.stringify(value)}`);
          if (!scope.$$phase && !scope.$root?.$$phase) scope.$apply();
          return 'scope-eval';
        }
      } catch {
        // fall through — the DOM events above may already have been enough
      }
    }
    return 'dom-events';
  }

  /**
   * Type into an autocomplete and click the suggestion that matches.
   * Returns which suggestion was chosen, so the caller can verify.
   */
  async function chooseSuggestion(el, value, cfg) {
    setNgValue(el, value);
    await sleep(cfg.suggestionSettleMs ?? 900);

    const items = await waitFor(cfg.suggestionItem, {
      timeout: cfg.suggestionTimeoutMs ?? 10000
    }).catch(() => null);

    if (!items) return { chosen: null, reason: 'no-suggestions-appeared' };

    const list = allVisible(cfg.suggestionItem);
    const needle = String(value).trim().toLowerCase();

    // Exact match first, then substring — the Python used substring only, which
    // can pick "Bagmane Phase 2" when you asked for "Bagmane".
    let target = list.find((li) => li.textContent.trim().toLowerCase() === needle);
    if (!target) target = list.find((li) => li.textContent.trim().toLowerCase().includes(needle));
    if (!target) {
      return {
        chosen: null,
        reason: 'no-matching-suggestion',
        options: list.slice(0, 10).map((li) => li.textContent.trim())
      };
    }

    const chosenText = target.textContent.trim();
    clickRobust(target);
    await sleep(cfg.afterSelectMs ?? 600);
    return { chosen: chosenText };
  }

  /**
   * Click an element the way the Python did (JS click, which bypasses overlay
   * interception), with a real-click fallback and retries.
   */
  function clickRobust(el) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (el.disabled) continue;
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        // Prefer a genuine click so Angular's handlers see a trusted-ish event.
        el.click();
        return true;
      } catch {
        /* try JS click below */
      }
      try {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch {
        /* retry */
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Commands
   * ------------------------------------------------------------------ */

  const commands = {
    /** Liveness probe. */
    async ping() {
      return {
        pong: true,
        version: VERSION,
        url: location.href,
        title: document.title,
        angular: !!ng(),
        angularVersion: ng()?.version?.full ?? null,
        signedOut: /sign\s?in|login/i.test(document.title) || !!firstVisible(['#id_password'])
      };
    },

    /**
     * Enumerate candidate form fields so the user can map them in Settings.
     * This is the escape hatch when SupplyNote ships a frontend change: the
     * team can re-point a selector without anyone editing code.
     */
    async inspect() {
      const candidates = [
        'input[type="text"]',
        'input:not([type])',
        'input[type="search"]',
        'md-autocomplete input',
        '.md-datepicker-input'
      ];
      const seen = new Set();
      const fields = [];
      for (const el of allVisible(candidates)) {
        if (seen.has(el)) continue;
        seen.add(el);
        fields.push({ ...describeField(el), selectorSuggestions: buildSelectors(el) });
      }

      const buttons = [];
      for (const b of allVisible(['button', 'md-button', '[role="button"]']).slice(0, 60)) {
        const text = (b.textContent || '').trim().replace(/\s+/g, ' ');
        if (text) buttons.push({ text: text.slice(0, 60), classes: (b.className || '').toString().slice(0, 80) });
      }

      const dateInputs = allVisible(['.md-datepicker-input']).map((el, i) => ({
        index: i,
        ...describeField(el),
        value: el.value
      }));

      return { fields, buttons, dateInputs, url: location.href };
    },

    async fill({ selector, value, cfg }) {
      const el = await waitFor(selector, { timeout: cfg?.timeoutMs ?? 20000 });
      const how = setNgValue(el, value);
      return { ok: true, how, value };
    },

    async choose({ selector, value, cfg }) {
      const el = await waitFor(selector, { timeout: cfg?.timeoutMs ?? 20000 });
      const result = await chooseSuggestion(el, value, cfg ?? {});
      if (!result.chosen) {
        throw new Error(
          `Could not select "${value}"${result.options ? ` — saw: ${result.options.join(' / ')}` : ` (${result.reason})`}`
        );
      }
      return { ok: true, chosen: result.chosen };
    },

    async setDate({ index, value, selector, cfg }) {
      const inputs = await waitFor(selector ?? ['.md-datepicker-input'], {
        timeout: cfg?.timeoutMs ?? 20000,
        all: true
      });
      const el = inputs[index ?? 1];
      if (!el) {
        throw new Error(
          `Date field at index ${index ?? 1} not found (page exposes ${inputs.length}). ` +
          `Re-map it in Settings → Field selectors.`
        );
      }
      const how = setNgValue(el, value);
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      el.blur?.();
      return { ok: true, how, value, available: inputs.length };
    },

    /**
     * Diagnostic: confirm the hidden bulk-upload input is reachable.
     *
     * The real attach happens inside runPo, because revealing the input,
     * building the File and firing `change` have to be one uninterrupted
     * sequence — the page resets the field if anything re-renders in between.
     */
    async waitForHidden(selectors, timeout) {
      const el = await waitForHidden(selectors, timeout);
      return { ok: true, found: true, ...describeField(el) };
    },

    async click({ selector, cfg }) {
      const el = await waitFor(selector, { timeout: cfg?.timeoutMs ?? 20000 });
      const ok = clickRobust(el);
      if (!ok) throw new Error(`Element matched but could not be clicked: ${toArray(selector).join(' | ')}`);
      return { ok: true, text: (el.textContent || '').trim().slice(0, 60) };
    },

    /** Read back confirmation text / a PO number after Save & Send. */
    async readConfirmation({ cfg }) {
      const deadline = Date.now() + (cfg?.confirmationTimeoutMs ?? 12000);
      const patterns = [
        /PO\s*[-#]?\s*([A-Za-z0-9-]{4,})/i,
        /order\s*(?:id|number|no\.?)\s*[:#-]?\s*([A-Za-z0-9-]{4,})/i
      ];
      const toastSelectors = [
        'md-toast',
        '.md-toast-content',
        '[role="alert"]',
        '.toast',
        '.alert-success',
        'md-dialog'
      ];

      let lastText = '';
      while (Date.now() < deadline) {
        const nodes = allVisible(toastSelectors);
        for (const n of nodes) {
          const text = (n.textContent || '').trim().replace(/\s+/g, ' ');
          if (text) {
            lastText = text;
            for (const re of patterns) {
              const m = text.match(re);
              if (m) return { ok: true, poNumber: m[1], message: text, source: 'toast' };
            }
          }
        }
        // A URL change to /orders or /orders/<id> is also strong evidence.
        if (/\/orders(\/\d+)?$/.test(location.pathname) && !/\/orders\/create/.test(location.pathname)) {
          const m = location.pathname.match(/\/orders\/(\d+)/);
          return {
            ok: true,
            poNumber: m ? m[1] : null,
            message: lastText || 'Navigated away from the create-order page.',
            source: 'url'
          };
        }
        await sleep(400);
      }
      // No confirmation is NOT success — the Python assumed it was. Report it
      // as unverified so the ledger and UI can treat it honestly.
      return { ok: false, poNumber: null, message: lastText, source: 'none', unverified: true };
    },

    /**
     * Execute one complete Purchase Order, page-side.
     *
     * Doing the whole sequence in a single injected call rather than eight
     * round-trips through the service worker matters for two reasons: it keeps
     * the timing tight, and it means an MV3 service-worker eviction mid-PO
     * cannot leave the form half-filled.
     *
     * `skipSubmit` implements dry-run: everything is filled, the CSV is
     * attached, but Save & Send is never clicked, so a human can eyeball the
     * form before anything reaches a vendor.
     */
    async runPo({ po, selectors, timings, dateIndex, skipSubmit, onProgress }) {
      const S = selectors;
      const T = timings;
      const step = (name, detail) => onProgress?.(name, detail);

      if (!po?.vendor || !po?.location) throw new Error('PO is missing vendor or location.');
      if (!po?.csv) throw new Error('PO has no CSV content to upload.');

      step('vendor', `Selecting vendor "${po.vendor}"`);
      const vendorEl = await waitFor(S.vendor, { timeout: T.elementTimeoutMs });
      const vendorChoice = await chooseSuggestion(vendorEl, po.vendor, T);
      if (!vendorChoice.chosen) {
        throw new Error(
          `Vendor "${po.vendor}" was not offered by SupplyNote` +
          (vendorChoice.options ? ` — saw: ${vendorChoice.options.join(' / ')}` : '')
        );
      }
      step('vendor', `Matched "${vendorChoice.chosen}"`);
      await sleep(T.afterSelectMs ?? 500);

      step('pod', `Selecting delivery location "${po.location}"`);
      const podEl = await waitFor(S.pod, { timeout: T.elementTimeoutMs });
      const podChoice = await chooseSuggestion(podEl, po.location, T);
      if (!podChoice.chosen) {
        throw new Error(`Delivery location "${po.location}" was not offered — is this pod listed on your SupplyNote account?`);
      }
      step('pod', `Matched "${podChoice.chosen}"`);
      await sleep(T.afterSelectMs ?? 500);

      // Billing address: only if it is a *different* element from the delivery
      // field and is currently blank. Blindly filling it (as the original did)
      // can overwrite a correct value with a wrong one.
      step('billing', 'Checking billing address');
      try {
        const billingEl = firstVisible(S.billing);
        if (billingEl && billingEl !== podEl && !String(billingEl.value || '').trim()) {
          const b = await chooseSuggestion(billingEl, po.location, T);
          step('billing', b.chosen ? `Matched "${b.chosen}"` : 'No suggestion matched; left blank.');
        } else {
          step('billing', billingEl ? 'Already populated; left as-is.' : 'Field not present; skipped.');
        }
      } catch (e) {
        step('billing', `Skipped (${e.message})`);
      }

      step('date', `Setting delivery date to ${po.dateUs} (mm/dd/yyyy)`);
      const dateInputs = allVisible(S.dateInputs);
      const dateEl = dateInputs[dateIndex ?? 1];
      if (!dateEl) {
        throw new Error(
          `Expected a date field at index ${dateIndex ?? 1} but the page exposes ${dateInputs.length}. ` +
          `Re-map it in Settings.`
        );
      }
      setNgValue(dateEl, po.dateUs);
      dateEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      dateEl.blur?.();
      await sleep(T.afterSelectMs ?? 400);

      step('bulk', 'Opening Bulk Add');
      const bulk = await waitFor(S.bulkAddButton, { timeout: T.elementTimeoutMs });
      if (!clickRobust(bulk)) throw new Error('Bulk Add button matched but could not be clicked.');
      await sleep(700);

      step('file', `Attaching ${po.filename}`);
      const fileEl = await waitForHidden(S.fileInput, T.elementTimeoutMs);
      fileEl.classList.remove('ng-hide');
      fileEl.removeAttribute('hidden');
      if ((fileEl.getAttribute('style') || '').includes('display: none')) fileEl.style.display = '';

      const file = new File([po.csv], po.filename, { type: 'text/csv', lastModified: Date.now() });
      const dt = new DataTransfer();
      dt.items.add(file);
      Object.defineProperty(fileEl, 'files', { value: dt.files, writable: true, configurable: true });
      fileEl.dispatchEvent(new Event('change', { bubbles: true }));
      fileEl.dispatchEvent(new Event('input', { bubbles: true }));

      const angular = ng();
      if (angular) {
        try {
          const scope = angular.element(fileEl).scope();
          if (scope && !scope.$$phase && !scope.$root?.$$phase) scope.$apply();
        } catch {
          /* non-fatal */
        }
      }
      await sleep(T.afterAttachMs ?? 1200);
      if ((fileEl.files?.length ?? 0) === 0) {
        throw new Error('The CSV was attached but the page did not accept the file list.');
      }

      step('upload', 'Uploading');
      const upload = await waitFor(S.uploadButton, { timeout: T.elementTimeoutMs });
      if (!clickRobust(upload)) throw new Error('Upload button matched but could not be clicked.');
      await sleep(T.afterUploadMs ?? 2500);

      // Give the grid a moment, then confirm the lines actually landed. A
      // silently-empty upload is the worst outcome: Save & Send would create a
      // blank or partial PO.
      step('verify-lines', 'Checking the uploaded line items');
      const gridRows = allVisible([
        'table tbody tr',
        'md-table tbody tr',
        '[ng-repeat*="item"]',
        '[ng-repeat*="product"]'
      ]);
      const uploadedLines = gridRows.length;
      if (uploadedLines === 0) {
        throw new Error(
          'Upload completed but no line items appeared on the form. ' +
          'The vendor CSV may not match what SupplyNote expects — nothing was submitted.'
        );
      }
      if (po.expectedLines && uploadedLines < po.expectedLines) {
        throw new Error(
          `Upload produced ${uploadedLines} line(s) but the CSV contained ${po.expectedLines}. ` +
          'Refusing to submit a partial PO — nothing was submitted.'
        );
      }

      if (skipSubmit) {
        step('dry-run', 'Dry run: form filled and verified, Save & Send NOT clicked.');
        return { ok: true, dryRun: true, uploadedLines, steps: 'complete' };
      }

      step('submit', 'Clicking Save & Send');
      const submitEl = await waitFor(S.submitButton, { timeout: T.elementTimeoutMs });
      if (!clickRobust(submitEl)) throw new Error('Save & Send matched but could not be clicked.');

      // Do not report success here. Confirmation is read separately, after any
      // resulting navigation settles, by readConfirmation.
      step('submitted', 'Save & Send clicked; awaiting confirmation');
      return { ok: true, submitted: true, uploadedLines };
    },

    /** Dump the page for debugging a failure. */
    async debugSnapshot() {
      return {
        url: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || '').slice(0, 3000),
        visibleButtons: allVisible(['button']).slice(0, 30).map((b) => (b.textContent || '').trim()).filter(Boolean)
      };
    }
  };

  function waitForHidden(selectors, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const tick = () => {
        for (const sel of toArray(selectors)) {
          // Deliberately ignores visibility: the bulk-upload input is hidden
          // behind an `ng-hide` class until Bulk Add is clicked.
          const nodes = resolveSelector(sel);
          if (nodes.length > 0) return resolve(nodes[0]);
        }
        if (Date.now() > deadline) {
          return reject(new Error(`Hidden element not found: ${toArray(selectors).join(' | ')}`));
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /**
   * Suggest copy-pasteable selectors for the field inspector, most durable
   * first. Mirrors suggestSelectors() in lib/selector-utils.js, which is the
   * unit-tested copy of this ranking.
   *
   * An auto-generated Angular Material id (input-18, input-21) is offered only
   * as a last resort: it renumbers whenever the page gains a field, which is
   * exactly why the original notebook kept breaking.
   */
  function buildSelectors(el) {
    const out = [];
    const model = el.getAttribute('ng-model');
    const ph = el.getAttribute('placeholder');
    const id = el.id || '';
    const name = el.getAttribute('name');

    if (model) out.push(`input[ng-model="${model}"]`);
    if (ph) out.push(`input[placeholder="${ph}"]`);
    if (id && !/^input-\d+$/.test(id)) out.push(`#${id}`);
    if (name) out.push(`input[name="${name}"]`);
    if (out.length === 0 && id) out.push(`#${id}`);

    return [...new Set(out)];
  }

  /* ------------------------------------------------------------------ *
   * Message plumbing
   * ------------------------------------------------------------------ */

  function post(payload) {
    window.postMessage({ __ns: NS, __dir: 'res', ...payload }, '*');
  }

  async function handle(cmd) {
    const fn = commands[cmd.type];
    if (!fn) {
      post({ id: cmd.id, ok: false, error: `Unknown command: ${cmd.type}` });
      return;
    }
    try {
      // Commands may declare an `onProgress` parameter; give them a channel
      // that streams back through the relay without waiting for completion.
      const args = { ...(cmd.args || {}) };
      if (fn.length > 0 && /onProgress/.test(fn.toString())) {
        args.onProgress = (step, detail) =>
          post({ id: cmd.id, ok: true, progress: { step, detail, at: Date.now() }, partial: true });
      }
      const result = await fn(args);
      post({ id: cmd.id, ok: true, result });
    } catch (err) {
      post({ id: cmd.id, ok: false, error: String(err?.message || err) });
    }
  }

  // Drain anything that arrived during installation, then listen live.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ns !== NS || data.__dir !== 'cmd' || data.__consumed) return;
    data.__consumed = true;
    handle(data);
  });

  for (const cmd of pending.splice(0)) handle(cmd);

  post({ id: null, ok: true, result: { ready: true, version: VERSION }, broadcast: 'bridge-ready' });
})();
