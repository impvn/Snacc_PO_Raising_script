#!/usr/bin/env python3
"""Parity check: does the extension's JS transform match the original Python?

This is the guard that matters most in the whole migration. The extension
re-implements `prepare_csv_files_from_sheets()` from Raise_PO_bulk_final.py in
JavaScript, and a silent difference here means a vendor receives a different
order than they do today.

The script builds the same DataFrames the original builds (from a JSON fixture
instead of gspread, but with object dtype, exactly as
`pd.DataFrame(sheet.get(...)[1:], columns=...)` produces), runs the original
pandas pipeline verbatim, then runs the JS pipeline over the same fixture and
diffs the resulting CSVs.

Part 1 asserts the two agree byte-for-byte on well-formed data.
Part 2 asserts that on malformed data the JS is *safe* — and documents each
place where it deliberately diverges from pandas, because pandas' behaviour on
those inputs is itself a bug that would over- or under-order.

    python3 tools/parity_check.py
"""

from __future__ import annotations

import csv
import io
import json
import os
import subprocess
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
RUNNER = os.path.join(HERE, "parity_run.mjs")

REQUIRED_COLUMNS = [
    "id", "priceContract", "minimumOrderQty", "skuProductCode", "category",
    "subCategory", "productTitle", "recommendedQty", "lastAuditedStock",
    "currentStock", "quantity", "baseUnit", "price", "conversion", "quantity2",
    "secondaryUnit", "secondaryUnitPrice", "discount", "tax",
]

failures: list[str] = []
notes: list[str] = []


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  \033[32mok\033[0m   {message}")
    else:
        print(f"  \033[31mFAIL\033[0m {message}")
        failures.append(message)


def note(message: str) -> None:
    notes.append(message)
    print(f"  \033[33mnote\033[0m {message}")


def to_dataframe(block: dict) -> pd.DataFrame:
    """Reproduce what the original does with gspread's list-of-lists."""
    return pd.DataFrame(block["rows"], columns=block["headers"], dtype=object)


def python_pipeline(fixture: dict) -> dict[str, str]:
    """Verbatim port of prepare_csv_files_from_sheets()'s pandas logic."""
    df = to_dataframe(fixture["forecast"])
    mapping_df = to_dataframe(fixture["pods"])
    vendors = {name: to_dataframe(b) for name, b in fixture.get("vendors", {}).items()}

    df = pd.merge(df, mapping_df, how="left", on="Location").dropna()
    grouped = dict(tuple(df.groupby(["Vendor", "Location", "Date", "Slot"])))

    out: dict[str, str] = {}
    for (vendor, location, date, slot), group_df in grouped.items():
        if vendor not in vendors:
            continue
        formatted_date = str(date).replace("-", "_").replace("/", "_")
        filename = f"{vendor}_{slot}_{location}_{formatted_date}.csv".replace(" ", "_")

        merged = pd.merge(
            group_df[["SKUcode", "Quantity"]],
            vendors[vendor],
            how="left",
            left_on="SKUcode",
            right_on="skuProductCode",
        )
        merged["quantity"] = merged["Quantity"]

        missing = [c for c in REQUIRED_COLUMNS if c not in merged.columns]
        if missing:
            continue

        buf = io.StringIO()
        merged[REQUIRED_COLUMNS].to_csv(buf, index=False)
        out[filename] = buf.getvalue()
    return out


def js_pipeline(fixture_path: str) -> list[dict]:
    result = subprocess.run(
        ["node", RUNNER, fixture_path],
        capture_output=True, text=True, check=True, cwd=REPO,
    )
    return json.loads(result.stdout)["pos"]


def parse_csv(text: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text)))


def compare(filename: str, expected: str, actual: str) -> None:
    exp_rows, act_rows = parse_csv(expected), parse_csv(actual)

    check(
        list(exp_rows[0].keys()) == list(act_rows[0].keys()) if exp_rows and act_rows else False,
        f"{filename}: column order identical ({len(REQUIRED_COLUMNS)} columns)",
    )
    check(
        len(exp_rows) == len(act_rows),
        f"{filename}: row count identical (pandas {len(exp_rows)}, js {len(act_rows)})",
    )

    differing = []
    for i, (e, a) in enumerate(zip(exp_rows, act_rows)):
        for col in REQUIRED_COLUMNS:
            ev, av = str(e.get(col, "")), str(a.get(col, ""))
            # pandas renders a NaN cell as an empty string; so do we.
            if ev == "nan":
                ev = ""
            if ev != av:
                differing.append(f"row {i + 1} [{col}]: pandas={ev!r} js={av!r}")

    check(
        not differing,
        f"{filename}: every cell byte-identical" + ("" if not differing else f" ({len(differing)} diffs)"),
    )
    for d in differing[:6]:
        print(f"         {d}")


def part1_clean() -> None:
    print("\n\033[1mPart 1 — well-formed data must match exactly\033[0m")
    path = os.path.join(HERE, "fixture_clean.json")
    fixture = json.load(open(path))

    expected = python_pipeline(fixture)
    actual_list = js_pipeline(path)
    actual = {po["filename"]: po["csv"] for po in actual_list if po["csv"]}

    check(
        set(expected) == set(actual),
        f"same set of {len(expected)} PO files generated",
    )
    if set(expected) != set(actual):
        print(f"         only in pandas: {sorted(set(expected) - set(actual))}")
        print(f"         only in js:     {sorted(set(actual) - set(expected))}")

    for filename in sorted(set(expected) & set(actual)):
        compare(filename, expected[filename], actual[filename])

    # The "Closed Pod" row must be filtered out by both implementations.
    check(
        not any("Closed_Pod" in f for f in actual),
        "rows for pods absent from Listed Pods are dropped by both",
    )
    check(
        not any("Ghost" in f for f in actual) and not any("Ghost" in f for f in expected),
        "a vendor with no catalogue tab is skipped by both",
    )


