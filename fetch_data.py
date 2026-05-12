#!/usr/bin/env python3
"""
Valuatio bulk data fetcher.

Pulls all FMP profile + quote data for a list of tickers and writes a single CSV
to data/master.csv. Designed to run nightly via GitHub Actions — completely free,
unlimited fetches per day (GitHub gives 2000 free CI minutes/month).

Reads tickers from data/tickers.txt (one ticker per line).
Reads FMP_API_KEY from environment variable (set in repo Settings → Secrets).
"""

import csv
import json
import os
import sys
import time
from pathlib import Path
from urllib import request, error
from urllib.parse import quote

ROOT = Path(__file__).parent
TICKERS_FILE = ROOT / "data" / "tickers.txt"
OUTPUT_CSV = ROOT / "data" / "master.csv"
OUTPUT_JSON = ROOT / "data" / "master.json"

# FMP /quote endpoint accepts up to ~100 comma-separated symbols per call.
# This is the secret to staying under 250/day even for thousands of tickers:
# 1000 tickers = 10 calls instead of 1000.
BATCH_SIZE = 100

# Polite rate limit between batches (FMP free tier is 250/day total — these
# batches help us stay well under)
BATCH_DELAY_SEC = 1.0

# Profile endpoint must be called one ticker at a time on free tier.
# Don't refresh profile every run — it's stable data. Use --full to force.
PROFILE_REFRESH_DAYS = 30


def log(*args):
    print("[fetch_data]", *args, flush=True)


def fetch_json(url, timeout=30):
    """Fetch JSON from URL with proper error handling."""
    req = request.Request(url, headers={"User-Agent": "Valuatio/1.0"})
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                log(f"  HTTP {resp.status} for {url[:80]}")
                return None
            return json.loads(resp.read())
    except error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        log(f"  HTTP {e.code}: {body}")
        return None
    except (error.URLError, json.JSONDecodeError, TimeoutError) as e:
        log(f"  Fetch error: {e}")
        return None


def load_tickers():
    """Read tickers from data/tickers.txt, one per line."""
    if not TICKERS_FILE.exists():
        log(f"❌ {TICKERS_FILE} not found")
        log("   Create it with one ticker per line:")
        log("     AAPL")
        log("     MSFT")
        log("     NVDA")
        sys.exit(1)
    tickers = []
    for line in TICKERS_FILE.read_text().splitlines():
        t = line.strip().upper()
        # Skip blanks and comments
        if not t or t.startswith("#"):
            continue
        tickers.append(t)
    return tickers


def load_existing():
    """Load existing CSV so we can preserve fields we don't refresh every run."""
    if not OUTPUT_CSV.exists():
        return {}
    existing = {}
    with OUTPUT_CSV.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            tic = row.get("ticker", "").strip().upper()
            if tic:
                existing[tic] = row
    return existing


def fetch_batch_quotes(tickers, api_key):
    """Fetch live quotes for a batch of tickers in ONE API call.
    Returns dict: {ticker: quote_dict}
    """
    if not tickers:
        return {}
    symbols = ",".join(tickers)
    url = f"https://financialmodelingprep.com/stable/batch-quote?symbols={quote(symbols)}&apikey={api_key}"
    data = fetch_json(url)
    if not isinstance(data, list):
        return {}
    return {item["symbol"]: item for item in data if "symbol" in item}


def fetch_profile(ticker, api_key):
    """Fetch full company profile (one ticker = one call). Used sparingly."""
    url = f"https://financialmodelingprep.com/stable/profile?symbol={quote(ticker)}&apikey={api_key}"
    data = fetch_json(url)
    if isinstance(data, list) and data:
        return data[0]
    if isinstance(data, dict) and "symbol" in data:
        return data
    return None


def should_refresh_profile(existing_row):
    """True if the profile is stale or missing."""
    if not existing_row:
        return True
    last = existing_row.get("profile_fetched_at", "")
    if not last:
        return True
    try:
        from datetime import datetime, timezone
        last_dt = datetime.fromisoformat(last)
        age_days = (datetime.now(timezone.utc).replace(tzinfo=None) - last_dt).days
        return age_days >= PROFILE_REFRESH_DAYS
    except (ValueError, TypeError):
        return True


