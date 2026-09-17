/**
 * mock-app.js — simulates the SupplyNote order form's behaviour.
 *
 * The point is fidelity to the *irritating* details, not to the visual design:
 * suggestions only appear after an `input` event (so a naive `el.value = x`
 * fails), the file input is behind an `ng-hide` class until Bulk Add is
 * clicked, and Save & Send only produces a PO number once the grid has rows.
 *
 * Exposes window.__mock so run.html can assert on what happened.
 */
(() => {
  const VENDORS = ['Fresh Harvest Foods', 'Daily Dairy Co', 'Metro Beverages', 'Spice Route', 'Green Leaf Produce'];
  const PODS = ['Bagmane', 'Bagmane Phase 2', 'Embassy Manyata', 'Prestige Tech Park', 'Ecospace'];

  const state = {
    vendor: '',
    pod: '',
    billing: '',
    orderDate: '',
    expectedDate: '',
    lines: [],
    submitted: false,
    poNumber: null,
    events: [],
    // Flip these from a test to exercise failure paths.
    failUpload: false,
    failSubmit: false,
    dropLastLine: false
  };
  window.__mock = state;

  const log = (name, detail) => state.events.push({ name, detail, at: Date.now() });
  const $ = (s) => document.querySelector(s);
  const setEl = (sel, text) => { const n = $(sel); if (n) n.textContent = text; };

  /* ---------------- autocomplete ---------------- */

  function attachAutocomplete(input, options, onPick) {
    let list = null;

    const close = () => {
      if (list) { list.remove(); list = null; }
    };

    const open = (query) => {
      close();
      const q = String(query).trim().toLowerCase();
      if (!q) return;
      const matches = options.filter((o) => o.toLowerCase().includes(q));
      if (matches.length === 0) return;

      list = document.createElement('ul');
      list.className = 'md-autocomplete-suggestions';
      for (const m of matches) {
        const li = document.createElement('li');
        li.textContent = m;
        li.addEventListener('click', () => {
          input.value = m;
          log('autocomplete:pick', `${input.id} -> ${m}`);
          onPick?.(m);
          close();
        });
        list.append(li);
      }
      input.parentElement.append(list);
    };

    // Critically, the panel opens off the `input` event — assigning .value
    // directly would never trigger it. This is what makes naive automation fail.
    input.addEventListener('input', () => {
      log('autocomplete:input', `${input.id} = "${input.value}"`);
      open(input.value);
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }

  attachAutocomplete($('#input-18'), VENDORS, (v) => { state.vendor = v; });
  attachAutocomplete($('#input-21'), PODS, (v) => {
    state.pod = v;
    // The real form auto-fills billing from the delivery address sometimes.
    if (!$('#input-24').value) log('billing:auto-filled-by-page', v);
  });
  attachAutocomplete($('#input-24'), PODS, (v) => { state.billing = v; });

  /* ---------------- datepickers ---------------- */

  const dates = document.querySelectorAll('.md-datepicker-input');
  dates.forEach((d, i) => {
    d.addEventListener('input', () => {
      log(`date:${i}`, d.value);
      if (i === 0) state.orderDate = d.value;
      else state.expectedDate = d.value;
    });
    d.addEventListener('change', () => {
      if (i === 0) state.orderDate = d.value;
      else state.expectedDate = d.value;
    });
  });

  /* ---------------- bulk add / upload ---------------- */

  $('#bulkAdd').addEventListener('click', () => {
    log('bulkAdd:click', '');
    $('#fileInput').classList.remove('ng-hide');
    $('#uploadBtn').classList.remove('ng-hide');
  });

  $('#fileInput').addEventListener('change', () => {
    const file = $('#fileInput').files?.[0];
    log('file:change', file ? `${file.name} (${file.size} bytes)` : 'no file');
    state.attachedFile = file ? { name: file.name, size: file.size } : null;
  });

  $('#uploadBtn').addEventListener('click', async () => {
    log('upload:click', '');
    const file = $('#fileInput').files?.[0];
    if (!file) {
      setEl('#state', 'state: upload failed — no file attached');
      return;
    }
    if (state.failUpload) {
      setEl('#state', 'state: upload failed — simulated rejection');
      log('upload:rejected', 'simulated');
      return;
    }

    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      setEl('#state', 'state: upload failed — CSV has no data rows');
      return;
    }
    const headers = rows[0];
    const idx = (n) => headers.indexOf(n);

    let data = rows.slice(1);
    if (state.dropLastLine) data = data.slice(0, -1);

    state.lines = data.map((r) => ({
      sku: r[idx('skuProductCode')] ?? '',
      title: r[idx('productTitle')] ?? '',
      qty: r[idx('quantity')] ?? '',
      price: r[idx('price')] ?? ''
    }));

    const grid = $('#grid');
    grid.classList.remove('ng-hide');
    const tbody = grid.querySelector('tbody');
    tbody.innerHTML = '';
    state.lines.forEach((l, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td></td><td></td><td></td><td></td>`;
      tr.children[1].textContent = l.sku;
      tr.children[2].textContent = l.title;
      tr.children[3].textContent = l.qty;
      tr.children[4].textContent = l.price;
      tbody.append(tr);
    });

    setEl('#state', `state: ${state.lines.length} line(s) staged`);
    log('upload:complete', `${state.lines.length} lines`);
  });

  /* ---------------- submit ---------------- */

  $('#saveSend').addEventListener('click', () => {
    log('saveAndSend:click', '');
    if (state.failSubmit) {
      setEl('#state', 'state: submit rejected — simulated');
      return;
    }
    if (!state.vendor || !state.pod) {
      setEl('#state', 'state: submit rejected — vendor or delivery address missing');
      return;
    }
    if (state.lines.length === 0) {
      setEl('#state', 'state: submit rejected — no line items');
      return;
    }
    state.submitted = true;
    state.poNumber = `PO-${Math.floor(100000 + Math.random() * 899999)}`;

    const toast = document.createElement('md-toast');
    toast.className = 'md-toast-content';
    toast.textContent = `Purchase order created successfully. Order number ${state.poNumber}`;
    document.body.append(toast);

    setEl('#state', `state: submitted ${state.poNumber}`);
    log('submit:complete', state.poNumber);
  });

  /* ---------------- csv ---------------- */

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
        continue;
      }
      if (c === '"') { inQ = true; continue; }
      if (c === ',') { row.push(field); field = ''; continue; }
      if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
        continue;
      }
      field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  }

  log('page:ready', '');
})();
