#!/usr/bin/env python3
"""
Valuatio history fetcher — pulls 5-year daily price history per ticker.

Writes one file per ticker to data/history/{TICKER}.json. Each file is small
(~30 KB), and the app downloads only the ones it needs (lazy-load).

Schema per file:
{
  "ticker": "AAPL",
  "fetched_at": "2026-05-11T22:00:00",
  "start": "2020-05-11",
  "end":   "2026-05-09",
  "n":     1257,
  "data":  [
    {"date": "2020-05-11", "price": 79.81},
    {"date": "2020-05-12", "price": 77.85},
    ...
  ]
}

Designed to be smart about incremental updates: if a ticker already has a
history file with recent data, only fetches the latest bars and appends.
A full 5-year refresh only happens on first run or weekly --full passes.
"""

import json
import os
import sys
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

ROOT = Path(__file__).parent
TICKERS_FILE = ROOT / "data" / "tickers.txt"
HISTORY_DIR = ROOT / "data" / "history"

# Yahoo allows large batch downloads via yf.download(). 50 at a time is safe.
BATCH_SIZE = 50
DELAY_BETWEEN_BATCHES = 2.0

# How far back to fetch on a fresh ticker (no existing history file)
FULL_HISTORY_PERIOD = "5y"

# How many days of recent data to fetch on incremental update.
# 10 calendar days covers any reasonable gap including 3-day weekends.
INCREMENTAL_DAYS = 10


def log(*args):
    print("[fetch_history]", *args, flush=True)


def load_tickers():
    if not TICKERS_FILE.exists():
        log(f"❌ {TICKERS_FILE} not found")
        sys.exit(1)
    tickers = []
    for line in TICKERS_FILE.read_text().splitlines():
        t = line.strip().upper()
        if not t or t.startswith("#"):
            continue
        tickers.append(t)
    return tickers


def history_path(ticker):
    # Sanitize ticker for filesystem (^ and = are valid in some tickers)
    safe = ticker.replace("/", "_").replace("\\", "_")
    return HISTORY_DIR / f"{safe}.json"


def load_existing_history(ticker):
    p = history_path(ticker)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def save_history(ticker, data_points):
    """Write a ticker's history file. data_points is a sorted list of {date, price}."""
    if not data_points:
        return False
    p = history_path(ticker)
    p.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ticker": ticker,
        "fetched_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds"),
        "start": data_points[0]["date"],
        "end": data_points[-1]["date"],
        "n": len(data_points),
        "data": data_points,
    }
    # Compact JSON to keep file size small
    p.write_text(json.dumps(record, separators=(",", ":")))
    return True


def yf_history_to_points(df, ticker):
    """Convert a yfinance DataFrame slice for one ticker to [{date, price}].
    Uses adjusted close so splits/dividends are normalized.
    """
    points = []
    if df is None or df.empty:
        return points

    # For multi-ticker downloads, columns are tuples (field, ticker) — use the slice
    # For single-ticker, columns are (field,) — handle both
    if hasattr(df.columns, "levels") and len(df.columns.levels) > 1:
        # MultiIndex columns from yf.download(group_by='ticker' or default)
        try:
            close_series = df["Close"][ticker] if ticker in df["Close"].columns else None
        except (KeyError, AttributeError):
            close_series = None
    else:
        close_series = df.get("Close") if "Close" in df.columns else None

    if close_series is None or close_series.empty:
        return points

    for date_idx, val in close_series.items():
        # val may be NaN on non-trading days that slipped through
        if val is None:
            continue
        try:
            v = float(val)
        except (TypeError, ValueError):
            continue
        # NaN check
        if v != v or v <= 0:
            continue
        # date_idx is a pandas Timestamp
        date_str = date_idx.strftime("%Y-%m-%d") if hasattr(date_idx, "strftime") else str(date_idx)[:10]
        points.append({"date": date_str, "price": round(v, 4)})
    return points


def merge_history(existing_points, new_points):
    """Merge two sorted lists of {date, price}, deduping by date. Latest wins."""
    by_date = {p["date"]: p for p in (existing_points or [])}
    for p in new_points:
        by_date[p["date"]] = p
    return sorted(by_date.values(), key=lambda p: p["date"])


