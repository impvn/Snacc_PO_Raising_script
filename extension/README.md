# Snacc PO Raiser — Chrome extension

Raises bulk Purchase Orders on **supplynote.in** straight from the shared forecasting
spreadsheet, using **your own** SupplyNote and Google accounts.

This replaces `Raise_PO_bulk_final.py`, which only ran on one person's laptop, needed Python
and ChromeDriver installed, and had a shared password typed into the source code.

---

## Why this exists

Every day, someone had to turn a demand forecast into real purchase orders: pick a vendor,
pick a pod, set a delivery date, then search and add 20–60 SKUs — and repeat that for every
vendor × outlet × date × slot combination. It was hours of clicking, and retyping quantities
by hand is how wrong amounts reach real suppliers.

The extension does the whole batch for you. You review the plan, press **Start**, and watch.

**It does not decide what to order.** Quantities come from the spreadsheet exactly as they do
today. The extension only handles the last mile: turning that forecast into placed orders.

---

## What makes it different from the Python script

| | Python script | This extension |
|---|---|---|
| Install | Python, pip, ChromeDriver, a key file | Load a folder, or one click |
| SupplyNote login | Shared password in the source code | **Your own session** — nothing stored |
| Google Sheets | `service-key.json` service account | **Your own Google login** — nothing stored |
| Who can run it | Whoever owns that laptop | Anyone on the team |
| Before submitting | Nothing | A checks screen listing every PO |
| After submitting | Assumed success if the click didn't throw | **Reads the confirmation**; unconfirmed POs are flagged, never retried |
| Raising the same PO twice | Possible | Blocked by a local history ledger |
| Retries | Unbounded loop | Capped, with backoff, and it stops if failures repeat |

---

## Install (2 minutes, once)