def part2_edge() -> None:
    print("\n\033[1mPart 2 — malformed data: the JS must be safe, not merely identical\033[0m")
    path = os.path.join(HERE, "fixture_edge.json")
    fixture = json.load(open(path))

    expected = python_pipeline(fixture)
    actual_list = js_pipeline(path)
    actual = {po["filename"]: po["csv"] for po in actual_list if po["csv"]}
    issues = {po["filename"]: po["issues"] for po in actual_list}

    filename = "Fresh_Harvest_Morning_Bagmane_15_04_2025.csv"
    check(filename in expected and filename in actual, "both produce the Bagmane PO file")

    py_rows = parse_csv(expected[filename])
    js_rows = parse_csv(actual[filename])

    check(
        len(py_rows) > len(js_rows),
        f"the same sheet yields {len(py_rows)} uploaded line(s) under pandas vs {len(js_rows)} under js",
    )
    # The unmatched SKU comes out of pandas as a row where every catalogue
    # column is blank and only `quantity` survives — a line SupplyNote cannot
    # price, identify or reject cleanly.
    blank_rows = [r for r in py_rows if not str(r.get("skuProductCode", "")).strip()]
    check(
        len(blank_rows) >= 1,
        f"pandas emits {len(blank_rows)} line(s) with no SKU, product or price at all",
    )
    check(
        not [r for r in js_rows if not str(r.get("skuProductCode", "")).strip()],
        "js emits no such line",
    )

    # --- duplicate forecast SKU -------------------------------------------
    # The fixture has SKU1001 twice in the forecast AND twice in the vendor
    # catalogue. pandas' merge is a cross-product, so it emits 2 x 2 = 4 lines
    # for one product — the vendor would be asked for 20kg when 10kg was
    # intended. Verified against the original pipeline output below.
    py_dupe = [r for r in py_rows if r["skuProductCode"] == "SKU1001"]
    py_qty_total = sum(int(float(r["quantity"])) for r in py_dupe)
    js_dupe = sum(1 for r in js_rows if r["skuProductCode"] == "SKU1001")
    js_qty = next((r["quantity"] for r in js_rows if r["skuProductCode"] == "SKU1001"), None)

    check(
        len(py_dupe) == 4 and py_qty_total == 20,
        f"pandas expands one SKU into {len(py_dupe)} lines totalling {py_qty_total} units "
        f"(forecast dupes x catalogue dupes) — the old behaviour",
    )
    check(js_dupe == 1, f"js emits {js_dupe} line for the same input")
    check(js_qty == "10", f"js sums the quantities to {js_qty} rather than inflating the order")
    check(
        any(i["code"] == "DUPLICATE_FORECAST_SKU" for i in issues[filename]),
        "js reports the merge to the operator instead of doing it silently",
    )
    note("DIVERGENCE (intended): pandas sent 4 lines / 20 units; js sends 1 line / 10 units and warns.")

    # --- duplicate catalogue row ------------------------------------------
    check(
        any(i["code"] == "DUPLICATE_VENDOR_SKUS" for i in issues[filename]),
        "js reports the duplicated row in the vendor catalogue",
    )
    note("DIVERGENCE (intended): a duplicated catalogue row doubles every matching order line in pandas.")

    # --- SKU missing from the catalogue -----------------------------------
    py_ghost = [r for r in py_rows if r["skuProductCode"] == ""]
    check(
        len(py_ghost) >= 1,
        f"pandas still emits the unmatched SKU as a row with {len(py_ghost)} blank catalogue field(s)",
    )
    check(
        not any(r["skuProductCode"] == "SKU404" or r.get("productTitle", "").strip() == "" for r in js_rows),
        "js does not emit a line with no product or price",
    )
    check(
        any(i["code"] == "SKU_NOT_IN_CATALOGUE" for i in issues[filename]),
        "js raises SKU_NOT_IN_CATALOGUE so the Checks step blocks the PO",
    )
    note("DIVERGENCE (intended): pandas would upload a line the platform cannot price.")

    # --- bad quantities ----------------------------------------------------
    check(
        not any(i["code"] == "BAD_QUANTITY" for i in issues[filename]) is False,
        "js flags the non-numeric and zero quantities",
    )
    check(
        not any(r["quantity"] in ("abc", "0", "0.0") for r in js_rows),
        "js never uploads a zero or non-numeric quantity",
    )
    note("DIVERGENCE (intended): pandas passed both straight through to the vendor.")

    # --- missing vendor tab ------------------------------------------------
    check(
        not any("Ghost_Vendor" in f for f in actual),
        "js skips the vendor with no catalogue tab",
    )
    check(
        any(
            po["vendor"] == "Ghost Vendor" and any(i["code"] == "NO_VENDOR_TAB" for i in po["issues"])
            for po in actual_list
        ),
        "js still reports that vendor as an error rather than dropping it silently",
    )


def main() -> int:
    print("\033[1mParity check: Raise_PO_bulk_final.py  vs  extension/lib\033[0m")
    try:
        part1_clean()
        part2_edge()
    except subprocess.CalledProcessError as err:
        print(f"\n\033[31mThe JS runner failed:\033[0m\n{err.stderr}")
        return 2

    print()
    if failures:
        print(f"\033[31m{len(failures)} check(s) failed.\033[0m")
        for f in failures:
            print(f"  - {f}")
        return 1

    print(f"\033[32mAll parity checks passed.\033[0m {len(notes)} intended divergence(s) documented:")
    for n in notes:
        print(f"  - {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