def fetch_full_batch(tickers):
    """Fetch full 5-year history for a list of tickers in one yf.download() call.
    Returns dict: {TICKER: [{date, price}, ...]}
    """
    if not tickers:
        return {}
    try:
        # auto_adjust=True returns split/dividend-adjusted prices (cleaner for analysis)
        # progress=False suppresses yfinance's noisy progress bars
        df = yf.download(
            tickers=" ".join(tickers),
            period=FULL_HISTORY_PERIOD,
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=True,
            group_by="column",
        )
    except Exception as e:
        log(f"  Batch download failed: {e}")
        return {}

    out = {}
    for t in tickers:
        out[t] = yf_history_to_points(df, t)
    return out


def fetch_incremental_batch(tickers):
    """Fetch only recent bars for tickers that already have history.
    Same shape as fetch_full_batch.
    """
    if not tickers:
        return {}
    start_date = (datetime.now(timezone.utc) - timedelta(days=INCREMENTAL_DAYS)).date().isoformat()
    try:
        df = yf.download(
            tickers=" ".join(tickers),
            start=start_date,
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=True,
            group_by="column",
        )
    except Exception as e:
        log(f"  Incremental download failed: {e}")
        return {}
    out = {}
    for t in tickers:
        out[t] = yf_history_to_points(df, t)
    return out


def main():
    log("Valuatio history fetcher · yfinance edition")
    force_full = "--full" in sys.argv

    tickers = load_tickers()
    log(f"Loaded {len(tickers)} tickers")

    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    # Split tickers: those needing FULL history (new or --full) vs INCREMENTAL
    full_needed = []
    incremental_needed = []
    for t in tickers:
        existing = load_existing_history(t)
        if force_full or not existing or not existing.get("data"):
            full_needed.append(t)
        else:
            incremental_needed.append(t)
    log(f"  Full 5y refresh needed: {len(full_needed)}")
    log(f"  Incremental update:    {len(incremental_needed)}")

    success_count = 0
    failure_count = 0

    # ── Full refresh batches ──
    if full_needed:
        log(f"Fetching full 5-year history in batches of {BATCH_SIZE}…")
        batches = [full_needed[i:i + BATCH_SIZE] for i in range(0, len(full_needed), BATCH_SIZE)]
        for i, batch in enumerate(batches, 1):
            log(f"  Full batch {i}/{len(batches)} ({len(batch)} tickers)")
            results = fetch_full_batch(batch)
            for t in batch:
                points = results.get(t) or []
                if points:
                    if save_history(t, points):
                        success_count += 1
                else:
                    failure_count += 1
            if i < len(batches):
                time.sleep(DELAY_BETWEEN_BATCHES)

    # ── Incremental batches ──
    if incremental_needed:
        log(f"Fetching incremental updates in batches of {BATCH_SIZE}…")
        batches = [incremental_needed[i:i + BATCH_SIZE] for i in range(0, len(incremental_needed), BATCH_SIZE)]
        for i, batch in enumerate(batches, 1):
            log(f"  Incremental batch {i}/{len(batches)} ({len(batch)} tickers)")
            results = fetch_incremental_batch(batch)
            for t in batch:
                new_points = results.get(t) or []
                existing = load_existing_history(t)
                existing_points = existing.get("data", []) if existing else []
                if new_points:
                    merged = merge_history(existing_points, new_points)
                    if save_history(t, merged):
                        success_count += 1
                else:
                    # Keep the old file as-is; just count as no-update
                    pass
            if i < len(batches):
                time.sleep(DELAY_BETWEEN_BATCHES)

    # ── Manifest: tiny file listing every ticker that has a history file ──
    # Lets the app know which tickers have history available without HEAD requests.
    manifest = {
        "generated_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds"),
        "tickers": [],
    }
    for t in tickers:
        h = load_existing_history(t)
        if h and h.get("n", 0) > 0:
            manifest["tickers"].append({
                "ticker": t,
                "start": h.get("start"),
                "end": h.get("end"),
                "n": h.get("n"),
            })
    (ROOT / "data" / "history_manifest.json").write_text(
        json.dumps(manifest, separators=(",", ":"))
    )
    log(f"✓ Manifest written: {len(manifest['tickers'])} tickers have history")

    log("")
    log("Summary:")
    log(f"  Total tickers:       {len(tickers)}")
    log(f"  Updated this run:    {success_count}")
    log(f"  Failed this run:     {failure_count}")
    log(f"  Tickers with history: {len(manifest['tickers'])}")


if __name__ == "__main__":
    main()