1. Get the `snacc-po-raiser` folder (unzip it somewhere permanent — **don't** leave it in
   Downloads, and don't delete it afterwards).
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `snacc-po-raiser` folder.
5. Pin the extension: puzzle-piece icon in the toolbar → pin **Snacc PO Raiser**.

> Chrome may show *"Turn off developer mode extensions"* on startup. Click the ✕, not
> "Remove" — your extensions keep working.

**Before your first run**, also sign in to both of these in the same Chrome profile:

- `https://www.supplynote.in/signin`
- `https://docs.google.com` (your normal Google account)

The extension borrows those sessions. It never asks for, sees, or stores a password.

---

## Use (daily, ~2 minutes)

Click the toolbar icon. The panel opens on the right of your screen and walks you through
four steps.

### 1 · Connect
Paste the two spreadsheet links and press **Connect**.

- **Forecast spreadsheet** — the one with `PO_Status` and `Listed Pods`
- **Vendor template spreadsheet** — one tab per vendor with the SupplyNote catalogue columns
  (leave blank if those tabs live in the forecast spreadsheet)

Your links are saved, so after the first day this step is just a glance.

Then pick which tab holds the forecast, and optionally narrow the run — by vendor, location,
slot or delivery date. Leave the filters empty to raise everything.

Press **Check login** to confirm SupplyNote is signed in and the order form looks the way the
extension expects.

### 2 · Checks
Press **Run checks**. This reads the sheets and validates every PO *before* anything is sent.

You'll see a summary — how many POs, how many line items, how many vendors, estimated value —
and a list of findings. Anything red **blocks** that PO and must be fixed in the sheet:

| Finding | What it means |
|---|---|
| SKU not in the vendor's catalogue | It can't be priced, so it would be silently dropped |
| Invalid quantity | Blank, zero, negative or text in the Quantity column |
| Delivery date in the past | SupplyNote will reject it, or accept it for the wrong day |
| Vendor tab missing | Nobody has added that vendor to the template spreadsheet |
| Required columns missing | The vendor's tab doesn't match the bulk-upload format |
| Already raised | **You** submitted this exact PO before — see below |

Amber items are warnings, not blockers: below minimum order quantity, an ambiguous date like
`05/04/2025` (day ≤ 12), a same-day delivery, a repeated SKU.

Expand any PO to see its lines and the exact CSV that will be uploaded. **Download CSVs**
saves all of them to `Downloads/snacc-po/` if you want to eyeball them first.

### 3 · Run
Tick the POs you want (all are ticked by default) and press **Start**.

You'll get a confirmation dialog repeating the count and estimated value. Then the panel shows
live progress — which vendor, which step, which PO number came back.

**Do a Dry run first.** It fills the entire form on SupplyNote — vendor, pod, date, uploaded
lines — and then *stops without clicking Save & Send*, so you can look at the real form and
check it against the sheet. Nothing is submitted. Do this the first time you use the
extension, and any time the sheet structure changes.

You can **Stop** at any point. It finishes the PO in flight and then halts; it never abandons a
half-filled form.

### 4 · History
Every PO this browser submitted, with its PO number and timestamp.

This is the duplicate guard. If a PO is in here, the Checks step marks it *Already raised* and
skips it — so re-running the same sheet on the same day won't send vendors a second order.
**Forget** removes one entry if you genuinely need to re-raise it.

---

## "Already raised" — read this

The history is stored **in your browser**, not in the spreadsheet. That's deliberate: each
person raises their own POs under their own SupplyNote account, so a local record is the right
scope, and it means nobody needs write access to a shared log.

Two consequences worth knowing:

- If you clear your browser data, or run from a different machine or Chrome profile, the
  extension won't know what you already raised. Check the Orders list on SupplyNote if unsure.
- Two people running the same sheet **will** raise the same POs twice. Split the work by
  vendor or location using the filters in step 1.

---

## When SupplyNote changes their website

The extension finds things on the page by their label and placeholder, which survives most
redesigns. If a run starts failing with *"Timed out waiting for…"* or *"was not offered by
SupplyNote"*, it usually means a field moved.

You can fix this yourself, without a new version of the extension:

1. Open the panel → **⚙ Settings** → **Inspect page**.
2. The extension opens SupplyNote and lists every input and button it can see, with a
   ready-made selector next to each.
3. **Copy** the right one and paste it into the matching box under *Field selectors*. One
   selector per line — they're tried top to bottom, so put the most reliable first.
4. Run a **Dry run** to confirm.

Selector syntax:

```
text=Save and Send                    ← a button by its exact label (most durable)
text~=button|save                     ← a button whose label contains "save"
input[placeholder="e.g Bagmane"]      ← CSS
//button[.//span[text()='Upload']]    ← XPath
```

Tell the rest of the team what you changed, and send the selectors to whoever maintains the
extension so the next zip includes them.

---

## Troubleshooting

**"Google returned a sign-in page"**
You're signed out of Google in this browser, or the spreadsheet isn't shared with the account
you're signed into. Sign in at `docs.google.com`, confirm you can open both spreadsheets
yourself, then re-run Connect.

**"You are signed out of SupplyNote"**
Sign in at `supplynote.in`, then press **Check login** again.

**Every PO fails immediately**
Almost always a session or a selector problem. Run **Check login**, then a **Dry run**, then
**Inspect page**. The extension stops itself after 3 consecutive failures rather than
hammering the site.

**A PO is marked "unverified"**
Save & Send was clicked but no confirmation came back. **The order may or may not have gone
through.** Look it up in SupplyNote's order list before doing anything else. The extension
deliberately will *not* retry these automatically, because retrying an order that actually
succeeded is how vendors get duplicates. Once you've confirmed it didn't go through, press
**Forget** on it in History and re-run.

**Upload succeeded but "no line items appeared"**
The CSV was rejected by the site, so nothing was submitted. Check that the vendor's tab still
has all 19 required columns, and download the CSV to inspect it.

**The panel says a run was "interrupted"**
Chrome restarted or the tab was closed mid-run. Open **History** and check SupplyNote's order
list to see how far it got before running again — don't just restart it blind.

---

## Sharing a new version with the team

Zip the `extension/` folder and send it. Recipients:

1. Unzip over the **same folder** they loaded originally.
2. Go to `chrome://extensions` → find **Snacc PO Raiser** → click the ↻ **reload** icon.

Their settings and history are preserved — those live in Chrome, not in the folder.

If the team grows beyond a handful of people, or non-technical users start struggling with
Developer mode, ask IT about **force-installing** it through Chrome Browser Cloud Management,
or publish it to the Chrome Web Store as **unlisted** (one-click install, automatic updates,
$5 one-time fee). Both remove the manual reload step.

---

## What is in the box

```
extension/
├── manifest.json              MV3 manifest; permissions are the minimum needed
├── background/
│   ├── service-worker.js      message router; reads sheets, builds the plan
│   └── orchestrator.js        owns the automation tab, the run loop, retries
├── lib/
│   ├── csv.js                 RFC4180 parse/serialise
│   ├── dates.js               dd/mm/yyyy ↔ mm/dd/yyyy, ambiguity detection
│   ├── sheets.js              reads shared sheets via your Google session
│   ├── po-builder.js          the transformation (port of the Python join)
│   ├── validation.js          the Checks step
│   ├── ledger.js              duplicate-PO history
│   ├── selector-utils.js      locator strategy, unit-tested
│   └── defaults.js            every tunable, editable from Settings
├── content/
│   ├── relay.js               isolated-world message proxy (no logic)
│   └── bridge.js              MAIN-world automation; sees the page's Angular
├── sidepanel/                 the UI: HTML, CSS, JS
├── test/
│   ├── mock.html              a fake SupplyNote order form
│   ├── mock-app.js            its behaviour, including the awkward parts
│   └── run.html               5 end-to-end automation tests
├── tests/                     56 unit tests (node --test)
└── assets/                    icons
```

### How it talks to the page

A content script can't see the page's `window.angular`, and an injected page-level script
can't talk to Chrome. So there are two halves: `relay.js` (isolated world) forwards messages,
`bridge.js` (MAIN world) does the work. This is what lets the extension drive AngularJS
autocompletes properly instead of just typing into a box and hoping.

The whole per-PO sequence runs as **one** page-side command rather than a series of
round-trips, so Chrome evicting the background worker mid-order can't leave a form
half-filled.

### No backend, no keys

Because the sheets are shared with everyone and everyone is already signed in to Google and
SupplyNote in their own browser, the extension reads and writes using those existing
sessions. There is no server, no API key, no OAuth client to configure, and nothing to host.

---

## For whoever maintains this

```bash
cd extension
npm test                    # 56 unit tests
npm run test:parity         # diff the JS output against the original pandas pipeline
```

Open `extension/test/run.html` in Chrome (as a `chrome-extension://` URL) and press
**Run all tests** to exercise the real `bridge.js` against the mock order form. That covers:

1. happy path — full PO, submission confirmed with a PO number
2. unknown vendor — must fail loudly and **not** submit
3. dry run — fills everything, never clicks Save & Send
4. rejected upload — no line items appear, so nothing is submitted
5. short upload — fewer lines than the CSV had, so nothing is submitted

`tools/parity_check.py` is the important one. It runs the original pandas pipeline and the new
JavaScript pipeline over the same fixtures and diffs the CSVs cell by cell. On well-formed
data they must be **byte-identical**; on messy data the differences are intentional and each
one is documented in the output.

### Known limitations

- **The DOM automation has not been run against the live site in this repo's CI.** There is no
  browser available in the build environment, so `test/run.html` is verified against a mock
  that reproduces the page's behaviour, not the page itself. **Do a Dry run against the real
  SupplyNote before the first live run**, and expect to adjust one or two selectors.
- The history ledger is per-browser, not shared across the team.
- Reading sheets uses your Google session, so it is subject to Google's rate limits. A normal
  daily run is far below them; reading 40 vendor tabs repeatedly in a loop is not.
- If SupplyNote exposes an upload API, replacing `runPo`'s form-filling with a single
  authenticated `fetch` would remove every selector in this codebase. See `bridge.js` — the
  seam is already there. Worth asking their integrations team about; they already build
  connectors for Petpooja, Restroworks, Zoho and Tally.

### Permissions, and why

| Permission | Used for |
|---|---|
| `storage` | Your settings, the run state, the history ledger |
| `tabs` | Opening and driving the SupplyNote tab |
| `sidePanel` | The UI |
| `scripting` | Injecting `bridge.js` into the SupplyNote page |
| `alarms` | Keeping a long run alive; noticing an interrupted one |
| `downloads` | Saving the generated CSVs when you ask for them |
| host: `supplynote.in` | Automating the order form |
| host: `docs/drive.google.com` | Reading the shared spreadsheets |

No `<all_urls>`, no browsing history, nothing leaves your machine except requests to
SupplyNote and Google that you initiated.

---

## One thing to settle before you roll this out

Automating actions on SupplyNote — whether by Selenium or by an extension — may be against
their terms of service. The extension is less conspicuous than a WebDriver, but "less
conspicuous" is not "permitted".

Given that they already build integrations for Petpooja, LimeTray, Restroworks, Zoho, Tally
and UrbanPiper, the better move is to tell them what you're doing and ask. The best possible
outcome is that they hand you an upload endpoint, which turns this from reverse-engineering
into a supported integration — and lets you delete the most fragile part of the codebase.
