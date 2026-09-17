# Snacc PO Raising

Turns the shared forecasting spreadsheet into Purchase Orders on
[supplynote.in](https://www.supplynote.in) for Snacc outlets.

> ⚠️ **Read [SECURITY.md](SECURITY.md) first.** An earlier commit in this repository exposed a
> live SupplyNote password. It has been removed from the working tree but **still exists in git
> history**, so it must be treated as compromised and rotated.

---

## Which one should I use?

### 👉 Use the Chrome extension — [`extension/`](extension/)

This is what the team should be running. Load it once, and every day: paste the sheet link,
review the checks, press Start.

- **No install beyond the extension** — no Python, no ChromeDriver, no key file.
- **No stored credentials.** It uses your own Google and SupplyNote sessions, so orders are
  raised under your own account and there is nothing to leak.
- **Shows you the plan before submitting**, and blocks any PO with a problem.
- **Confirms each submission** and refuses to auto-retry an unconfirmed one, which is how
  vendors end up with duplicate orders.
- **Remembers what you've already raised**, so re-running the same sheet is safe.

Full guide: **[extension/README.md](extension/README.md)**

### The Python script — [`Raise_PO_bulk_final.py`](Raise_PO_bulk_final.py)

The original automation, kept working. Needs Python, ChromeDriver, a Google service-account
key, and a SupplyNote login supplied via environment variables (see `.env.example`). One
person runs it on one machine.

Prefer the extension unless you specifically need a headless or scheduled run.

### The notebook — [`Updated_script_to_raise_Purchase_Orders_latest.ipynb`](Updated_script_to_raise_Purchase_Orders_latest.ipynb)

The earlier approach, which added items to the order form one at a time instead of using bulk
CSV upload. Superseded by both of the above; kept for reference. Cells 0–1 are dead scratch
code.

---

## How the pipeline works

Both implementations do the same transformation:

1. Read the forecast (`PO_Status`) and join it against **Listed Pods** so only active outlets
   are ordered for.
2. Group into one PO per `(Vendor, Location, Date, Slot)`.
3. Join each group's SKUs against that vendor's tab in **Vendor_Wise_PO_Template** to pull the
   catalogue data SupplyNote's bulk upload requires — price, contract, units, conversion
   factors, tax — into a fixed 19-column CSV.
4. Raise the PO on SupplyNote via **Bulk Add**.

Step 3 is the part that actually matters: unit conversions and contract pricing mean nobody
can just copy `SKUcode, Quantity` across by hand.

---

## Development

```bash
cd extension
npm test                  # 61 unit tests
npm run test:parity       # diff the JS output against the original pandas pipeline
```

Open `extension/test/run.html` in Chrome to exercise the real page automation against a mock
order form. See the extension README for what those tests cover.

`tools/parity_check.py` is the guard on the migration: it runs the original pandas pipeline and
the extension's JavaScript pipeline over the same fixtures and diffs the resulting CSVs cell by
cell. On well-formed data the output must be byte-identical. On malformed data the differences
are intentional, and each one is asserted and documented in the output — the pandas version had
a cross-product bug that could double an order's quantity.

| Command | What it does |
|---|---|
| `make test` | unit tests |
| `make parity` | pandas-vs-JS output diff |
| `make zip` | build `snacc-po-raiser.zip` for distribution |
| `make icons` | regenerate the extension icons |

---

## Repository layout

```
extension/          Chrome extension — the thing the team uses
  README.md         install, daily use, troubleshooting, distribution
tools/              parity harness, fixtures, icon generator
SECURITY.md         the exposed credential, and what to do about it
.env.example        environment variables for the Python script
```
