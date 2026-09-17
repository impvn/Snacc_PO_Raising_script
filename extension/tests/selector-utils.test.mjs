/**
 * Unit tests for the locator strategy.
 *
 * These are pure string functions, so they run without a DOM. Element-level
 * behaviour (XPath evaluation, autocomplete, file attach) is covered by
 * extension/test/run.html, which needs a real browser.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectorKind, looksLikeXPath, parseTextSelector, labelMatches,
  normaliseLabel, suggestSelectors, parseSelectorList, formatSelectorList,
  SELECTOR_KIND
} from '../lib/selector-utils.js';

describe('selector classification', () => {
  test('recognises every supported syntax', () => {
    assert.equal(selectorKind('text=Save and Send'), SELECTOR_KIND.text);
    assert.equal(selectorKind('text~=button|Save'), SELECTOR_KIND.textScoped);
    assert.equal(selectorKind('/html/body/md-content/button[2]'), SELECTOR_KIND.xpath);
    assert.equal(selectorKind('//button[.//span[text()="Upload"]]'), SELECTOR_KIND.xpath);
    assert.equal(selectorKind('./div/span'), SELECTOR_KIND.xpath);
    assert.equal(selectorKind('(//div)[1]'), SELECTOR_KIND.xpath);
    assert.equal(selectorKind('input[placeholder="e.g Bagmane"]'), SELECTOR_KIND.css);
    assert.equal(selectorKind('#fileInput'), SELECTOR_KIND.css);
    assert.equal(selectorKind('ul.md-autocomplete-suggestions li'), SELECTOR_KIND.css);
    assert.equal(selectorKind(''), SELECTOR_KIND.empty);
    assert.equal(selectorKind(null), SELECTOR_KIND.empty);
  });

  test('does not mistake a CSS selector for XPath', () => {
    // A leading slash is the only reliable XPath signal; these must stay CSS.
    for (const css of ['div > span', '[role="button"]', '.md-datepicker-input', 'input[type="file"]']) {
      assert.equal(selectorKind(css), SELECTOR_KIND.css, css);
    }
  });

  test('the original script\'s absolute XPath is classified as XPath, not CSS', () => {
    const legacy =
      '/html/body/md-content/section/ui-view/section/div/div/div/md-toolbar[2]/div/div[2]/button[2]/span';
    assert.ok(looksLikeXPath(legacy));
    assert.equal(selectorKind(legacy), SELECTOR_KIND.xpath);
  });
});

describe('text selectors', () => {
  test('text= means an exact label match', () => {
    const p = parseTextSelector('text=Save and Send');
    assert.equal(p.wanted, 'save and send');
    assert.equal(p.exact, true);
    assert.match(p.scope, /button/);
  });

  test('text~= means a scoped substring match', () => {
    const p = parseTextSelector('text~=md-button|upload');
    assert.equal(p.scope, 'md-button');
    assert.equal(p.wanted, 'upload');
    assert.equal(p.exact, false);
  });

  test('collapses whitespace and case so labels match reliably', () => {
    const p = parseTextSelector('text=Save and Send');
    assert.ok(labelMatches('Save  and\nSend', p));
    assert.ok(labelMatches(' SAVE AND SEND ', p));
    assert.ok(!labelMatches('Save and Send for Approval', p), 'exact must not substring-match');
  });

  test('a substring selector does substring-match', () => {
    const p = parseTextSelector('text~=button|save');
    assert.ok(labelMatches('Save and Send', p));
    assert.ok(!labelMatches('Cancel', p));
  });

  test('an empty label never matches, so hidden buttons are skipped', () => {
    const p = parseTextSelector('text=Upload');
    assert.ok(!labelMatches('', p));
    assert.ok(!labelMatches('   ', p));
  });

  test('returns null for a non-text selector', () => {
    assert.equal(parseTextSelector('#fileInput'), null);
    assert.equal(parseTextSelector('/html/body'), null);
  });

  test('normaliseLabel is idempotent', () => {
    assert.equal(normaliseLabel(normaliseLabel('  A   B ')), 'a b');
  });
});

describe('selector suggestions from the page inspector', () => {
  test('prefers ng-model over a placeholder over an id', () => {
    const s = suggestSelectors({
      id: 'input-18', ngModel: 'vm.order.vendor', placeholder: 'e.g Local Vendor', name: ''
    });
    assert.deepEqual(s, [
      'input[ng-model="vm.order.vendor"]',
      'input[placeholder="e.g Local Vendor"]'
    ]);
  });

  test('never prefers an auto-generated Angular Material id', () => {
    // `input-18` / `input-21` are what the notebook pinned itself to; they
    // renumber whenever the page gains a field.
    const ranked = suggestSelectors({
      id: 'input-18', ngModel: 'vm.order.vendor', placeholder: 'e.g Local Vendor'
    });
    assert.ok(!ranked.includes('#input-18'), 'a generated id must not be offered when better options exist');
    assert.equal(ranked[0], 'input[ng-model="vm.order.vendor"]');
  });

  test('falls back to a generated id rather than suggesting nothing', () => {
    // Better to hand the user a working-but-fragile selector with a caveat than
    // an empty box.
    assert.deepEqual(
      suggestSelectors({ id: 'input-21', ngModel: '', placeholder: '', name: '' }),
      ['#input-21']
    );
  });

  test('a stable id is suggested normally', () => {
    assert.deepEqual(
      suggestSelectors({ id: 'real-id', ngModel: '', placeholder: '', name: '' }),
      ['#real-id']
    );
  });

  test('a stable id is suggested when there is nothing better', () => {
    const s = suggestSelectors({ id: 'fileInput', ngModel: '', placeholder: '', name: 'file' });
    assert.deepEqual(s, ['#fileInput', 'input[name="file"]']);
  });

  test('de-duplicates repeated suggestions', () => {
    const s = suggestSelectors({ id: 'x', ngModel: 'a.b', placeholder: '', name: '' });
    assert.equal(new Set(s).size, s.length);
  });
});

describe('settings round-trip', () => {
  test('a textarea becomes a clean list and back', () => {
    const text = 'text=Save and Send\n\n  #saveSend  \n//button[.//span[text()="Save"]]';
    const list = parseSelectorList(text);
    assert.deepEqual(list, [
      'text=Save and Send',
      '#saveSend',
      '//button[.//span[text()="Save"]]'
    ]);
    assert.equal(formatSelectorList(list), list.join('\n'));
  });

  test('empty input yields an empty list, not ["" ]', () => {
    assert.deepEqual(parseSelectorList(''), []);
    assert.deepEqual(parseSelectorList('\n\n'), []);
    assert.equal(formatSelectorList([]), '');
  });

  test('order is preserved, because order is the fallback chain', () => {
    const list = parseSelectorList('a\nb\nc');
    assert.deepEqual(list, ['a', 'b', 'c']);
  });
});