# Columns matching the Valuatio app's expected schema
OUTPUT_COLUMNS = [
    "ticker",
    "name",
    "price",
    "marketcap",
    "volume",
    "volumeavg",
    "priceopen",
    "low",
    "high",
    "close",
    "change",
    "changepct",
    "closeyest",
    "date",
    "high52",
    "low52",
    "beta",
    "shares",
    "pe",
    "eps",
    "sector",
    "industry",
    "description",
    "exchange",
    "ceo",
    "country",
    "ipodate",
    "isEtf",
    "isFund",
    "isActive",
    "web_url",
    "image",
    "currency",
    "employees",
    "city",
    "state",
    "phone",
    "address",
    "fetched_at",
    "profile_fetched_at",
]


def build_row(ticker, quote_data, profile_data, existing_row):
    """Merge quote + profile + existing into a single CSV row."""
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")

    # Start with whatever we had before so unchanged fields persist
    row = {col: (existing_row.get(col, "") if existing_row else "") for col in OUTPUT_COLUMNS}
    row["ticker"] = ticker

    if quote_data:
        # /stable/ endpoints use slightly different field names than /api/v3/.
        # Try both variants for each field so the script works on either tier.
        def g(*keys):
            for k in keys:
                if k in quote_data and quote_data[k] not in (None, ""):
                    return quote_data[k]
            return ""

        row["name"]       = g("name") or row["name"]
        row["price"]      = g("price")
        row["marketcap"]  = g("marketCap", "mktCap")
        row["volume"]     = g("volume")
        row["volumeavg"]  = g("avgVolume", "averageVolume")
        row["priceopen"]  = g("open")
        row["low"]        = g("dayLow", "low")
        row["high"]       = g("dayHigh", "high")
        row["close"]      = g("price", "close")
        row["change"]     = g("change")
        row["changepct"]  = g("changePercentage", "changesPercentage")
        row["closeyest"]  = g("previousClose")
        row["high52"]     = g("yearHigh")
        row["low52"]      = g("yearLow")
        row["pe"]         = g("pe", "priceEarningsRatio")
        row["eps"]        = g("eps")
        row["shares"]     = g("sharesOutstanding")
        row["fetched_at"] = now_iso
        ts = g("timestamp")
        if ts:
            try:
                row["date"] = datetime.utcfromtimestamp(int(ts)).date().isoformat()
            except (TypeError, ValueError):
                pass

    if profile_data:
        row["name"]        = profile_data.get("companyName", row.get("name", ""))
        row["sector"]      = profile_data.get("sector", "")
        row["industry"]    = profile_data.get("industry", "")
        row["description"] = (profile_data.get("description", "") or "")[:1000]
        row["exchange"]    = profile_data.get("exchangeShortName", profile_data.get("exchange", ""))
        row["ceo"]         = profile_data.get("ceo", "")
        row["country"]     = profile_data.get("country", "")
        row["ipodate"]     = profile_data.get("ipoDate", "")
        row["beta"]        = profile_data.get("beta", "")
        row["web_url"]     = profile_data.get("website", "")
        row["image"]       = profile_data.get("image", "")
        row["currency"]    = profile_data.get("currency", "")
        row["employees"]   = profile_data.get("fullTimeEmployees", "")
        row["city"]        = profile_data.get("city", "")
        row["state"]       = profile_data.get("state", "")
        row["phone"]       = profile_data.get("phone", "")
        row["address"]     = profile_data.get("address", "")
        row["isEtf"]       = "TRUE" if profile_data.get("isEtf") else "FALSE"
        row["isFund"]      = "TRUE" if profile_data.get("isFund") else "FALSE"
        row["isActive"]    = "TRUE" if profile_data.get("isActivelyTrading", True) else "FALSE"
        row["profile_fetched_at"] = now_iso

    return row


def main():
    api_key = os.environ.get("FMP_API_KEY", "").strip()
    if not api_key:
        log("❌ FMP_API_KEY environment variable not set")
        log("   Set it in your repo: Settings → Secrets and variables → Actions → New repository secret")
        sys.exit(1)

    force_full_refresh = "--full" in sys.argv

    tickers = load_tickers()
    log(f"Loaded {len(tickers)} tickers")

    existing = load_existing()
    log(f"Found {len(existing)} existing rows in master.csv")

    # ─── FETCH QUOTES IN BATCHES ───
    # Quote endpoint is bulk-friendly: 100 tickers per call.
    log(f"Fetching live quotes in batches of {BATCH_SIZE}…")
    all_quotes = {}
    batches = [tickers[i:i + BATCH_SIZE] for i in range(0, len(tickers), BATCH_SIZE)]
    for i, batch in enumerate(batches, 1):
        log(f"  Batch {i}/{len(batches)} ({len(batch)} tickers)")
        result = fetch_batch_quotes(batch, api_key)
        all_quotes.update(result)
        log(f"    Got {len(result)} quotes back")
        if i < len(batches):
            time.sleep(BATCH_DELAY_SEC)
    log(f"Total quotes fetched: {len(all_quotes)}")

    # ─── FETCH PROFILES (only stale ones) ───
    if force_full_refresh:
        profile_tickers = list(tickers)
        log(f"--full flag: refreshing ALL {len(profile_tickers)} profiles")
    else:
        profile_tickers = [t for t in tickers if should_refresh_profile(existing.get(t))]
        log(f"Profiles to refresh (stale or missing): {len(profile_tickers)}")
        log(f"Profiles cached + fresh: {len(tickers) - len(profile_tickers)}")

    new_profiles = {}
    daily_budget_remaining = 250 - len(batches) - 5  # leave room for retries
    if len(profile_tickers) > daily_budget_remaining:
        log(f"⚠ Capping profile refreshes at {daily_budget_remaining} to stay under daily quota")
        profile_tickers = profile_tickers[:daily_budget_remaining]

    for i, tic in enumerate(profile_tickers, 1):
        if i % 25 == 0:
            log(f"  Profile {i}/{len(profile_tickers)} (last: {tic})")
        p = fetch_profile(tic, api_key)
        if p:
            new_profiles[tic] = p
        # Light rate limit — be a good API citizen
        time.sleep(0.05)
    log(f"Profiles fetched: {len(new_profiles)}")

    # ─── BUILD ROWS ───
    rows = []
    for tic in tickers:
        quote_data = all_quotes.get(tic)
        # Profile: prefer fresh, fall back to existing (we'll preserve fields in build_row)
        profile_data = new_profiles.get(tic)
        existing_row = existing.get(tic)
        row = build_row(tic, quote_data, profile_data, existing_row)
        rows.append(row)

    # ─── WRITE CSV ───
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    log(f"✓ Wrote {len(rows)} rows to {OUTPUT_CSV}")

    # ─── ALSO WRITE JSON (smaller, faster for app to parse) ───
    # Drop empty values to keep file size down
    json_rows = []
    for row in rows:
        json_rows.append({k: v for k, v in row.items() if v not in ("", None)})
    OUTPUT_JSON.write_text(json.dumps(json_rows, indent=None, separators=(",", ":")))
    log(f"✓ Wrote {len(json_rows)} rows to {OUTPUT_JSON}")

    # ─── SUMMARY ───
    success_count = sum(1 for r in rows if r.get("price"))
    log(f"")
    log(f"Summary:")
    log(f"  Total tickers:     {len(rows)}")
    log(f"  With live price:   {success_count}")
    log(f"  Without price:     {len(rows) - success_count}")
    log(f"  Quote API calls:   {len(batches)}")
    log(f"  Profile API calls: {len(new_profiles)}")
    log(f"  Total API calls:   {len(batches) + len(new_profiles)} / 250 daily limit")


if __name__ == "__main__":
    main()
