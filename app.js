/* ============================================================
   VALUATIO — Stock Valuation Engine
   Implements: DCF, CAPM, Relative Valuation, Monte Carlo
   Per Damodaran framework (intrinsic + relative + risk-adjusted)
   ============================================================ */

// ---------- STATE ----------
const state = {
  stock: null,          // raw fetched data
  inputs: {},           // editable assumptions (drives all calcs)
  results: {},          // computed valuations
  mcResults: null,      // monte carlo array
};

// ---------- CONSTANTS (defaults from Damodaran's framework) ----------
const DEFAULTS = {
  riskFreeRate: 0.045,        // ~10Y Treasury (nominal), can be overridden
  expectedInflation: 0.025,   // long-run US CPI expectation
  matureERP: 0.055,           // mature market equity risk premium
  marginalTaxRate: 0.21,      // US corporate
  terminalGrowth: 0.025,      // ≤ risk-free rate per Damodaran
  highGrowthYears: 10,        // projection horizon (was 5; longer = more visible detail)
  defaultBeta: 1.0,
  granularity: 'annual',      // 'annual' or 'quarterly'
  displayMode: 'nominal',     // 'nominal' (future $) or 'real' (today's $)
};

// Country Risk Premium table (additive to mature ERP)
// Sourced conceptually from Damodaran's CRP methodology
const COUNTRY_RISK = {
  'United States': 0.0, 'USA': 0.0, 'US': 0.0,
  'United Kingdom': 0.005, 'UK': 0.005, 'Germany': 0.0, 'France': 0.005,
  'Japan': 0.005, 'Canada': 0.0, 'Australia': 0.0, 'Switzerland': 0.0,
  'China': 0.0125, 'India': 0.025, 'Brazil': 0.035, 'Mexico': 0.025,
  'Russia': 0.06, 'South Africa': 0.04, 'Turkey': 0.055, 'Argentina': 0.10,
  'Other Emerging': 0.03, 'Other Developed': 0.005,
};

// ---------- UI: SET UP CLOCK ----------
function tickClock() {
  const d = new Date();
  document.getElementById('clock').textContent =
    d.toISOString().slice(0,10) + ' · ' + d.toTimeString().slice(0,5);
}
tickClock();
setInterval(tickClock, 30000);

// ---------- DATA FETCHING ----------
// Strategy in 2026: Yahoo Finance's unofficial API now requires a session crumb
// that can't be obtained from the browser. CORS proxies are unreliable.
// We use Alpha Vantage (free, real CORS support, requires a free API key)
// with Stooq as a price-only fallback for users who haven't set up a key yet.
//
// Get a free Alpha Vantage key at https://www.alphavantage.co/support/#api-key
// Save it once via the "Set API Key" button in the app. It lives in localStorage.

const AV_KEY_STORAGE = 'valuatio.alphavantage.key';
const FINNHUB_KEY_STORAGE = 'valuatio.finnhub.key';
const FMP_KEY_STORAGE = 'valuatio.fmp.key';
const TWELVE_KEY_STORAGE = 'valuatio.twelvedata.key';
const SHEET_URL_STORAGE = 'valuatio.sheet.url';
const SOURCE_PREF_STORAGE = 'valuatio.source.preference';

function getApiKey() {
  return localStorage.getItem(AV_KEY_STORAGE) || '';
}
function setApiKey(k) {
  if (k) localStorage.setItem(AV_KEY_STORAGE, k.trim());
  else localStorage.removeItem(AV_KEY_STORAGE);
}
function getFinnhubKey() {
  return localStorage.getItem(FINNHUB_KEY_STORAGE) || '';
}
function setFinnhubKey(k) {
  if (k) localStorage.setItem(FINNHUB_KEY_STORAGE, k.trim());
  else localStorage.removeItem(FINNHUB_KEY_STORAGE);
}
function getFmpKey() { return localStorage.getItem(FMP_KEY_STORAGE) || ''; }
function setFmpKey(k) {
  if (k) localStorage.setItem(FMP_KEY_STORAGE, k.trim());
  else localStorage.removeItem(FMP_KEY_STORAGE);
}
function getTwelveKey() { return localStorage.getItem(TWELVE_KEY_STORAGE) || ''; }
function setTwelveKey(k) {
  if (k) localStorage.setItem(TWELVE_KEY_STORAGE, k.trim());
  else localStorage.removeItem(TWELVE_KEY_STORAGE);
}
function getSheetUrl() {
  return localStorage.getItem(SHEET_URL_STORAGE) || '';
}
function setSheetUrl(u) {
  if (u) localStorage.setItem(SHEET_URL_STORAGE, u.trim());
  else localStorage.removeItem(SHEET_URL_STORAGE);
}
// Multiple sheet URL support — newline-separated, stored in same key for backwards compat.
// First non-empty line is the "primary" URL (used for legacy single-URL code paths).
function getSheetUrls() {
  const raw = localStorage.getItem(SHEET_URL_STORAGE) || '';
  return raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
}
function setSheetUrls(urls) {
  const cleaned = (urls || []).map(s => (s || '').trim()).filter(s => s.length > 0);
  if (cleaned.length === 0) {
    localStorage.removeItem(SHEET_URL_STORAGE);
  } else {
    localStorage.setItem(SHEET_URL_STORAGE, cleaned.join('\n'));
  }
}
function getSourcePref() {
  return localStorage.getItem(SOURCE_PREF_STORAGE) || 'auto'; // 'sheet' | 'av' | 'auto'
}
function setSourcePref(p) {
  localStorage.setItem(SOURCE_PREF_STORAGE, p);
}

async function fetchStock(ticker) {
  ticker = ticker.toUpperCase().trim();
  if (!ticker) throw new Error('No ticker');

  const key = getApiKey();
  const sheetUrl = getSheetUrl();
  const sourcePref = getSourcePref(); // 'sheet' | 'av' | 'auto'

  // Decide which sources to fire based on user preference
  const useSheet = sheetUrl && (sourcePref === 'sheet' || sourcePref === 'auto');
  const useAV = key && (sourcePref === 'av' || sourcePref === 'auto');

  const tasks = [
    fetchStooqPrice(ticker),
    fetchYahooQuote(ticker),
  ];
  if (useSheet) tasks.push(fetchSheetData());
  if (useAV) {
    tasks.push(fetchAlphaVantageOverview(ticker, key));
    tasks.push(fetchAlphaVantageIncomeStatement(ticker, key));
    tasks.push(fetchAlphaVantageCashFlow(ticker, key));
    tasks.push(fetchAlphaVantageBalanceSheet(ticker, key));
  }

  const results = await Promise.allSettled(tasks);
  let idx = 0;
  const stooqRes = results[idx++];
  const yahooQuoteRes = results[idx++];
  const sheetRes = useSheet ? results[idx++] : null;
  const overviewRes = useAV ? results[idx++] : null;
  const incomeRes = useAV ? results[idx++] : null;
  const cashRes = useAV ? results[idx++] : null;
  const balanceRes = useAV ? results[idx++] : null;

  const sheet = sheetRes?.status === 'fulfilled' ? sheetRes.value : null;

  const envelope = {
    ticker,
    stooq: stooqRes?.status === 'fulfilled' ? stooqRes.value : null,
    yahooQuote: yahooQuoteRes?.status === 'fulfilled' ? yahooQuoteRes.value : null,
    overview: overviewRes?.status === 'fulfilled' ? overviewRes.value : null,
    income: incomeRes?.status === 'fulfilled' ? incomeRes.value : null,
    cash: cashRes?.status === 'fulfilled' ? cashRes.value : null,
    balance: balanceRes?.status === 'fulfilled' ? balanceRes.value : null,
    sheet,
    sheetRow: sheet ? findSheetRow(sheet, ticker) : null,
    sourcePref,
    hasKey: !!key,
    hasSheet: !!sheetUrl,
  };

  if (!envelope.stooq && !envelope.yahooQuote && !envelope.overview && !envelope.sheetRow) {
    if (!key && !sheetUrl) throw new Error('No data source set. Click "Sources" or enter values manually.');
    throw new Error('All data sources failed. Check your config or enter values manually.');
  }

  return envelope;
}

// ----- Google Sheets CSV fetcher (multi-tab aware) -----
//
// Accepts any of these URL forms and converts to CSV:
//   - .../pubhtml or .../pubhtml?gid=N (published web page, single or multi-tab)
//   - .../pub?output=csv or .../pub?gid=N&output=csv
//   - .../edit#gid=N
//   - .../export?format=csv&gid=N
//
// For multi-tab sheets, we discover all gids from the pubhtml page and fetch each.

// Fetch a single sheet URL. Returns the same shape as before.
async function fetchSheetDataSingle(url) {
  if (!url) return null;

  // Step 1: extract the document key (always present in any of these URL forms)
  // /d/<long-key>/  OR  /d/e/<published-key>/
  const keyMatch = url.match(/\/d\/(?:e\/)?([a-zA-Z0-9_-]+)/);
  if (!keyMatch) throw new Error('Could not parse sheet URL');
  const isPublished = url.includes('/d/e/');
  const docKey = keyMatch[1];

  // Step 2: discover tab gids
  // For /pubhtml URLs, we fetch the HTML and extract gids from the tab list.
  // For /edit URLs we can only see one gid; for direct CSV URLs we use only that gid.
  let gids = [];

  // Pull gid from URL if explicitly given
  const explicitGid = (url.match(/[?&#]gid=(\d+)/) || [])[1];
  if (explicitGid) gids.push(explicitGid);

  // For pubhtml, scrape the tab list to find ALL gids
  if (url.includes('/pubhtml')) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const html = await r.text();
        // Tabs in pubhtml have anchors like <a href="#sheet=Sheet2&amp;gid=12345">
        const re = /[?&]gid=(\d+)/g;
        let m;
        while ((m = re.exec(html)) !== null) {
          if (!gids.includes(m[1])) gids.push(m[1]);
        }
      }
    } catch {}
  }

  // Default to gid=0 (first tab) if we couldn't discover any
  if (gids.length === 0) gids.push('0');

  // Step 3: build CSV URLs for each gid
  // Published URLs use /d/e/.../pub?gid=N&output=csv
  // Regular URLs use /d/<key>/export?format=csv&gid=N
  const buildCsvUrl = (gid) =>
    isPublished
      ? `https://docs.google.com/spreadsheets/d/e/${docKey}/pub?gid=${gid}&single=true&output=csv`
      : `https://docs.google.com/spreadsheets/d/${docKey}/export?format=csv&gid=${gid}`;

  // Step 4: fetch all tabs in parallel
  const fetchedTabs = await Promise.allSettled(
    gids.map(async gid => {
      const csvUrl = buildCsvUrl(gid);
      const r = await fetch(csvUrl, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      // Skip totally empty tabs
      if (!text.trim()) throw new Error('empty');
      return { gid, ...parseSheetCsv(text) };
    })
  );

  const tabs = fetchedTabs
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  if (tabs.length === 0) {
    throw new Error('No readable tabs. Make sure each tab is published (File → Share → Publish to web → select each tab).');
  }

  // Combined view: all rows from all tabs, plus per-tab access
  const allHeaders = [...new Set(tabs.flatMap(t => t.headers))];
  const allRows = tabs.flatMap(t =>
    t.rows.map(r => ({ ...r, _tab: t.gid }))
  );
  // Merge price history from all tabs (last write wins if duplicate ticker)
  const priceHistory = {};
  tabs.forEach(t => {
    if (t.priceHistory) Object.assign(priceHistory, t.priceHistory);
  });

  return {
    headers: allHeaders,
    rows: allRows,
    tabs,
    priceHistory,
    docKey,
    isPublished,
  };
}

// Robust CSV parser that handles quoted fields and commas inside quotes
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') { inQ = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

function parseSheetCsv(text) {
  const allLines = text.replace(/\r/g, '').split('\n');
  if (allLines.length < 2) return { headers: [], rows: [] };

  // Smart header detection: find the row that contains "ticker" / "symbol" / "act symbol".
  let headerIdx = -1;
  for (let i = 0; i < Math.min(allLines.length, 30); i++) {
    const cells = parseCsvLine(allLines[i]).map(c => c.trim().toLowerCase());
    const hasTickerCol = cells.some(c =>
      c === 'ticker' || c === 'symbol' || c === 'tickers' || c === 'symbols' ||
      c === 'act symbol' || c === 'act_symbol' || c === 'actsymbol'
    );
    if (hasTickerCol) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    for (let i = 0; i < Math.min(allLines.length, 30); i++) {
      const cells = parseCsvLine(allLines[i]).map(c => c.trim());
      const filled = cells.filter(c => c).length;
      const hasWord = cells.some(c => /^[A-Za-z][A-Za-z\s/%#&]*$/.test(c));
      if (filled >= 3 && hasWord) { headerIdx = i; break; }
    }
  }
  if (headerIdx === -1) return { headers: [], rows: [] };

  const rawHeaders = parseCsvLine(allLines[headerIdx]);
  // Normalize headers: lowercase + alias common variants to canonical names
  const headers = rawHeaders.map(h => {
    const lower = h.trim().toLowerCase();
    // Aliases — map alternate column names to the canonical name we use everywhere
    if (lower === 'act symbol' || lower === 'act_symbol' || lower === 'actsymbol') return 'ticker';
    if (lower === 'company name' && rawHeaders.some(r => r.trim().toLowerCase() === 'name')) return 'company name';
    return lower;
  });

  // Detect "data ends here" — the last header column that's a known field name
  // (vs. blank or date columns trailing it). After this, columns are price history.
  const KNOWN_FIELDS = new Set([
    // Identity
    'company','ticker','symbol','tickers','symbols','name','company name','fmpname',
    'act symbol','act_symbol','actsymbol',
    // Pricing
    'price','fmpprice','last price','open','price open','priceopen','high','low','close','prev close','closeyest',
    'change','changepct','change from prev day','tradetime','datadelay','date',
    // Market data
    'market cap','marketcap','fmpmarketcap','volume','volumeavg','avg volume','shares','shares outstanding','fmpshares',
    'beta','fmpbeta','pe','p/e','eps','eps (ttm)',
    // Position tracking
    'status','column 1','price when added','p/l%','p/l% since','p/l since','p/l %',
    'date added','note','notes','link','links','chart_link','chartlink',
    // Range
    'high52','low52','52w high','52w low','net assets','netassets',
    'fmp52weekhigh','fmp52weeklow','fmphigh52','fmplow52',
    // Returns
    'returnytd','return ytd','return day','return1','return4','return13','return52','return156','return260',
    // Distributions / Mutual fund only
    'incomedividend','incomedividend date','incomedividenddate','capitalgain',
    'morningstarrating','morningstar rating','expense ratio','expenseratio','dividend yield','div yield',
    // Taxonomy (the user-curated columns)
    'sector','sub-sector','sub sector','subsector','industry','function',
    'core segments','core-segments','segments','description','summary',
    // Company info (from FMP via Apps Script)
    'exchange','ceo','country','ipodate','ipo date','isetf','is_etf',
    'isfund','is_fund','isactive','is_active','isactivelytrading','currency',
    'web_url','website','url','image','logo','phone','address','city','state','zip','employees','fulltimeemployees',
    // Financials (legacy / additional)
    'revenue','fcf','ebitda','debt','cash','operating margin','op margin','ev/ebitda',
  ]);
  let lastDataCol = -1;
  for (let i = 0; i < headers.length; i++) {
    if (KNOWN_FIELDS.has(headers[i])) lastDataCol = i;
  }

  // Build the regular row records (only using columns ≤ lastDataCol)
  const tickerColIdx = headers.findIndex(h =>
    h === 'ticker' || h === 'symbol' || h === 'tickers' || h === 'symbols'
  );
  const allLineCells = allLines.slice(headerIdx + 1).map(l => parseCsvLine(l));

  // ----- HISTORY EXTRACTION — supports 3 layouts -----
  //
  // LAYOUT 1: PAIRED ROWS
  //   Each ticker takes 2 rows. Row N has dates in trailing cells.
  //   Row N+1 (with empty ticker col) has matching prices.
  //
  // LAYOUT 2: HEADER DATES
  //   Dates are in the header row (or any earlier row above the ticker).
  //   Each ticker has 1 row, with prices in the columns that match those dates.
  //   This is the form Google Finance produces with =GOOGLEFINANCE("AAPL","close",...).
  //
  // LAYOUT 3: COLUMNAR
  //   Dates run DOWN column A. Tickers run ACROSS row 2. Row 3 says "Close" under each.
  //   Prices fill the grid. Sheet must be its own tab to detect this.
  //
  // We auto-detect by content. Layout 1 is tried first (most specific). Fallback to 2 then 3.

  const priceHistory = {};

  // ----- LAYOUT 1: paired rows -----
  for (let i = 0; i < allLineCells.length; i++) {
    const cells = allLineCells[i];
    if (!cells || tickerColIdx < 0) continue;
    const tic = (cells[tickerColIdx] || '').trim().toUpperCase();
    if (!tic || tic.includes('#')) continue;
    const stripped = tic.replace(/[.\-]/g, '');
    if (stripped.length > 5 || !/^[A-Z0-9.\-]+$/.test(tic)) continue;

    const nextRow = allLineCells[i + 1] || [];
    const nextTicker = (nextRow[tickerColIdx] || '').trim();
    if (nextTicker) continue; // next row has its own ticker — not a paired layout

    let firstDateCol = -1;
    for (let c = tickerColIdx + 1; c < cells.length; c++) {
      if (parseAnyDate((cells[c] || '').trim())) { firstDateCol = c; break; }
    }
    if (firstDateCol === -1) continue;

    const history = [];
    for (let c = firstDateCol; c < cells.length; c++) {
      const dRaw = (cells[c] || '').trim();
      const pRaw = (nextRow[c] || '').trim();
      if (!dRaw || !pRaw) continue;
      const date = parseAnyDate(dRaw);
      if (!date) continue;
      const upper = pRaw.toUpperCase();
      if (upper.includes('#') || upper === 'N/A') continue;
      const cleaned = pRaw.replace(/[$,]/g, '');
      const price = parseFloat(cleaned);
      if (!isFinite(price) || price <= 0) continue;
      history.push({ date, price });
    }
    if (history.length >= 2) {
      priceHistory[tic] = sortDedup(history);
    }
  }

  // ----- LAYOUT 2: HEADER DATES -----
  // Look for a date row above the ticker rows. Dates can be in the header row
  // OR any of the first 5 rows. Match by column index — for each ticker row,
  // the cells under date columns are prices.
  if (Object.keys(priceHistory).length === 0) {
    // Find a row that has the most parseable dates in trailing cells
    let dateHeaderIdx = -1;
    let maxDates = 0;
    let dateColMap = {}; // col idx -> ISO date
    for (let r = 0; r < Math.min(allLines.length, 5); r++) {
      const rowCells = parseCsvLine(allLines[r]);
      const dates = {};
      for (let c = 0; c < rowCells.length; c++) {
        const d = parseAnyDate((rowCells[c] || '').trim());
        if (d) dates[c] = d;
      }
      const count = Object.keys(dates).length;
      if (count > maxDates && count >= 5) { // at least 5 dates to qualify
        maxDates = count;
        dateHeaderIdx = r;
        dateColMap = dates;
      }
    }

    if (dateHeaderIdx >= 0 && tickerColIdx >= 0) {
      // For each row that has a valid ticker in tickerColIdx, extract prices from date columns
      for (let i = 0; i < allLineCells.length; i++) {
        const cells = allLineCells[i];
        if (!cells) continue;
        const tic = (cells[tickerColIdx] || '').trim().toUpperCase();
        if (!tic || tic.includes('#')) continue;
        const stripped = tic.replace(/[.\-]/g, '');
        if (stripped.length > 5 || !/^[A-Z0-9.\-]+$/.test(tic)) continue;

        const history = [];
        for (const [col, date] of Object.entries(dateColMap)) {
          const pRaw = (cells[parseInt(col)] || '').trim();
          if (!pRaw) continue;
          const upper = pRaw.toUpperCase();
          if (upper.includes('#') || upper === 'N/A') continue;
          const cleaned = pRaw.replace(/[$,]/g, '');
          const price = parseFloat(cleaned);
          if (!isFinite(price) || price <= 0) continue;
          history.push({ date, price });
        }
        if (history.length >= 2) {
          priceHistory[tic] = sortDedup(history);
        }
      }
    }
  }

  // ----- LAYOUT 3: COLUMNAR -----
  // Dates in column A (rows N+ ), tickers across in row M, "Close" in row M+1, prices in grid.
  // Detect: row 1 or 2 contains a string like "Historical pricing", and column A has dates.
  // ----- LAYOUT 3: COLUMNAR (wide format) -----
  // Dates in column A; tickers across row 1 or 2; row 2 or 3 is often "Close" placeholders.
  // Sheet may be ascending or descending date order.
  // Examples:
  //   "Date column" sheet:           Row1=tickers, Row2=Close, Row3+=actual data ascending
  //   "Date Column Backward test":   Same shape but Row3+ are descending (newest first)
  if (Object.keys(priceHistory).length === 0) {
    // Find the row that has the MOST short uppercase ticker tokens. Scan first 5 rows.
    let tickerRow = -1;
    let tickerCols = {};
    for (let r = 0; r < Math.min(allLines.length, 5); r++) {
      const rowCells = parseCsvLine(allLines[r]);
      const tickers = {};
      for (let c = 1; c < rowCells.length; c++) {
        const v = (rowCells[c] || '').trim().toUpperCase();
        if (!v) continue;
        if (v.includes('#')) continue;
        if (v === 'CLOSE' || v === 'OPEN' || v === 'HIGH' || v === 'LOW' || v === 'VOLUME') continue;
        const stripped = v.replace(/[.\-]/g, '');
        if (stripped.length === 0 || stripped.length > 5) continue;
        if (!/^[A-Z0-9.\-]+$/.test(v)) continue;
        tickers[c] = v;
      }
      if (Object.keys(tickers).length > Object.keys(tickerCols).length && Object.keys(tickers).length >= 3) {
        tickerRow = r;
        tickerCols = tickers;
      }
    }

    if (tickerRow >= 0) {
      // Walk down rows after the ticker row, looking for date-in-column-A rows.
      // SKIP rows where column A is "Date", "Close", or any non-date placeholder
      // (handles the "Close" placeholder row that sits between tickers and prices)
      for (let r = tickerRow + 1; r < allLines.length; r++) {
        const rowCells = parseCsvLine(allLines[r]);
        const dRaw = (rowCells[0] || '').trim();
        // Skip placeholder/header rows in column A
        if (!dRaw) continue;
        const upperA = dRaw.toUpperCase();
        if (upperA === 'DATE' || upperA === 'CLOSE' || upperA === 'OPEN' ||
            upperA === 'HIGH' || upperA === 'LOW' || upperA === 'VOLUME' ||
            upperA.includes('#')) continue;
        const date = parseAnyDate(dRaw);
        if (!date) continue;
        for (const [col, tic] of Object.entries(tickerCols)) {
          const pRaw = (rowCells[parseInt(col)] || '').trim();
          if (!pRaw) continue;
          const upper = pRaw.toUpperCase();
          if (upper.includes('#') || upper === 'N/A' || upper === 'CLOSE') continue;
          const cleaned = pRaw.replace(/[$,]/g, '');
          const price = parseFloat(cleaned);
          if (!isFinite(price) || price <= 0) continue;
          if (!priceHistory[tic]) priceHistory[tic] = [];
          priceHistory[tic].push({ date, price });
        }
      }
      for (const tic of Object.keys(priceHistory)) {
        if (priceHistory[tic].length < 2) {
          delete priceHistory[tic];
        } else {
          // sortDedup ensures ascending order — handles both ascending source and reverse-chronological
          priceHistory[tic] = sortDedup(priceHistory[tic]);
        }
      }
    }
  }

  // ----- BUILD STANDARD ROWS (only the leading data columns) -----
  const trimmedHeaders = headers.slice(0, lastDataCol + 1);
  const rows = allLineCells
    .filter(cells => cells && cells.some(c => c.trim()))
    .map(cells => {
      const obj = {};
      trimmedHeaders.forEach((h, i) => { obj[h] = (cells[i] || '').trim(); });
      return obj;
    })
    .filter(r => {
      const tic = (r['ticker'] || r['symbol'] || r['tickers'] || r['symbols'] || '').trim().toUpperCase();
      if (!tic) return false;
      if (tic.includes('#') || tic === 'N/A' || tic === '#REF!') return false;
      const stripped = tic.replace(/[.\-]/g, '');
      if (stripped.length > 5) return false;
      if (!/^[A-Z0-9.\-]+$/.test(tic)) return false;
      return true;
    });

  return { headers: trimmedHeaders, rows, headerRowIndex: headerIdx, priceHistory };
}

// Multi-sheet wrapper — fetches all configured URLs in parallel and merges results.
// Tickers are deduped by symbol; later sheets fill blank fields from earlier sheets.
// Price history is unioned (later URLs take precedence on duplicate dates).
async function fetchSheetData() {
  const urls = getSheetUrls();
  if (urls.length === 0) return null;
  if (urls.length === 1) {
    return fetchSheetDataSingle(urls[0]);
  }

  const results = await Promise.all(urls.map(u =>
    fetchSheetDataSingle(u).catch(e => {
      console.warn('Sheet fetch failed for', u.slice(0, 60), e.message);
      return null;
    })
  ));

  const valid = results.filter(r => r != null);
  if (valid.length === 0) return null;

  // Merge headers (union)
  const mergedHeaders = [];
  const seenH = new Set();
  for (const r of valid) {
    for (const h of r.headers) {
      if (!seenH.has(h)) { seenH.add(h); mergedHeaders.push(h); }
    }
  }

  // Helper: is this cell a "missing" value? Includes #N/A, blank, error markers.
  const isMissing = (v) => {
    if (v == null) return true;
    const s = String(v).trim();
    if (!s) return true;
    if (s === '—' || s === '-') return true;
    const upper = s.toUpperCase();
    if (upper === 'N/A' || upper === '#N/A' || upper.startsWith('#N/A')) return true;
    if (upper === '#REF!' || upper === '#ERROR!' || upper === '#NAME?') return true;
    if (upper === '#DIV/0!' || upper === '#VALUE!' || upper === '#NULL!') return true;
    if (upper === 'NULL' || upper === 'UNDEFINED' || upper === 'NAN') return true;
    return false;
  };

  // Merge rows by ticker — SIFT THROUGH all sheets:
  // For each field, take the FIRST non-missing value across sheets (no priority by sheet order
  // for the data itself; we just iterate in URL order and grab any usable value).
  // This means if sheet 1 has #N/A for marketcap but sheet 2 has 5.2T, we use 5.2T.
  const rowsByTicker = new Map();
  for (const r of valid) {
    for (const row of r.rows) {
      const tic = (row['ticker'] || row['symbol'] || '').toUpperCase().trim();
      if (!tic) continue;
      if (rowsByTicker.has(tic)) {
        const existing = rowsByTicker.get(tic);
        for (const k of Object.keys(row)) {
          // Replace existing value if existing is missing AND new is not missing.
          // Otherwise keep what we have. Don't overwrite a real value with an N/A.
          if (isMissing(existing[k]) && !isMissing(row[k])) {
            existing[k] = row[k];
          }
        }
      } else {
        rowsByTicker.set(tic, { ...row });
      }
    }
  }

  // Merge price history (later URLs override duplicates by date — recency assumption)
  const mergedHistory = {};
  for (const r of valid) {
    if (!r.priceHistory) continue;
    for (const [tic, hist] of Object.entries(r.priceHistory)) {
      if (!mergedHistory[tic]) {
        mergedHistory[tic] = [...hist];
      } else {
        const map = new Map();
        for (const p of mergedHistory[tic]) map.set(p.date, p);
        for (const p of hist) map.set(p.date, p);
        mergedHistory[tic] = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
      }
    }
  }

  console.log(`✓ Merged ${valid.length} sheets · ${rowsByTicker.size} unique tickers · ${Object.keys(mergedHistory).length} with price history`);

  return {
    headers: mergedHeaders,
    rows: Array.from(rowsByTicker.values()),
    priceHistory: mergedHistory,
    sourceCount: valid.length,
    tabs: valid.flatMap(r => r.tabs || []),
  };
}

// Sort history ascending by date and dedupe duplicate dates.
function sortDedup(history) {
  history.sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set();
  return history.filter(h => {
    if (seen.has(h.date)) return false;
    seen.add(h.date);
    return true;
  });
}

// Parse parallel date/price arrays into a clean ascending history array.
function parseDatePricePairs(dateCells, priceCells) {
  const history = [];
  const len = Math.min(dateCells.length, priceCells.length);
  for (let c = 0; c < len; c++) {
    const dRaw = (dateCells[c] || '').trim();
    const pRaw = (priceCells[c] || '').trim();
    if (!dRaw || !pRaw) continue;
    const date = parseAnyDate(dRaw);
    if (!date) continue;
    const upper = pRaw.toUpperCase();
    if (upper.includes('#') || upper === 'N/A') continue;
    const cleaned = pRaw.replace(/[$,]/g, '');
    const price = parseFloat(cleaned);
    if (!isFinite(price) || price <= 0) continue;
    history.push({ date, price });
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set();
  return history.filter(h => {
    if (seen.has(h.date)) return false;
    seen.add(h.date);
    return true;
  });
}

// Parse various date formats into ISO YYYY-MM-DD, or null if unrecognized.
function parseAnyDate(s) {
  if (!s) return null;
  s = s.trim();
  // GoogleFinance/Sheets sometimes emits "Date(2025,0,2)" (month is 0-indexed)
  const gd = s.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})/);
  if (gd) {
    const y = gd[1];
    const m = (parseInt(gd[2]) + 1).toString().padStart(2, '0'); // 0-indexed → 1-indexed
    const d = gd[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Already ISO?
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
  // M/D/YYYY or M/D/YY
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    let [, m, d, y] = us;
    if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // D-Mon-YY or D Mon YYYY
  const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                   jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const named = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})/);
  if (named) {
    const m = months[named[2].toLowerCase()];
    if (m) {
      let y = named[3];
      if (y.length === 2) y = (parseInt(y) > 50 ? '19' : '20') + y;
      return `${y}-${m}-${named[1].padStart(2,'0')}`;
    }
  }
  // Try Date.parse fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}

// Find a row in the sheet by ticker (searches all tabs/rows)
function findSheetRow(sheet, ticker) {
  if (!sheet || !sheet.rows) return null;
  const upper = ticker.toUpperCase();
  const tickerCol = sheet.headers.find(h =>
    h === 'ticker' || h === 'symbol' || h.includes('ticker') || h.includes('symbol')
  );
  if (!tickerCol) return null;
  return sheet.rows.find(r => (r[tickerCol] || '').toUpperCase() === upper) || null;
}

// Get price history for a ticker from cached sheet, or null if absent.
// Per-ticker price history cache (external API results, 1-day TTL)
const PRICE_HIST_CACHE_KEY = 'valuatio.priceHist.cache.v1';
const PRICE_HIST_TTL_MS = 24 * 60 * 60 * 1000;

function loadPriceHistCache() {
  try { return JSON.parse(localStorage.getItem(PRICE_HIST_CACHE_KEY) || '{}'); }
  catch { return {}; }
}
function savePriceHistCache(c) {
  try { localStorage.setItem(PRICE_HIST_CACHE_KEY, JSON.stringify(c)); } catch {}
}

// Get price history with fallback chain:
//   1. Sheet (instant, no API call)
//   2. Cached external (1d TTL)
//   3. Twelve Data (800/day free)
//   4. FMP (250/day free)
//   5. Stooq (no key, CORS works)
async function getPriceHistory(ticker, opts = {}) {
  const TIC = ticker.toUpperCase();

  // 1. Try sheet first
  if (!opts.skipSheet) {
    const sheet = await getSheetData(false).catch(() => null);
    if (sheet?.priceHistory?.[TIC]) {
      const h = sheet.priceHistory[TIC];
      if (h.length >= 2) return h;
    }
  }

  // 2. Check ticker-specific cache
  const cache = loadPriceHistCache();
  if (cache[TIC] && (Date.now() - cache[TIC].t) < PRICE_HIST_TTL_MS) {
    return cache[TIC].data;
  }

  // 3. Twelve Data
  let history = null;
  if (getTwelveKey()) {
    const td = await fetchTwelveDataHistory(TIC, 500);
    if (td && td.length >= 2) {
      history = td.map(p => ({ date: p.date, price: p.close }));
    }
  }

  // 4. FMP
  if (!history && getFmpKey()) {
    const fmp = await fetchFmpHistory(TIC);
    if (fmp && fmp.length >= 2) {
      history = fmp.map(p => ({ date: p.date, price: p.close }));
    }
  }

  // 5. Stooq (no key needed, but ETFs use different symbol formats)
  if (!history) {
    try {
      const stooq = await fetchStooqHistory(TIC);
      if (stooq && stooq.length >= 2) {
        history = stooq.map(p => ({ date: p.date, price: p.close }));
      }
    } catch {}
  }

  if (history && history.length >= 2) {
    cache[TIC] = { t: Date.now(), data: history };
    // Keep cache size in check
    const keys = Object.keys(cache);
    if (keys.length > 100) {
      const sorted = keys.sort((a, b) => cache[b].t - cache[a].t).slice(0, 100);
      const trimmed = {};
      sorted.forEach(k => trimmed[k] = cache[k]);
      savePriceHistCache(trimmed);
    } else {
      savePriceHistCache(cache);
    }
    return history;
  }

  return null;
}

// Compute percentage change over N trading days from a history array.
// History is ascending by date. daysBack = how many trading days to look back.
function priceChangeFromHistory(history, daysBack) {
  if (!history || history.length < 2) return null;
  const lastIdx = history.length - 1;
  const priorIdx = Math.max(0, lastIdx - daysBack);
  if (priorIdx >= lastIdx) return null;
  const last = history[lastIdx].price;
  const prior = history[priorIdx].price;
  if (!prior || !last) return null;
  return (last / prior) - 1;
}

// Find the closest history entry on or before a target ISO date (YYYY-MM-DD).
// Returns { date, price } or null.
function priceAtOrBefore(history, isoDate) {
  if (!history || history.length === 0 || !isoDate) return null;
  // Binary search since history is sorted ascending by date
  let lo = 0, hi = history.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = history[mid].date;
    if (d <= isoDate) {
      best = history[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// Compute percentage change over a specific calendar window (in days, not trading days).
// Uses real dates: finds the last bar, then walks back N calendar days.
// Falls back to the closest available bar on/before that target.
function priceChangeOverDays(history, calendarDays) {
  if (!history || history.length < 2) return null;
  const lastEntry = history[history.length - 1];
  const lastIso = lastEntry.date;
  if (!lastIso || !lastEntry.price) return null;
  // Compute target date
  const lastDate = new Date(lastIso + 'T00:00:00Z');
  const targetDate = new Date(lastDate.getTime() - calendarDays * 86400000);
  const y = targetDate.getUTCFullYear();
  const m = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(targetDate.getUTCDate()).padStart(2, '0');
  const targetIso = `${y}-${m}-${d}`;
  const priorEntry = priceAtOrBefore(history, targetIso);
  if (!priorEntry || !priorEntry.price) return null;
  // Sanity: only return if we found a bar reasonably close to the target
  // (within 1.5x the window — accounts for weekends/holidays at long horizons)
  const priorDate = new Date(priorEntry.date + 'T00:00:00Z');
  const gapDays = Math.abs((targetDate - priorDate) / 86400000);
  if (gapDays > calendarDays * 0.6) return null; // gap too big — data doesn't span the window
  return (lastEntry.price / priorEntry.price) - 1;
}

// Pull a numeric field from a sheet row, looking through several possible header names.
// Handles "$1,234.56", "1.5B", "(123)" for negatives, "—" / "-" / "" for null.
function sheetNum(row, ...possibleKeys) {
  if (!row) return null;
  for (const k of possibleKeys) {
    for (const actualKey of Object.keys(row)) {
      if (actualKey === k.toLowerCase() || actualKey.includes(k.toLowerCase())) {
        const raw = row[actualKey];
        if (raw == null || raw === '' || raw === '—' || raw === '-') continue;
        // Reject ALL Google Sheets error values
        const rawStr = String(raw).trim().toUpperCase();
        if (rawStr === 'N/A' || rawStr === '#N/A' || rawStr === '#REF!' ||
            rawStr === '#ERROR!' || rawStr === '#NAME?' || rawStr === '#VALUE!' ||
            rawStr === '#DIV/0!' || rawStr === '#NULL!' || rawStr === '#NUM!') continue;
        // Strip $, commas, parens (negatives), %
        let cleaned = String(raw).trim().replace(/[$,]/g, '').replace(/%$/, '');
        let neg = false;
        if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
          neg = true;
          cleaned = cleaned.slice(1, -1);
        }
        // Handle K/M/B/T suffixes
        const m = cleaned.match(/^(-?[\d.]+)([KMBT])$/i);
        let val;
        if (m) {
          const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
          val = parseFloat(m[1]) * mult[m[2].toUpperCase()];
        } else {
          val = parseFloat(cleaned);
        }
        if (isFinite(val)) return neg ? -val : val;
      }
    }
  }
  return null;
}

function sheetStr(row, ...possibleKeys) {
  if (!row) return null;
  // First pass: exact match
  for (const k of possibleKeys) {
    const lc = k.toLowerCase();
    for (const actualKey of Object.keys(row)) {
      if (actualKey === lc) {
        const v = (row[actualKey] || '').trim();
        if (v && v !== '—' && v !== '-' && !v.toUpperCase().startsWith('#')) return v;
      }
    }
  }
  // Second pass: substring match (looser)
  for (const k of possibleKeys) {
    const lc = k.toLowerCase();
    for (const actualKey of Object.keys(row)) {
      if (actualKey.includes(lc)) {
        const v = (row[actualKey] || '').trim();
        if (v && v !== '—' && v !== '-' && !v.toUpperCase().startsWith('#')) return v;
      }
    }
  }
  return null;
}

// ----- Yahoo Finance v7 quote endpoint (price only) via CORS proxy fallback chain
// This endpoint is simpler than quoteSummary and works through proxies.
async function fetchYahooQuote(ticker) {
  const target = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
  const proxies = [
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];
  for (let i = 0; i < proxies.length; i++) {
    try {
      const r = await fetch(proxies[i](target), { headers: { 'Accept': 'application/json' } });
      if (!r.ok) continue;
      const text = await r.text();
      if (!text.startsWith('{')) continue; // proxy error page
      const j = JSON.parse(text);
      const q = j.quoteResponse?.result?.[0];
      if (q && (q.regularMarketPrice || q.regularMarketPreviousClose)) return q;
    } catch {}
  }
  return null; // soft fail — we have other price sources
}

// ----- Stooq: free, CORS-enabled, returns CSV with the latest quote -----
async function fetchStooqPrice(ticker) {
  const stooqTicker = ticker.toLowerCase().replace('-', '.') + '.us';
  const url = `https://stooq.com/q/l/?s=${stooqTicker}&f=sd2t2ohlcv&h&e=csv`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Stooq HTTP ' + r.status);
  const text = await r.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('Stooq: no data');
  const cols = lines[1].split(',');
  if (cols[3] === 'N/D' || !cols[6]) throw new Error('Stooq: ticker not found');
  return {
    symbol: cols[0],
    open: parseFloat(cols[3]),
    high: parseFloat(cols[4]),
    low: parseFloat(cols[5]),
    close: parseFloat(cols[6]),
    volume: parseInt(cols[7]) || 0,
  };
}

// ----- Alpha Vantage: free tier, real CORS support, requires API key -----
async function fetchAlphaVantage(fn, ticker, key) {
  const url = `https://www.alphavantage.co/query?function=${fn}&symbol=${ticker}&apikey=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`AV HTTP ${r.status}`);
  const j = await r.json();
  // Rate-limit / error responses come back as 200 OK with a "Note" or "Information" key
  if (j.Note || j.Information) throw new Error('AV rate limit (free tier: 25/day)');
  if (j['Error Message']) throw new Error('AV: ' + j['Error Message']);
  if (!Object.keys(j).length) throw new Error('AV: empty response');
  return j;
}

const fetchAlphaVantageOverview = (t, k) => fetchAlphaVantage('OVERVIEW', t, k);
const fetchAlphaVantageIncomeStatement = (t, k) => fetchAlphaVantage('INCOME_STATEMENT', t, k);
const fetchAlphaVantageCashFlow = (t, k) => fetchAlphaVantage('CASH_FLOW', t, k);
const fetchAlphaVantageBalanceSheet = (t, k) => fetchAlphaVantage('BALANCE_SHEET', t, k);

// Pull a numeric value out of Alpha Vantage's stringified-everything responses
const avNum = (v) => {
  if (v == null || v === 'None' || v === '-' || v === '') return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
};

// ---------- NORMALIZE FETCHED DATA ----------
function normalizeStock(envelope) {
  const ov = envelope.overview || {};
  const incomeRpts = envelope.income?.annualReports || [];
  const cashRpts = envelope.cash?.annualReports || [];
  const balanceRpts = envelope.balance?.annualReports || [];
  const stooq = envelope.stooq || null;
  const sheetRow = envelope.sheetRow || null;
  const sourcePref = envelope.sourcePref || 'auto';
  const ticker = envelope.ticker;

  const inc = incomeRpts[0] || {};
  const inc1 = incomeRpts[1] || {};
  const cf = cashRpts[0] || {};
  const bs = balanceRpts[0] || {};

  let histRevGrowth = null;
  const r0 = avNum(inc.totalRevenue);
  const r1 = avNum(inc1.totalRevenue);
  if (r0 && r1 && r1 > 0) histRevGrowth = (r0 / r1) - 1;

  const ocf = avNum(cf.operatingCashflow);
  const capex = Math.abs(avNum(cf.capitalExpenditures) || 0);
  const fcfFromAV = ocf != null ? ocf - capex : null;

  const opInc = avNum(inc.operatingIncome);
  const da = avNum(inc.depreciationAndAmortization) || avNum(cf.depreciationDepletionAndAmortization) || 0;
  const ebitdaAV = avNum(ov.EBITDA) || (opInc != null ? opInc + da : null);

  const stDebt = avNum(bs.shortTermDebt) || 0;
  const ltDebt = avNum(bs.longTermDebt) || 0;
  const totalDebtAV = avNum(bs.shortLongTermDebtTotal) || (stDebt + ltDebt);

  const cashAV = avNum(bs.cashAndCashEquivalentsAtCarryingValue) || avNum(bs.cashAndShortTermInvestments) || 0;

  // ----- Sheet-first picker -----
  // 'sheet'  → sheet value wins, fall back to AV/Stooq if missing
  // 'av'     → AV value wins, fall back to sheet if missing
  // 'auto'   → sheet wins if present (you typed it = you mean it), else AV
  const preferSheet = sourcePref === 'sheet' || sourcePref === 'auto';

  function pick(sheetVal, otherVal) {
    if (preferSheet && sheetVal != null) return sheetVal;
    if (otherVal != null) return otherVal;
    return sheetVal;
  }

  // Sheet values (null if no sheet row or that column doesn't exist)
  const sheetPrice    = sheetNum(sheetRow, 'last price', 'price', 'last', 'close', 'current price');
  const sheetMcap     = sheetNum(sheetRow, 'market cap', 'marketcap', 'mcap');
  const sheetShares   = sheetNum(sheetRow, 'shares', 'shares outstanding', 'sharesout');
  const sheetEps      = sheetNum(sheetRow, 'eps', 'earnings per share');
  const sheetBeta     = sheetNum(sheetRow, 'beta');
  const sheetPe       = sheetNum(sheetRow, 'p/e', 'pe ratio', 'pe', 'price/earnings');
  const sheetRevenue  = sheetNum(sheetRow, 'revenue', 'sales');
  const sheetFcf      = sheetNum(sheetRow, 'fcf', 'free cash flow', 'freecashflow');
  const sheetEbitda   = sheetNum(sheetRow, 'ebitda');
  const sheetDebt     = sheetNum(sheetRow, 'debt', 'total debt');
  const sheetCash     = sheetNum(sheetRow, 'cash');
  const sheetSector   = sheetRow ? (sheetRow['sector'] || sheetRow['industry'] || null) : null;
  const sheetName     = sheetRow ? (sheetRow['name'] || sheetRow['company'] || null) : null;
  const sheetEvEbitda = sheetNum(sheetRow, 'ev/ebitda', 'evebitda');
  const sheetGrowth   = sheetNum(sheetRow, 'growth', 'revenue growth');
  const sheetMargin   = sheetNum(sheetRow, 'operating margin', 'op margin');
  const sheetDiv      = sheetNum(sheetRow, 'dividend yield', 'div yield');
  const sheetHigh52   = sheetNum(sheetRow, 'high52', 'high 52', '52w high', '52 week high', '52-wk high');
  const sheetLow52    = sheetNum(sheetRow, 'low52', 'low 52', '52w low', '52 week low', '52-wk low');
  const sheetDescr    = sheetRow ? (sheetRow['description'] || sheetRow['summary'] || null) : null;

  // FMP-prefixed columns from your master sheet's =FMPDATA() formulas
  const fmpName       = sheetStr(sheetRow, 'fmpname');
  const fmpPrice      = sheetNum(sheetRow, 'fmpprice');
  const fmpMcap       = sheetNum(sheetRow, 'fmpmarketcap');
  const fmpBeta       = sheetNum(sheetRow, 'fmpbeta');
  const fmpHigh52     = sheetNum(sheetRow, 'fmp52weekhigh', 'fmphigh52');
  const fmpLow52      = sheetNum(sheetRow, 'fmp52weeklow', 'fmplow52');

  // Company info (added via FMPDATA Apps Script)
  const sheetExchange = sheetStr(sheetRow, 'exchange');
  const sheetCeo      = sheetStr(sheetRow, 'ceo');
  const sheetCountry  = sheetStr(sheetRow, 'country');
  const sheetIpoDate  = sheetStr(sheetRow, 'ipodate', 'ipo date');
  const sheetCurrency = sheetStr(sheetRow, 'currency');
  const sheetWebsite  = sheetStr(sheetRow, 'web_url', 'website', 'url');
  const sheetImage    = sheetStr(sheetRow, 'image', 'logo');
  const sheetPhone    = sheetStr(sheetRow, 'phone');
  const sheetAddress  = sheetStr(sheetRow, 'address');
  const sheetCity     = sheetStr(sheetRow, 'city');
  const sheetStateLoc = sheetStr(sheetRow, 'state');
  const sheetEmployees = sheetNum(sheetRow, 'employees', 'fulltimeemployees');
  const sheetIsEtf    = sheetStr(sheetRow, 'isetf', 'is_etf');
  const sheetIsFund   = sheetStr(sheetRow, 'isfund', 'is_fund');
  const sheetIsActive = sheetStr(sheetRow, 'isactive', 'is_active', 'isactivelytrading');
  const sheetChartLink = sheetStr(sheetRow, 'chart_link', 'chartlink');

  // Live price cascade — sheet overrides Stooq/Yahoo if user prefers sheet
  let livePrice = null;
  let priceSource = 'none';
  if (preferSheet && sheetPrice && isFinite(sheetPrice)) {
    livePrice = sheetPrice;
    priceSource = 'Sheet (live)';
  } else if (stooq?.close && isFinite(stooq.close)) {
    livePrice = stooq.close;
    priceSource = 'Stooq (last close)';
  } else if (envelope.yahooQuote?.regularMarketPrice && isFinite(envelope.yahooQuote.regularMarketPrice)) {
    livePrice = envelope.yahooQuote.regularMarketPrice;
    priceSource = 'Yahoo (live)';
  } else if (envelope.yahooQuote?.regularMarketPreviousClose) {
    livePrice = envelope.yahooQuote.regularMarketPreviousClose;
    priceSource = 'Yahoo (prev close)';
  } else if (sheetPrice && isFinite(sheetPrice)) {
    livePrice = sheetPrice;
    priceSource = 'Sheet';
  }

  const country = ov.Country === 'USA' ? 'United States' : (ov.Country || 'United States');

  let dataSource;
  if (sheetRow && envelope.overview && livePrice) dataSource = `Sheet + AV · ${priceSource}`;
  else if (sheetRow && livePrice) dataSource = `Sheet · ${priceSource}`;
  else if (envelope.overview && livePrice) dataSource = `AV · ${priceSource}`;
  else if (envelope.overview) dataSource = 'AV (no live price)';
  else if (livePrice) dataSource = priceSource;
  else dataSource = 'Manual entry';

  return {
    ticker: ov.Symbol || ticker,
    name: pick(sheetName, ov.Name) || ticker,
    sector: pick(sheetSector, ov.Sector) || '—',
    industry: ov.Industry || '—',
    country,
    currency: ov.Currency || 'USD',
    dataSource,
    sheetRow,
    price: livePrice,
    marketCap: pick(sheetMcap, avNum(ov.MarketCapitalization)),
    sharesOutstanding: pick(sheetShares, avNum(ov.SharesOutstanding)),
    beta: pick(sheetBeta, avNum(ov.Beta)) || DEFAULTS.defaultBeta,
    pe: pick(sheetPe, avNum(ov.PERatio)),
    forwardPE: avNum(ov.ForwardPE),
    eps: pick(sheetEps, avNum(ov.EPS)),
    revenue: pick(sheetRevenue, avNum(inc.totalRevenue) || avNum(ov.RevenueTTM)),
    ebitda: pick(sheetEbitda, ebitdaAV),
    operatingIncome: opInc,
    netIncome: avNum(inc.netIncome),
    capex,
    depreciation: da,
    operatingCashFlow: ocf,
    freeCashFlow: pick(sheetFcf, fcfFromAV),
    totalDebt: pick(sheetDebt, totalDebtAV),
    cash: pick(sheetCash, cashAV),
    totalEquity: avNum(bs.totalShareholderEquity),
    revenueGrowth: pick(sheetGrowth ? sheetGrowth / 100 : null,
                        avNum(ov.QuarterlyRevenueGrowthYOY) || histRevGrowth),
    earningsGrowth: avNum(ov.QuarterlyEarningsGrowthYOY),
    grossMargin: avNum(ov.GrossProfitTTM) && avNum(ov.RevenueTTM)
      ? avNum(ov.GrossProfitTTM) / avNum(ov.RevenueTTM) : null,
    operatingMargin: pick(sheetMargin ? sheetMargin / 100 : null, avNum(ov.OperatingMarginTTM)),
    profitMargin: avNum(ov.ProfitMargin),
    returnOnEquity: avNum(ov.ReturnOnEquityTTM),
    returnOnAssets: avNum(ov.ReturnOnAssetsTTM),
    priceToBook: avNum(ov.PriceToBookRatio),
    enterpriseValue: pick(sheetMcap, avNum(ov.MarketCapitalization))
      ? pick(sheetMcap, avNum(ov.MarketCapitalization)) + (pick(sheetDebt, totalDebtAV) || 0) - (pick(sheetCash, cashAV) || 0)
      : null,
    evToRevenue: avNum(ov.EVToRevenue),
    evToEbitda: pick(sheetEvEbitda, avNum(ov.EVToEBITDA)),
    dividendYield: pick(sheetDiv ? sheetDiv / 100 : null, avNum(ov.DividendYield)) || 0,
    high52: pick(sheetHigh52, fmpHigh52) || avNum(ov['52WeekHigh']),
    low52: pick(sheetLow52, fmpLow52) || avNum(ov['52WeekLow']),
    description: sheetDescr || (ov.Description ? ov.Description.match(/^[^.]+\./)?.[0]?.trim() : null),
    fullDescription: sheetDescr || ov.Description || null,

    // FMP-prefixed alternate values (for cross-source comparison)
    fmpName, fmpPrice, fmpMarketCap: fmpMcap, fmpBeta, fmpHigh52, fmpLow52,

    // Company info from FMPDATA Apps Script
    exchange: sheetExchange || ov.Exchange || null,
    ceo: sheetCeo || null,
    countryFull: sheetCountry || country || null,
    ipoDate: sheetIpoDate || null,
    website: sheetWebsite || null,
    image: sheetImage || null,
    phone: sheetPhone || null,
    address: sheetAddress || null,
    city: sheetCity || null,
    stateLoc: sheetStateLoc || null,
    employees: sheetEmployees || null,
    isEtf: sheetIsEtf,
    isFund: sheetIsFund,
    isActive: sheetIsActive,
    chartLink: sheetChartLink || null,
  };
}

// ---------- BUILD INPUT FORM FROM STOCK DATA ----------
function buildInputs(stock) {
  // Compute initial values (auto-derived, but user can override every one)
  const fcf = stock.freeCashFlow || ((stock.operatingCashFlow || 0) - stock.capex);

  // Foreign revenue: Yahoo doesn't directly expose it. Use heuristic:
  // - Default 0% for US-only signaling, user adjusts
  // - Many large caps are 30-50% international; we let the user dial it
  const foreignRevPct = 0.30; // sane starting default for large cap

  // CRP weighted by foreign revenue exposure
  const domesticCRP = COUNTRY_RISK[stock.country] ?? 0.0;
  const foreignCRPDefault = 0.015; // weighted average emerging+developed

  state.inputs = {
    // === MARKET / SHARES ===
    currentPrice: stock.price || 0,
    sharesOutstanding: stock.sharesOutstanding || 0,
    marketCap: stock.marketCap || 0,

    // === DCF: CASH FLOWS ===
    fcf: fcf || 0,
    revenue: stock.revenue || 0,
    operatingMargin: (stock.operatingMargin ?? 0.15) * 100, // as %
    taxRate: DEFAULTS.marginalTaxRate * 100,

    // === DCF: GROWTH & HORIZON ===
    growthRate: clamp((stock.revenueGrowth ?? stock.earningsGrowth ?? 0.08) * 100, -10, 40),
    growthYears: DEFAULTS.highGrowthYears,
    terminalGrowth: DEFAULTS.terminalGrowth * 100,

    // === INFLATION (separates real from nominal) ===
    expectedInflation: DEFAULTS.expectedInflation * 100,

    // === COST OF EQUITY (CAPM) ===
    riskFreeRate: DEFAULTS.riskFreeRate * 100,
    beta: stock.beta || DEFAULTS.defaultBeta,
    matureERP: DEFAULTS.matureERP * 100,

    // === COUNTRY / FOREIGN EXPOSURE ===
    homeCountry: stock.country,
    domesticCRP: domesticCRP * 100,
    foreignRevenuePct: foreignRevPct * 100,
    foreignCRP: foreignCRPDefault * 100,

    // === COST OF DEBT ===
    preTaxCostOfDebt: 0.06 * 100,
    totalDebt: stock.totalDebt || 0,
    cash: stock.cash || 0,

    // === RELATIVE VALUATION ===
    sectorPE: stock.pe ? Math.max(8, Math.min(stock.pe * 0.9, 35)) : 18,
    sectorEvEbitda: stock.evToEbitda ? Math.max(6, Math.min(stock.evToEbitda * 0.9, 25)) : 12,
    eps: stock.eps || 0,
    ebitda: stock.ebitda || 0,

    // === 52-WEEK RANGE (informs MC vol prior + sanity bounds) ===
    high52: stock.high52 || 0,
    low52: stock.low52 || 0,

    // === MONTE CARLO ===
    growthVol: 3,        // ± percentage points
    marginVol: 2,        // ± percentage points
    discountVol: 1.5,    // ± percentage points

    // === DISPLAY OPTIONS (toggles, not numeric) ===
    granularity: state.inputs.granularity || DEFAULTS.granularity,
    displayMode: state.inputs.displayMode || DEFAULTS.displayMode,
  };

  renderInputs();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- INPUT RENDERER ----------
const INPUT_GROUPS = [
  // [key, label, unit, tooltip]
  ['currentPrice', 'Current Price', '$', 'Latest market price per share'],
  ['sharesOutstanding', 'Shares Outstanding', '#', 'Diluted shares — used to convert enterprise value to per-share value'],
  ['fcf', 'Free Cash Flow (TTM)', '$', 'Trailing twelve-month free cash flow. The cash the business actually generates after reinvestment.'],
  ['growthRate', 'Growth Rate (Year 1)', '%', 'NOMINAL expected near-term growth (includes inflation). Damodaran: anchor to history but check feasibility at scale.'],
  ['growthYears', 'Projection Horizon', 'yrs', 'Years until the company reaches stable growth. 5–10 typical, 15–20 for high-growth firms with durable advantages. Cash flows fade linearly to terminal growth.'],
  ['terminalGrowth', 'Terminal Growth (nominal)', '%', 'Perpetual nominal growth after high-growth phase. CANNOT exceed the risk-free rate (the proxy for long-run nominal economic growth).'],
  ['expectedInflation', 'Expected Inflation', '%', 'Long-run inflation expectation. Used to convert between nominal (future $) and real (today\'s purchasing power) projections. The model is internally consistent: nominal cash flows + nominal discount rate.'],
  ['riskFreeRate', 'Risk-Free Rate (nominal)', '%', '10-year US Treasury yield — already includes inflation. Real Rf ≈ Nominal Rf − Inflation. The starting point for cost of equity (CAPM).'],
  ['beta', 'Beta', 'β', 'Sensitivity to market movements. >1 = more volatile than market. Bottom-up beta is more reliable than regression beta.'],
  ['matureERP', 'Mature Market ERP', '%', 'Equity risk premium for a mature market like the US (~5.5% historically per Damodaran).'],
  ['domesticCRP', 'Domestic CRP', '%', 'Country Risk Premium for the company\'s home country. Zero for US/developed markets.'],
  ['foreignRevenuePct', 'Foreign Revenue %', '%', 'Percent of revenue from outside the home country. Higher = more diversified country risk.'],
  ['foreignCRP', 'Avg Foreign CRP', '%', 'Weighted-average country risk premium for the company\'s foreign markets.'],
  ['operatingMargin', 'Operating Margin', '%', 'EBIT / Revenue. Used in efficiency-growth checks.'],
  ['taxRate', 'Marginal Tax Rate', '%', 'Long-run tax rate. Use marginal, not effective, for long-horizon models.'],
  ['preTaxCostOfDebt', 'Cost of Debt (pre-tax)', '%', 'What the company pays to borrow today. Risk-free + default spread.'],
  ['totalDebt', 'Total Debt', '$', 'Used in WACC weighting and net-debt adjustment.'],
  ['cash', 'Cash & Equivalents', '$', 'Subtracted as net debt — adds to per-share equity value.'],
  ['sectorPE', 'Sector P/E', 'x', 'Peer-group P/E multiple. The relative-valuation lens.'],
  ['eps', 'EPS (TTM)', '$', 'Trailing earnings per share. Multiplied by sector P/E for relative value.'],
  ['sectorEvEbitda', 'Sector EV/EBITDA', 'x', 'Peer-group EV/EBITDA multiple. Less manipulable than P/E.'],
  ['ebitda', 'EBITDA', '$', 'Earnings before interest, tax, depreciation, amortization.'],
  ['high52', '52-Week High', '$', 'Highest price in the last 52 weeks. Used as a sanity check on Monte Carlo upper bound.'],
  ['low52', '52-Week Low', '$', 'Lowest price in the last 52 weeks. Used as a sanity check on Monte Carlo lower bound.'],
  ['growthVol', 'MC: Growth σ', '±%', 'Standard deviation for growth rate in Monte Carlo simulation.'],
  ['marginVol', 'MC: Margin σ', '±%', 'Standard deviation for margins in Monte Carlo.'],
  ['discountVol', 'MC: Discount Rate σ', '±%', 'Standard deviation for discount rate in Monte Carlo.'],
];

// Format a big number for editable inputs: 1500000000 → "1.50B", 250000000 → "250.00M", 15000 → "15000"
// Reverse-parseable by parseHumanNumber()
function formatHumanNumber(n) {
  if (n == null || !isFinite(n)) return '0';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e4) return sign + Math.round(abs).toString();
  if (abs % 1 === 0) return sign + abs.toString();
  return sign + abs.toFixed(2);
}

// Parse a string like "1.5B", "250M", "15000", "-3.2K" into a number.
// Plain numbers (e.g. "1500000000") also work.
function parseHumanNumber(s) {
  if (typeof s === 'number') return s;
  if (s == null || s === '') return NaN;
  const cleaned = String(s).trim().replace(/[$,\s]/g, '');
  const m = cleaned.match(/^(-?[\d.]+)([KMBT])?$/i);
  if (!m) return parseFloat(cleaned);
  const base = parseFloat(m[1]);
  if (!isFinite(base)) return NaN;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  return m[2] ? base * mult[m[2].toUpperCase()] : base;
}

// Which input keys represent large dollar amounts that should use M/B/T notation
const LARGE_INPUTS = new Set([
  'sharesOutstanding', 'marketCap', 'fcf', 'revenue', 'totalDebt', 'cash', 'ebitda'
]);

function renderInputs() {
  const wrap = document.getElementById('inputs');
  wrap.innerHTML = INPUT_GROUPS.map(([key, label, unit, tip]) => {
    const v = state.inputs[key];
    let formatted;
    if (typeof v !== 'number') {
      formatted = v;
    } else if (LARGE_INPUTS.has(key)) {
      formatted = formatHumanNumber(v);
    } else if (v % 1 === 0) {
      formatted = v.toString();
    } else {
      formatted = v.toFixed(2);
    }
    return `
      <div class="input-cell">
        <label>
          <span data-tip="${tip}">${label}</span>
          <span class="unit">${unit}</span>
        </label>
        <input type="text" data-key="${key}" value="${formatted}" />
      </div>
    `;
  }).join('');

  wrap.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', e => {
      const key = e.target.dataset.key;
      const val = LARGE_INPUTS.has(key)
        ? parseHumanNumber(e.target.value)
        : parseFloat(e.target.value);
      if (!isNaN(val)) {
        state.inputs[key] = val;
        // If the user edited the price, mirror it into state.stock so summary card reflects it
        if (key === 'currentPrice' && state.stock) {
          state.stock.price = val;
          state.stock._priceOverridden = true;
        }
        if (key === 'marketCap' && state.stock) {
          state.stock.marketCap = val;
        }
        // Re-render summary card so the visible price/market cap stays in sync with edits
        if (state.stock && (key === 'currentPrice' || key === 'marketCap')) {
          renderSummary(state.stock);
        }
        recalculate();
      }
    });
  });
}

// ============================================================
//   VALUATION METHODS
// ============================================================

// ---------- CAPM Cost of Equity (Damodaran's lambda approach #2) ----------
// E(Return) = Rf + Beta * (Mature ERP + CRP)
// Where CRP is weighted by domestic vs foreign revenue exposure
function costOfEquity(i) {
  const rf = i.riskFreeRate / 100;
  const beta = i.beta;
  const erp = i.matureERP / 100;

  // Operation-based CRP: weighted avg of domestic and foreign CRPs
  const fwt = i.foreignRevenuePct / 100;
  const dwt = 1 - fwt;
  const blendedCRP = dwt * (i.domesticCRP / 100) + fwt * (i.foreignCRP / 100);

  // Approach 2: company exposure to country risk like other market risk
  const coe = rf + beta * (erp + blendedCRP);
  return { coe, blendedCRP, rf, beta, erp };
}

// ---------- WACC ----------
function wacc(i) {
  const { coe } = costOfEquity(i);
  const cod = i.preTaxCostOfDebt / 100;
  const t = i.taxRate / 100;
  const E = i.marketCap;
  const D = i.totalDebt;
  const V = E + D;
  if (V <= 0) return coe; // pure equity fallback
  const we = E / V;
  const wd = D / V;
  return we * coe + wd * cod * (1 - t);
}

// ---------- DCF (FCF to firm, two-stage with full projection schedule) ----------
//
// Conventions (Damodaran):
//   - All cash flows and rates are NOMINAL by default (include inflation)
//   - Internal consistency: nominal flows + nominal discount rate
//   - "Real" view divides nominal flows by (1+inflation)^t for display only
//   - Quarterly mode converts annual rates to per-period equivalents
//
function dcfValue(i) {
  const annualR = wacc(i);                                  // nominal WACC, annual
  const g1 = i.growthRate / 100;                            // nominal year-1 growth
  const gT = Math.min(i.terminalGrowth / 100, i.riskFreeRate / 100); // cap at Rf
  const inflation = (i.expectedInflation || 0) / 100;
  const totalYears = Math.round(i.growthYears);
  const fcf0 = i.fcf;

  const isQuarterly = i.granularity === 'quarterly';
  const periodsPerYear = isQuarterly ? 4 : 1;
  const periods = totalYears * periodsPerYear;

  // Convert annual rates to per-period (geometric, not naive division)
  const r = Math.pow(1 + annualR, 1 / periodsPerYear) - 1;
  const periodG1 = Math.pow(1 + g1, 1 / periodsPerYear) - 1;
  const periodGT = Math.pow(1 + gT, 1 / periodsPerYear) - 1;
  const periodInflation = Math.pow(1 + inflation, 1 / periodsPerYear) - 1;

  if (fcf0 <= 0 || annualR <= gT) {
    return fallbackDcf(i, annualR, g1, gT, totalYears);
  }

  const schedule = [];
  let cumulativePV = 0;
  let fcf = fcf0;
  // Spread the existing TTM FCF across the periods if we're starting partway in
  if (isQuarterly) fcf = fcf0 / 4; // start with quarterly FCF base

  for (let t = 1; t <= periods; t++) {
    // Linear fade from g1 to gT across the high-growth window
    const fade = (t - 1) / Math.max(periods - 1, 1);
    const periodGrowth = periodG1 + (periodGT - periodG1) * fade;
    const annualEquivGrowth = Math.pow(1 + periodGrowth, periodsPerYear) - 1;

    fcf = fcf * (1 + periodGrowth);
    const discountFactor = Math.pow(1 + r, t);
    const pv = fcf / discountFactor;
    cumulativePV += pv;

    // "Real" values deflate nominal by (1+inflation)^t
    const inflationFactor = Math.pow(1 + periodInflation, t);
    const realFcf = fcf / inflationFactor;
    const realPv = pv / inflationFactor;

    schedule.push({
      period: t,
      label: isQuarterly ? `Q${((t - 1) % 4) + 1} Y${Math.floor((t - 1) / 4) + 1}` : `Year ${t}`,
      year: t / periodsPerYear,
      growthRate: annualEquivGrowth,        // shown as annualized for readability
      nominalFcf: fcf,
      realFcf,
      discountFactor,
      nominalPv: pv,
      realPv,
      cumulativePV,
    });
  }

  // Terminal value (nominal, at end of horizon)
  const finalFcf = schedule[schedule.length - 1].nominalFcf;
  const tvCashFlow = finalFcf * (1 + periodGT);
  const tv = tvCashFlow / (r - periodGT);
  const tvPV = tv / Math.pow(1 + r, periods);

  const enterpriseValue = cumulativePV + tvPV;
  const equityValue = enterpriseValue - i.totalDebt + i.cash;
  const perShare = equityValue / i.sharesOutstanding;

  return {
    enterpriseValue, equityValue, perShare,
    discountRate: annualR, terminalValue: tv, terminalPV: tvPV,
    pvOperatingCF: cumulativePV,
    tvFraction: tvPV / enterpriseValue,
    schedule,
    granularity: i.granularity,
    inflation,
    realPerShare: perShare / Math.pow(1 + inflation, totalYears),
    fallback: false,
  };
}

// Used when FCF isn't positive — derive from revenue & margin assumptions
function fallbackDcf(i, annualR, g1, gT, totalYears) {
  const inflation = (i.expectedInflation || 0) / 100;
  const isQuarterly = i.granularity === 'quarterly';
  const periodsPerYear = isQuarterly ? 4 : 1;
  const periods = totalYears * periodsPerYear;

  const r = Math.pow(1 + annualR, 1 / periodsPerYear) - 1;
  const periodG1 = Math.pow(1 + g1, 1 / periodsPerYear) - 1;
  const periodGT = Math.pow(1 + gT, 1 / periodsPerYear) - 1;
  const periodInflation = Math.pow(1 + inflation, 1 / periodsPerYear) - 1;

  let rev = isQuarterly ? i.revenue / 4 : i.revenue;
  const margin = i.operatingMargin / 100;
  const tax = i.taxRate / 100;
  const ROIC = 0.12; // assumed reinvestment efficiency

  const schedule = [];
  let cumulativePV = 0;
  let nopat = 0;

  for (let t = 1; t <= periods; t++) {
    const fade = (t - 1) / Math.max(periods - 1, 1);
    const periodGrowth = periodG1 + (periodGT - periodG1) * fade;
    const annualEquivGrowth = Math.pow(1 + periodGrowth, periodsPerYear) - 1;

    rev = rev * (1 + periodGrowth);
    nopat = rev * margin * (1 - tax);
    // Reinvestment rate scales with growth and ROIC
    const reinvestRate = Math.min(annualEquivGrowth / ROIC, 0.8);
    const fcf = nopat * (1 - reinvestRate);
    const discountFactor = Math.pow(1 + r, t);
    const pv = fcf / discountFactor;
    cumulativePV += pv;

    const inflationFactor = Math.pow(1 + periodInflation, t);
    schedule.push({
      period: t,
      label: isQuarterly ? `Q${((t - 1) % 4) + 1} Y${Math.floor((t - 1) / 4) + 1}` : `Year ${t}`,
      year: t / periodsPerYear,
      growthRate: annualEquivGrowth,
      nominalFcf: fcf,
      realFcf: fcf / inflationFactor,
      discountFactor,
      nominalPv: pv,
      realPv: pv / inflationFactor,
      cumulativePV,
    });
  }

  const finalNopat = nopat;
  const finalFcf = finalNopat * (1 - gT / ROIC);
  const tv = (finalFcf * (1 + gT)) / (annualR - gT);
  const tvPV = tv / Math.pow(1 + annualR, totalYears);
  const ev = cumulativePV + tvPV;
  const eq = ev - i.totalDebt + i.cash;
  return {
    enterpriseValue: ev, equityValue: eq,
    perShare: eq / i.sharesOutstanding,
    discountRate: annualR, terminalValue: tv, terminalPV: tvPV,
    pvOperatingCF: cumulativePV,
    tvFraction: tvPV / ev,
    schedule,
    granularity: i.granularity,
    inflation,
    realPerShare: (eq / i.sharesOutstanding) / Math.pow(1 + inflation, totalYears),
    fallback: true,
  };
}

// ---------- Relative Valuation ----------
function relativeValue(i) {
  const peValue = i.eps > 0 ? i.eps * i.sectorPE : null;
  const evEbitda = i.ebitda > 0 ? i.ebitda * i.sectorEvEbitda : null;
  const ebitdaEquity = evEbitda != null
    ? (evEbitda - i.totalDebt + i.cash) / i.sharesOutstanding
    : null;

  // Blend the two if both available
  let blended = null;
  if (peValue != null && ebitdaEquity != null) {
    blended = (peValue + ebitdaEquity) / 2;
  } else {
    blended = peValue ?? ebitdaEquity;
  }
  return { peValue, evEbitdaPerShare: ebitdaEquity, blended };
}

// ---------- Pure CAPM Justified Price (using Gordon dividend) ----------
// A simpler check: what price is justified by the cost of equity alone?
// V = D1 / (r - g) — using FCF/share as proxy when no dividend
function capmJustified(i) {
  const { coe } = costOfEquity(i);
  const fcfPerShare = i.fcf / i.sharesOutstanding;
  const g = Math.min(i.terminalGrowth / 100, coe - 0.005);
  if (coe - g < 0.005) return { perShare: null, coe };
  const v = (fcfPerShare * (1 + g)) / (coe - g);
  return { perShare: v, coe };
}

// ---------- Monte Carlo ----------
// Simulate the DCF with random draws on growth, margin, discount rate.
// 52-week range, when available, informs the MC vol prior:
// realized 52w volatility = (high - low) / midpoint  →  scales growth/margin σ.
function monteCarlo(i, n = 10000) {
  const results = [];
  const inputs = { ...i };
  inputs.granularity = 'annual';

  // 52-week realized range as a sanity prior on uncertainty
  let realizedVolMultiplier = 1;
  let upperSanityCap = i.currentPrice * 20;
  let lowerSanityFloor = 0;
  if (i.high52 && i.low52 && i.high52 > i.low52 && i.currentPrice) {
    const mid = (i.high52 + i.low52) / 2;
    const range52 = (i.high52 - i.low52) / mid; // proportional range
    // Scale vol prior: stocks that swung 80% over 52w have more model uncertainty
    // than stocks that ranged 15%. Cap the multiplier so it doesn't go crazy.
    realizedVolMultiplier = Math.max(0.5, Math.min(2.5, range52 / 0.30));
    // Sanity bounds: don't accept fair values >3x the 52w high or below the 52w low
    upperSanityCap = i.high52 * 3;
    lowerSanityFloor = i.low52 * 0.25;
  }

  const gv = i.growthVol * realizedVolMultiplier;
  const mv = i.marginVol * realizedVolMultiplier;
  const dv = i.discountVol * realizedVolMultiplier;

  for (let k = 0; k < n; k++) {
    inputs.growthRate = i.growthRate + boxMuller() * gv;
    inputs.operatingMargin = Math.max(0, i.operatingMargin + boxMuller() * mv);
    inputs.beta = Math.max(0.1, i.beta + boxMuller() * (dv / 5));
    inputs.terminalGrowth = Math.min(i.terminalGrowth, i.riskFreeRate - 0.5);

    const dcf = dcfValue(inputs);
    if (dcf && isFinite(dcf.perShare) &&
        dcf.perShare > lowerSanityFloor &&
        dcf.perShare < upperSanityCap) {
      results.push(dcf.perShare);
    }
  }
  results.sort((a, b) => a - b);
  return results;
}

// Box-Muller transform for normal distribution
function boxMuller() {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ============================================================
//   MAIN RECALCULATION
// ============================================================
function recalculate() {
  const i = state.inputs;
  if (!i.sharesOutstanding || !i.currentPrice) return;

  const dcf = dcfValue(i);
  const rel = relativeValue(i);
  const capm = capmJustified(i);
  const coeData = costOfEquity(i);
  const w = wacc(i);

  state.results = { dcf, rel, capm, coeData, wacc: w };

  // Run Monte Carlo (debounced)
  clearTimeout(state.mcTimer);
  const mcStatus = document.getElementById('mc-status');
  if (mcStatus) mcStatus.textContent = 'Computing 10,000 simulations…';
  state.mcTimer = setTimeout(() => {
    const t0 = performance.now();
    state.mcResults = monteCarlo(i, 10000);
    const elapsed = performance.now() - t0;
    if (mcStatus) {
      mcStatus.textContent = `${state.mcResults.length.toLocaleString()} valid simulations · ${elapsed.toFixed(0)}ms`;
    }
    renderMonteCarlo();
  }, 200);

  renderResults();
  renderProjection();
}

// ============================================================
//   RENDERING
// ============================================================
function fmt$(n, dec = 2) {
  if (n == null || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1e12) return '$' + (n/1e12).toFixed(2) + 'T';
  if (Math.abs(n) >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  return '$' + n.toFixed(dec);
}
function fmtPct(n, dec = 2) {
  if (n == null || !isFinite(n)) return '—';
  return (n * 100).toFixed(dec) + '%';
}
function fmtNum(n, dec = 2) {
  if (n == null || !isFinite(n)) return '—';
  return n.toFixed(dec);
}

function renderSummary(s) {
  document.getElementById('s-name').textContent = s.name;
  document.getElementById('s-tic').textContent = s.ticker;
  document.getElementById('s-price').textContent = fmt$(s.price);
  document.getElementById('s-mcap').textContent = fmt$(s.marketCap);
  document.getElementById('s-pe').textContent = fmtNum(s.pe);
  document.getElementById('s-beta').textContent = fmtNum(s.beta);
  document.getElementById('s-eps').textContent = fmt$(s.eps);

  // Logo from FMPDATA "image" column
  const logoEl = document.getElementById('s-logo');
  if (logoEl) {
    if (s.image && /^https?:\/\//.test(s.image)) {
      logoEl.src = s.image;
      logoEl.style.display = '';
      logoEl.onerror = () => { logoEl.style.display = 'none'; };
    } else {
      logoEl.style.display = 'none';
    }
  }

  // Top-right meta: website link · ticker exchange · IPO date
  const metaEl = document.getElementById('s-meta');
  if (metaEl) {
    const parts = [];
    if (s.website) {
      const cleanUrl = s.website.replace(/\/$/, '');
      const display = cleanUrl.replace(/^https?:\/\//, '').replace(/^www\./, '');
      parts.push(`<a href="${cleanUrl}" target="_blank" rel="noopener">${escapeHtml(display)}</a>`);
    }
    if (s.exchange) parts.push(`<span>${escapeHtml(s.exchange)}</span>`);
    if (s.ipoDate) parts.push(`<span>IPO ${s.ipoDate.slice(0, 10)}</span>`);
    metaEl.innerHTML = parts.join('<br>');
  }

  // Company info row: CEO · Country · Employees · Address
  const ciEl = document.getElementById('s-company-info');
  if (ciEl) {
    const items = [];
    if (s.ceo)        items.push(`<span><span class="ci-label">CEO</span><span class="ci-value">${escapeHtml(s.ceo)}</span></span>`);
    if (s.countryFull && s.countryFull !== '—') items.push(`<span><span class="ci-label">Country</span><span class="ci-value">${escapeHtml(s.countryFull)}</span></span>`);
    if (s.city || s.stateLoc) {
      const loc = [s.city, s.stateLoc].filter(Boolean).join(', ');
      items.push(`<span><span class="ci-label">HQ</span><span class="ci-value">${escapeHtml(loc)}</span></span>`);
    }
    if (s.employees) items.push(`<span><span class="ci-label">Employees</span><span class="ci-value">${s.employees.toLocaleString()}</span></span>`);
    if (s.exchange && !metaEl?.textContent) items.push(`<span><span class="ci-label">Exchange</span><span class="ci-value">${escapeHtml(s.exchange)}</span></span>`);
    if (items.length > 0) {
      ciEl.innerHTML = items.join('');
      ciEl.style.display = '';
    } else {
      ciEl.style.display = 'none';
    }
  }

  // Pull taxonomy from Stock Book if the live stock object is missing it.
  // Sheet is authoritative — the stockbook row already carries the user-curated values.
  const sbRow = state.stockbook?.rows?.find(r => r.ticker === s.ticker);
  if (sbRow) {
    if (!s.sector && sbRow.sector)             s.sector       = sbRow.sector;
    if (!s.subSector && sbRow.subSector)       s.subSector    = sbRow.subSector;
    if (!s.industry && sbRow.industry)         s.industry     = sbRow.industry;
    if (!s.function && sbRow.function)         s.function     = sbRow.function;
    if (!s.coreSegments && sbRow.coreSegments) s.coreSegments = sbRow.coreSegments;
    if (!s.description && sbRow.description)   s.description  = sbRow.description;
    if (sbRow.isDerivative != null)            s.isDerivative = sbRow.isDerivative;
    if (sbRow.instrumentType)                  s.instrumentType = sbRow.instrumentType;
  }

  // Build sector display string. For derivatives, show function · sub-sector.
  // For equities, show sector · sub-sector · industry (whichever are set).
  let sectorDisplay = '—';
  if (s.isDerivative && s.function) {
    const parts = [s.function];
    if (s.subSector) parts.push(s.subSector);
    sectorDisplay = parts.join(' · ');
  } else {
    const parts = [];
    if (s.sector) parts.push(s.sector);
    if (s.subSector) parts.push(s.subSector);
    else if (s.industry) parts.push(s.industry);
    if (parts.length) sectorDisplay = parts.join(' · ');
  }
  document.getElementById('s-sector').textContent = sectorDisplay;
  document.getElementById('s-description').textContent = s.description || '';

  // 52W range mini-bar
  const wrap = document.getElementById('s-52w-bar-wrap');
  const range = document.getElementById('s-52w');
  if (s.high52 && s.low52 && s.price && s.high52 > s.low52) {
    range.textContent = `$${s.low52.toFixed(2)} – $${s.high52.toFixed(2)}`;
    const pct = (s.price - s.low52) / (s.high52 - s.low52);
    const clamped = Math.max(0, Math.min(1, pct));
    document.getElementById('s-52w-low').textContent = '$' + s.low52.toFixed(2);
    document.getElementById('s-52w-high').textContent = '$' + s.high52.toFixed(2);
    document.getElementById('s-52w-pct').textContent = (clamped * 100).toFixed(0) + '% of range';
    document.getElementById('s-52w-fill').style.width = (clamped * 100) + '%';
    document.getElementById('s-52w-marker').style.left = (clamped * 100) + '%';
    wrap.style.display = 'block';
  } else {
    range.textContent = '—';
    wrap.style.display = 'none';
  }

  document.getElementById('summary').classList.add('visible');

  // Today's price action strip (sheet-driven, fast, no API needed)
  renderTodayStrip(s);

  // Cross-source market cap verification (async, non-blocking)
  renderMarketCapCheck(s).catch(() => {});

  // Wire sector click → override modal (only if stockbook has the row)
  const sectorEl = document.getElementById('s-sector');
  if (sectorEl) {
    sectorEl.onclick = () => {
      const sbRow = state.stockbook?.rows?.find(r => r.ticker === s.ticker);
      if (sbRow) openOverrideModal(s.ticker);
      else alert('Load Stock Book first to enable overrides');
    };
  }

  // Lazy-fetch sector + description ONLY if both still missing (sheet/stockbook is authoritative)
  if ((!s.sector || !s.description) && s.ticker) {
    enrichTicker(s.ticker, s.name).then(enriched => {
      if (!enriched) return;
      if (state.stock?.ticker !== s.ticker) return;
      if (!s.sector && enriched.sector) {
        s.sector = enriched.sector;
        // Re-render the sector cell with the same logic
        renderSummary(s);
        return;
      }
      if (!s.industry && enriched.industry) s.industry = enriched.industry;
      if (!s.description && enriched.description) {
        s.description = enriched.description;
        document.getElementById('s-description').textContent = enriched.description;
      }
    }).catch(() => {});
  }
}

function renderResults() {
  const i = state.inputs;
  const { dcf, rel, capm, coeData, wacc: w } = state.results;
  const price = i.currentPrice;

  // Blended fair value: average of available estimates, weighted toward DCF
  const candidates = [];
  if (dcf?.perShare > 0) candidates.push({ v: dcf.perShare, weight: 2 });
  if (rel.blended > 0) candidates.push({ v: rel.blended, weight: 1 });
  if (capm.perShare > 0) candidates.push({ v: capm.perShare, weight: 1 });

  let blended = null;
  if (candidates.length) {
    const sumW = candidates.reduce((a, c) => a + c.weight, 0);
    blended = candidates.reduce((a, c) => a + c.v * c.weight, 0) / sumW;
  }

  document.getElementById('v-fair').textContent = fmt$(blended);
  document.getElementById('v-fair-sub').textContent =
    `DCF ${fmt$(dcf?.perShare)} · Relative ${fmt$(rel.blended)} · CAPM ${fmt$(capm.perShare)}`;

  if (blended && price) {
    const mos = (blended - price) / price;
    const el = document.getElementById('v-mos');
    const sub = document.getElementById('v-mos-sub');
    el.textContent = (mos >= 0 ? '+' : '') + (mos * 100).toFixed(1) + '%';
    el.style.color = mos > 0.10 ? 'var(--green)' : (mos < -0.10 ? 'var(--red)' : 'var(--amber)');
    sub.textContent = mos > 0.10 ? 'UNDERVALUED — market may be missing something'
                    : mos < -0.10 ? 'OVERVALUED — market expects more than fundamentals support'
                    : 'FAIRLY VALUED — market and model agree';
    sub.className = 'sub ' + (mos > 0 ? 'pos' : 'neg');
  }

  // Method cards
  const methodsHTML = [
    {
      num: '01',
      name: 'Discounted Cash Flow',
      sub: 'Intrinsic · two-stage',
      value: fmt$(dcf?.perShare),
      delta: deltaTag(dcf?.perShare, price),
      detail: `
        <strong>WACC:</strong> ${fmtPct(w)}<br>
        <strong>Terminal value share:</strong> ${fmtPct(dcf?.tvFraction)}<br>
        <strong>Method:</strong> ${dcf?.fallback ? 'Margin-based (FCF≤0)' : 'FCF-based'}<br>
        <em style="color:var(--ink-faint)">Cash flows projected ${i.growthYears} years, then perpetuity.</em>
      `
    },
    {
      num: '02',
      name: 'CAPM Justified',
      sub: 'Cost of equity model',
      value: fmt$(capm.perShare),
      delta: deltaTag(capm.perShare, price),
      detail: `
        <strong>Cost of Equity:</strong> ${fmtPct(coeData.coe)}<br>
        <strong>Risk-Free + β·ERP:</strong> ${fmtPct(coeData.rf)} + ${coeData.beta.toFixed(2)}·${fmtPct(coeData.erp + coeData.blendedCRP)}<br>
        <strong>Blended CRP:</strong> ${fmtPct(coeData.blendedCRP)}<br>
        <em style="color:var(--ink-faint)">Damodaran approach #2: country risk via beta.</em>
      `
    },
    {
      num: '03',
      name: 'Relative Valuation',
      sub: 'Multiples · sector peers',
      value: fmt$(rel.blended),
      delta: deltaTag(rel.blended, price),
      detail: `
        <strong>P/E × EPS:</strong> ${fmt$(rel.peValue)}<br>
        <strong>EV/EBITDA implied:</strong> ${fmt$(rel.evEbitdaPerShare)}<br>
        <em style="color:var(--ink-faint)">Markets right on average, wrong on individuals — Damodaran.</em>
      `
    },
    {
      num: '04',
      name: 'Monte Carlo',
      sub: '10,000 simulations',
      value: state.mcResults && state.mcResults.length
        ? fmt$(percentile(state.mcResults, 0.5))
        : '…',
      delta: state.mcResults && state.mcResults.length
        ? deltaTag(percentile(state.mcResults, 0.5), price)
        : '<span style="color:var(--ink-faint)">computing…</span>',
      detail: state.mcResults && state.mcResults.length ? `
        <strong>5th–95th pctile:</strong> ${fmt$(percentile(state.mcResults, 0.05))} – ${fmt$(percentile(state.mcResults, 0.95))}<br>
        <strong>P(undervalued):</strong> ${(state.mcResults.filter(v => v > price).length / state.mcResults.length * 100).toFixed(1)}%<br>
        <em style="color:var(--ink-faint)">Probability bands across uncertainty in growth, margin, discount.</em>
      ` : '<em style="color:var(--ink-faint)">Running simulations…</em>'
    },
  ].map(m => `
    <div class="method-card" data-num="${m.num}">
      <h3>${m.name}</h3>
      <div class="method-sub">${m.sub}</div>
      <div class="method-value">${m.value}</div>
      <div class="method-delta">${m.delta}</div>
      <div class="method-detail">${m.detail}</div>
    </div>
  `).join('');
  document.getElementById('methods').innerHTML = methodsHTML;
}

function deltaTag(estimate, price) {
  if (!estimate || !price) return '<span style="color:var(--ink-faint)">—</span>';
  const d = (estimate - price) / price;
  const cls = d > 0 ? 'pos' : 'neg';
  const color = d > 0 ? 'var(--green)' : 'var(--red)';
  return `<span style="color:${color}">${(d>=0?'+':'') + (d * 100).toFixed(1)}% vs market</span>`;
}

// ---------- PROJECTION TABLE ----------
function renderProjection() {
  const wrap = document.getElementById('projection-table-wrap');
  if (!wrap) return;
  const dcf = state.results.dcf;
  if (!dcf?.schedule) {
    wrap.innerHTML = '<div class="empty">DCF unavailable — check inputs</div>';
    return;
  }

  const real = state.inputs.displayMode === 'real';
  const fcfKey = real ? 'realFcf' : 'nominalFcf';
  const pvKey = real ? 'realPv' : 'nominalPv';
  const granLabel = state.inputs.granularity === 'quarterly' ? 'Quarter' : 'Year';

  // Find max FCF magnitude for the inline bar visualization
  const maxFcf = Math.max(...dcf.schedule.map(p => Math.abs(p[fcfKey])));

  const rows = dcf.schedule.map(p => {
    const barWidth = maxFcf > 0 ? (Math.abs(p[fcfKey]) / maxFcf * 60) : 0;
    return `
      <tr>
        <td>${p.label}</td>
        <td>${(p.growthRate * 100).toFixed(2)}%</td>
        <td class="proj-bar-cell">
          ${fmt$(p[fcfKey])}
          <span class="proj-bar" style="width:${barWidth}px"></span>
        </td>
        <td>${p.discountFactor.toFixed(3)}</td>
        <td>${fmt$(p[pvKey])}</td>
        <td>${fmt$(p.cumulativePV)}</td>
      </tr>
    `;
  }).join('');

  // Terminal value handling for the display mode
  const displayTV = real
    ? dcf.terminalPV / Math.pow(1 + dcf.inflation, state.inputs.growthYears)
    : dcf.terminalPV;

  wrap.innerHTML = `
    <div class="proj-table-wrap">
      <table class="proj-table">
        <thead>
          <tr>
            <th>${granLabel}</th>
            <th>Growth (annualized)</th>
            <th>FCF ${real ? '(real)' : '(nominal)'}</th>
            <th>Discount factor</th>
            <th>PV ${real ? '(real)' : '(nominal)'}</th>
            <th>Cumulative PV</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td>Terminal Value (PV)</td>
            <td>—</td>
            <td>—</td>
            <td>—</td>
            <td>${fmt$(displayTV)}</td>
            <td>${fmt$(dcf.pvOperatingCF + dcf.terminalPV)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div class="proj-summary">
      <div><div class="l">Discount Rate (WACC)</div><div class="v">${fmtPct(dcf.discountRate)}</div></div>
      <div><div class="l">Inflation Assumption</div><div class="v">${fmtPct(dcf.inflation)}</div></div>
      <div><div class="l">Real Discount Rate</div><div class="v">${fmtPct((1 + dcf.discountRate) / (1 + dcf.inflation) - 1)}</div></div>
      <div><div class="l">Periods Modeled</div><div class="v">${dcf.schedule.length}</div></div>
      <div><div class="l">Terminal Value Share</div><div class="v">${fmtPct(dcf.tvFraction)}</div></div>
      <div><div class="l">Per-Share (${real ? 'real' : 'nominal'})</div><div class="v">${fmt$(real ? dcf.realPerShare : dcf.perShare)}</div></div>
    </div>
  `;
}

// ---------- MONTE CARLO HISTOGRAM ----------
function renderMonteCarlo() {
  const r = state.mcResults;
  if (!r || r.length === 0) return;

  const canvas = document.getElementById('mc-canvas');
  const ctx = canvas.getContext('2d');

  // Make the canvas hi-dpi
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  const W = cssW, H = cssH;
  ctx.clearRect(0, 0, W, H);

  // Histogram
  const min = percentile(r, 0.01);
  const max = percentile(r, 0.99);
  const bins = 60;
  const range = max - min;
  const binW = range / bins;
  const counts = new Array(bins).fill(0);
  r.forEach(v => {
    if (v >= min && v <= max) {
      const idx = Math.min(Math.floor((v - min) / binW), bins - 1);
      counts[idx]++;
    }
  });
  const maxCount = Math.max(...counts);

  const padL = 40, padR = 20, padT = 20, padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const price = state.inputs.currentPrice;
  const median = percentile(r, 0.5);
  const p5 = percentile(r, 0.05);
  const p95 = percentile(r, 0.95);

  // Draw bars
  counts.forEach((c, idx) => {
    const x = padL + (idx / bins) * plotW;
    const w = plotW / bins - 1;
    const h = (c / maxCount) * plotH;
    const valAtBin = min + (idx + 0.5) * binW;
    // Color by under/over current price
    const isUnder = valAtBin > price;
    ctx.fillStyle = isUnder ? 'rgba(107, 155, 111, 0.7)' : 'rgba(181, 104, 86, 0.7)';
    ctx.fillRect(x, padT + plotH - h, w, h);
  });

  // Vertical lines
  function vline(val, color, label, dashed = false) {
    if (val < min || val > max) return;
    const x = padL + ((val - min) / range) * plotW;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    if (dashed) ctx.setLineDash([4, 4]); else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '10px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, padT - 6);
  }

  vline(price, '#e8dfc9', `MARKET $${price.toFixed(2)}`);
  vline(median, '#d4a24c', `MEDIAN $${median.toFixed(2)}`, true);
  vline(p5, '#8a8275', `P5`, true);
  vline(p95, '#8a8275', `P95`, true);

  // X-axis labels
  ctx.fillStyle = '#8a8275';
  ctx.font = '10px JetBrains Mono';
  ctx.textAlign = 'left';
  ctx.fillText('$' + min.toFixed(0), padL, padT + plotH + 18);
  ctx.textAlign = 'right';
  ctx.fillText('$' + max.toFixed(0), W - padR, padT + plotH + 18);
  ctx.textAlign = 'center';
  ctx.fillText('Estimated Per-Share Value Distribution', W/2, H - 8);

  // Y label
  ctx.save();
  ctx.translate(12, padT + plotH/2);
  ctx.rotate(-Math.PI/2);
  ctx.textAlign = 'center';
  ctx.fillText('Frequency', 0, 0);
  ctx.restore();

  // Stats grid
  const probUnder = r.filter(v => v > price).length / r.length;
  const stats = [
    { l: 'Mean', v: '$' + (r.reduce((a,b)=>a+b,0)/r.length).toFixed(2) },
    { l: 'Median', v: '$' + median.toFixed(2) },
    { l: 'P5', v: '$' + p5.toFixed(2) },
    { l: 'P95', v: '$' + p95.toFixed(2) },
    { l: 'P(undervalued)', v: (probUnder * 100).toFixed(1) + '%' },
  ];
  document.getElementById('mc-stats').innerHTML = stats.map(s =>
    `<div class="mc-stat"><div class="l">${s.l}</div><div class="v">${s.v}</div></div>`
  ).join('');
}

// ============================================================
//   PERSISTENCE (localStorage)
// ============================================================
const STORAGE_KEY = 'valuatio.savedValuations.v1';

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}
function writeSaved(arr) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
}

function saveCurrent() {
  if (!state.stock) return;
  const arr = loadSaved();
  const entry = {
    id: Date.now(),
    ticker: state.stock.ticker,
    name: state.stock.name,
    sector: state.stock.sector,
    industry: state.stock.industry,
    price: state.inputs.currentPrice,
    fairValue: getBlendedFairValue(),
    inputs: { ...state.inputs },
    savedAt: new Date().toISOString(),
  };
  // Replace previous valuation for the same ticker
  const filtered = arr.filter(a => a.ticker !== entry.ticker);
  filtered.unshift(entry);
  writeSaved(filtered.slice(0, 100));
  renderSaved();
  flashStatus('Saved ' + entry.ticker, 'success');
}

function getBlendedFairValue() {
  const { dcf, rel, capm } = state.results;
  const cands = [];
  if (dcf?.perShare > 0) cands.push({ v: dcf.perShare, w: 2 });
  if (rel.blended > 0) cands.push({ v: rel.blended, w: 1 });
  if (capm.perShare > 0) cands.push({ v: capm.perShare, w: 1 });
  if (!cands.length) return null;
  const sw = cands.reduce((a, c) => a + c.w, 0);
  return cands.reduce((a, c) => a + c.v * c.w, 0) / sw;
}

function renderSaved() {
  const list = loadSaved();
  const el = document.getElementById('saved-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">No saved valuations yet. Run a valuation and click Save.</div>';
    return;
  }
  el.innerHTML = list.map(v => {
    const mos = v.fairValue && v.price ? ((v.fairValue - v.price) / v.price * 100) : null;
    const mosColor = mos == null ? 'var(--ink-faint)' : (mos > 10 ? 'var(--green)' : mos < -10 ? 'var(--red)' : 'var(--amber)');
    return `
      <div class="saved-item" data-id="${v.id}">
        <button class="s-del" data-del="${v.id}" title="Delete">×</button>
        <div class="s-tic">${v.ticker}</div>
        <div class="s-name">${v.name}</div>
        <div class="s-val">
          $${v.price?.toFixed(2)} → $${v.fairValue?.toFixed(2)}
          <span style="color:${mosColor}">(${mos >= 0 ? '+' : ''}${mos?.toFixed(1)}%)</span>
        </div>
        <div class="s-date">${new Date(v.savedAt).toLocaleString()}</div>
      </div>
    `;
  }).join('');

  el.querySelectorAll('.s-del').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(e.target.dataset.del);
      writeSaved(loadSaved().filter(v => v.id !== id));
      renderSaved();
    });
  });
  el.querySelectorAll('.saved-item').forEach(item => {
    item.addEventListener('click', e => {
      const id = parseInt(item.dataset.id);
      const v = loadSaved().find(x => x.id === id);
      if (v) {
        document.getElementById('ticker').value = v.ticker;
        loadValuation(v); // pass the saved record so its overrides survive the re-fetch
      }
    });
  });
}

// ============================================================
//   STATUS / EVENTS
// ============================================================
function flashStatus(msg, cls = '') {
  const s = document.getElementById('status');
  s.textContent = msg;
  s.className = 'status ' + cls;
  setTimeout(() => { s.textContent = 'Ready'; s.className = 'status'; }, 3000);
}

async function loadValuation(savedRecord = null) {
  const ticker = document.getElementById('ticker').value.toUpperCase().trim();
  if (!ticker) {
    flashStatus('Enter a ticker', 'error');
    return;
  }
  const btn = document.getElementById('fetch-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const raw = await fetchStock(ticker);
    const stock = normalizeStock(raw);
    state.stock = stock;
    buildInputs(stock);

    // If we're loading a saved valuation, overlay the saved inputs on top
    // of the freshly-fetched data so the user's manual overrides persist.
    if (savedRecord && savedRecord.inputs) {
      Object.assign(state.inputs, savedRecord.inputs);
      // Sync overridden price / market cap back to state.stock for the summary card
      if (savedRecord.inputs.currentPrice) {
        state.stock.price = savedRecord.inputs.currentPrice;
        state.stock._priceOverridden = true;
      }
      if (savedRecord.inputs.marketCap) {
        state.stock.marketCap = savedRecord.inputs.marketCap;
      }
      renderInputs(); // re-render with the overlaid values
    }

    renderSummary(stock);
    recalculate();
    document.getElementById('intro').style.display = 'none';
    document.getElementById('workspace').classList.add('visible');
    document.getElementById('save-btn').disabled = false;

    // If stockbook isn't loaded yet, load it then refresh summary so taxonomy fills in
    if ((state.stockbook?.rows?.length ?? 0) === 0) {
      loadStockBook(false).then(() => {
        if (state.stock?.ticker === stock.ticker) renderSummary(state.stock);
      }).catch(() => {});
    }

    // Async: load price history from sheet and render chart
    loadPriceChart(stock.ticker).catch(e => console.warn('Price chart skipped', e));

    // If user is on Financials sub-tab, fetch new financials too
    if (state.valSubtab === 'financials') {
      loadFinancials(stock.ticker).catch(e => console.warn('Financials skipped', e));
    } else {
      // Reset cached financials so the next sub-tab visit fetches fresh
      if (state.financials) { state.financials.ticker = null; state.financials.data = null; }
    }

    // If FMP key set, auto-merge most recent annual statements into assumptions
    if (getFmpKey() && !savedRecord) {
      autoMergeFmpToAssumptions(stock.ticker).catch(e => console.warn('FMP auto-merge skipped', e));
    }

    const sourceMsg = savedRecord
      ? 'Reloaded ' + stock.ticker + ' with your saved overrides'
      : (raw.overview
          ? 'Loaded ' + stock.ticker + ' · ' + stock.dataSource
          : stock.ticker + ' · ' + stock.dataSource);
    flashStatus(sourceMsg, 'success');
  } catch (e) {
    console.error(e);
    flashStatus(e.message + ' — manual mode', 'error');
    openManualMode(ticker);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch & Value';
  }
}

// Allow the user to value a ticker even when ALL data sources fail.
// Provides a blank-but-sensible scaffold; user fills in the numbers from 10-K / 10-Q.
function openManualMode(ticker) {
  const stub = {
    ticker,
    name: ticker + ' (manual entry)',
    sector: '—',
    industry: '—',
    country: 'United States',
    currency: 'USD',
    dataSource: 'Manual entry',
    price: null,
    marketCap: null,
    sharesOutstanding: null,
    beta: 1.0,
    pe: null, forwardPE: null, eps: 0,
    revenue: 0, ebitda: 0,
    operatingIncome: 0, netIncome: 0,
    capex: 0, depreciation: 0,
    operatingCashFlow: 0, freeCashFlow: 0,
    totalDebt: 0, cash: 0, totalEquity: 0,
    revenueGrowth: 0.05, earningsGrowth: 0.05,
    grossMargin: 0.30, operatingMargin: 0.15, profitMargin: 0.10,
    returnOnEquity: 0.12, returnOnAssets: 0.06,
    priceToBook: null, enterpriseValue: null,
    evToRevenue: null, evToEbitda: null,
    dividendYield: 0,
  };
  state.stock = stub;
  renderSummary(stub);
  buildInputs(stub);
  recalculate();
  document.getElementById('intro').style.display = 'none';
  document.getElementById('workspace').classList.add('visible');
  document.getElementById('save-btn').disabled = false;
}

document.getElementById('fetch-btn').addEventListener('click', loadValuation);
document.getElementById('ticker').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadValuation();
});
document.getElementById('save-btn').addEventListener('click', saveCurrent);

// ---------- DATA SOURCES MODAL ----------
function openSourcesModal() {
  document.getElementById('sources-modal').style.display = 'flex';
  document.getElementById('av-key-input').value = getApiKey();
  document.getElementById('finnhub-key-input').value = getFinnhubKey();
  document.getElementById('fmp-key-input').value = getFmpKey();
  document.getElementById('twelve-key-input').value = getTwelveKey();
  document.getElementById('sheet-url-input').value = getSheetUrls().join('\n');
  const pref = getSourcePref();
  document.querySelectorAll('#source-pref-control .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.val === pref);
  });
  document.getElementById('sheet-test-result').textContent = '';
}
function closeSourcesModal() {
  document.getElementById('sources-modal').style.display = 'none';
}

document.getElementById('sources-btn').addEventListener('click', openSourcesModal);
document.getElementById('sources-close').addEventListener('click', closeSourcesModal);
document.getElementById('sources-modal').addEventListener('click', e => {
  if (e.target.id === 'sources-modal') closeSourcesModal();
});

document.querySelectorAll('#source-pref-control .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#source-pref-control .seg-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
  });
});

document.getElementById('sheet-test-btn').addEventListener('click', async () => {
  const raw = document.getElementById('sheet-url-input').value;
  const urls = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  const out = document.getElementById('sheet-test-result');
  if (urls.length === 0) { out.textContent = 'Paste at least one URL'; out.style.color = 'var(--red)'; return; }
  out.textContent = `Testing ${urls.length} URL${urls.length > 1 ? 's' : ''}…`;
  out.style.color = 'var(--ink-dim)';
  try {
    // Temporarily set the URLs then fetch
    const prior = getSheetUrls();
    setSheetUrls(urls);
    const data = await fetchSheetData();
    setSheetUrls(prior); // restore until user clicks Save
    const ct = data?.rows?.length || 0;
    const histCount = Object.keys(data?.priceHistory || {}).length;
    out.style.color = 'var(--green)';
    out.innerHTML = `✓ ${urls.length} sheet${urls.length > 1 ? 's' : ''} merged · <strong>${ct} unique tickers</strong> · ${histCount} with price history`;
  } catch (e) {
    out.style.color = 'var(--red)';
    out.textContent = '✗ ' + e.message;
  }
});

document.getElementById('sources-save').addEventListener('click', () => {
  const key = document.getElementById('av-key-input').value.trim();
  const fhKey = document.getElementById('finnhub-key-input').value.trim();
  const fmpKey = document.getElementById('fmp-key-input').value.trim();
  const twelveKey = document.getElementById('twelve-key-input').value.trim();
  const raw = document.getElementById('sheet-url-input').value;
  const urls = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  const pref = document.querySelector('#source-pref-control .seg-btn.active')?.dataset.val || 'auto';
  setApiKey(key);
  setFinnhubKey(fhKey);
  setFmpKey(fmpKey);
  setTwelveKey(twelveKey);
  setSheetUrls(urls);
  setSourcePref(pref);
  closeSourcesModal();
  // Bust sheet cache so the new URLs take effect immediately
  try { localStorage.removeItem(SHEET_CACHE_KEY); } catch {}
  flashStatus(`Sources saved · ${urls.length} sheet${urls.length !== 1 ? 's' : ''} · ${pref}`, 'success');
  updateSourcesBtnHint();
});

function updateSourcesBtnHint() {
  const btn = document.getElementById('sources-btn');
  const hasKey = !!getApiKey();
  const hasFh = !!getFinnhubKey();
  const hasFmp = !!getFmpKey();
  const hasTwelve = !!getTwelveKey();
  const sheetCount = getSheetUrls().length;
  if (!hasKey && !hasFh && !hasFmp && !hasTwelve && sheetCount === 0) {
    btn.style.borderColor = 'var(--amber)';
    btn.style.color = 'var(--amber)';
    btn.textContent = 'Data Sources';
  } else {
    btn.style.borderColor = '';
    btn.style.color = '';
    const tags = [];
    if (sheetCount > 0) tags.push(sheetCount > 1 ? `${sheetCount} Sheets` : 'Sheet');
    if (hasFh) tags.push('FH');
    if (hasFmp) tags.push('FMP');
    if (hasTwelve) tags.push('TD');
    if (hasKey) tags.push('AV');
    btn.textContent = `Data Sources · ${tags.join(' + ')}`;
  }
}
updateSourcesBtnHint();

// Hydrate from taxonomy cache instantly so the ticker tape + stockbook
// can render immediately while the fresh sheet fetch runs in background.
if (hydrateStockbookFromCache()) {
  // Render the cached skeleton right away
  try { renderStockBook(); } catch {}
  try { maybeShowTickerTape(); } catch {}
}

// Load stockbook quietly in background so the ticker tape can populate
if (getSheetUrls().length > 0) {
  loadStockBook(false).catch(() => {});
}

// Segmented controls: granularity and display mode
function wireSegControl(id, key) {
  const ctrl = document.getElementById(id);
  if (!ctrl) return;
  ctrl.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const val = btn.dataset.val;
    state.inputs[key] = val;
    ctrl.querySelectorAll('.seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.val === val);
    });
    // Granularity changes the math; display mode is just a view flip
    if (key === 'granularity') {
      recalculate();
    } else {
      renderProjection();
    }
  });
}
wireSegControl('seg-granularity', 'granularity');
wireSegControl('seg-display', 'displayMode');

// Initial render of saved list
renderSaved();

// ============================================================
//   MACRO QUAD MODEL
//   Hedgeye-style GIP regime classifier built from public data.
//   This is an APPROXIMATION using GDP YoY rate-of-change and
//   CPI YoY rate-of-change. Not the proprietary Hedgeye nowcast.
// ============================================================

const MACRO_CACHE_KEY = 'valuatio.macroData.v1';
const MACRO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SHEET_CACHE_KEY = 'valuatio.sheet.cache.v1';
const SHEET_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — sheets change frequently
const DESC_CACHE_KEY = 'valuatio.desc.cache.v1';
const PERSONAL_BOOK_KEY = 'valuatio.personalBook.v1';

// ============================================================
//   TAXONOMY CACHE — slim, long-lived per-ticker store
//   Holds STABLE identity/taxonomy fields only (not prices).
//   Used as instant skeleton on cold start so the stockbook
//   shows ticker names + sectors immediately while fresh sheet
//   data fetches in the background.
//   7-day TTL — these fields rarely change.
// ============================================================
const TAXONOMY_CACHE_KEY = 'valuatio.taxonomy.cache.v1';
const TAXONOMY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Fields we cache. Strictly stable identity & taxonomy — NO prices, NO market cap,
// NO P/L, NO volume, NO 52-wk range. Those need to stay live.
const TAXONOMY_FIELDS = [
  'name', 'fmpName',
  'sector', 'subSector', 'industry', 'function', 'coreSegments',
  'exchange', 'ceo', 'country', 'countryFull', 'ipoDate', 'image', 'website',
  'isEtf', 'isFund', 'currency',
  'description', 'fullDescription',
  'instrumentType', 'isDerivative',
  'sharesOutstanding', // changes ≤4×/year (buybacks/issuance)
  'employees', 'address', 'city', 'state', 'phone',
];

function loadTaxonomyCache() {
  try {
    const raw = localStorage.getItem(TAXONOMY_CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch { return {}; }
}

function saveTaxonomyCache(cache) {
  try {
    localStorage.setItem(TAXONOMY_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // QuotaExceededError — drop the oldest 50% and retry once
    if (e.name === 'QuotaExceededError') {
      const pruned = pruneOldestEntries(cache, 0.5);
      try { localStorage.setItem(TAXONOMY_CACHE_KEY, JSON.stringify(pruned)); }
      catch { console.warn('Taxonomy cache write failed even after pruning'); }
    }
  }
}

// Drop the oldest N% of entries by timestamp
function pruneOldestEntries(cache, keepRatio = 0.5) {
  const entries = Object.entries(cache).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
  const keep = Math.floor(entries.length * keepRatio);
  return Object.fromEntries(entries.slice(0, keep));
}

// Update the cache from a fresh stockbook row set. Only writes stable fields.
function updateTaxonomyCache(rows) {
  if (!rows || rows.length === 0) return;
  const cache = loadTaxonomyCache();
  const now = Date.now();
  let updated = 0;
  for (const row of rows) {
    if (!row.ticker) continue;
    const slim = {};
    for (const field of TAXONOMY_FIELDS) {
      if (row[field] != null && row[field] !== '') slim[field] = row[field];
    }
    if (Object.keys(slim).length === 0) continue;
    cache[row.ticker] = { t: now, ...slim };
    updated++;
  }
  // Drop entries older than TTL (housekeeping)
  for (const [tic, entry] of Object.entries(cache)) {
    if (now - (entry.t || 0) > TAXONOMY_CACHE_TTL_MS) delete cache[tic];
  }
  saveTaxonomyCache(cache);
  console.log(`✓ Taxonomy cache: ${updated} tickers updated · ${Object.keys(cache).length} total cached`);
}

// Apply cached taxonomy fields to a row WITHOUT overwriting fresh data.
// Used to fill in blanks during background fetch.
function applyTaxonomyCacheToRow(row) {
  if (!row?.ticker) return row;
  const cache = loadTaxonomyCache();
  const cached = cache[row.ticker];
  if (!cached) return row;
  // Cached entry beyond TTL — ignore it
  if (Date.now() - (cached.t || 0) > TAXONOMY_CACHE_TTL_MS) return row;
  for (const field of TAXONOMY_FIELDS) {
    if ((row[field] == null || row[field] === '') && cached[field] != null) {
      row[field] = cached[field];
    }
  }
  return row;
}

// Hydrate the stockbook from cache as an instant skeleton on cold start.
// Returns true if any rows were added from cache.
function hydrateStockbookFromCache() {
  const cache = loadTaxonomyCache();
  const tickers = Object.keys(cache);
  if (tickers.length === 0) return false;
  const now = Date.now();
  const rows = [];
  for (const tic of tickers) {
    const c = cache[tic];
    if (!c || now - (c.t || 0) > TAXONOMY_CACHE_TTL_MS) continue;
    rows.push({
      ticker: tic,
      ...c,
      source: 'cache',
      _fromCache: true,
    });
  }
  if (rows.length === 0) return false;
  state.stockbook.rows = rows;
  state.stockbook.rows.forEach(applyOverridesToRow);
  console.log(`⚡ Hydrated stockbook from cache: ${rows.length} tickers`);
  return true;
}

// Cache the fetched sheet so multiple tabs reuse one fetch
async function getSheetData(forceRefresh = false) {
  if (!getSheetUrl()) return null;
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
      if (cached && (Date.now() - cached.t) < SHEET_CACHE_TTL_MS) return cached.data;
    } catch {}
  }
  const data = await fetchSheetData();
  try {
    localStorage.setItem(SHEET_CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
  } catch {}
  return data;
}

// Twelve Data — daily price history (800 calls/day free, real CORS support)
// Returns array of {date, open, high, low, close, volume} ascending.
async function fetchTwelveDataHistory(ticker, outputsize = 500) {
  const key = getTwelveKey();
  if (!key) return null;
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=1day&outputsize=${outputsize}&apikey=${key}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status === 'error' || !Array.isArray(j.values)) return null;
    return j.values.map(v => ({
      date: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume) || 0,
    })).filter(p => isFinite(p.close) && p.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

// Financial Modeling Prep — full financials (free tier varies, CORS supported)
// FMP migrated to "stable" endpoints in late 2024. Old /api/v3/ paths still work
// for some accounts but are legacy. We try stable first, fall back to v3.
async function fetchFmpStatement(endpoint, ticker, period = 'annual', limit = 4) {
  const key = getFmpKey();
  if (!key) return null;

  // Build URL variants — FMP has multiple endpoint formats over the years
  const urls = period === 'annual' ? [
    // Stable WITH period
    `https://financialmodelingprep.com/stable/${endpoint}?symbol=${encodeURIComponent(ticker)}&period=annual&limit=${limit}&apikey=${key}`,
    // Stable WITHOUT period (some endpoints default to annual)
    `https://financialmodelingprep.com/stable/${endpoint}?symbol=${encodeURIComponent(ticker)}&limit=${limit}&apikey=${key}`,
    // Legacy v3 path with period query
    `https://financialmodelingprep.com/api/v3/${endpoint}/${ticker}?period=annual&limit=${limit}&apikey=${key}`,
    // Legacy v3 path without period
    `https://financialmodelingprep.com/api/v3/${endpoint}/${ticker}?limit=${limit}&apikey=${key}`,
  ] : [
    // Quarterly variants — period MUST be specified
    `https://financialmodelingprep.com/stable/${endpoint}?symbol=${encodeURIComponent(ticker)}&period=quarter&limit=${limit}&apikey=${key}`,
    `https://financialmodelingprep.com/api/v3/${endpoint}/${ticker}?period=quarter&limit=${limit}&apikey=${key}`,
    // Some FMP versions use 'quarterly' instead of 'quarter'
    `https://financialmodelingprep.com/stable/${endpoint}?symbol=${encodeURIComponent(ticker)}&period=quarterly&limit=${limit}&apikey=${key}`,
  ];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const r = await fetch(url);
      const safeUrl = url.replace(key, '***');
      if (!r.ok) {
        console.warn(`FMP variant ${i + 1}/${urls.length} HTTP ${r.status} —`, safeUrl);
        continue;
      }
      const j = await r.json();
      if (Array.isArray(j) && j.length > 0) {
        console.log(`FMP ✓ ${endpoint} (variant ${i + 1}, ${j.length} rows)`);
        return j;
      }
      if (j && j['Error Message']) {
        console.warn(`FMP variant ${i + 1} error:`, j['Error Message']);
      } else if (Array.isArray(j) && j.length === 0) {
        console.warn(`FMP variant ${i + 1} returned empty for ${ticker} ${period} ${endpoint}`);
      } else {
        console.warn(`FMP variant ${i + 1} unexpected response shape`, j);
      }
    } catch (e) {
      console.warn(`FMP variant ${i + 1} fetch failed:`, e.message);
    }
  }
  return null;
}

async function fetchFmpIncome(ticker, period = 'annual', limit = 4) {
  return fetchFmpStatement('income-statement', ticker, period, limit);
}
async function fetchFmpBalance(ticker, period = 'annual', limit = 4) {
  return fetchFmpStatement('balance-sheet-statement', ticker, period, limit);
}
async function fetchFmpCashflow(ticker, period = 'annual', limit = 4) {
  return fetchFmpStatement('cash-flow-statement', ticker, period, limit);
}
// FMP daily history (5y default) - useful as backup chart source
async function fetchFmpHistory(ticker, fromDate = null) {
  const key = getFmpKey();
  if (!key) return null;
  // Stable endpoint for historical price (light)
  try {
    let url = `https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${encodeURIComponent(ticker)}&apikey=${key}`;
    if (fromDate) url += `&from=${fromDate}`;
    const r = await fetch(url);
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j.length >= 2) {
        return j.map(p => ({ date: p.date, close: p.close, open: p.open, high: p.high, low: p.low, volume: p.volume }))
          .sort((a, b) => a.date.localeCompare(b.date));
      }
    }
  } catch {}
  // Legacy fallback
  try {
    let url = `https://financialmodelingprep.com/api/v3/historical-price-full/${ticker}?apikey=${key}`;
    if (fromDate) url += `&from=${fromDate}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.historical || !Array.isArray(j.historical)) return null;
    return j.historical
      .map(p => ({ date: p.date, open: p.open, high: p.high, low: p.low, close: p.close, volume: p.volume }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch { return null; }
}

// FMP ETF holdings — what stocks does an ETF hold + at what %?
// Returns array of {asset, name, weight, sharesNumber} sorted by weight desc.
async function fetchEtfHoldings(ticker) {
  const key = getFmpKey();
  if (!key) return null;
  // Stable endpoint
  const urls = [
    `https://financialmodelingprep.com/stable/etf/holdings?symbol=${encodeURIComponent(ticker)}&apikey=${key}`,
    `https://financialmodelingprep.com/api/v3/etf-holder/${ticker}?apikey=${key}`,
    `https://financialmodelingprep.com/api/v3/etf-holdings/symbol/${ticker}?apikey=${key}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      if (!Array.isArray(j) || j.length === 0) continue;
      // Normalize across endpoint shapes
      return j.map(h => ({
        asset: h.asset || h.symbol || h.ticker,
        name: h.name || h.assetName,
        weight: parseFloat(h.weightPercentage || h.weight_percentage || h.weight) || null,
        sharesNumber: parseFloat(h.sharesNumber || h.shares) || null,
        marketValue: parseFloat(h.marketValue || h.market_value) || null,
      }))
      .filter(h => h.asset)
      .sort((a, b) => (b.weight || 0) - (a.weight || 0));
    } catch {}
  }
  return null;
}

// Reverse lookup — what ETFs hold this stock?
// Returns array of {symbol, name, weight} where this stock appears.
async function fetchEtfsHoldingStock(ticker) {
  const key = getFmpKey();
  if (!key) return null;
  const urls = [
    `https://financialmodelingprep.com/stable/etf-holder/${ticker}?apikey=${key}`,
    `https://financialmodelingprep.com/api/v3/etf-holder/${ticker}?apikey=${key}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      if (!Array.isArray(j) || j.length === 0) continue;
      return j.map(e => ({
        symbol: e.symbol || e.ticker,
        name: e.name || e.assetName,
        weight: parseFloat(e.weightPercentage || e.weight_percentage || e.weight) || null,
        shares: parseFloat(e.sharesNumber || e.shares) || null,
      })).filter(e => e.symbol).sort((a, b) => (b.weight || 0) - (a.weight || 0));
    } catch {}
  }
  return null;
}




// Finnhub /stock/profile2 — gives sector, name, country, etc.
// Real CORS support, free tier 60 calls/min. Get a key at finnhub.io (free, no card).
async function fetchFinnhubProfile(ticker) {
  const key = getFinnhubKey();
  if (!key) return null;
  try {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${key}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || Object.keys(j).length === 0) return null;
    return {
      sector: j.finnhubIndustry || null,        // Finnhub uses "finnhubIndustry" but it's really sector-level
      industry: j.gicsSubIndustry || j.finnhubIndustry || null,
      name: j.name || null,
      country: j.country || null,
      website: j.weburl || null,
      logo: j.logo || null,
      exchange: j.exchange || null,
      ipoDate: j.ipo || null,
      marketCap: j.marketCapitalization ? j.marketCapitalization * 1e6 : null, // returned in millions
    };
  } catch {
    return null;
  }
}

// Search Wikipedia smartly — use the search API with company name (not ticker letter)
// to avoid disambiguation pages like "B (letter)" when searching for Barrick.
async function fetchWikipediaSummary(ticker, name) {
  // Build search candidates that bias toward COMPANY pages
  const candidates = [];
  if (name && name.length > 1) {
    // Strip common suffixes for better match
    const cleanName = name.replace(/,?\s+(inc\.?|corp\.?|corporation|company|co\.?|ltd\.?|limited|plc|holdings?|group)$/i, '').trim();
    candidates.push(cleanName + ' (company)');
    candidates.push(cleanName + ' Inc');
    candidates.push(cleanName);
  }
  // Only use ticker as a LAST resort and only if it's >2 letters
  // Single/double letter tickers (B, GE, T) hit alphabet disambig pages.
  if (ticker && ticker.length >= 3) candidates.push(ticker);

  for (const candidate of candidates) {
    try {
      // Step 1: search to get the best matching page title
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(candidate)}&limit=3&namespace=0&format=json&origin=*`;
      const sr = await fetch(searchUrl);
      if (!sr.ok) continue;
      const searchResult = await sr.json();
      // searchResult is [query, [titles], [descs], [urls]]
      const titles = searchResult[1] || [];
      if (titles.length === 0) continue;

      // Find the best match — prefer titles that look like company pages
      let bestTitle = titles.find(t => /\(company\)|\(corporation\)|Inc|Corp/i.test(t))
        || titles.find(t => candidate.toLowerCase().split(/\s+/).every(w => w.length < 3 || t.toLowerCase().includes(w)))
        || titles[0];

      // Step 2: fetch the summary for that title
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(bestTitle.replace(/ /g, '_'))}`;
      const r = await fetch(summaryUrl);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.type === 'disambiguation') continue;
      const extract = j.extract || '';
      if (!extract || extract.length < 30) continue;

      // Filter out obvious non-company pages (e.g., "B is a letter")
      if (/^[A-Z]\s+(is|was|may refer to)/i.test(extract)) continue;
      if (/letter of the/i.test(extract.slice(0, 80))) continue;
      if (/disambiguation/i.test(j.description || '')) continue;

      // First sentence
      return (extract.match(/^[^.]+\./)?.[0] || extract.slice(0, 200)).trim();
    } catch {}
  }
  return null;
}

// Multi-source enrichment with persistent cache.
// Priority: Finnhub (sector + name) → AV overview → Wikipedia (description fallback)
// Hardcoded sector overrides for popular tickers — used as last-resort fallback
// when no API key is set and Wikipedia fails. Keeps the app useful even without API keys.
const HARDCODED_SECTORS = {
  AAPL:  { sector: 'Technology', industry: 'Consumer Electronics', name: 'Apple Inc.' },
  MSFT:  { sector: 'Technology', industry: 'Software—Infrastructure', name: 'Microsoft Corporation' },
  GOOGL: { sector: 'Communication Services', industry: 'Internet Content & Information', name: 'Alphabet Inc.' },
  GOOG:  { sector: 'Communication Services', industry: 'Internet Content & Information', name: 'Alphabet Inc.' },
  META:  { sector: 'Communication Services', industry: 'Internet Content & Information', name: 'Meta Platforms Inc.' },
  AMZN:  { sector: 'Consumer Cyclical', industry: 'Internet Retail', name: 'Amazon.com Inc.' },
  NVDA:  { sector: 'Technology', industry: 'Semiconductors', name: 'NVIDIA Corporation' },
  TSLA:  { sector: 'Consumer Cyclical', industry: 'Auto Manufacturers', name: 'Tesla Inc.' },
  AVGO:  { sector: 'Technology', industry: 'Semiconductors', name: 'Broadcom Inc.' },
  ORCL:  { sector: 'Technology', industry: 'Software—Infrastructure', name: 'Oracle Corporation' },
  CRM:   { sector: 'Technology', industry: 'Software—Application', name: 'Salesforce Inc.' },
  ADBE:  { sector: 'Technology', industry: 'Software—Application', name: 'Adobe Inc.' },
  AMD:   { sector: 'Technology', industry: 'Semiconductors', name: 'Advanced Micro Devices' },
  INTC:  { sector: 'Technology', industry: 'Semiconductors', name: 'Intel Corporation' },
  CSCO:  { sector: 'Technology', industry: 'Communication Equipment', name: 'Cisco Systems' },
  IBM:   { sector: 'Technology', industry: 'Information Technology Services', name: 'IBM Corporation' },
  QCOM:  { sector: 'Technology', industry: 'Semiconductors', name: 'QUALCOMM Incorporated' },
  NFLX:  { sector: 'Communication Services', industry: 'Entertainment', name: 'Netflix Inc.' },
  DIS:   { sector: 'Communication Services', industry: 'Entertainment', name: 'Walt Disney Company' },
  // Financials
  JPM:   { sector: 'Financial Services', industry: 'Banks—Diversified', name: 'JPMorgan Chase' },
  BAC:   { sector: 'Financial Services', industry: 'Banks—Diversified', name: 'Bank of America' },
  WFC:   { sector: 'Financial Services', industry: 'Banks—Diversified', name: 'Wells Fargo' },
  C:     { sector: 'Financial Services', industry: 'Banks—Diversified', name: 'Citigroup Inc.' },
  GS:    { sector: 'Financial Services', industry: 'Capital Markets', name: 'Goldman Sachs' },
  MS:    { sector: 'Financial Services', industry: 'Capital Markets', name: 'Morgan Stanley' },
  V:     { sector: 'Financial Services', industry: 'Credit Services', name: 'Visa Inc.' },
  MA:    { sector: 'Financial Services', industry: 'Credit Services', name: 'Mastercard Inc.' },
  BRK:   { sector: 'Financial Services', industry: 'Insurance—Diversified', name: 'Berkshire Hathaway' },
  // Healthcare
  JNJ:   { sector: 'Healthcare', industry: 'Drug Manufacturers—General', name: 'Johnson & Johnson' },
  LLY:   { sector: 'Healthcare', industry: 'Drug Manufacturers—General', name: 'Eli Lilly' },
  UNH:   { sector: 'Healthcare', industry: 'Healthcare Plans', name: 'UnitedHealth Group' },
  PFE:   { sector: 'Healthcare', industry: 'Drug Manufacturers—General', name: 'Pfizer Inc.' },
  MRK:   { sector: 'Healthcare', industry: 'Drug Manufacturers—General', name: 'Merck & Co.' },
  ABBV:  { sector: 'Healthcare', industry: 'Drug Manufacturers—General', name: 'AbbVie Inc.' },
  // Consumer
  WMT:   { sector: 'Consumer Defensive', industry: 'Discount Stores', name: 'Walmart Inc.' },
  PG:    { sector: 'Consumer Defensive', industry: 'Household & Personal Products', name: 'Procter & Gamble' },
  KO:    { sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic', name: 'Coca-Cola Company' },
  PEP:   { sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic', name: 'PepsiCo Inc.' },
  MCD:   { sector: 'Consumer Cyclical', industry: 'Restaurants', name: "McDonald's Corporation" },
  SBUX:  { sector: 'Consumer Cyclical', industry: 'Restaurants', name: 'Starbucks Corporation' },
  NKE:   { sector: 'Consumer Cyclical', industry: 'Footwear & Accessories', name: 'NIKE Inc.' },
  HD:    { sector: 'Consumer Cyclical', industry: 'Home Improvement Retail', name: 'Home Depot' },
  TGT:   { sector: 'Consumer Defensive', industry: 'Discount Stores', name: 'Target Corporation' },
  COST:  { sector: 'Consumer Defensive', industry: 'Discount Stores', name: 'Costco Wholesale' },
  // Energy
  XOM:   { sector: 'Energy', industry: 'Oil & Gas Integrated', name: 'Exxon Mobil' },
  CVX:   { sector: 'Energy', industry: 'Oil & Gas Integrated', name: 'Chevron Corporation' },
  COP:   { sector: 'Energy', industry: 'Oil & Gas E&P', name: 'ConocoPhillips' },
  // Misc
  GME:   { sector: 'Consumer Cyclical', industry: 'Specialty Retail', name: 'GameStop Corp.' },
  SPY:   { sector: 'ETF', industry: 'S&P 500 Index ETF', name: 'SPDR S&P 500 ETF Trust' },
  QQQ:   { sector: 'ETF', industry: 'Nasdaq 100 Index ETF', name: 'Invesco QQQ Trust' },
  SOUN:  { sector: 'Technology', industry: 'Software—Application', name: 'SoundHound AI Inc.' },
  PLTR:  { sector: 'Technology', industry: 'Software—Infrastructure', name: 'Palantir Technologies' },
  UAMY:  { sector: 'Basic Materials', industry: 'Mining', name: 'United States Antimony Corp' },
  CHWY:  { sector: 'Consumer Cyclical', industry: 'Internet Retail', name: 'Chewy Inc.' },
  TSLL:  { sector: 'ETF', industry: 'Leveraged ETF', name: 'Direxion Daily TSLA Bull 2X' },
};

async function enrichTicker(ticker, name) {
  // Cache enriched data persistently
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(DESC_CACHE_KEY) || '{}'); } catch {}
  const cached = cache[ticker];
  // Only return cache if it actually has useful data — empty cached entries
  // shouldn't block re-enrichment from a now-better source
  if (cached && typeof cached === 'object' && (cached.sector || cached.description)) {
    return cached;
  }

  let result = { sector: null, industry: null, description: null, name: name || null };

  // 1. Finnhub for sector — this is the reliable one
  try {
    const fp = await fetchFinnhubProfile(ticker);
    if (fp) {
      result.sector = fp.sector;
      result.industry = fp.industry;
      if (fp.name && (!result.name || result.name === ticker)) result.name = fp.name;
    }
  } catch {}

  // 2. AV overview as secondary source (sector + description)
  const avKey = getApiKey();
  if (avKey && (!result.sector || !result.description)) {
    try {
      const ov = await fetchAlphaVantageOverview(ticker, avKey);
      if (!result.sector && ov.Sector) result.sector = ov.Sector;
      if (!result.industry && ov.Industry) result.industry = ov.Industry;
      if (!result.name && ov.Name) result.name = ov.Name;
      if (!result.description && ov.Description) {
        result.description = ov.Description.match(/^[^.]+\./)?.[0]?.trim() || ov.Description.slice(0, 200);
      }
    } catch {}
  }

  // 3. Wikipedia smart-search for description (uses NAME, not ticker letter)
  if (!result.description) {
    try {
      const desc = await fetchWikipediaSummary(ticker, result.name);
      if (desc) result.description = desc;
    } catch {}
  }

  // 4. Hardcoded fallback for popular tickers (no key required)
  if (!result.sector && HARDCODED_SECTORS[ticker]) {
    const hc = HARDCODED_SECTORS[ticker];
    result.sector = hc.sector;
    if (!result.industry) result.industry = hc.industry;
    if (!result.name || result.name === ticker) result.name = hc.name;
  }

  // Cache result (capped to prevent localStorage bloat)
  cache[ticker] = result;
  try {
    const keys = Object.keys(cache);
    if (keys.length > 500) {
      const toKeep = {};
      keys.slice(-500).forEach(k => toKeep[k] = cache[k]);
      cache = toKeep;
    }
    localStorage.setItem(DESC_CACHE_KEY, JSON.stringify(cache));
  } catch {
    try {
      localStorage.removeItem(DESC_CACHE_KEY);
      localStorage.setItem(DESC_CACHE_KEY, JSON.stringify({ [ticker]: result }));
    } catch {}
  }
  return result;
}

// Legacy single-string description fetch (used by Valuation summary card)
async function fetchCompanyDescription(ticker, name) {
  const enriched = await enrichTicker(ticker, name);
  return enriched?.description || null;
}

// Personal book: in-app additions that the user adds via the UI.
// Stored separately from the sheet so we can merge them.
function loadPersonalBook() {
  try { return JSON.parse(localStorage.getItem(PERSONAL_BOOK_KEY) || '[]'); } catch { return []; }
}
function savePersonalBook(arr) {
  localStorage.setItem(PERSONAL_BOOK_KEY, JSON.stringify(arr));
}
function addToPersonalBook(entry) {
  const book = loadPersonalBook();
  const idx = book.findIndex(e => e.ticker?.toUpperCase() === entry.ticker?.toUpperCase());
  const stamped = { ...entry, ticker: entry.ticker.toUpperCase(), savedAt: new Date().toISOString() };
  if (idx >= 0) book[idx] = { ...book[idx], ...stamped };
  else book.unshift(stamped);
  savePersonalBook(book);
  return stamped;
}
function removeFromPersonalBook(ticker) {
  savePersonalBook(loadPersonalBook().filter(e => e.ticker?.toUpperCase() !== ticker.toUpperCase()));
}

// ---------- QUAD DEFINITIONS ----------
const QUADS = {
  1: {
    num: '01',
    name: 'Goldilocks',
    axes: 'Growth ↑ · Inflation ↓',
    desc: 'Strong real growth with cooling price pressures. Historically the most bullish for broad risk assets — high-beta, momentum, and growth styles tend to lead.',
    color: '#5b8a72',
    overweights: ['XLK (Tech)', 'XLY (Discretionary)', 'XLI (Industrials)', 'XLC (Comm)'],
    underweights: ['XLU (Utilities)', 'XLP (Staples)', 'XLE (Energy)'],
    style: 'Growth, Momentum, High-Beta',
  },
  2: {
    num: '02',
    name: 'Reflation',
    axes: 'Growth ↑ · Inflation ↑',
    desc: 'Booming growth alongside rising prices — the post-stimulus or commodity-boom regime. Still pro-risk but more cyclical in character.',
    color: '#c4965a',
    overweights: ['XLK (Tech)', 'XLI (Industrials)', 'XLF (Financials)', 'XLE (Energy)', 'XLY (Discretionary)'],
    underweights: ['XLU (Utilities)', 'XLP (Staples)', 'TLT (Long bonds)'],
    style: 'Cyclicals, Value, Commodities',
  },
  3: {
    num: '03',
    name: 'Stagflation',
    axes: 'Growth ↓ · Inflation ↑',
    desc: 'Slowing growth with rising prices — the squeeze. Defensive yield and inflation-protected positioning have historically led.',
    color: '#a5645a',
    overweights: ['XLK (Tech)', 'XLU (Utilities)', 'XLRE (REITs)', 'XLE (Energy)', 'GLD (Gold)'],
    underweights: ['XLY (Discretionary)', 'XLF (Financials)', 'XLI (Industrials)'],
    style: 'Quality, Yield, Hard Assets',
  },
  4: {
    num: '04',
    name: 'Deflation',
    axes: 'Growth ↓ · Inflation ↓',
    desc: 'Slowing growth and falling prices — the deflationary slowdown, often the toughest regime for equities overall. Safety and duration historically lead.',
    color: '#6b7a8f',
    overweights: ['XLP (Staples)', 'XLV (Healthcare)', 'XLU (Utilities)', 'XLRE (REITs)', 'TLT (Long bonds)', 'GLD (Gold)'],
    underweights: ['XLK (Tech)', 'XLY (Discretionary)', 'XLF (Financials)'],
    style: 'Defensives, Long Duration',
  },
};

// Sector ETF ticker → name + which quads favor it (over/under)
const SECTOR_ETFS = [
  { ticker: 'XLK', name: 'Technology',          favors: [1, 2, 3], hurts: [4] },
  { ticker: 'XLY', name: 'Consumer Discretionary', favors: [1, 2], hurts: [3, 4] },
  { ticker: 'XLI', name: 'Industrials',         favors: [1, 2], hurts: [3] },
  { ticker: 'XLF', name: 'Financials',          favors: [2], hurts: [3, 4] },
  { ticker: 'XLE', name: 'Energy',              favors: [2, 3], hurts: [1] },
  { ticker: 'XLP', name: 'Consumer Staples',    favors: [4], hurts: [1] },
  { ticker: 'XLV', name: 'Healthcare',          favors: [4], hurts: [] },
  { ticker: 'XLU', name: 'Utilities',           favors: [3, 4], hurts: [1] },
  { ticker: 'XLRE', name: 'Real Estate',        favors: [3, 4], hurts: [] },
  { ticker: 'TLT', name: 'Long Bonds (20y+)',   favors: [4], hurts: [2] },
  { ticker: 'GLD', name: 'Gold',                favors: [3, 4], hurts: [] },
];

// Map equity sector name → which ETF represents it (for tie-in)
const SECTOR_TO_ETF = {
  'Technology': 'XLK',
  'Consumer Cyclical': 'XLY', 'Consumer Discretionary': 'XLY',
  'Industrials': 'XLI', 'Industrial': 'XLI',
  'Financial Services': 'XLF', 'Financials': 'XLF', 'Financial': 'XLF',
  'Energy': 'XLE',
  'Consumer Defensive': 'XLP', 'Consumer Staples': 'XLP',
  'Healthcare': 'XLV', 'Health Care': 'XLV',
  'Utilities': 'XLU',
  'Real Estate': 'XLRE',
  'Communication Services': 'XLK',
  'Basic Materials': 'XLI',
};

// Curated list of representative large-cap holdings per sector ETF.
// Click a ticker on the macro tab and it loads in the valuation tab.
const SECTOR_HOLDINGS = {
  XLK:  ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'AMD', 'CSCO', 'ADBE', 'ACN', 'IBM', 'INTU'],
  XLY:  ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG', 'LOW', 'NKE', 'TJX', 'SBUX', 'CMG', 'ABNB', 'F'],
  XLI:  ['GE', 'CAT', 'RTX', 'HON', 'UNP', 'BA', 'LMT', 'DE', 'UPS', 'ETN', 'NOC', 'WM'],
  XLF:  ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'BLK', 'C', 'AXP', 'SCHW', 'BX', 'PGR', 'SPGI'],
  XLE:  ['XOM', 'CVX', 'COP', 'EOG', 'SLB', 'PSX', 'MPC', 'OXY', 'PXD', 'VLO', 'WMB', 'KMI'],
  XLP:  ['PG', 'COST', 'WMT', 'KO', 'PEP', 'PM', 'MO', 'MDLZ', 'CL', 'TGT', 'KMB', 'GIS'],
  XLV:  ['LLY', 'UNH', 'JNJ', 'MRK', 'ABBV', 'TMO', 'ABT', 'PFE', 'DHR', 'BMY', 'AMGN', 'CVS'],
  XLU:  ['NEE', 'SO', 'DUK', 'CEG', 'AEP', 'D', 'SRE', 'PCG', 'EXC', 'XEL', 'ED', 'PEG'],
  XLRE: ['PLD', 'AMT', 'EQIX', 'WELL', 'SPG', 'O', 'PSA', 'CCI', 'DLR', 'EXR', 'AVB', 'VICI'],
  TLT:  [], // bond ETF, no underlying stocks to value
  GLD:  [], // commodity ETF
};

// ---------- UNIFIED SECTOR RESOLUTION ----------
// Maps any sector name (Finnhub, Yahoo, AV, sheet) to a sector ETF.
// Returns null if no match.
// Normalize a sector/industry/sub-sector name so case variants match.
// "CONSUMER CYCLICAL", "Consumer Cyclical", "consumer cyclical" all → "Consumer Cyclical"
function normalizeSectorName(s) {
  if (!s) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  // Title case each word (preserve special chars like &, -, /)
  return trimmed.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
}

function sectorNameToETF(sectorName) {
  if (!sectorName) return null;
  const s = sectorName.toLowerCase().trim();
  // Direct match first
  for (const [name, etf] of Object.entries(SECTOR_TO_ETF)) {
    if (name.toLowerCase() === s) return etf;
  }
  // ORDER MATTERS — most specific keywords first.
  if (s.includes('reit') || s.includes('real estate')) return 'XLRE';
  if (s.includes('drug') || s.includes('pharma') || s.includes('biotech') ||
      s.includes('medical') || s.includes('health') || s.includes('hospital')) return 'XLV';
  if (s.includes('financial') || s.includes('bank') || s.includes('insurance') ||
      s.includes('asset manag') || s.includes('capital markets')) return 'XLF';
  if (s.includes('energy') || s.includes('oil') || s.includes('gas') ||
      s.includes('petroleum') || s.includes('refining')) return 'XLE';
  if (s.includes('utilit')) return 'XLU';
  if (s.includes('consumer cyc') || s.includes('discretion') || s.includes('retail') ||
      s.includes('apparel') || s.includes('auto') || s.includes('hotel') ||
      s.includes('restaurant') || s.includes('luxury')) return 'XLY';
  if (s.includes('consumer def') || s.includes('staple') || s.includes('beverage') ||
      s.includes('food') || s.includes('tobacco') || s.includes('household')) return 'XLP';
  if (s.includes('semiconductor') || s.includes('software') || s.includes('tech') ||
      s.includes('information technology')) return 'XLK';
  if (s.includes('communication') || s.includes('media') || s.includes('telecom') ||
      s.includes('entertainment') || s.includes('publishing')) return 'XLK';
  if (s.includes('industrial') || s.includes('aerospace') || s.includes('transport') ||
      s.includes('airline') || s.includes('railroad') || s.includes('logistics') ||
      s.includes('mining') || s.includes('steel') || s.includes('chemical') ||
      s.includes('material') || s.includes('manufactur')) return 'XLI';
  return null;
}

// Get all stockbook tickers that map to a given ETF
function tickersInSectorETF(etfTicker) {
  const fromBook = (state.stockbook?.rows || [])
    .filter(r => r.sector && sectorNameToETF(r.sector) === etfTicker)
    .map(r => r.ticker);
  const fromCurated = SECTOR_HOLDINGS[etfTicker] || [];
  // Union, stockbook entries first (they're yours)
  return Array.from(new Set([...fromBook, ...fromCurated]));
}

// ---------- CACHE LAYER ----------
function loadMacroCache() {
  try {
    const raw = localStorage.getItem(MACRO_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.fetchedAt > MACRO_CACHE_TTL_MS) return null;
    return parsed;
  } catch { return null; }
}
function saveMacroCache(data) {
  localStorage.setItem(MACRO_CACHE_KEY, JSON.stringify({
    ...data,
    fetchedAt: Date.now(),
  }));
}

// ---------- FRED ECONOMIC INDICATORS (no API key needed) ----------
// FRED's CSV download (fredgraph.csv) is public, no auth, no rate limit.
// FRED doesn't support CORS, so we route through public proxies with fallback.
// Series IDs:
//   GDPC1     = Real GDP, quarterly (chained 2017 dollars)
//   CPIAUCSL  = Consumer Price Index All Urban Consumers, monthly
//   DGS10     = 10-Year Treasury Constant Maturity, daily
//   DFF       = Effective Federal Funds Rate, daily

const FRED_SERIES = {
  gdp: 'GDPC1',
  cpi: 'CPIAUCSL',
  tsy10: 'DGS10',
  fedFunds: 'DFF',
};

// Public CORS proxies for the FRED CSV endpoint. Tried in order, first success wins.
// As of 2026: corsproxy.io is most reliable, allorigins works, cors.sh is a fallback.
function buildProxiedFredUrl(seriesId, proxyIdx) {
  const target = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
  const proxies = [
    // 0: direct (rarely works due to CORS, but try anyway)
    u => u,
    // 1-6: proxies
    u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`, // legacy form
    u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, // wrapped JSON form
    u => `https://thingproxy.freeboard.io/fetch/${u}`,
  ];
  return proxies[proxyIdx] ? { url: proxies[proxyIdx](target), wrapped: proxyIdx === 5 } : null;
}

// Fetch a FRED series and return [{date, value}] sorted oldest → newest
async function fetchFredSeries(seriesId) {
  let lastErr = null;
  const errors = [];
  for (let i = 0; i < 7; i++) {
    const built = buildProxiedFredUrl(seriesId, i);
    if (!built) break;
    try {
      const r = await fetch(built.url, { headers: { 'Accept': 'text/csv,*/*' } });
      if (!r.ok) {
        const e = `proxy ${i}: HTTP ${r.status}`;
        errors.push(e); lastErr = new Error(e); continue;
      }
      let text;
      if (built.wrapped) {
        const j = await r.json().catch(() => null);
        text = j?.contents;
        if (!text) { lastErr = new Error('Wrapped proxy returned no contents'); continue; }
      } else {
        text = await r.text();
      }
      const firstLine = text.split('\n')[0]?.toUpperCase() || '';
      if (!firstLine.includes('DATE')) {
        const e = `proxy ${i}: bad format (got "${firstLine.slice(0, 40)}")`;
        errors.push(e); lastErr = new Error(e); continue;
      }
      const rows = text.trim().split('\n').slice(1)
        .map(line => line.split(','))
        .filter(c => c.length >= 2)
        .map(c => ({ date: c[0].trim(), value: parseFloat(c[1]) }))
        .filter(d => isFinite(d.value));
      if (rows.length === 0) { lastErr = new Error('FRED returned empty series'); continue; }
      console.log(`✓ FRED ${seriesId} loaded via proxy ${i} (${rows.length} obs)`);
      return rows;
    } catch (e) {
      const msg = `proxy ${i}: ${e.message}`;
      errors.push(msg); lastErr = e;
    }
  }
  console.error(`FRED ${seriesId} failed:`, errors.join(' · '));
  throw new Error('FRED unreachable: ' + errors.slice(0, 3).join(' · '));
}

// ---------- COMPUTE QUAD FROM RAW SERIES ----------
function computeYoYSeriesFromFred(rawSeries, periodsPerYear) {
  // Already sorted oldest → newest from fetchFredSeries
  const out = [];
  for (let i = periodsPerYear; i < rawSeries.length; i++) {
    const cur = rawSeries[i].value;
    const prior = rawSeries[i - periodsPerYear].value;
    if (prior > 0) {
      out.push({ date: rawSeries[i].date, yoy: (cur / prior) - 1 });
    }
  }
  return out;
}

function classifyQuad(growthRoC, inflationRoC) {
  const gUp = growthRoC > 0;
  const iUp = inflationRoC > 0;
  if (gUp && !iUp) return 1;
  if (gUp && iUp) return 2;
  if (!gUp && iUp) return 3;
  return 4;
}

function buildQuadHistory(gdpYoY, cpiYoY, lookbackPeriods = 24) {
  const recent = cpiYoY.slice(-lookbackPeriods);
  const result = [];
  for (let i = 1; i < recent.length; i++) {
    const cpiPoint = recent[i];
    const cpiPrior = recent[Math.max(i - 3, 0)]; // 3-month RoC for inflation
    const inflationRoC = cpiPoint.yoy - cpiPrior.yoy;

    const gdpPoint = [...gdpYoY].reverse().find(g => g.date <= cpiPoint.date);
    const gdpPriorPoint = gdpPoint
      ? [...gdpYoY].reverse().find(g => g.date < gdpPoint.date)
      : null;
    if (!gdpPoint || !gdpPriorPoint) continue;
    const growthRoC = gdpPoint.yoy - gdpPriorPoint.yoy;

    result.push({
      date: cpiPoint.date,
      growthYoY: gdpPoint.yoy,
      inflationYoY: cpiPoint.yoy,
      growthRoC,
      inflationRoC,
      quad: classifyQuad(growthRoC, inflationRoC),
    });
  }
  return result;
}

// ---------- MASTER MACRO FETCH (FRED via CORS proxies, no key) ----------
async function fetchMacroData(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = loadMacroCache();
    if (cached) return cached;
  }

  const setStatus = m => {
    const el = document.getElementById('macro-status');
    if (el) el.textContent = m;
  };

  setStatus('Fetching real GDP from FRED…');
  const gdpRows = await fetchFredSeries(FRED_SERIES.gdp);

  setStatus('Fetching CPI from FRED…');
  const cpiRows = await fetchFredSeries(FRED_SERIES.cpi);

  setStatus('Fetching 10Y yield…');
  let tsyRows = [];
  try { tsyRows = await fetchFredSeries(FRED_SERIES.tsy10); } catch {}

  setStatus('Fetching Fed Funds rate…');
  let fedRows = [];
  try { fedRows = await fetchFredSeries(FRED_SERIES.fedFunds); } catch {}

  const data = {
    source: 'FRED',
    gdpRaw: gdpRows,
    cpiRaw: cpiRows,
    tsyRaw: tsyRows,
    fedRaw: fedRows,
  };

  saveMacroCache(data);
  return data;
}

// ---------- SECTOR ETF FETCH (Stooq, no API key) ----------
async function fetchSectorPerf() {
  const tickers = SECTOR_ETFS.map(s => s.ticker);
  const results = await Promise.allSettled(
    tickers.map(t => fetchStooqHistory(t, 60))
  );
  const out = {};
  results.forEach((r, idx) => {
    if (r.status === 'fulfilled' && r.value) out[tickers[idx]] = r.value;
  });
  return out;
}

// Get last N days of daily OHLC from Stooq
async function fetchStooqHistory(ticker, days = 60) {
  const stooqTicker = ticker.toLowerCase().replace('-', '.') + '.us';
  const url = `https://stooq.com/q/d/l/?s=${stooqTicker}&i=d`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    // Header: Date,Open,High,Low,Close,Volume
    const rows = lines.slice(1)
      .map(l => l.split(','))
      .filter(c => c.length >= 5)
      .map(c => ({ date: c[0], close: parseFloat(c[4]) }))
      .filter(d => isFinite(d.close));
    return rows.slice(-days);
  } catch { return null; }
}

function pctChange(series, daysBack) {
  if (!series || series.length < daysBack + 1) return null;
  const latest = series[series.length - 1].close;
  const prior = series[series.length - 1 - daysBack].close;
  if (!prior) return null;
  return (latest / prior) - 1;
}

// ============================================================
//   MACRO RENDERING
// ============================================================
async function loadMacroTab(forceRefresh = false) {
  const intro = document.getElementById('macro-intro');
  const content = document.getElementById('macro-content');
  const setStatus = (m, c='') => {
    const s = document.getElementById('macro-status');
    if (s) { s.textContent = m; s.className = 'status ' + c; }
  };

  try {
    setStatus('Loading…');
    const macro = await fetchMacroData(forceRefresh);

    // Compute YoY series — FRED data is oldest→newest already
    const gdpYoY = computeYoYSeriesFromFred(macro.gdpRaw, 4);   // quarterly
    const cpiYoY = computeYoYSeriesFromFred(macro.cpiRaw, 12);  // monthly

    if (gdpYoY.length < 2 || cpiYoY.length < 4) {
      throw new Error('Insufficient macro history');
    }

    const history = buildQuadHistory(gdpYoY, cpiYoY, 30);
    if (history.length === 0) throw new Error('Could not align GDP and CPI');

    const current = history[history.length - 1];

    // Latest yields — FRED returns oldest-first arrays, so take the LAST entry
    const tsyArr = (macro.tsyRaw || []).filter(d => isFinite(d.value));
    const fedArr = (macro.fedRaw || []).filter(d => isFinite(d.value));
    const latest10y = tsyArr.length ? tsyArr[tsyArr.length - 1].value : NaN;
    const latestFed = fedArr.length ? fedArr[fedArr.length - 1].value : NaN;
    // 3-month change in 10y yield (FRED daily data, ~63 trading days back)
    const tsy3moAgo = tsyArr.length > 63 ? tsyArr[tsyArr.length - 64].value : NaN;
    const tsyChange3mo = isFinite(latest10y) && isFinite(tsy3moAgo) ? latest10y - tsy3moAgo : null;

    state.macro = {
      raw: macro,
      gdpYoY,
      cpiYoY,
      history,
      current,
      latest10y,
      latestFed,
      tsyChange3mo,
    };

    // Render sector table immediately (with sheet data if present); Stooq fetch overlays
    renderSectorTable();
    fetchSectorPerf().then(sectors => {
      state.macro.sectors = sectors;
      renderSectorTable();
      renderTieIn();
    });

    intro.style.display = 'none';
    content.style.display = 'block';

    renderQuadHero();
    renderQuadGrid();
    renderQuadHistory();
    attachQuadChartHover();
    renderSectorStocks();
    renderTieIn();

    const ageMs = Date.now() - (loadMacroCache()?.fetchedAt || Date.now());
    const ageHr = Math.floor(ageMs / (60 * 60 * 1000));
    setStatus(`Loaded · cached ${ageHr}h ago · refresh after 24h`, 'success');
  } catch (e) {
    setStatus(e.message, 'error');
    console.error('Macro load failed:', e);
    // Show a friendly fallback message in the macro content area
    const intro = document.getElementById('macro-intro');
    if (intro) {
      intro.innerHTML = `
        <div style="text-align:center;padding:60px 30px">
          <div style="font-family:var(--serif);font-style:italic;font-size:24px;color:var(--ink);margin-bottom:14px">Macro data unreachable</div>
          <div style="font-family:var(--mono);font-size:12px;color:var(--ink-dim);line-height:1.7;max-width:520px;margin:0 auto">
            FRED's API is blocked by browser CORS, so we route through public proxies.
            All proxies are currently failing — open DevTools (F12) → Console for details on which ones returned what.
            <br><br>
            Common causes: proxy services rate-limited, FRED itself temporarily down, or your network blocking these proxies.
            <br><br>
            <strong style="color:var(--amber)">Workaround:</strong> The macro tab works once it loads at least once — cached for 24h.
            Try refreshing in a few minutes.
          </div>
          <button class="btn" id="macro-retry-btn" style="margin-top:20px">Retry</button>
        </div>
      `;
      intro.style.display = 'block';
      const content = document.getElementById('macro-content');
      if (content) content.style.display = 'none';
      document.getElementById('macro-retry-btn')?.addEventListener('click', () => loadMacroTab(true));
    }
  }
}

function renderQuadHero() {
  const m = state.macro;
  if (!m) return;
  const q = QUADS[m.current.quad];
  const hero = document.getElementById('quad-hero');
  hero.className = `quad-hero q${m.current.quad}`;
  document.getElementById('quad-current-num').textContent = q.num;
  document.getElementById('quad-current-name').textContent = q.name;
  document.getElementById('quad-current-desc').textContent = q.desc;

  const stats = [
    { l: 'GDP YoY (latest)', v: (m.current.growthYoY * 100).toFixed(2) + '%', dir: m.current.growthYoY > 0 ? 'up' : 'down' },
    { l: 'CPI YoY (latest)', v: (m.current.inflationYoY * 100).toFixed(2) + '%', dir: m.current.inflationYoY > 0 ? 'up' : 'down' },
    { l: 'Growth Δ (RoC)', v: (m.current.growthRoC > 0 ? '+' : '') + (m.current.growthRoC * 100).toFixed(2) + 'pp', dir: m.current.growthRoC > 0 ? 'up' : 'down' },
    { l: 'Inflation Δ (RoC)', v: (m.current.inflationRoC > 0 ? '+' : '') + (m.current.inflationRoC * 100).toFixed(2) + 'pp', dir: m.current.inflationRoC > 0 ? 'up' : 'down' },
    { l: '10Y Treasury', v: isFinite(m.latest10y) ? m.latest10y.toFixed(2) + '%' : '—', dir: '' },
    { l: 'Fed Funds', v: isFinite(m.latestFed) ? m.latestFed.toFixed(2) + '%' : '—', dir: '' },
  ];
  document.getElementById('quad-stats').innerHTML = stats.map(s =>
    `<div><div class="l">${s.l}</div><div class="v ${s.dir}">${s.v}</div></div>`
  ).join('');
}

function renderQuadGrid() {
  const m = state.macro;
  const grid = document.getElementById('quad-grid');
  // Render in 2x2 visual order: Q1 top-left, Q2 top-right, Q4 bottom-left, Q3 bottom-right
  const order = [1, 2, 4, 3];
  grid.innerHTML = order.map(qNum => {
    const q = QUADS[qNum];
    const isCurrent = m && m.current.quad === qNum;
    return `
      <div class="quad-card q${qNum} ${isCurrent ? 'current' : ''}">
        <div class="quad-card-num">${q.num}</div>
        <h3>${q.name}</h3>
        <div class="quad-card-axes">${q.axes}</div>
        <div class="quad-card-desc">${q.desc}</div>
        <div class="quad-overweights">
          <div class="quad-tag-label">Overweights</div>
          ${q.overweights.map(s => `<span class="quad-tag over">${s}</span>`).join('')}
        </div>
        <div class="quad-underweights">
          <div class="quad-tag-label">Underweights</div>
          ${q.underweights.map(s => `<span class="quad-tag under">${s}</span>`).join('')}
        </div>
        <div class="quad-overweights">
          <div class="quad-tag-label">Style</div>
          <span class="quad-tag" style="color:var(--ink-dim)">${q.style}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderQuadHistory() {
  const m = state.macro;
  if (!m?.history) return;
  const canvas = document.getElementById('quad-history-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const padL = 60, padR = 30, padT = 36, padB = 40; // extra top padding for quad labels
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const data = m.history;
  const allRoC = data.flatMap(d => [d.growthRoC, d.inflationRoC]);
  const yMin = Math.min(...allRoC) * 1.1;
  const yMax = Math.max(...allRoC) * 1.1;
  const yRange = yMax - yMin;

  const x = (i) => padL + (i / (data.length - 1)) * plotW;
  const y = (v) => padT + plotH - ((v - yMin) / yRange) * plotH;

  // Cache geometry for the hover handler
  state.macroChartGeom = { padL, padT, padR, padB, plotW, plotH, W, H, data, x, y };

  // STRONGER quad backgrounds — alpha bumped from 22 to 40 (25%) for visibility on black
  // Also draw a subtle border between quad regions
  let prevQuad = null;
  let regionStart = 0;
  data.forEach((d, i) => {
    const xc = x(i);
    const xn = i < data.length - 1 ? x(i + 1) : xc + (plotW / data.length);
    const w = xn - xc;
    ctx.fillStyle = QUADS[d.quad].color + '40'; // ~25% alpha — much more visible
    ctx.fillRect(xc, padT, w + 1, plotH);

    // When the quad changes, label the previous region at top
    if (prevQuad !== null && d.quad !== prevQuad && i - regionStart >= 2) {
      const cx = (x(regionStart) + x(i - 1)) / 2;
      labelQuadRegion(ctx, cx, padT, prevQuad);
      regionStart = i;
    }
    if (prevQuad !== d.quad) regionStart = i;
    prevQuad = d.quad;
  });
  // Label the final region too
  if (data.length - regionStart >= 2) {
    const cx = (x(regionStart) + x(data.length - 1)) / 2;
    labelQuadRegion(ctx, cx, padT, prevQuad);
  }

  // Zero line
  ctx.strokeStyle = '#5a564e';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(padL, y(0));
  ctx.lineTo(padL + plotW, y(0));
  ctx.stroke();
  ctx.setLineDash([]);

  // Growth RoC line (amber)
  ctx.strokeStyle = '#d4a24c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i), py = y(d.growthRoC);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Inflation RoC line (red-brown)
  ctx.strokeStyle = '#a5645a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i), py = y(d.inflationRoC);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // Y-axis labels
  ctx.fillStyle = '#8a8275';
  ctx.font = '10px JetBrains Mono';
  ctx.textAlign = 'right';
  for (let frac = 0; frac <= 1; frac += 0.25) {
    const yv = yMin + yRange * frac;
    const py = y(yv);
    ctx.fillText((yv * 100).toFixed(2) + 'pp', padL - 8, py + 3);
    ctx.strokeStyle = '#2a2722';
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + plotW, py);
    ctx.stroke();
  }

  // X-axis labels (first, middle, last date)
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8a8275';
  [0, Math.floor(data.length / 2), data.length - 1].forEach(i => {
    if (data[i]) ctx.fillText(data[i].date.slice(0, 7), x(i), padT + plotH + 16);
  });

  // Inline legend
  ctx.textAlign = 'left';
  ctx.fillStyle = '#d4a24c';
  ctx.fillText('— Growth RoC', padL + 8, padT + 14);
  ctx.fillStyle = '#a5645a';
  ctx.fillText('— Inflation RoC', padL + 110, padT + 14);
}

// Draw a "Q1", "Q2" etc. label for a quad-shaded region
function labelQuadRegion(ctx, cx, top, quad) {
  ctx.fillStyle = QUADS[quad].color;
  ctx.font = 'bold 10px JetBrains Mono';
  ctx.textAlign = 'center';
  ctx.fillText('Q' + quad, cx, top - 8);
}

// Hover handler for the quad history chart
function attachQuadChartHover() {
  const canvas = document.getElementById('quad-history-canvas');
  const tip = document.getElementById('quad-chart-tooltip');
  if (!canvas || !tip) return;

  canvas.onmousemove = (e) => {
    const geom = state.macroChartGeom;
    if (!geom) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < geom.padL || mx > geom.padL + geom.plotW || my < geom.padT || my > geom.padT + geom.plotH) {
      tip.style.display = 'none';
      renderQuadHistory(); // clear hover marker
      return;
    }
    // Find closest data point
    const fraction = (mx - geom.padL) / geom.plotW;
    const idx = Math.round(fraction * (geom.data.length - 1));
    const d = geom.data[idx];
    if (!d) return;

    // Re-render base, then overlay a vertical line + dots at this index
    renderQuadHistory();
    const ctx = canvas.getContext('2d');
    const px = geom.x(idx);
    ctx.strokeStyle = '#e8dfc9';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(px, geom.padT);
    ctx.lineTo(px, geom.padT + geom.plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    // Dots
    ctx.fillStyle = '#d4a24c';
    ctx.beginPath(); ctx.arc(px, geom.y(d.growthRoC), 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a5645a';
    ctx.beginPath(); ctx.arc(px, geom.y(d.inflationRoC), 4, 0, Math.PI * 2); ctx.fill();

    // Position tooltip
    const q = QUADS[d.quad];
    tip.innerHTML = `
      <div class="qct-date">${d.date}</div>
      <div class="qct-quad" style="color:${q.color}">Q${d.quad} · ${q.name}</div>
      <div class="qct-row"><span>GDP YoY</span><span>${(d.growthYoY * 100).toFixed(2)}%</span></div>
      <div class="qct-row"><span>CPI YoY</span><span>${(d.inflationYoY * 100).toFixed(2)}%</span></div>
      <div class="qct-row"><span>Growth Δ</span><span style="color:#d4a24c">${(d.growthRoC * 100 >= 0 ? '+' : '') + (d.growthRoC * 100).toFixed(2)}pp</span></div>
      <div class="qct-row"><span>Inflation Δ</span><span style="color:#a5645a">${(d.inflationRoC * 100 >= 0 ? '+' : '') + (d.inflationRoC * 100).toFixed(2)}pp</span></div>
    `;
    tip.style.display = 'block';
    const tipW = 200;
    let leftPx = mx + 14;
    if (leftPx + tipW > rect.width - 8) leftPx = mx - tipW - 14;
    tip.style.left = leftPx + 'px';
    tip.style.top = Math.max(8, my - 50) + 'px';
  };

  canvas.onmouseleave = () => {
    tip.style.display = 'none';
    renderQuadHistory();
  };
}

function renderSectorTable() {
  const m = state.macro;
  const currentQuad = m?.current?.quad;
  if (!currentQuad) {
    document.getElementById('sector-etf-table').innerHTML =
      '<div class="empty">Loading…</div>';
    return;
  }

  // Pull cached sheet history
  let sheetHistory = null;
  try {
    const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
    if (cached?.data?.priceHistory) sheetHistory = cached.data.priceHistory;
  } catch {}
  const extCache = loadPriceHistCache();

  // Helper: parse changepct from sheet (always /100)
  function parsePctCell(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.toUpperCase().startsWith('#')) return null;
    const isNeg = /^\(/.test(s) || /^-/.test(s);
    const n = parseFloat(s.replace(/[%$,\s()+]/g, '').replace(/^-/, ''));
    if (!isFinite(n)) return null;
    return (isNeg ? -n : n) / 100;
  }

  const rows = SECTOR_ETFS.map(etf => {
    const sbRow = state.stockbook?.rows?.find(r => r.ticker === etf.ticker);
    const sheetSeries = sheetHistory?.[etf.ticker];
    const stooqSeries = m?.sectors?.[etf.ticker];
    const externalSeries = extCache[etf.ticker]?.data;

    let last = null, r1d = null, r1m = null, r3m = null, r1y = null, r5y = null;

    // Last price priority: stockbook live → sheet history → stooq → external cache
    if (sbRow?.price != null) last = sbRow.price;
    else if (sheetSeries?.length) last = sheetSeries[sheetSeries.length - 1].price;
    else if (stooqSeries?.length) last = stooqSeries[stooqSeries.length - 1].close;
    else if (externalSeries?.length) last = externalSeries[externalSeries.length - 1].price;

    // 1D: sheet's changepct → date-aware sheet history → stooq diff → external diff
    if (sbRow?.rawRow) {
      r1d = parsePctCell(sbRow.rawRow['changepct']) ?? parsePctCell(sbRow.rawRow['return day']);
    }
    if (r1d == null && sheetSeries?.length >= 2) r1d = priceChangeOverDays(sheetSeries, 1);
    if (r1d == null && stooqSeries?.length >= 2) {
      r1d = (stooqSeries[stooqSeries.length - 1].close / stooqSeries[stooqSeries.length - 2].close) - 1;
    }
    if (r1d == null && externalSeries?.length >= 2) r1d = priceChangeOverDays(externalSeries, 1);

    // Multi-period: date-aware lookup at 30/91/365/1825 calendar days
    // Try sheet → stooq (converted to {date, price}) → external cache
    const tryAllSeries = [
      sheetSeries,
      stooqSeries ? stooqSeries.map(s => ({ date: s.date, price: s.close })) : null,
      externalSeries,
    ].filter(Boolean);

    for (const series of tryAllSeries) {
      if (r1m == null && series.length >= 2) r1m = priceChangeOverDays(series, 30);
      if (r3m == null && series.length >= 2) r3m = priceChangeOverDays(series, 91);
      if (r1y == null && series.length >= 2) r1y = priceChangeOverDays(series, 365);
      if (r5y == null && series.length >= 2) r5y = priceChangeOverDays(series, 1825);
    }

    let stance = 'neutral', stanceLabel = 'Neutral';
    if (etf.favors.includes(currentQuad)) { stance = 'over'; stanceLabel = 'Tailwind'; }
    else if (etf.hurts.includes(currentQuad)) { stance = 'under'; stanceLabel = 'Headwind'; }
    const rowClass = stance === 'over' ? 'sector-row-good' : stance === 'under' ? 'sector-row-bad' : '';

    const fmtPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
    const cls = v => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';

    return `
      <tr class="${rowClass}">
        <td>${etf.ticker}</td>
        <td>${etf.name}</td>
        <td>${last != null ? '$' + last.toFixed(2) : '—'}</td>
        <td class="${cls(r1d)}">${fmtPct(r1d)}</td>
        <td class="${cls(r1m)}">${fmtPct(r1m)}</td>
        <td class="${cls(r3m)}">${fmtPct(r3m)}</td>
        <td class="${cls(r1y)}">${fmtPct(r1y)}</td>
        <td class="${cls(r5y)}">${fmtPct(r5y)}</td>
        <td><span class="sector-stance ${stance}">${stanceLabel}</span></td>
      </tr>
    `;
  }).join('');

  const sheetCount = sheetHistory ? Object.keys(sheetHistory).filter(t =>
    SECTOR_ETFS.some(e => e.ticker === t)).length : 0;
  document.getElementById('sector-etf-table').innerHTML = `
    <table class="sector-table">
      <thead>
        <tr>
          <th>Ticker</th><th>Name</th><th>Last</th>
          <th>1D</th><th>1M</th><th>3M</th><th>1Y</th><th>5Y</th><th>Quad ${currentQuad}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="font-family:var(--mono);font-size:10px;color:var(--ink-faint);text-transform:uppercase;letter-spacing:0.18em;margin-top:8px;">
      Tailwind = Quad favors this sector · Headwind = underweighted · ${sheetCount > 0 ? `${sheetCount} ETFs from your sheet, Stooq + external fallback for the rest` : 'Returns from Stooq + external sources'}
    </div>
  `;
}

function renderSectorStocks() {
  const picker = document.getElementById('sector-picker');
  const grid = document.getElementById('sector-stocks-grid');
  const subtitle = document.getElementById('sector-stocks-subtitle');
  if (!picker || !grid) return;

  const m = state.macro;
  const currentQuad = m?.current?.quad;
  const selectedETF = state.selectedSectorETF || (currentQuad
    ? SECTOR_ETFS.find(s => s.favors.includes(currentQuad))?.ticker
    : 'XLK') || 'XLK';

  picker.innerHTML = SECTOR_ETFS
    .filter(s => SECTOR_HOLDINGS[s.ticker]?.length > 0)
    .map(s => {
      let stance = '';
      if (currentQuad) {
        if (s.favors.includes(currentQuad)) stance = 'tail';
        else if (s.hurts.includes(currentQuad)) stance = 'head';
      }
      const active = s.ticker === selectedETF ? 'active' : '';
      return `<button class="sector-pill ${stance} ${active}" data-etf="${s.ticker}">${s.ticker} · ${s.name}</button>`;
    }).join('');

  picker.querySelectorAll('.sector-pill').forEach(pill => {
    pill.addEventListener('click', e => {
      state.selectedSectorETF = pill.dataset.etf;
      renderSectorStocks();
    });
  });

  // Build stock list using unified sector resolver
  const sectorETFData = SECTOR_ETFS.find(s => s.ticker === selectedETF);
  const stocks = tickersInSectorETF(selectedETF);

  if (currentQuad && sectorETFData) {
    let stanceText = 'neutral';
    if (sectorETFData.favors.includes(currentQuad)) stanceText = 'tailwind';
    else if (sectorETFData.hurts.includes(currentQuad)) stanceText = 'headwind';
    const fromBookCount = (state.stockbook?.rows || []).filter(r =>
      r.sector && sectorNameToETF(r.sector) === selectedETF).length;
    subtitle.textContent = `${selectedETF} · Quad ${currentQuad} ${stanceText} · ${fromBookCount} from your Stock Book`;
  }

  grid.className = 'sector-stocks-grid';
  if (stocks.length === 0) {
    grid.innerHTML = '<div class="empty" style="padding:24px;text-align:center">No equity holdings to value (this is a bond/commodity ETF)</div>';
    return;
  }

  // Look up sheet price for each ticker if available
  grid.innerHTML = stocks.map(t => {
    const bookEntry = state.stockbook.rows.find(r => r.ticker === t);
    const price = bookEntry?.price;
    const priceLabel = price != null ? `$${price.toFixed(2)}` : 'Value →';
    return `
      <div class="sector-stock" data-ticker="${t}">
        <div class="stock-tic">${t}</div>
        <div class="stock-arrow">${priceLabel}</div>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.sector-stock').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('ticker').value = el.dataset.ticker;
      switchTab('valuation');
      loadValuation();
    });
  });
}

function renderTieIn() {
  const m = state.macro;
  const wrap = document.getElementById('quad-tie-in');
  if (!m) return;
  const currentQuad = m.current.quad;
  const saved = loadSaved();

  if (saved.length === 0) {
    wrap.innerHTML = '<div class="empty">No saved valuations yet. Value some tickers in the Valuation tab and save them — they\'ll appear here with regime context.</div>';
    return;
  }

  const cards = saved.map(v => {
    // Prefer the sector saved with the valuation; fall back to live state if it's the loaded ticker
    let sectorName = v.sector;
    if (!sectorName && state.stock && state.stock.ticker === v.ticker) {
      sectorName = state.stock.sector;
    }
    const sectorETF = sectorName ? SECTOR_TO_ETF[sectorName] : null;
    const sectorETFData = sectorETF ? SECTOR_ETFS.find(e => e.ticker === sectorETF) : null;

    let verdict = 'neutral', verdictText = sectorName
      ? `Sector "${sectorName}" doesn't map cleanly to a Quad sector ETF — treat as neutral.`
      : 'Sector unknown — re-save this ticker to capture sector mapping.';
    if (sectorETFData) {
      if (sectorETFData.favors.includes(currentQuad)) {
        verdict = 'tail';
        verdictText = `Quad ${currentQuad} (${QUADS[currentQuad].name}) is a TAILWIND for ${sectorName} — bottom-up valuation gets a top-down nudge.`;
      } else if (sectorETFData.hurts.includes(currentQuad)) {
        verdict = 'head';
        verdictText = `Quad ${currentQuad} (${QUADS[currentQuad].name}) is a HEADWIND for ${sectorName} — your DCF assumptions may be optimistic in this regime.`;
      } else {
        verdictText = `Quad ${currentQuad} is neutral for ${sectorName} — no strong regime signal.`;
      }
    }

    return `
      <div class="tie-in-card">
        <div class="tie-tic">${v.ticker}</div>
        <div class="tie-name">${v.name}${sectorName ? ' · ' + sectorName : ''}</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);">
          Saved fair value: <strong style="color:var(--ink)">$${v.fairValue?.toFixed(2)}</strong>
          vs price <strong style="color:var(--ink)">$${v.price?.toFixed(2)}</strong>
        </div>
        <div class="tie-verdict ${verdict}">${verdictText}</div>
      </div>
    `;
  }).join('');

  wrap.innerHTML = `<div class="tie-in-list">${cards}</div>`;
}

// ============================================================
//   TAB SWITCHING
// ============================================================
function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.panel === tabName);
  });
  // Show/hide the valuation-only top control bar based on tab
  document.querySelector('.control-bar').style.display = (tabName === 'valuation') ? 'flex' : 'none';
  document.getElementById('summary').style.display =
    (tabName === 'valuation' && state.stock) ? 'block' : 'none';

  const sub = document.getElementById('masthead-sub');
  if (sub) {
    sub.textContent =
      tabName === 'macro' ? 'Macro Quad · GIP regime detection · Hedgeye-style framework' :
      tabName === 'stockbook' ? 'Stock Book · universe of tickers + saved valuations' :
      tabName === 'probability' ? 'Probability · binary thesis odds blended from priors' :
      tabName === 'risk' ? 'Risk Calculator · Ray Dalio Holy Grail · diversification math' :
      tabName === 'bonds' ? 'Bonds & Treasuries · yield curve · interest rates · public debt' :
      'Intrinsic Value Engine · DCF · CAPM · Multiples · Monte Carlo';
  }

  // Auto-load on first visit
  if (tabName === 'macro' && !state.macro) {
    const cached = loadMacroCache();
    if (cached) loadMacroTab(false);
  }
  if (tabName === 'stockbook' && state.stockbook.rows.length === 0) {
    loadStockBook(false);
  }
  if (tabName === 'probability') {
    if (state.probability && state.probability.theses.length === 0) {
      state.probability.theses = loadTheses();
    }
    if (state.stockbook.rows.length === 0) {
      loadStockBook(false).then(() => renderProbabilityTab());
    } else {
      renderProbabilityTab();
    }
  }
  if (tabName === 'risk') {
    if (!state.risk?._initialized) {
      initRiskCalculator();
      state.risk._initialized = true;
    } else {
      renderHolyGrailChart();
      renderRiskMetrics();
    }
  }
  if (tabName === 'bonds') {
    if (!state.bonds?.loaded) {
      loadBondsTab(false).catch(e => console.warn('Bonds load failed', e));
    } else {
      // Refresh just the bond ETF table from latest sheet
      renderBondEtfTable();
    }
  }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.getElementById('macro-refresh-btn').addEventListener('click', () => loadMacroTab(true));

// On window resize, redraw the canvas charts so they stay sharp
window.addEventListener('resize', () => {
  if (state.macro) renderQuadHistory();
  if (state.mcResults) renderMonteCarlo();
});

// ============================================================
//   STOCK BOOK
//   Universe of all known tickers (sheet + saved valuations + personal additions)
//   with sector lookup, descriptions, and live data.
// ============================================================

state.stockbook = {
  section: 'portfolio',
  search: '',
  rows: [],
  sortBy: null,        // column key
  sortDir: 'asc',      // 'asc' or 'desc'
};

async function loadStockBook(forceRefresh = false) {
  const setStatus = (m, c='') => {
    const el = document.getElementById('stockbook-status');
    if (el) { el.textContent = m; el.className = 'status ' + c; }
  };

  setStatus('Loading universe…');
  const sheet = await getSheetData(forceRefresh).catch(e => {
    setStatus('Sheet: ' + e.message, 'error');
    return null;
  });

  // Build a unified list of tickers from all sources
  const universe = new Map(); // ticker -> entry

  // 1) From Google Sheet — all tabs, all rows
  if (sheet?.rows) {
    sheet.rows.forEach(row => {
      // Find ticker column flexibly
      const tickerKey = Object.keys(row).find(k =>
        k === 'ticker' || k === 'symbol' || k.includes('ticker') || k.includes('symbol')
      );
      const tic = (tickerKey ? row[tickerKey] : '').trim().toUpperCase();
      // Strict validation: reject errors, >5 letter tickers, weird chars
      if (!tic) return;
      if (tic.includes('#')) return;       // sheet errors
      if (tic === 'N/A' || tic === '#REF!') return;
      const stripped = tic.replace(/[.\-]/g, '');
      if (stripped.length > 5) return;     // user requested cap
      if (!/^[A-Z0-9.\-]+$/.test(tic)) return;
      if (universe.has(tic)) return;       // dedupe across tabs

      // Reject "junk" rows ONLY if NO data at all comes from any source.
      // We try: name, FMPname, price, FMPprice, marketcap, FMPmarketcap.
      // If any of these has a real value, keep the row.
      const isMissingVal = v => {
        if (v == null) return true;
        const s = String(v).trim();
        if (!s) return true;
        const u = s.toUpperCase();
        return u === 'N/A' || u === '#N/A' || u.startsWith('#') || u === '—' || u === '-';
      };
      const rawName    = (row['name'] || row['company'] || row['company name'] || '').trim();
      const rawFmpName = (row['fmpname'] || '').trim();
      const rawPrice    = sheetNum(row, 'last price', 'price', 'last', 'close', 'current price');
      const rawFmpPrice = sheetNum(row, 'fmpprice');
      const rawMcap     = sheetNum(row, 'marketcap', 'market cap');
      const rawFmpMcap  = sheetNum(row, 'fmpmarketcap');
      const hasAnyData =
        !isMissingVal(rawName) || !isMissingVal(rawFmpName) ||
        rawPrice != null || rawFmpPrice != null ||
        rawMcap != null || rawFmpMcap != null;
      if (!hasAnyData) return;

      // Read the 6 user-curated taxonomy columns from the sheet (exact-match preferred)
      const sheetSector       = sheetStr(row, 'sector');
      const sheetSubSector    = sheetStr(row, 'sub-sector', 'sub sector', 'subsector');
      const sheetIndustry     = sheetStr(row, 'industry');
      const sheetFunction     = sheetStr(row, 'function');
      const sheetCoreSegments = sheetStr(row, 'core segments', 'core-segments', 'segments');
      const sheetDescription  = sheetStr(row, 'description', 'summary', 'note');

      // Detect leveraged products by NAME pattern (2X, 3X, -2X, -3X, "leverage", "bull", "bear")
      // Many sheet rows won't have function set, so this is the fallback.
      const nameLc = (rawName || '').toLowerCase();
      const nameIndicatesLeverage =
        /\b\d?[-+]?[23]x\b/i.test(rawName) ||  // "2X", "3X", "-3X", "+2X" etc as standalone
        nameLc.includes('leverag') ||
        nameLc.includes('inverse') ||
        nameLc.includes('ultra') ||              // ProShares Ultra prefix = 2x leveraged
        nameLc.includes('ultrashort') ||
        nameLc.includes('ultrapro') ||           // 3x leveraged
        nameLc.includes('daily ') && (nameLc.includes('bull') || nameLc.includes('bear'));
      const nameIndicatesETF =
        nameLc.includes('etf') ||
        nameLc.includes('etn') ||
        nameLc.includes('trust') ||
        nameLc.includes('fund') ||
        nameLc.includes('spdr') ||
        nameLc.includes('ishares') ||
        nameLc.includes('vanguard') ||
        nameLc.includes('proshares') ||
        nameLc.includes('direxion') ||
        nameLc.includes('invesco');

      // Combine sheet's function column with name detection
      const fnLc = (sheetFunction || '').toLowerCase();
      const isDerivative =
        fnLc.includes('leverag') || fnLc.includes('derivative') || fnLc.includes('etf') ||
        fnLc.includes('macro') || fnLc.includes('micro') || fnLc.includes('crypto') ||
        fnLc.includes('option') || fnLc.includes('future') || fnLc.includes('inverse') ||
        fnLc.includes('bull') || fnLc.includes('bear') ||
        nameIndicatesLeverage || nameIndicatesETF;

      // Specific instrument category (used for grouping)
      let instrumentType = 'equity';
      if (fnLc.includes('leverag') || fnLc.includes('bull') || fnLc.includes('bear') || nameIndicatesLeverage) {
        instrumentType = 'leveraged_etf';
      } else if (fnLc.includes('inverse') || nameLc.includes('inverse')) instrumentType = 'inverse_etf';
      else if (fnLc.includes('macro etf') || (fnLc.includes('etf') && fnLc.includes('macro'))) instrumentType = 'macro_etf';
      else if (fnLc.includes('micro etf') || (fnLc.includes('etf') && fnLc.includes('micro'))) instrumentType = 'micro_etf';
      else if (fnLc.includes('crypto') || nameLc.includes('bitcoin') || nameLc.includes('crypto')) instrumentType = 'crypto';
      else if (fnLc.includes('option')) instrumentType = 'option';
      else if (fnLc.includes('future')) instrumentType = 'future';
      else if (fnLc.includes('etf') || nameIndicatesETF) instrumentType = 'etf';
      else if (fnLc.includes('derivative')) instrumentType = 'derivative';

      // Resolve name + price with FMP fallback (since google data may be N/A
      // due to sheet quota limits, but FMPDATA() may have populated FMP* columns)
      const nameVal = !isMissingVal(rawName) ? rawName : (!isMissingVal(rawFmpName) ? rawFmpName : null);
      const priceVal = rawPrice != null ? rawPrice : (rawFmpPrice != null ? rawFmpPrice : null);
      const mcapVal = rawMcap != null ? rawMcap : (rawFmpMcap != null ? rawFmpMcap : null);

      universe.set(tic, {
        ticker: tic,
        name: nameVal,
        // Taxonomy fields — sheet authoritative, normalized for case consistency
        sector:        normalizeSectorName(sheetSector),
        subSector:     normalizeSectorName(sheetSubSector),
        industry:      normalizeSectorName(sheetIndustry),
        function:      sheetFunction || null,
        coreSegments:  sheetCoreSegments || null,
        description:   sheetDescription || null,
        // Derived flags
        isDerivative,
        instrumentType,
        // Numeric/financial fields — fall through to FMP if google is missing
        price: priceVal,
        fmpPrice: rawFmpPrice,
        priceWhenAdded: sheetNum(row, 'price when added', 'cost basis', 'entry price'),
        plPct: sheetNum(row, 'p/l since', 'p/l%', 'p/l %', 'p/l', 'pnl%', 'return%', 'return %'),
        high52: sheetNum(row, 'high52', 'high 52', '52w high', '52 week high', '52-wk high') ?? sheetNum(row, 'fmp52weekhigh', 'fmphigh52'),
        low52:  sheetNum(row, 'low52',  'low 52',  '52w low',  '52 week low',  '52-wk low') ?? sheetNum(row, 'fmp52weeklow', 'fmplow52'),
        fmpHigh52: sheetNum(row, 'fmp52weekhigh', 'fmphigh52'),
        fmpLow52:  sheetNum(row, 'fmp52weeklow', 'fmplow52'),
        volume: sheetNum(row, 'volume', 'vol'),
        avgVolume: sheetNum(row, 'volumeavg', 'avg volume', 'volume avg'),
        marketCap: mcapVal,
        fmpMarketCap: rawFmpMcap,
        pe: sheetNum(row, 'p/e', 'pe', 'pe ratio'),
        eps: sheetNum(row, 'eps'),
        beta: sheetNum(row, 'beta'),
        fmpBeta: sheetNum(row, 'fmpbeta'),
        sharesOutstanding: sheetNum(row, 'shares', 'shares outstanding'),
        fmpName: sheetStr(row, 'fmpname'),
        returnYTD: sheetNum(row, 'returnytd', 'return ytd'),
        returnDay: sheetNum(row, 'return day'),
        return1w: sheetNum(row, 'return1'),
        return1m: sheetNum(row, 'return4'),
        return3m: sheetNum(row, 'return13'),
        return1y: sheetNum(row, 'return52'),
        return3y: sheetNum(row, 'return156'),
        return5y: sheetNum(row, 'return260'),
        netAssets: sheetNum(row, 'net assets', 'netassets'),
        expenseRatio: sheetNum(row, 'expense ratio', 'expenseratio'),
        morningstarRating: sheetNum(row, 'morningstarrating', 'morningstar rating'),
        revenue: sheetNum(row, 'revenue'),
        fcf: sheetNum(row, 'fcf', 'free cash flow'),
        ebitda: sheetNum(row, 'ebitda'),
        dividendYield: sheetNum(row, 'dividend yield', 'div yield'),
        // Company info — pulled in via FMPDATA Apps Script
        exchange:    sheetStr(row, 'exchange'),
        ceo:         sheetStr(row, 'ceo'),
        country:     sheetStr(row, 'country'),
        ipoDate:     sheetStr(row, 'ipodate', 'ipo date'),
        currency:    sheetStr(row, 'currency'),
        website:     sheetStr(row, 'web_url', 'website', 'url'),
        image:       sheetStr(row, 'image', 'logo'),
        phone:       sheetStr(row, 'phone'),
        address:     sheetStr(row, 'address'),
        city:        sheetStr(row, 'city'),
        state:       sheetStr(row, 'state'),
        zip:         sheetStr(row, 'zip'),
        employees:   sheetNum(row, 'employees', 'fulltimeemployees'),
        isEtf:       sheetStr(row, 'isetf', 'is_etf'),
        isFund:      sheetStr(row, 'isfund', 'is_fund'),
        isActive:    sheetStr(row, 'isactive', 'is_active', 'isactivelytrading'),
        chartLink:   sheetStr(row, 'chart_link', 'chartlink'),
        status: sheetStr(row, 'status') || row['column 1'] || null,
        priceHistory: sheet.priceHistory?.[tic] || null,
        source: 'sheet',
        rawRow: row,
      });
    });
  }

  // 2) Personal book — overlay enrichment ONLY where sheet is blank.
  // Sheet is the authoritative source; personal book and API are fallbacks.
  loadPersonalBook().forEach(e => {
    const tic = e.ticker?.toUpperCase();
    if (!tic) return;
    if (universe.has(tic)) {
      const existing = universe.get(tic);
      universe.set(tic, {
        ...existing,
        sector:       existing.sector       || e.sector       || null,
        subSector:    existing.subSector    || e.subSector    || null,
        industry:     existing.industry     || e.industry     || null,
        function:     existing.function     || e.function     || null,
        coreSegments: existing.coreSegments || e.coreSegments || null,
        description:  existing.description  || e.description  || null,
        name:         existing.name         || e.name         || null,
        source: existing.source + (e.description || e.sector ? '+enriched' : ''),
      });
    } else {
      universe.set(tic, { ...e, source: 'personal-book' });
    }
  });

  state.stockbook.rows = Array.from(universe.values());
  // Apply manual overrides as final layer (saved sector/industry/status per ticker)
  state.stockbook.rows.forEach(applyOverridesToRow);
  // Persist stable identity/taxonomy fields to long-lived cache for instant cold-start
  updateTaxonomyCache(state.stockbook.rows);
  setStatus(`${state.stockbook.rows.length} tickers loaded`, 'success');
  renderStockBook();
  maybeShowTickerTape();
}

function renderStockBook() {
  const content = document.getElementById('stockbook-content');
  if (!content) return;
  const sb = state.stockbook;

  if (sb.section === 'valuations') {
    renderStockBookValuations(content);
    return;
  }

  if (sb.section === 'portfolio') {
    renderStockBookPortfolio(content);
    return;
  }

  // Filter by section: equities = NOT derivative; derivatives = IS derivative; universe = all
  let rows = sb.rows;
  if (sb.section === 'equities') {
    rows = rows.filter(r => !r.isDerivative);
  } else if (sb.section === 'derivatives') {
    rows = rows.filter(r => r.isDerivative);
  }

  const search = (sb.search || '').toLowerCase().trim();
  if (search) {
    rows = rows.filter(r =>
      r.ticker.toLowerCase().includes(search) ||
      (r.name || '').toLowerCase().includes(search) ||
      (r.sector || '').toLowerCase().includes(search) ||
      (r.subSector || '').toLowerCase().includes(search) ||
      (r.industry || '').toLowerCase().includes(search) ||
      (r.function || '').toLowerCase().includes(search) ||
      (r.coreSegments || '').toLowerCase().includes(search) ||
      (r.description || '').toLowerCase().includes(search)
    );
  }

  // Apply sort
  rows = [...rows];
  const { sortBy, sortDir } = sb;
  if (sortBy) {
    const isString = ['ticker', 'name', 'sector', 'status', 'description'].includes(sortBy);
    rows.sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy];
      // Nulls always at the bottom regardless of direction
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      let cmp;
      if (isString) cmp = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' });
      else cmp = av - bv;
      return sortDir === 'desc' ? -cmp : cmp;
    });
  } else {
    // Default: by ticker A→Z
    rows.sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  if (rows.length === 0) {
    content.innerHTML = `<div class="empty" style="padding:60px;text-align:center">
      ${sb.rows.length === 0
        ? 'No tickers yet. Configure a Google Sheet in <strong>Data Sources</strong>, or click <strong>+ Add Ticker</strong>.'
        : 'No matches for "' + search + '"'}
    </div>`;
    return;
  }

  // Sortable column metadata: [key, label, sortable]
  const sortIcon = (key) => {
    if (sortBy !== key) return '<span class="sort-icon">↕</span>';
    return sortDir === 'asc' ? '<span class="sort-icon active">↑</span>' : '<span class="sort-icon active">↓</span>';
  };
  const th = (key, label) =>
    `<th class="sortable" data-sort="${key}">${label}${sortIcon(key)}</th>`;

  content.innerHTML = `
    <div class="sb-table-wrap">
      <table class="sb-table">
        <thead>
          <tr>
            ${th('ticker', 'Ticker')}
            ${th('name', 'Name')}
            ${sb.section === 'derivatives'
              ? `${th('function', 'Function')}${th('subSector', 'Sub-Sector')}<th>Core Segments</th>`
              : `${th('sector', 'Sector')}${th('subSector', 'Sub-Sector')}${th('industry', 'Industry')}`}
            <th>Description</th>
            ${th('status', 'Status')}
            ${th('price', 'Price')}
            ${th('marketCap', 'Mkt Cap')}
            ${sb.section === 'derivatives' ? '' : th('pe', 'P/E')}
            ${th('beta', 'Beta')}
            <th>Source</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const statusClass = r.status ? r.status.toLowerCase().trim() : '';
            const functionBadge = r.function
              ? `<span class="sb-function-badge sb-fn-${r.instrumentType}">${escapeHtml(r.function)}</span>`
              : '—';
            const taxonomyCells = sb.section === 'derivatives'
              ? `<td>${functionBadge}</td>
                 <td class="sb-sector">${r.subSector || '—'}</td>
                 <td class="sb-segments" title="${r.coreSegments ? escapeHtml(r.coreSegments) : ''}">${r.coreSegments ? escapeHtml(r.coreSegments) : '—'}</td>`
              : `<td class="sb-sector">${r.sector || '—'}</td>
                 <td class="sb-sector">${r.subSector || '—'}</td>
                 <td class="sb-sector">${r.industry || '—'}</td>`;
            return `
            <tr data-tic="${r.ticker}" ${r.isDerivative ? 'data-derivative="1"' : ''}>
              <td class="sb-tic">${r.ticker}${r.isDerivative ? ' <span class="sb-deriv-marker">⚡</span>' : ''}</td>
              <td class="sb-name">${r.name || '—'}</td>
              ${taxonomyCells}
              <td class="sb-desc" data-full="${r.description ? escapeHtml(r.description) : ''}">${r.description ? escapeHtml(r.description) : '<span style="color:var(--ink-faint)">—</span>'}</td>
              <td>${r.status ? `<span class="sb-status sb-status-${statusClass}">${escapeHtml(r.status)}</span>` : '—'}</td>
              <td>${r.price != null ? '$' + r.price.toFixed(2) : '—'}</td>
              <td>${r.marketCap != null ? formatHumanNumber(r.marketCap) : '—'}</td>
              ${sb.section === 'derivatives' ? '' : `<td>${r.pe != null ? r.pe.toFixed(2) : '—'}</td>`}
              <td>${r.beta != null ? r.beta.toFixed(2) : '—'}</td>
              <td><span class="sb-source-tag ${r.source.includes('sheet') ? 'sheet' : r.source.includes('av') ? 'av' : 'manual'}">${r.source}</span></td>
              <td class="sb-action-cell">
                <button class="sb-icon-btn" data-act="value" data-tic="${r.ticker}">Value</button>
                ${r.isDerivative ? `<button class="sb-icon-btn" data-act="holdings" data-tic="${r.ticker}" title="View ETF holdings">Holdings</button>` : ''}
                <button class="sb-icon-btn" data-act="edit" data-tic="${r.ticker}" title="Override sector/industry/status">Edit</button>
                <button class="sb-icon-btn" data-act="enrich" data-tic="${r.ticker}" title="Fetch sector & description">Enrich</button>
                ${r.source === 'personal-book' || r.source === 'manual' ? `<button class="sb-icon-btn danger" data-act="remove" data-tic="${r.ticker}">×</button>` : ''}
              </td>
            </tr>
          `;}).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Wire action buttons
  content.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const act = btn.dataset.act;
      const tic = btn.dataset.tic;
      if (act === 'value') {
        document.getElementById('ticker').value = tic;
        switchTab('valuation');
        loadValuation();
      } else if (act === 'enrich') {
        enrichRow(tic);
      } else if (act === 'edit') {
        openOverrideModal(tic);
      } else if (act === 'holdings') {
        showEtfHoldings(tic);
      } else if (act === 'remove') {
        if (confirm('Remove ' + tic + ' from your personal book?')) {
          removeFromPersonalBook(tic);
          loadStockBook();
        }
      }
    });
  });
  // Sortable column headers
  content.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      // Strings default ASC. Numbers default DESC for "best first" (price/pl/mcap).
      const isString = ['ticker', 'name', 'sector', 'status'].includes(key);
      if (sb.sortBy === key) {
        sb.sortDir = sb.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sb.sortBy = key;
        sb.sortDir = isString ? 'asc' : 'desc';
      }
      renderStockBook();
    });
  });
  // Whole row click → value
  content.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', () => {
      document.getElementById('ticker').value = tr.dataset.tic;
      switchTab('valuation');
      loadValuation();
    });
  });
}

function renderStockBookValuations(content) {
  const saved = loadSaved();
  if (saved.length === 0) {
    content.innerHTML = `<div class="empty" style="padding:60px;text-align:center">
      No saved valuations yet. Run a valuation in the Valuation tab and click <strong>Save Valuation</strong>.
    </div>`;
    return;
  }
  content.innerHTML = `
    <div class="sb-table-wrap">
      <table class="sb-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Name</th>
            <th>Sector</th>
            <th>Saved At</th>
            <th>Price at Save</th>
            <th>Fair Value</th>
            <th>Margin of Safety</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${saved.map(v => {
            const mos = v.fairValue && v.price ? ((v.fairValue - v.price) / v.price * 100) : null;
            const mosColor = mos == null ? 'var(--ink-dim)' : (mos > 10 ? '#8aa890' : mos < -10 ? '#b88578' : 'var(--amber)');
            return `
              <tr data-tic="${v.ticker}">
                <td class="sb-tic">${v.ticker}</td>
                <td class="sb-name">${v.name || '—'}</td>
                <td class="sb-sector">${v.sector || '—'}</td>
                <td>${new Date(v.savedAt).toLocaleDateString()}</td>
                <td>${v.price != null ? '$' + v.price.toFixed(2) : '—'}</td>
                <td>${v.fairValue != null ? '$' + v.fairValue.toFixed(2) : '—'}</td>
                <td style="color:${mosColor}">${mos != null ? (mos>=0?'+':'') + mos.toFixed(1) + '%' : '—'}</td>
                <td class="sb-action-cell">
                  <button class="sb-icon-btn" data-act="reload" data-id="${v.id}">Reload</button>
                  <button class="sb-icon-btn danger" data-act="del" data-id="${v.id}">×</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
  content.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id);
      const v = loadSaved().find(x => x.id === id);
      if (!v) return;
      if (btn.dataset.act === 'reload') {
        document.getElementById('ticker').value = v.ticker;
        switchTab('valuation');
        loadValuation(v);
      } else if (btn.dataset.act === 'del') {
        if (confirm('Delete saved valuation for ' + v.ticker + '?')) {
          writeSaved(loadSaved().filter(x => x.id !== id));
          renderStockBookValuations(content);
        }
      }
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Enrich a row by fetching sector + description from external sources
async function enrichRow(ticker) {
  const setStatus = (m, c='') => {
    const el = document.getElementById('stockbook-status');
    if (el) { el.textContent = m; el.className = 'status ' + c; }
  };
  setStatus('Enriching ' + ticker + '…');

  const row = state.stockbook.rows.find(r => r.ticker === ticker);
  if (!row) return;

  try {
    const enriched = await enrichTicker(ticker, row.name);
    if (enriched) {
      // ONLY fill blank fields — sheet/user values always win
      if (!row.sector && enriched.sector)         row.sector = enriched.sector;
      if (!row.industry && enriched.industry)     row.industry = enriched.industry;
      if (!row.name && enriched.name)             row.name = enriched.name;
      if (!row.description && enriched.description) row.description = enriched.description;
      addToPersonalBook({
        ticker, name: row.name, sector: row.sector,
        industry: row.industry, description: row.description,
      });
    }
    setStatus(ticker + ' enriched', 'success');
  } catch (e) {
    console.warn('Enrich failed', e);
    setStatus('Enrich failed: ' + e.message, 'error');
  }
  renderStockBook();
}

// Bulk enrich (rate limited to avoid hammering AV)
async function bulkEnrich() {
  const missing = state.stockbook.rows.filter(r => !r.sector || !r.description).slice(0, 5);
  for (const r of missing) {
    await enrichRow(r.ticker);
    await new Promise(r => setTimeout(r, 1500)); // be nice to free APIs
  }
}

// ----- WIRE UP STOCK BOOK CONTROLS -----
document.getElementById('stockbook-search').addEventListener('input', e => {
  state.stockbook.search = e.target.value;
  renderStockBook();
});

document.querySelectorAll('.sb-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.stockbook.section = btn.dataset.section;
    document.querySelectorAll('.sb-tab-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    renderStockBook();
  });
});

document.getElementById('stockbook-refresh-btn').addEventListener('click', () => {
  loadStockBook(true);
});

document.getElementById('stockbook-clear-cache-btn').addEventListener('click', () => {
  if (!confirm('Clear cached sectors/descriptions and personal-book overlay? You will need to Enrich All again.')) return;
  localStorage.removeItem(DESC_CACHE_KEY);
  const book = loadPersonalBook().map(e => ({ ticker: e.ticker, savedAt: e.savedAt }));
  savePersonalBook(book);
  loadStockBook(true);
  flashStatus('Cache cleared', 'success');
});

document.getElementById('stockbook-diag-btn').addEventListener('click', async () => {
  const setStatus = (m, c='') => {
    const el = document.getElementById('stockbook-status');
    if (el) { el.textContent = m; el.className = 'status ' + c; }
  };
  setStatus('Diagnosing sheet…');

  // Re-fetch fresh
  let sheet = null;
  try { sheet = await getSheetData(true); }
  catch (e) {
    setStatus('Sheet error: ' + e.message, 'error');
    return;
  }
  if (!sheet) {
    setStatus('No sheet configured', 'error');
    return;
  }

  // Collect diagnostic info
  const tabs = sheet.tabs || [];
  const priceHistory = sheet.priceHistory || {};
  const tickersWithHistory = Object.keys(priceHistory);
  const tickersInSheet = sheet.rows.map(r => {
    const tk = Object.keys(r).find(k => k === 'ticker' || k === 'symbol' || k.includes('ticker'));
    return tk ? r[tk] : null;
  }).filter(Boolean);

  // Show inline modal
  const html = `
    <div class="modal-backdrop" id="diag-modal" style="display:flex">
      <div class="modal-box" style="max-width:760px;max-height:80vh;overflow-y:auto">
        <div class="modal-head">
          <div class="modal-title">Sheet Diagnostics</div>
          <button class="modal-close" onclick="document.getElementById('diag-modal').remove()">×</button>
        </div>
        <div class="modal-section">
          <div class="modal-label">URL</div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);word-break:break-all">
            ${(() => {
              const urls = getSheetUrls();
              if (urls.length === 0) return 'not set';
              return urls.map((u, i) => `${i + 1}. ${u}`).join('<br>');
            })()}
          </div>
        </div>
        <div class="modal-section" style="background:var(--bg-elev);padding:14px;border-left:2px solid var(--amber)">
          <div class="modal-label">Local Taxonomy Cache <small style="text-transform:none;letter-spacing:0;color:var(--ink-faint)">7-day TTL · stable fields only · used as instant skeleton on cold start</small></div>
          ${(() => {
            const cache = loadTaxonomyCache();
            const tickers = Object.keys(cache);
            const sizeKb = Math.round(JSON.stringify(cache).length / 1024);
            const oldestT = tickers.reduce((m, t) => Math.min(m, cache[t]?.t || Date.now()), Date.now());
            const ageDays = ((Date.now() - oldestT) / 86400000).toFixed(1);
            return `
              <div style="font-family:var(--mono);font-size:11px;color:var(--ink);line-height:1.7">
                <strong>${tickers.length} tickers cached</strong> · ${sizeKb} KB · oldest entry ${ageDays}d ago<br>
                <span style="color:var(--ink-dim)">Holds: name, sector, sub-sector, industry, CEO, country, exchange, IPO date, image, website, description</span>
              </div>
              <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn btn-ghost" style="font-size:10px;padding:4px 10px" onclick="(()=>{localStorage.removeItem('valuatio.taxonomy.cache.v1');document.getElementById('diag-modal').remove();flashStatus('Taxonomy cache cleared','success');})()">Clear Cache</button>
                <button class="btn btn-ghost" style="font-size:10px;padding:4px 10px" onclick="(()=>{const c=JSON.parse(localStorage.getItem('valuatio.taxonomy.cache.v1')||'{}');console.log('Taxonomy cache:',c);document.getElementById('diag-modal').remove();flashStatus('Logged to console','success');})()">Log to Console</button>
              </div>
            `;
          })()}
        </div>
        <div class="modal-section">
          <div class="modal-label">Tabs found (${tabs.length})</div>
          <table class="fn-table" style="width:100%">
            <thead><tr><th>GID</th><th>Headers</th><th>Rows</th><th>Tickers w/ history</th></tr></thead>
            <tbody>
              ${tabs.map(t => `
                <tr>
                  <td>${t.gid}</td>
                  <td style="text-align:left;font-size:10px;color:var(--ink-dim)">${(t.headers || []).slice(0,5).join(', ')}…</td>
                  <td>${(t.rows || []).length}</td>
                  <td>${Object.keys(t.priceHistory || {}).length}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="modal-section">
          <div class="modal-label">Tickers found in rows: ${tickersInSheet.length}</div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);max-height:80px;overflow-y:auto">
            ${tickersInSheet.slice(0, 40).join(', ')}${tickersInSheet.length > 40 ? '…' : ''}
          </div>
        </div>
        <div class="modal-section">
          <div class="modal-label">Price history extracted: ${tickersWithHistory.length} tickers</div>
          <div style="font-family:var(--mono);font-size:11px;color:${tickersWithHistory.length > 0 ? '#5b8a72' : '#a5645a'}">
            ${tickersWithHistory.length === 0
              ? 'NONE — parser could not find date/price pairs. The price chart and historical-probability signal both depend on this.'
              : tickersWithHistory.join(', ')}
          </div>
        </div>
        ${tickersWithHistory.length > 0 ? `
        <div class="modal-section">
          <div class="modal-label">Sample: ${tickersWithHistory[0]} — ${(priceHistory[tickersWithHistory[0]] || []).length} data points</div>
          <table class="fn-table" style="width:100%;font-size:10px">
            <thead><tr><th>Date</th><th>Price</th></tr></thead>
            <tbody>
              ${(priceHistory[tickersWithHistory[0]] || []).slice(-5).map(p => `
                <tr><td>${p.date}</td><td>$${p.price.toFixed(2)}</td></tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ` : `
        <div class="modal-section">
          <div class="modal-label" style="color:var(--amber)">What to check</div>
          <ul style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);line-height:1.7">
            <li>Each ticker row should have a <strong>date in some trailing cell</strong> (e.g. <code>1/2/2025</code> or <code>1/2/2025 16:00:00</code>)</li>
            <li>The next row (with empty ticker column) should have <strong>matching prices</strong> in the same columns</li>
            <li>If the date cell is empty — say only "Date" is there with no actual date — the parser skips it</li>
            <li>If your Google Sheet uses <code>=TRANSPOSE()</code>, the published CSV may show formula errors instead of values. Check by opening the published URL in a new tab</li>
          </ul>
        </div>
        `}
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', html);
  setStatus('Diagnostics shown', 'success');
});

document.getElementById('stockbook-add-btn').addEventListener('click', () => {
  const tic = prompt('Enter ticker symbol (e.g. AAPL):');
  if (!tic) return;
  const ticker = tic.trim().toUpperCase();
  // Validation: ≤5 chars, alphanumeric only
  const stripped = ticker.replace(/[.\-]/g, '');
  if (!ticker || stripped.length > 5 || !/^[A-Z0-9.\-]+$/.test(ticker)) {
    alert('Invalid ticker. Must be ≤5 letters and alphanumeric.');
    return;
  }
  addToPersonalBook({ ticker });
  loadStockBook().then(() => enrichRow(ticker));
});

// Enrich All — process every row missing sector OR description, with rate limiting
document.getElementById('stockbook-enrich-all-btn').addEventListener('click', async () => {
  const setStatus = (m, c='') => {
    const el = document.getElementById('stockbook-status');
    if (el) { el.textContent = m; el.className = 'status ' + c; }
  };
  const btn = document.getElementById('stockbook-enrich-all-btn');
  btn.disabled = true;
  const original = btn.textContent;

  const targets = state.stockbook.rows.filter(r => !r.sector || !r.description);
  if (targets.length === 0) {
    setStatus('All rows already enriched', 'success');
    btn.disabled = false;
    return;
  }

  const delayMs = 600;
  let done = 0;
  let lastRender = 0;

  for (const row of targets) {
    btn.textContent = `Enriching ${done + 1}/${targets.length}…`;
    setStatus(`${row.ticker}…`, '');
    try {
      const enriched = await enrichTicker(row.ticker, row.name);
      if (enriched) {
        // Sheet is authoritative — fill ONLY blanks
        if (!row.sector && enriched.sector)             row.sector = enriched.sector;
        if (!row.industry && enriched.industry)         row.industry = enriched.industry;
        if (!row.name && enriched.name)                 row.name = enriched.name;
        if (!row.description && enriched.description)   row.description = enriched.description;
        addToPersonalBook({
          ticker: row.ticker,
          name: row.name,
          sector: row.sector,
          industry: row.industry,
          description: row.description,
        });
      }
    } catch (e) {
      console.warn('Enrich failed for', row.ticker, e);
    }
    done++;
    // Throttled re-render: every 5 rows or last one. Avoids state loss from too many renders.
    if (done - lastRender >= 5 || done === targets.length) {
      try { renderStockBook(); } catch (e) { console.error('Render error during enrich', e); }
      lastRender = done;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  btn.textContent = original;
  btn.disabled = false;
  setStatus(`Enriched ${done} rows`, 'success');
});

// Description hover tooltip in stockbook
const descTip = document.getElementById('sb-desc-tooltip');
document.addEventListener('mouseover', e => {
  const cell = e.target.closest('.sb-desc');
  if (!cell || !descTip) return;
  const full = cell.dataset.full || cell.textContent;
  if (!full || full === '—') return;
  descTip.textContent = full;
  descTip.style.display = 'block';
});
document.addEventListener('mousemove', e => {
  if (descTip.style.display !== 'block') return;
  let left = e.clientX + 14;
  let top = e.clientY + 14;
  // Keep within viewport
  const rect = descTip.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - 8) left = e.clientX - rect.width - 14;
  if (top + rect.height > window.innerHeight - 8) top = e.clientY - rect.height - 14;
  descTip.style.left = left + 'px';
  descTip.style.top = top + 'px';
});
document.addEventListener('mouseout', e => {
  if (e.target.closest('.sb-desc')) descTip.style.display = 'none';
});

// ============================================================
//   PRICE HISTORY CHART (TradingView-style line chart from Sheet)
// ============================================================

state.priceChart = {
  ticker: null,
  history: null,      // [{date, price}]
  range: 'all',
  geom: null,         // cached geometry for hover
};

async function loadPriceChart(ticker) {
  const section = document.getElementById('price-chart-section');
  if (!section) return;
  // Show a loading state
  section.style.display = 'block';
  const stats = document.getElementById('price-chart-stats');
  if (stats) stats.innerHTML = '<div style="grid-column:1/-1;padding:20px;text-align:center;color:var(--ink-dim);font-family:var(--mono);font-size:11px">Loading chart…</div>';

  const history = await getPriceHistory(ticker);
  if (!history || history.length < 2) {
    state.priceChart.ticker = null;
    state.priceChart.history = null;
    if (stats) {
      stats.innerHTML = `
        <div style="grid-column:1/-1;padding:20px;text-align:center;color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.6">
          <div style="color:var(--amber);font-size:14px;margin-bottom:8px">No price history available for ${ticker}</div>
          Add price data to your sheet, or set a Twelve Data / FMP key in Data Sources for automatic chart fallback.
        </div>
      `;
    }
    // Clear canvas
    const canvas = document.getElementById('price-chart-canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }
  state.priceChart.ticker = ticker;
  state.priceChart.history = history;
  renderPriceChart();
}

// Filter history by current range selection
function getRangedHistory() {
  const h = state.priceChart.history;
  if (!h || !h.length) return [];
  const range = state.priceChart.range;
  if (range === 'all') return h;
  const last = h[h.length - 1].date;
  const lastDate = new Date(last);
  let cutoff;
  if (range === 'ytd') {
    cutoff = new Date(lastDate.getFullYear(), 0, 1);
  } else {
    const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 };
    const m = months[range] || 0;
    cutoff = new Date(lastDate);
    cutoff.setMonth(cutoff.getMonth() - m);
  }
  const cutISO = cutoff.toISOString().slice(0, 10);
  return h.filter(p => p.date >= cutISO);
}

function renderPriceChart() {
  const canvas = document.getElementById('price-chart-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const data = getRangedHistory();
  if (data.length < 2) return;

  const padL = 60, padR = 20, padT = 16, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const prices = data.map(d => d.price);
  let minP = Math.min(...prices);
  let maxP = Math.max(...prices);
  const range = maxP - minP || 1;
  // Add 5% padding
  minP -= range * 0.05;
  maxP += range * 0.05;
  const yRange = maxP - minP;

  const x = (i) => padL + (i / Math.max(data.length - 1, 1)) * plotW;
  const y = (v) => padT + plotH - ((v - minP) / yRange) * plotH;

  state.priceChart.geom = { padL, padR, padT, padB, plotW, plotH, W, H, data, x, y, minP, maxP };

  // ----- Y-axis grid lines + labels -----
  ctx.strokeStyle = '#2a2722';
  ctx.fillStyle = '#8a8275';
  ctx.font = '10px JetBrains Mono';
  ctx.textAlign = 'right';
  for (let frac = 0; frac <= 1; frac += 0.2) {
    const yv = minP + yRange * frac;
    const py = y(yv);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + plotW, py);
    ctx.stroke();
    ctx.fillText('$' + yv.toFixed(2), padL - 8, py + 3);
  }

  // ----- Area fill under the line (TradingView-style) -----
  const firstPrice = data[0].price;
  const lastPrice = data[data.length - 1].price;
  const isUp = lastPrice >= firstPrice;
  const lineColor = isUp ? '#5b8a72' : '#a5645a';
  const fillColor = isUp ? 'rgba(91, 138, 114, 0.15)' : 'rgba(165, 100, 90, 0.15)';

  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i), py = y(d.price);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.lineTo(x(data.length - 1), padT + plotH);
  ctx.lineTo(x(0), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // ----- Line -----
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  data.forEach((d, i) => {
    const px = x(i), py = y(d.price);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // ----- X-axis date labels (3-5 evenly spaced) -----
  ctx.fillStyle = '#8a8275';
  ctx.textAlign = 'center';
  const labelCount = 5;
  for (let li = 0; li < labelCount; li++) {
    const idx = Math.floor((data.length - 1) * li / (labelCount - 1));
    const d = data[idx];
    if (!d) continue;
    // Friendly date: "Jan '25" or "Mar 14" depending on range
    const dt = new Date(d.date);
    const label = dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    ctx.fillText(label, x(idx), padT + plotH + 16);
  }

  // ----- Stats below -----
  renderPriceChartStats(data);
}

function renderPriceChartStats(data) {
  const wrap = document.getElementById('price-chart-stats');
  if (!wrap) return;
  const first = data[0].price, last = data[data.length - 1].price;
  const change = last - first;
  const changePct = (change / first) * 100;
  const high = Math.max(...data.map(d => d.price));
  const low = Math.min(...data.map(d => d.price));
  const dir = change >= 0 ? 'up' : 'down';
  wrap.innerHTML = `
    <div><div class="l">Last</div><div class="v">$${last.toFixed(2)}</div></div>
    <div><div class="l">Change</div><div class="v ${dir}">${change >= 0 ? '+' : ''}$${change.toFixed(2)}</div></div>
    <div><div class="l">% Change</div><div class="v ${dir}">${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%</div></div>
    <div><div class="l">Range High</div><div class="v">$${high.toFixed(2)}</div></div>
    <div><div class="l">Range Low</div><div class="v">$${low.toFixed(2)}</div></div>
    <div><div class="l">Data Points</div><div class="v">${data.length}</div></div>
  `;
}

// Range button handlers
document.getElementById('price-range-control')?.addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.priceChart.range = btn.dataset.range;
  document.querySelectorAll('#price-range-control .seg-btn').forEach(b => {
    b.classList.toggle('active', b === btn);
  });
  renderPriceChart();
});

// Hover tooltip
function attachPriceChartHover() {
  const canvas = document.getElementById('price-chart-canvas');
  const tip = document.getElementById('price-chart-tooltip');
  if (!canvas || !tip) return;

  canvas.onmousemove = (e) => {
    const geom = state.priceChart.geom;
    if (!geom) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < geom.padL || mx > geom.padL + geom.plotW || my < geom.padT || my > geom.padT + geom.plotH) {
      tip.style.display = 'none';
      renderPriceChart();
      return;
    }
    // Find closest data point
    const fraction = (mx - geom.padL) / geom.plotW;
    const idx = Math.round(fraction * (geom.data.length - 1));
    const d = geom.data[idx];
    if (!d) return;

    renderPriceChart(); // redraw clean
    const ctx = canvas.getContext('2d');
    const px = geom.x(idx);
    const py = geom.y(d.price);

    // Crosshair
    ctx.strokeStyle = 'rgba(232, 223, 201, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px, geom.padT);
    ctx.lineTo(px, geom.padT + geom.plotH);
    ctx.moveTo(geom.padL, py);
    ctx.lineTo(geom.padL + geom.plotW, py);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dot
    ctx.fillStyle = '#d4a24c';
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0d0d0d';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Tooltip content
    const first = geom.data[0].price;
    const fromStart = ((d.price - first) / first) * 100;
    const dir = fromStart >= 0 ? 'up' : 'down';
    const dirColor = dir === 'up' ? '#5b8a72' : '#a5645a';
    const dt = new Date(d.date);
    const dateLabel = dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    tip.innerHTML = `
      <div class="pct-date">${dateLabel}</div>
      <div class="pct-price">$${d.price.toFixed(2)}</div>
      <div class="pct-change" style="color:${dirColor}">${fromStart >= 0 ? '+' : ''}${fromStart.toFixed(2)}% from start</div>
    `;
    tip.style.display = 'block';
    const tipW = 160;
    let leftPx = mx + 14;
    if (leftPx + tipW > rect.width - 8) leftPx = mx - tipW - 14;
    tip.style.left = leftPx + 'px';
    tip.style.top = Math.max(8, my - 60) + 'px';
  };

  canvas.onmouseleave = () => {
    tip.style.display = 'none';
    renderPriceChart();
  };
}
attachPriceChartHover();

// Redraw on resize
window.addEventListener('resize', () => {
  if (state.priceChart.history) renderPriceChart();
});

// ============================================================
//   BLOOMBERG-STYLE COMMAND TERMINAL
//   Mnemonic-driven function dispatcher.
//   Syntax:  TICKER FN          (e.g. "AAPL DES", "NVDA GP", "SPY WACC")
//   Or just: FN                  (uses currently loaded ticker)
//   Or just: TICKER              (loads valuation for ticker)
//   Press / to focus, ESC to clear, ENTER or GO to execute.
// ============================================================

state.terminal = {
  assetClass: 'EQUITY',
  selectedSuggest: 0,
  history: [],          // recent commands
};

// Function registry: mnemonic → { name, desc, scope, handler }
// scope: 'global' (no ticker required) or 'ticker' (needs ticker)
const TERMINAL_FUNCTIONS = {
  // === Company info & analysis ===
  DES:    { name: 'Description',          desc: 'Company overview, financials, contacts', scope: 'ticker', handler: fnDES },
  GP:     { name: 'Price Chart',          desc: 'Historical price chart with hover',     scope: 'ticker', handler: fnGP },
  RV:     { name: 'Relative Valuation',   desc: 'Compare peers on multiples',            scope: 'ticker', handler: fnRV },
  EE:     { name: 'Earnings Estimates',   desc: 'Consensus estimates & history',         scope: 'ticker', handler: fnEE },
  ANR:    { name: 'Analyst Recommendations', desc: 'Analyst ratings & target price',     scope: 'ticker', handler: fnANR },
  WACC:   { name: 'Cost of Capital',      desc: 'Weighted avg cost of capital',          scope: 'ticker', handler: fnWACC },
  FA:     { name: 'Financial Analysis',   desc: 'Statements & key ratios',               scope: 'ticker', handler: fnFA },
  SPLC:   { name: 'Supply Chain',         desc: 'Suppliers, customers, peers',           scope: 'ticker', handler: fnSPLC },
  HOLD:   { name: 'Holdings (52W)',       desc: '52-week range + current position',      scope: 'ticker', handler: fnHOLD },
  CRPR:   { name: 'Credit Profile',       desc: 'Synthetic rating & default spread',     scope: 'ticker', handler: fnCRPR },

  // === Market & macro ===
  GMM:    { name: 'Global Market Monitor', desc: 'Sector ETFs & macro snapshot',         scope: 'global', handler: fnGMM },
  IMAP:   { name: 'Intraday Market Map',   desc: 'Sector heat map by performance',       scope: 'global', handler: fnIMAP },
  HEAT:   { name: 'Heat Map by Sector',    desc: 'All your stocks grouped by sector',    scope: 'global', handler: fnHEAT },
  SOVM:   { name: 'Sovereign Monitor',     desc: 'Treasury yields & Fed Funds',          scope: 'global', handler: fnSOVM },
  QUAD:   { name: 'GIP Quad',              desc: 'Current macro regime',                 scope: 'global', handler: () => switchTab('macro') },

  // === Navigation ===
  HELP:   { name: 'Help',                 desc: 'List all functions',                    scope: 'global', handler: fnHELP },
  TOP:    { name: 'Top of Workspace',     desc: 'Jump to Valuation tab',                 scope: 'global', handler: () => switchTab('valuation') },
  BOOK:   { name: 'Stock Book',           desc: 'Full ticker universe',                  scope: 'global', handler: () => switchTab('stockbook') },
  EQS:    { name: 'Equity Screen',        desc: 'Filter your stock book',                scope: 'global', handler: fnEQS },
  PORT:   { name: 'Portfolio',            desc: 'Saved valuations summary',              scope: 'global', handler: fnPORT },
};

const TERMINAL_GROUPS = [
  { label: 'Company', mnemonics: ['DES', 'GP', 'RV', 'EE', 'ANR', 'WACC', 'FA', 'SPLC', 'HOLD', 'CRPR'] },
  { label: 'Market',  mnemonics: ['GMM', 'IMAP', 'HEAT', 'SOVM', 'QUAD'] },
  { label: 'Navigate', mnemonics: ['HELP', 'TOP', 'BOOK', 'EQS', 'PORT'] },
];

// ---------- COMMAND PARSER ----------
function parseCommand(input) {
  const tokens = input.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Strip trailing GO if present
  if (tokens[tokens.length - 1] === 'GO') tokens.pop();
  // Strip <EQUITY>, <CMDTY> etc tokens
  const filtered = tokens.filter(t => !/^<\w+>$/.test(t));

  if (filtered.length === 0) return null;

  // Cases:
  //   single token: ticker OR mnemonic
  //   two tokens: ticker mnemonic (or mnemonic ticker)
  //   3+: ticker + multi-word query (rare for our purposes)
  let ticker = null, mnem = null;
  for (const t of filtered) {
    if (TERMINAL_FUNCTIONS[t]) mnem = t;
    else if (/^[A-Z0-9.\-]{1,6}$/.test(t)) ticker = t;
  }
  return { ticker, mnem, raw: input };
}

// ---------- DISPATCHER ----------
async function executeCommand(input) {
  const parsed = parseCommand(input);
  if (!parsed) return;

  state.terminal.history.unshift(input);
  if (state.terminal.history.length > 50) state.terminal.history.pop();

  const { ticker, mnem } = parsed;

  // Just a ticker → load valuation
  if (ticker && !mnem) {
    document.getElementById('ticker').value = ticker;
    switchTab('valuation');
    loadValuation();
    return;
  }

  // Just a mnemonic, scope=global → run it
  if (mnem && !ticker && TERMINAL_FUNCTIONS[mnem].scope === 'global') {
    TERMINAL_FUNCTIONS[mnem].handler();
    return;
  }

  // Mnemonic + ticker → run with that ticker
  if (mnem) {
    const tic = ticker || state.stock?.ticker;
    if (!tic && TERMINAL_FUNCTIONS[mnem].scope === 'ticker') {
      flashStatus('Need a ticker for ' + mnem, 'error');
      return;
    }
    TERMINAL_FUNCTIONS[mnem].handler(tic);
    return;
  }
}

// ---------- FUNCTION OVERLAY HELPERS ----------
function openFnOverlay(mnem, ticker) {
  const fn = TERMINAL_FUNCTIONS[mnem];
  if (!fn) return;
  document.getElementById('fn-overlay').style.display = 'flex';
  document.getElementById('fn-overlay-mnem').textContent = mnem;
  document.getElementById('fn-overlay-title').textContent = fn.name;
  document.getElementById('fn-overlay-tic').textContent = ticker || '';
  document.getElementById('fn-overlay-body').innerHTML =
    '<div style="text-align:center;padding:60px;color:var(--ink-dim);font-family:var(--mono);">Loading…</div>';
}
function setFnOverlayBody(html) {
  document.getElementById('fn-overlay-body').innerHTML = html;
}
function closeFnOverlay() {
  document.getElementById('fn-overlay').style.display = 'none';
}
document.getElementById('fn-overlay-close').addEventListener('click', closeFnOverlay);

// ============================================================
//   FUNCTION IMPLEMENTATIONS
// ============================================================

// --- DES: Company description (overview, key stats, links) ---
async function fnDES(ticker) {
  openFnOverlay('DES', ticker);
  // Use stockbook + sheet + enrichment to assemble a profile
  let row = state.stockbook.rows.find(r => r.ticker === ticker);
  let enriched = null;
  try { enriched = await enrichTicker(ticker, row?.name); } catch {}
  const merged = { ...(row || {}), ...(enriched || {}) };

  // If we don't have anything, fetch fresh
  if (!merged.price || !merged.name) {
    try {
      const raw = await fetchStock(ticker);
      const stock = normalizeStock(raw);
      Object.assign(merged, stock);
    } catch {}
  }

  // Build company info row from FMPDATA fields
  const ci = [];
  if (merged.ceo)        ci.push(`<div><div class="l">CEO</div><div class="v">${escapeHtml(merged.ceo)}</div></div>`);
  if (merged.exchange)   ci.push(`<div><div class="l">Exchange</div><div class="v">${escapeHtml(merged.exchange)}</div></div>`);
  if (merged.ipoDate)    ci.push(`<div><div class="l">IPO Date</div><div class="v">${escapeHtml(String(merged.ipoDate).slice(0, 10))}</div></div>`);
  if (merged.employees)  ci.push(`<div><div class="l">Employees</div><div class="v">${merged.employees.toLocaleString()}</div></div>`);
  if (merged.city || merged.stateLoc) {
    const loc = [merged.city, merged.stateLoc].filter(Boolean).join(', ');
    ci.push(`<div><div class="l">HQ Location</div><div class="v">${escapeHtml(loc)}</div></div>`);
  }
  if (merged.address)    ci.push(`<div><div class="l">Address</div><div class="v" style="font-size:11px">${escapeHtml(merged.address)}</div></div>`);
  if (merged.phone)      ci.push(`<div><div class="l">Phone</div><div class="v" style="font-size:11px">${escapeHtml(merged.phone)}</div></div>`);
  if (merged.currency)   ci.push(`<div><div class="l">Currency</div><div class="v">${escapeHtml(merged.currency)}</div></div>`);

  // Top header with logo + name + website
  const logoHtml = (merged.image && /^https?:\/\//.test(merged.image))
    ? `<img src="${merged.image}" style="width:72px;height:72px;border-radius:8px;background:var(--bg-card);border:1px solid var(--rule);object-fit:contain;padding:6px;flex-shrink:0" onerror="this.style.display='none'">`
    : '';
  const websiteHtml = merged.website ? (() => {
    const cleanUrl = String(merged.website).replace(/\/$/, '');
    const display = cleanUrl.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return `<a href="${cleanUrl}" target="_blank" rel="noopener" style="color:var(--amber);font-family:var(--mono);font-size:11px">${escapeHtml(display)}</a>`;
  })() : '';

  const fullDesc = merged.fullDescription || merged.description || 'No description available. Run the FMPDATA Apps Script in your sheet to populate company details.';

  setFnOverlayBody(`
    <div class="fn-section">
      <div style="display:flex;align-items:flex-start;gap:18px;margin-bottom:14px">
        ${logoHtml}
        <div style="flex:1;min-width:0">
          <h3 style="margin:0">${escapeHtml(merged.name || ticker)}</h3>
          <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);margin-top:6px;display:flex;gap:14px;flex-wrap:wrap">
            <span style="color:var(--amber);font-weight:700">${ticker}</span>
            ${merged.exchange ? `<span>${escapeHtml(merged.exchange)}</span>` : ''}
            ${websiteHtml}
            ${merged.countryFull && merged.countryFull !== '—' ? `<span>${escapeHtml(merged.countryFull)}</span>` : ''}
          </div>
        </div>
      </div>
      <div style="font-family:var(--serif);color:var(--ink-dim);font-size:13px;line-height:1.7;margin:8px 0 16px">
        ${escapeHtml(String(fullDesc))}
      </div>
      ${ci.length > 0 ? `<div class="fn-kv-grid">${ci.join('')}</div>` : ''}
    </div>
    <div class="fn-section">
      <h3>Key Statistics</h3>
      <div class="fn-kv-grid">
        <div><div class="l">Sector</div><div class="v">${merged.sector || '—'}</div></div>
        <div><div class="l">Industry</div><div class="v">${merged.industry || '—'}</div></div>
        <div><div class="l">Last Price</div><div class="v">${merged.price != null ? '$' + merged.price.toFixed(2) : '—'}</div></div>
        <div><div class="l">Market Cap</div><div class="v">${merged.marketCap != null ? formatHumanNumber(merged.marketCap) : '—'}</div></div>
        ${merged.fmpMarketCap && merged.fmpMarketCap !== merged.marketCap ?
          `<div><div class="l">FMP Market Cap</div><div class="v" style="color:#c4965a">${formatHumanNumber(merged.fmpMarketCap)}</div></div>` : ''}
        <div><div class="l">P/E</div><div class="v">${merged.pe != null ? merged.pe.toFixed(2) : '—'}</div></div>
        <div><div class="l">EPS</div><div class="v">${merged.eps != null ? '$' + merged.eps.toFixed(2) : '—'}</div></div>
        <div><div class="l">Beta</div><div class="v">${merged.beta != null ? merged.beta.toFixed(2) : '—'}</div></div>
        <div><div class="l">52W High</div><div class="v">${merged.high52 != null ? '$' + merged.high52.toFixed(2) : '—'}</div></div>
        <div><div class="l">52W Low</div><div class="v">${merged.low52 != null ? '$' + merged.low52.toFixed(2) : '—'}</div></div>
        <div><div class="l">Dividend Yield</div><div class="v">${merged.dividendYield != null ? (merged.dividendYield * 100).toFixed(2) + '%' : '—'}</div></div>
        ${merged.isEtf === true || merged.isEtf === 'TRUE' ? `<div><div class="l">Type</div><div class="v" style="color:var(--amber)">ETF</div></div>` : ''}
        ${merged.isFund === true || merged.isFund === 'TRUE' ? `<div><div class="l">Type</div><div class="v" style="color:var(--amber)">Fund</div></div>` : ''}
      </div>
    </div>
    <div class="fn-section">
      <h3>Quick Actions</h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${['GP', 'RV', 'WACC', 'EE', 'ANR', 'FA', 'SPLC', 'HOLD'].map(m =>
          `<button class="btn btn-ghost" onclick="executeCommand('${ticker} ${m}')">${m} ${TERMINAL_FUNCTIONS[m].name}</button>`
        ).join('')}
      </div>
    </div>
  `);
}

// --- GP: Price chart (uses existing chart, just opens valuation tab and scrolls to chart) ---
async function fnGP(ticker) {
  closeFnOverlay();
  document.getElementById('ticker').value = ticker;
  switchTab('valuation');
  await loadValuation();
  // Scroll to price chart
  setTimeout(() => {
    document.getElementById('price-chart-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 300);
}

// --- RV: Relative valuation (peer comparison via stockbook + sector) ---
async function fnRV(ticker) {
  openFnOverlay('RV', ticker);
  const subjectRow = state.stockbook.rows.find(r => r.ticker === ticker);
  const subjectEnriched = await enrichTicker(ticker, subjectRow?.name).catch(() => null);
  const subjectSector = subjectRow?.sector || subjectEnriched?.sector;

  if (!subjectSector) {
    setFnOverlayBody(`<div class="fn-section"><h3>Need sector first</h3><p>Run <strong>${ticker} DES</strong> or <strong>Enrich All</strong> in the Stock Book to get peer matching working.</p></div>`);
    return;
  }

  // Find peers in same sector
  const peers = state.stockbook.rows.filter(r =>
    r.ticker !== ticker &&
    r.sector &&
    r.sector.toLowerCase() === subjectSector.toLowerCase()
  ).slice(0, 12);

  // Add subject at top
  const allRows = [subjectRow, ...peers].filter(Boolean);
  if (allRows.length === 0) {
    setFnOverlayBody(`<div class="fn-section"><h3>No data</h3><p>${ticker} not found in your Stock Book.</p></div>`);
    return;
  }

  // Compute sector medians
  const med = (key) => {
    const vals = peers.map(p => p[key]).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    if (vals.length === 0) return null;
    return vals[Math.floor(vals.length / 2)];
  };
  const medians = { pe: med('pe'), beta: med('beta'), marketCap: med('marketCap'), plPct: med('plPct') };

  setFnOverlayBody(`
    <div class="fn-section">
      <h3>${subjectSector} · ${peers.length} peers from your Stock Book</h3>
      <table class="fn-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Name</th>
            <th>Price</th>
            <th>Mkt Cap</th>
            <th>P/E</th>
            <th>P/E vs Sector</th>
            <th>Beta</th>
            <th>P/L%</th>
          </tr>
        </thead>
        <tbody>
          ${allRows.map(r => {
            const pe_ratio = (r.pe && medians.pe) ? r.pe / medians.pe : null;
            const peColor = pe_ratio == null ? '' : (pe_ratio < 0.85 ? 'pos' : pe_ratio > 1.15 ? 'neg' : '');
            const isSubject = r.ticker === ticker;
            return `
              <tr ${isSubject ? 'style="background:rgba(245,184,0,0.08)"' : ''}>
                <td>${r.ticker}${isSubject ? ' ◀' : ''}</td>
                <td style="text-align:left">${r.name || '—'}</td>
                <td>${r.price != null ? '$' + r.price.toFixed(2) : '—'}</td>
                <td>${r.marketCap != null ? formatHumanNumber(r.marketCap) : '—'}</td>
                <td>${r.pe != null ? r.pe.toFixed(2) : '—'}</td>
                <td class="${peColor}">${pe_ratio != null ? pe_ratio.toFixed(2) + 'x' : '—'}</td>
                <td>${r.beta != null ? r.beta.toFixed(2) : '—'}</td>
                <td class="${r.plPct > 0 ? 'pos' : r.plPct < 0 ? 'neg' : ''}">${r.plPct != null ? (r.plPct >= 0 ? '+' : '') + r.plPct.toFixed(1) + '%' : '—'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="fn-section">
      <h3>Sector Medians (peers only)</h3>
      <div class="fn-kv-grid">
        <div><div class="l">Median P/E</div><div class="v">${medians.pe != null ? medians.pe.toFixed(2) : '—'}</div></div>
        <div><div class="l">Median Beta</div><div class="v">${medians.beta != null ? medians.beta.toFixed(2) : '—'}</div></div>
        <div><div class="l">Median Mkt Cap</div><div class="v">${medians.marketCap != null ? formatHumanNumber(medians.marketCap) : '—'}</div></div>
        <div><div class="l">Median P/L%</div><div class="v">${medians.plPct != null ? medians.plPct.toFixed(1) + '%' : '—'}</div></div>
      </div>
    </div>
  `);
}

// --- WACC: Cost of capital breakdown ---
async function fnWACC(ticker) {
  openFnOverlay('WACC', ticker);
  // Make sure we've loaded the stock so inputs/state.results are populated
  if (!state.stock || state.stock.ticker !== ticker) {
    document.getElementById('ticker').value = ticker;
    try { await loadValuation(); } catch {}
  }
  const i = state.inputs;
  if (!i || !i.beta) {
    setFnOverlayBody('<div class="fn-section"><h3>Load valuation first</h3></div>');
    return;
  }
  const coeData = costOfEquity(i);
  const w = wacc(i);
  const E = i.marketCap || 0, D = i.totalDebt || 0, V = E + D;
  const wE = V > 0 ? E / V : 1;
  const wD = V > 0 ? D / V : 0;
  const cod = i.preTaxCostOfDebt / 100;
  const t = i.taxRate / 100;

  setFnOverlayBody(`
    <div class="fn-section">
      <h3>Weighted Average Cost of Capital — ${ticker}</h3>
      <div class="fn-kv-grid">
        <div><div class="l">WACC</div><div class="v" style="color:var(--amber);font-size:20px">${(w * 100).toFixed(2)}%</div></div>
        <div><div class="l">Cost of Equity</div><div class="v">${(coeData.coe * 100).toFixed(2)}%</div></div>
        <div><div class="l">Cost of Debt (after tax)</div><div class="v">${(cod * (1 - t) * 100).toFixed(2)}%</div></div>
        <div><div class="l">Equity Weight</div><div class="v">${(wE * 100).toFixed(1)}%</div></div>
        <div><div class="l">Debt Weight</div><div class="v">${(wD * 100).toFixed(1)}%</div></div>
        <div><div class="l">Tax Rate</div><div class="v">${i.taxRate.toFixed(1)}%</div></div>
      </div>
    </div>
    <div class="fn-section">
      <h3>Cost of Equity Build (CAPM, operation-based CRP)</h3>
      <table class="fn-table">
        <thead><tr><th>Component</th><th>Value</th><th>Weighted Contribution</th></tr></thead>
        <tbody>
          <tr><td>Risk-Free Rate</td><td>${(coeData.rf * 100).toFixed(2)}%</td><td>${(coeData.rf * 100).toFixed(2)}%</td></tr>
          <tr><td>Mature Market ERP</td><td>${(coeData.erp * 100).toFixed(2)}%</td><td>${(coeData.beta * coeData.erp * 100).toFixed(2)}%</td></tr>
          <tr><td>Blended Country Risk</td><td>${(coeData.blendedCRP * 100).toFixed(2)}%</td><td>${(coeData.beta * coeData.blendedCRP * 100).toFixed(2)}%</td></tr>
          <tr><td>Beta</td><td>${coeData.beta.toFixed(2)}</td><td>—</td></tr>
          <tr style="background:rgba(245,184,0,0.06)"><td>Cost of Equity</td><td>—</td><td>${(coeData.coe * 100).toFixed(2)}%</td></tr>
        </tbody>
      </table>
    </div>
    <div class="fn-section">
      <h3>Capital Structure</h3>
      <div class="fn-kv-grid">
        <div><div class="l">Market Value of Equity</div><div class="v">${formatHumanNumber(E)}</div></div>
        <div><div class="l">Market Value of Debt</div><div class="v">${formatHumanNumber(D)}</div></div>
        <div><div class="l">Enterprise Value</div><div class="v">${formatHumanNumber(V)}</div></div>
        <div><div class="l">D/E Ratio</div><div class="v">${E > 0 ? (D / E).toFixed(2) : '—'}</div></div>
      </div>
    </div>
  `);
}

// --- HOLD: 52-week range visualization ---
async function fnHOLD(ticker) {
  openFnOverlay('HOLD', ticker);
  const row = state.stockbook.rows.find(r => r.ticker === ticker);
  const stock = state.stock?.ticker === ticker ? state.stock : null;
  const price = stock?.price ?? row?.price;
  const high52 = stock?.high52 ?? row?.high52;
  const low52 = stock?.low52 ?? row?.low52;
  const priceWhen = row?.priceWhenAdded;
  const plPct = row?.plPct;
  const status = row?.status;

  if (!price || !high52 || !low52) {
    setFnOverlayBody('<div class="fn-section"><h3>Need price + 52W range</h3><p>Make sure your sheet has price, high52, low52 columns for this ticker.</p></div>');
    return;
  }

  const range = high52 - low52;
  const pctOfRange = range > 0 ? (price - low52) / range : 0;

  setFnOverlayBody(`
    <div class="fn-section">
      <h3>52-Week Position — ${ticker}</h3>
      <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);margin-bottom:12px;display:flex;justify-content:space-between">
        <span>$${low52.toFixed(2)}</span>
        <span style="color:var(--amber);font-weight:700">${(pctOfRange * 100).toFixed(1)}% of range</span>
        <span>$${high52.toFixed(2)}</span>
      </div>
      <div style="position:relative;height:40px;background:linear-gradient(to right,#a5645a,var(--amber),#5b8a72);opacity:0.4;border:1px solid var(--rule)">
        <div style="position:absolute;top:-4px;width:3px;height:48px;background:var(--amber);left:${pctOfRange * 100}%;box-shadow:0 0 8px var(--amber)"></div>
      </div>
    </div>
    <div class="fn-section">
      <h3>Position Stats</h3>
      <div class="fn-kv-grid">
        <div><div class="l">Current Price</div><div class="v" style="color:var(--amber)">$${price.toFixed(2)}</div></div>
        <div><div class="l">52W High</div><div class="v">$${high52.toFixed(2)}</div></div>
        <div><div class="l">52W Low</div><div class="v">$${low52.toFixed(2)}</div></div>
        <div><div class="l">% From High</div><div class="v down">${(((price - high52) / high52) * 100).toFixed(2)}%</div></div>
        <div><div class="l">% From Low</div><div class="v up">+${(((price - low52) / low52) * 100).toFixed(2)}%</div></div>
        <div><div class="l">Avg of Range</div><div class="v">$${((high52 + low52) / 2).toFixed(2)}</div></div>
        ${priceWhen ? `<div><div class="l">Price When Added</div><div class="v">$${priceWhen.toFixed(2)}</div></div>` : ''}
        ${plPct != null ? `<div><div class="l">P/L Since Added</div><div class="v ${plPct > 0 ? 'up' : 'down'}">${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%</div></div>` : ''}
        ${status ? `<div><div class="l">Status</div><div class="v">${status}</div></div>` : ''}
      </div>
    </div>
  `);
}

// --- FA: Financial Analysis (key ratios from current valuation inputs) ---
async function fnFA(ticker) {
  openFnOverlay('FA', ticker);
  if (!state.stock || state.stock.ticker !== ticker) {
    document.getElementById('ticker').value = ticker;
    try { await loadValuation(); } catch {}
  }
  const s = state.stock;

  // If FMP key is set, fetch real annual statements
  let fmpData = null;
  if (getFmpKey()) {
    try {
      const [income, balance, cashflow] = await Promise.all([
        fetchFmpIncome(ticker, 'annual', 4),
        fetchFmpBalance(ticker, 'annual', 4),
        fetchFmpCashflow(ticker, 'annual', 4),
      ]);
      if (income?.length || balance?.length || cashflow?.length) {
        fmpData = { income, balance, cashflow };
      }
    } catch {}
  }

  if (!s && !fmpData) {
    setFnOverlayBody('<div class="fn-section"><h3>Could not load financials</h3><p style="color:var(--ink-dim)">Add a Financial Modeling Prep key in Data Sources, or load this ticker on the Valuation tab first.</p></div>');
    return;
  }

  // Build FMP financials table if available
  let fmpHtml = '';
  if (fmpData) {
    const fmt = (n) => n != null && isFinite(n) ? formatHumanNumber(n) : '—';
    const incomeYears = fmpData.income || [];
    const balanceYears = fmpData.balance || [];
    const cashflowYears = fmpData.cashflow || [];

    if (incomeYears.length > 0) {
      const headers = incomeYears.map(y => y.calendarYear || y.date?.slice(0, 4) || '—');
      const incomeRow = (label, key) => `
        <tr><td>${label}</td>${incomeYears.map(y => `<td>${fmt(y[key])}</td>`).join('')}</tr>
      `;
      fmpHtml += `
        <div class="fn-section">
          <h3>Income Statement · Annual (FMP)</h3>
          <table class="fn-table">
            <thead><tr><th>Line Item</th>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>
              ${incomeRow('Revenue', 'revenue')}
              ${incomeRow('Cost of Revenue', 'costOfRevenue')}
              ${incomeRow('Gross Profit', 'grossProfit')}
              ${incomeRow('Operating Expenses', 'operatingExpenses')}
              ${incomeRow('Operating Income', 'operatingIncome')}
              ${incomeRow('EBITDA', 'ebitda')}
              ${incomeRow('Net Income', 'netIncome')}
              ${incomeRow('EPS (Diluted)', 'epsdiluted')}
            </tbody>
          </table>
        </div>
      `;
    }
    if (balanceYears.length > 0) {
      const headers = balanceYears.map(y => y.calendarYear || y.date?.slice(0, 4) || '—');
      const balanceRow = (label, key) => `
        <tr><td>${label}</td>${balanceYears.map(y => `<td>${fmt(y[key])}</td>`).join('')}</tr>
      `;
      fmpHtml += `
        <div class="fn-section">
          <h3>Balance Sheet · Annual (FMP)</h3>
          <table class="fn-table">
            <thead><tr><th>Line Item</th>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>
              ${balanceRow('Cash & Equivalents', 'cashAndCashEquivalents')}
              ${balanceRow('Short-Term Investments', 'shortTermInvestments')}
              ${balanceRow('Total Current Assets', 'totalCurrentAssets')}
              ${balanceRow('Total Assets', 'totalAssets')}
              ${balanceRow('Total Debt', 'totalDebt')}
              ${balanceRow('Total Liabilities', 'totalLiabilities')}
              ${balanceRow('Total Equity', 'totalStockholdersEquity')}
              ${balanceRow('Net Debt', 'netDebt')}
            </tbody>
          </table>
        </div>
      `;
    }
    if (cashflowYears.length > 0) {
      const headers = cashflowYears.map(y => y.calendarYear || y.date?.slice(0, 4) || '—');
      const cfRow = (label, key) => `
        <tr><td>${label}</td>${cashflowYears.map(y => `<td>${fmt(y[key])}</td>`).join('')}</tr>
      `;
      fmpHtml += `
        <div class="fn-section">
          <h3>Cash Flow Statement · Annual (FMP)</h3>
          <table class="fn-table">
            <thead><tr><th>Line Item</th>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>
              ${cfRow('Operating Cash Flow', 'operatingCashFlow')}
              ${cfRow('CapEx', 'capitalExpenditure')}
              ${cfRow('Free Cash Flow', 'freeCashFlow')}
              ${cfRow('Investing Cash Flow', 'netCashUsedForInvestingActivites')}
              ${cfRow('Financing Cash Flow', 'netCashUsedProvidedByFinancingActivities')}
              ${cfRow('Dividends Paid', 'dividendsPaid')}
              ${cfRow('Stock Buybacks', 'commonStockRepurchased')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // TTM summary block (always shown when state.stock exists)
  let ttmHtml = '';
  if (s) {
    const ev = s.marketCap && s.totalDebt != null ? s.marketCap + s.totalDebt - (s.cash || 0) : null;
    const evToRev = ev && s.revenue ? ev / s.revenue : null;
    const evToEbitda = ev && s.ebitda ? ev / s.ebitda : s.evToEbitda;
    const fcfYield = s.freeCashFlow && s.marketCap ? s.freeCashFlow / s.marketCap : null;
    ttmHtml = `
      <div class="fn-section">
        <h3>TTM Snapshot · Valuation Ratios</h3>
        <div class="fn-kv-grid">
          <div><div class="l">Revenue (TTM)</div><div class="v">${formatHumanNumber(s.revenue)}</div></div>
          <div><div class="l">EBITDA (TTM)</div><div class="v">${formatHumanNumber(s.ebitda)}</div></div>
          <div><div class="l">Net Income (TTM)</div><div class="v">${formatHumanNumber(s.netIncome)}</div></div>
          <div><div class="l">Free Cash Flow (TTM)</div><div class="v">${formatHumanNumber(s.freeCashFlow)}</div></div>
          <div><div class="l">P/E</div><div class="v">${s.pe != null ? s.pe.toFixed(2) : '—'}</div></div>
          <div><div class="l">EV/Revenue</div><div class="v">${evToRev != null ? evToRev.toFixed(2) + 'x' : '—'}</div></div>
          <div><div class="l">EV/EBITDA</div><div class="v">${evToEbitda != null ? evToEbitda.toFixed(2) + 'x' : '—'}</div></div>
          <div><div class="l">FCF Yield</div><div class="v">${fcfYield != null ? (fcfYield * 100).toFixed(2) + '%' : '—'}</div></div>
          <div><div class="l">ROE</div><div class="v">${s.returnOnEquity != null ? (s.returnOnEquity * 100).toFixed(2) + '%' : '—'}</div></div>
          <div><div class="l">ROA</div><div class="v">${s.returnOnAssets != null ? (s.returnOnAssets * 100).toFixed(2) + '%' : '—'}</div></div>
          <div><div class="l">Operating Margin</div><div class="v">${s.operatingMargin != null ? (s.operatingMargin * 100).toFixed(2) + '%' : '—'}</div></div>
          <div><div class="l">P/B</div><div class="v">${s.priceToBook != null ? s.priceToBook.toFixed(2) : '—'}</div></div>
        </div>
      </div>
    `;
  }

  const noFmpNote = !getFmpKey() ? `
    <div class="fn-section">
      <p style="color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.6">
        Add a <strong style="color:var(--amber)">Financial Modeling Prep</strong> key in Data Sources
        to see 4 years of full income / balance sheet / cash flow statements here.
        Free tier: 250 calls/day at <a href="https://site.financialmodelingprep.com/register" target="_blank" style="color:var(--amber)">financialmodelingprep.com/register</a>
      </p>
    </div>
  ` : '';

  // Compute and render financial health grade
  const gradeHtml = renderFinancialGrade(s, fmpData);

  setFnOverlayBody(gradeHtml + ttmHtml + fmpHtml + noFmpNote);
}

// ============================================================
//   FINANCIAL HEALTH GRADE
//   Grades a stock A+ to F based on key indicators of business health.
//   Each category scored 0-100; final letter grade based on weighted avg.
// ============================================================
function renderFinancialGrade(s, fmpData) {
  if (!s && !fmpData) return '';

  // Pull most recent annual data from FMP if available
  const inc = fmpData?.income?.[0];
  const bal = fmpData?.balance?.[0];
  const cf  = fmpData?.cashflow?.[0];
  const incPrior = fmpData?.income?.[1];
  const incOld   = fmpData?.income?.[2];

  const scores = []; // {category, score, value, note, weight}

  // ── 1. PROFITABILITY (ROE, ROA, Operating Margin, Net Margin)
  let profitScore = null;
  let profitNotes = [];
  const roe = s?.returnOnEquity ?? (inc?.netIncome && bal?.totalStockholdersEquity ? inc.netIncome / bal.totalStockholdersEquity : null);
  const roa = s?.returnOnAssets ?? (inc?.netIncome && bal?.totalAssets ? inc.netIncome / bal.totalAssets : null);
  const opMargin = s?.operatingMargin ?? (inc?.operatingIncome && inc?.revenue ? inc.operatingIncome / inc.revenue : null);
  const netMargin = inc?.netIncome && inc?.revenue ? inc.netIncome / inc.revenue : null;
  if (roe != null || roa != null || opMargin != null || netMargin != null) {
    let p = 0, n = 0;
    if (roe != null)       { p += scoreThreshold(roe, [0, 0.05, 0.10, 0.15, 0.20]); n++; profitNotes.push(`ROE ${(roe*100).toFixed(1)}%`); }
    if (roa != null)       { p += scoreThreshold(roa, [0, 0.02, 0.05, 0.08, 0.12]); n++; profitNotes.push(`ROA ${(roa*100).toFixed(1)}%`); }
    if (opMargin != null)  { p += scoreThreshold(opMargin, [0, 0.05, 0.10, 0.18, 0.25]); n++; profitNotes.push(`Op Margin ${(opMargin*100).toFixed(1)}%`); }
    if (netMargin != null) { p += scoreThreshold(netMargin, [0, 0.03, 0.07, 0.12, 0.18]); n++; profitNotes.push(`Net Margin ${(netMargin*100).toFixed(1)}%`); }
    if (n > 0) profitScore = p / n;
  }
  if (profitScore != null) {
    scores.push({ category: 'Profitability', score: profitScore, weight: 25, note: profitNotes.join(' · ') });
  }

  // ── 2. GROWTH (Revenue YoY, EPS YoY, multi-year CAGR)
  let growthScore = null;
  let growthNotes = [];
  let revGrowth = null, epsGrowth = null, rev3yCAGR = null;
  if (inc?.revenue && incPrior?.revenue && incPrior.revenue > 0) {
    revGrowth = (inc.revenue / incPrior.revenue) - 1;
    growthNotes.push(`Rev YoY ${(revGrowth*100).toFixed(1)}%`);
  }
  if (inc?.epsdiluted && incPrior?.epsdiluted && incPrior.epsdiluted > 0) {
    epsGrowth = (inc.epsdiluted / incPrior.epsdiluted) - 1;
    growthNotes.push(`EPS YoY ${(epsGrowth*100).toFixed(1)}%`);
  }
  if (inc?.revenue && incOld?.revenue && incOld.revenue > 0) {
    rev3yCAGR = Math.pow(inc.revenue / incOld.revenue, 1/2) - 1;
    growthNotes.push(`3Y CAGR ${(rev3yCAGR*100).toFixed(1)}%`);
  }
  if (revGrowth != null || epsGrowth != null) {
    let p = 0, n = 0;
    if (revGrowth != null)  { p += scoreThreshold(revGrowth, [-0.05, 0, 0.05, 0.10, 0.20]); n++; }
    if (epsGrowth != null)  { p += scoreThreshold(epsGrowth, [-0.05, 0, 0.07, 0.15, 0.25]); n++; }
    if (rev3yCAGR != null)  { p += scoreThreshold(rev3yCAGR, [-0.05, 0, 0.04, 0.10, 0.18]); n++; }
    if (n > 0) growthScore = p / n;
  }
  if (growthScore != null) {
    scores.push({ category: 'Growth', score: growthScore, weight: 20, note: growthNotes.join(' · ') });
  }

  // ── 3. BALANCE SHEET STRENGTH (Debt/Equity, Current Ratio, Net Debt/EBITDA)
  let balanceScore = null;
  let balanceNotes = [];
  let dToE = null, currentRatio = null, netDebtEbitda = null;
  if (bal?.totalDebt != null && bal?.totalStockholdersEquity > 0) {
    dToE = bal.totalDebt / bal.totalStockholdersEquity;
    balanceNotes.push(`D/E ${dToE.toFixed(2)}`);
  }
  if (bal?.totalCurrentAssets && bal?.totalCurrentLiabilities > 0) {
    currentRatio = bal.totalCurrentAssets / bal.totalCurrentLiabilities;
    balanceNotes.push(`Current Ratio ${currentRatio.toFixed(2)}`);
  }
  if (bal?.netDebt != null && inc?.ebitda > 0) {
    netDebtEbitda = bal.netDebt / inc.ebitda;
    balanceNotes.push(`Net Debt/EBITDA ${netDebtEbitda.toFixed(2)}x`);
  }
  if (dToE != null || currentRatio != null) {
    let p = 0, n = 0;
    // Lower D/E is better (inverted threshold)
    if (dToE != null)         { p += scoreInverted(dToE, [0.3, 0.5, 1.0, 2.0, 3.0]); n++; }
    if (currentRatio != null) { p += scoreThreshold(currentRatio, [0.8, 1.0, 1.5, 2.0, 3.0]); n++; }
    if (netDebtEbitda != null) {
      // Net debt/EBITDA: <1=excellent, >4=bad. Negative (net cash) = excellent.
      if (netDebtEbitda < 0) p += 100;
      else p += scoreInverted(netDebtEbitda, [1, 2, 3, 4, 5]);
      n++;
    }
    if (n > 0) balanceScore = p / n;
  }
  if (balanceScore != null) {
    scores.push({ category: 'Balance Sheet', score: balanceScore, weight: 20, note: balanceNotes.join(' · ') });
  }

  // ── 4. CASH FLOW QUALITY (FCF, OCF/NetIncome, FCF margin)
  let cashScore = null;
  let cashNotes = [];
  const fcf = cf?.freeCashFlow ?? s?.freeCashFlow;
  const ocf = cf?.operatingCashFlow;
  const ni  = inc?.netIncome ?? s?.netIncome;
  const rev = inc?.revenue ?? s?.revenue;
  let fcfMargin = null, ocfToNI = null;
  if (fcf != null && rev > 0) { fcfMargin = fcf / rev; cashNotes.push(`FCF Margin ${(fcfMargin*100).toFixed(1)}%`); }
  if (ocf != null && ni > 0)  { ocfToNI = ocf / ni; cashNotes.push(`OCF/NI ${ocfToNI.toFixed(2)}`); }
  if (fcf != null) cashNotes.push(`FCF ${formatHumanNumber(fcf)}`);
  if (fcfMargin != null || ocfToNI != null || fcf != null) {
    let p = 0, n = 0;
    if (fcfMargin != null) { p += scoreThreshold(fcfMargin, [-0.05, 0, 0.05, 0.12, 0.20]); n++; }
    if (ocfToNI != null)   { p += scoreThreshold(ocfToNI, [0.5, 0.8, 1.0, 1.2, 1.5]); n++; }
    // FCF positive is binary +pass
    if (fcf != null) { p += fcf > 0 ? 80 : 30; n++; }
    if (n > 0) cashScore = p / n;
  }
  if (cashScore != null) {
    scores.push({ category: 'Cash Flow', score: cashScore, weight: 20, note: cashNotes.join(' · ') });
  }

  // ── 5. VALUATION (P/E, EV/EBITDA, FCF Yield, P/B)
  let valScore = null;
  let valNotes = [];
  const pe = s?.pe;
  const evEbitda = s?.evToEbitda;
  const fcfYield = (fcf && s?.marketCap) ? fcf / s.marketCap : null;
  const pb = s?.priceToBook;
  if (pe != null) valNotes.push(`P/E ${pe.toFixed(1)}`);
  if (evEbitda != null) valNotes.push(`EV/EBITDA ${evEbitda.toFixed(1)}x`);
  if (fcfYield != null) valNotes.push(`FCF Yield ${(fcfYield*100).toFixed(2)}%`);
  if (pb != null) valNotes.push(`P/B ${pb.toFixed(2)}`);
  if (pe != null || evEbitda != null || fcfYield != null) {
    let p = 0, n = 0;
    // Lower P/E is better
    if (pe != null && pe > 0) { p += scoreInverted(pe, [10, 15, 20, 30, 50]); n++; }
    if (evEbitda != null && evEbitda > 0) { p += scoreInverted(evEbitda, [6, 10, 14, 20, 30]); n++; }
    if (fcfYield != null) { p += scoreThreshold(fcfYield, [0, 0.02, 0.04, 0.07, 0.10]); n++; }
    if (pb != null && pb > 0) { p += scoreInverted(pb, [1, 2, 3, 5, 10]); n++; }
    if (n > 0) valScore = p / n;
  }
  if (valScore != null) {
    scores.push({ category: 'Valuation', score: valScore, weight: 15, note: valNotes.join(' · ') });
  }

  if (scores.length === 0) {
    return '';
  }

  // Compute weighted average → letter grade
  const totalWeight = scores.reduce((s, x) => s + x.weight, 0);
  const overall = scores.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight;
  const letter = overallToLetter(overall);
  const gradeColor = overall >= 85 ? '#5b8a72' : overall >= 70 ? '#7aa085' : overall >= 55 ? '#c4965a' : overall >= 40 ? '#b88578' : '#a5645a';

  return `
    <div class="fn-section">
      <h3>Financial Health Grade</h3>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:32px;align-items:start;background:var(--bg-card);border:1px solid var(--rule);padding:24px">
        <div style="text-align:center">
          <div style="font-family:var(--serif);font-size:96px;font-weight:700;font-style:italic;line-height:1;color:${gradeColor}">${letter}</div>
          <div style="font-family:var(--mono);font-size:14px;color:var(--ink);margin-top:6px;font-weight:700">${overall.toFixed(0)} / 100</div>
          <div style="font-family:var(--mono);font-size:9px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:0.18em;margin-top:4px">Overall</div>
        </div>
        <div>
          ${scores.map(s => {
            const c = s.score >= 85 ? '#5b8a72' : s.score >= 70 ? '#7aa085' : s.score >= 55 ? '#c4965a' : s.score >= 40 ? '#b88578' : '#a5645a';
            const barW = Math.max(2, Math.min(100, s.score));
            return `
              <div style="margin-bottom:14px">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
                  <div style="font-family:var(--mono);font-size:11px;color:var(--ink);text-transform:uppercase;letter-spacing:0.15em">${s.category}</div>
                  <div style="font-family:var(--mono);font-size:13px;color:${c};font-weight:700">${s.score.toFixed(0)} <span style="color:var(--ink-faint);font-size:10px;font-weight:400">/ ${overallToLetter(s.score)}</span> <span style="color:var(--ink-faint);font-size:9px;font-weight:400;margin-left:6px">w=${s.weight}%</span></div>
                </div>
                <div style="height:6px;background:var(--bg);border:1px solid var(--rule)">
                  <div style="width:${barW}%;height:100%;background:${c};opacity:0.85"></div>
                </div>
                <div style="font-family:var(--mono);font-size:10px;color:var(--ink-dim);margin-top:4px">${s.note}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      <p style="font-family:var(--mono);font-size:10px;color:var(--ink-faint);margin-top:10px;line-height:1.6">
        Grading methodology: weighted blend of profitability (25%), growth (20%), balance sheet (20%), cash flow (20%), valuation (15%).
        A+ ≥ 90 · A ≥ 85 · A− ≥ 80 · B+ ≥ 75 · B ≥ 70 · B− ≥ 65 · C+ ≥ 60 · C ≥ 55 · C− ≥ 50 · D ≥ 40 · F &lt; 40
      </p>
    </div>
  `;
}

// Score 0-100 based on which threshold the value crosses (ascending = better)
function scoreThreshold(value, thresholds) {
  // thresholds = [worst, poor, ok, good, excellent]
  if (value < thresholds[0]) return 10;
  if (value < thresholds[1]) return 30;
  if (value < thresholds[2]) return 55;
  if (value < thresholds[3]) return 75;
  if (value < thresholds[4]) return 88;
  return 95;
}
// Inverted score (ascending = worse, e.g. P/E)
function scoreInverted(value, thresholds) {
  if (value < thresholds[0]) return 95;
  if (value < thresholds[1]) return 80;
  if (value < thresholds[2]) return 65;
  if (value < thresholds[3]) return 45;
  if (value < thresholds[4]) return 25;
  return 10;
}
function overallToLetter(score) {
  if (score >= 90) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 80) return 'A−';
  if (score >= 75) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 65) return 'B−';
  if (score >= 60) return 'C+';
  if (score >= 55) return 'C';
  if (score >= 50) return 'C−';
  if (score >= 40) return 'D';
  return 'F';
}

// --- EE: Earnings Estimates (placeholder — needs paid data) ---
function fnEE(ticker) {
  openFnOverlay('EE', ticker);
  setFnOverlayBody(`
    <div class="fn-section">
      <h3>Earnings Estimates — ${ticker}</h3>
      <p style="color:var(--ink-dim);line-height:1.6">
        Consensus analyst estimates require a paid data feed (Refinitiv, FactSet, or Finnhub Premium).
        The free Finnhub tier exposes <strong>limited</strong> earnings data via <code>/stock/earnings</code> —
        last 4 quarters of actual vs. estimate.
      </p>
      <div id="ee-content" style="margin-top:16px;font-family:var(--mono);color:var(--ink-dim);font-size:12px">
        ${getFinnhubKey() ? 'Loading…' : 'Add a Finnhub key in Data Sources to populate this view.'}
      </div>
    </div>
  `);
  if (getFinnhubKey()) {
    fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${ticker}&token=${getFinnhubKey()}`)
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data) || data.length === 0) {
          document.getElementById('ee-content').textContent = 'No earnings data available for this ticker.';
          return;
        }
        const sorted = data.slice().sort((a, b) => b.period.localeCompare(a.period));
        document.getElementById('ee-content').innerHTML = `
          <table class="fn-table">
            <thead><tr><th>Period</th><th>Estimate</th><th>Actual</th><th>Surprise</th><th>Surprise %</th></tr></thead>
            <tbody>
              ${sorted.map(e => {
                const surprise = e.actual != null && e.estimate != null ? e.actual - e.estimate : null;
                const surprisePct = surprise != null && e.estimate ? (surprise / Math.abs(e.estimate)) * 100 : null;
                const cls = surprise == null ? '' : (surprise > 0 ? 'pos' : 'neg');
                return `
                  <tr>
                    <td>${e.period}</td>
                    <td>${e.estimate != null ? '$' + e.estimate.toFixed(2) : '—'}</td>
                    <td>${e.actual != null ? '$' + e.actual.toFixed(2) : '—'}</td>
                    <td class="${cls}">${surprise != null ? (surprise >= 0 ? '+' : '') + '$' + surprise.toFixed(2) : '—'}</td>
                    <td class="${cls}">${surprisePct != null ? (surprisePct >= 0 ? '+' : '') + surprisePct.toFixed(1) + '%' : '—'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `;
      })
      .catch(e => {
        document.getElementById('ee-content').textContent = 'Error: ' + e.message;
      });
  }
}

// --- ANR: Analyst Recommendations ---
function fnANR(ticker) {
  openFnOverlay('ANR', ticker);
  setFnOverlayBody(`
    <div class="fn-section">
      <h3>Analyst Recommendations — ${ticker}</h3>
      <div id="anr-content" style="font-family:var(--mono);color:var(--ink-dim);font-size:12px">
        ${getFinnhubKey() ? 'Loading from Finnhub…' : 'Add a Finnhub key in Data Sources to populate this view.'}
      </div>
    </div>
  `);
  if (!getFinnhubKey()) return;

  fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${getFinnhubKey()}`)
    .then(r => r.json())
    .then(data => {
      if (!Array.isArray(data) || data.length === 0) {
        document.getElementById('anr-content').textContent = 'No recommendation data available.';
        return;
      }
      const latest = data[0];
      const total = (latest.strongBuy || 0) + (latest.buy || 0) + (latest.hold || 0) + (latest.sell || 0) + (latest.strongSell || 0);
      const score = total > 0 ? (
        ((latest.strongBuy || 0) * 5 +
         (latest.buy || 0) * 4 +
         (latest.hold || 0) * 3 +
         (latest.sell || 0) * 2 +
         (latest.strongSell || 0) * 1) / total
      ) : null;
      const verdict = score == null ? 'N/A' :
        score >= 4.5 ? 'STRONG BUY' :
        score >= 3.5 ? 'BUY' :
        score >= 2.5 ? 'HOLD' :
        score >= 1.5 ? 'SELL' : 'STRONG SELL';

      document.getElementById('anr-content').innerHTML = `
        <div class="fn-kv-grid" style="margin-bottom:20px">
          <div><div class="l">Consensus Score</div><div class="v" style="color:var(--amber);font-size:20px">${score != null ? score.toFixed(2) + ' / 5' : '—'}</div></div>
          <div><div class="l">Verdict</div><div class="v" style="color:var(--amber)">${verdict}</div></div>
          <div><div class="l">Total Analysts</div><div class="v">${total}</div></div>
          <div><div class="l">As Of</div><div class="v">${latest.period || '—'}</div></div>
        </div>
        <table class="fn-table">
          <thead><tr><th>Period</th><th>Strong Buy</th><th>Buy</th><th>Hold</th><th>Sell</th><th>Strong Sell</th></tr></thead>
          <tbody>
            ${data.slice(0, 6).map(r => `
              <tr>
                <td>${r.period}</td>
                <td class="pos">${r.strongBuy || 0}</td>
                <td class="pos">${r.buy || 0}</td>
                <td>${r.hold || 0}</td>
                <td class="neg">${r.sell || 0}</td>
                <td class="neg">${r.strongSell || 0}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    })
    .catch(e => {
      document.getElementById('anr-content').textContent = 'Error: ' + e.message;
    });
}

// --- SPLC: Supply Chain (placeholder — needs paid data normally) ---
async function fnSPLC(ticker) {
  openFnOverlay('SPLC', ticker);
  // We can show peers from the stockbook as a proxy for "related companies"
  const subjectRow = state.stockbook.rows.find(r => r.ticker === ticker);
  const sector = subjectRow?.sector;
  const peers = sector ? state.stockbook.rows.filter(r =>
    r.ticker !== ticker && r.sector === sector
  ).slice(0, 8) : [];
  setFnOverlayBody(`
    <div class="fn-section">
      <h3>Supply Chain & Peers — ${ticker}</h3>
      <p style="color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.6;margin-bottom:14px">
        Bloomberg's full supplier/customer relationship data is a paid feature with 500K+ relationships.
        This view shows <strong>same-sector peers</strong> from your Stock Book as a free approximation.
        Click any to value it.
      </p>
      ${peers.length > 0 ? `
        <table class="fn-table">
          <thead><tr><th>Ticker</th><th>Name</th><th>Sector</th><th>Mkt Cap</th><th></th></tr></thead>
          <tbody>
            ${peers.map(p => `
              <tr style="cursor:pointer" onclick="executeCommand('${p.ticker}')">
                <td>${p.ticker}</td>
                <td style="text-align:left">${p.name || '—'}</td>
                <td style="text-align:left">${p.sector || '—'}</td>
                <td>${p.marketCap != null ? formatHumanNumber(p.marketCap) : '—'}</td>
                <td><button class="sb-icon-btn" onclick="event.stopPropagation();executeCommand('${p.ticker} DES')">DES</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<p style="color:var(--ink-dim)">No peers found. Run Enrich All in Stock Book to populate sectors.</p>'}
    </div>
  `);
}

// --- CRPR: Synthetic credit profile (interest coverage → rating) ---
async function fnCRPR(ticker) {
  openFnOverlay('CRPR', ticker);
  if (!state.stock || state.stock.ticker !== ticker) {
    document.getElementById('ticker').value = ticker;
    try { await loadValuation(); } catch {}
  }
  const s = state.stock;
  if (!s) { setFnOverlayBody('<div class="fn-section"><h3>Could not load</h3></div>'); return; }

  // Damodaran's synthetic rating: based on interest coverage ratio
  // Approximate interest expense as: totalDebt * pre-tax cost of debt
  const cod = (state.inputs?.preTaxCostOfDebt || 6) / 100;
  const intExpense = (s.totalDebt || 0) * cod;
  const intCoverage = (s.operatingIncome && intExpense > 0) ? s.operatingIncome / intExpense : null;

  // Damodaran's mapping (large company)
  const ratingTable = [
    { min: 8.5,  rating: 'AAA', spread: 0.0050 },
    { min: 6.5,  rating: 'AA',  spread: 0.0070 },
    { min: 5.5,  rating: 'A+',  spread: 0.0090 },
    { min: 4.25, rating: 'A',   spread: 0.0108 },
    { min: 3.0,  rating: 'A-',  spread: 0.0122 },
    { min: 2.5,  rating: 'BBB', spread: 0.0156 },
    { min: 2.25, rating: 'BB+', spread: 0.0240 },
    { min: 2.0,  rating: 'BB',  spread: 0.0293 },
    { min: 1.75, rating: 'B+',  spread: 0.0376 },
    { min: 1.5,  rating: 'B',   spread: 0.0451 },
    { min: 1.25, rating: 'B-',  spread: 0.0524 },
    { min: 0.8,  rating: 'CCC', spread: 0.0850 },
    { min: 0.65, rating: 'CC',  spread: 0.1043 },
    { min: 0.2,  rating: 'C',   spread: 0.1234 },
    { min: -100, rating: 'D',   spread: 0.1551 },
  ];
  const match = intCoverage != null ? ratingTable.find(r => intCoverage >= r.min) : null;

  setFnOverlayBody(`
    <div class="fn-section">
      <h3>Synthetic Credit Rating — ${ticker}</h3>
      <p style="color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.6;margin-bottom:14px">
        Damodaran-style synthetic rating from interest coverage ratio (EBIT / interest expense).
        Not an actual S&P/Moody's rating — but useful for cost-of-debt estimation.
      </p>
      <div class="fn-kv-grid">
        <div><div class="l">EBIT (Operating Income)</div><div class="v">${formatHumanNumber(s.operatingIncome)}</div></div>
        <div><div class="l">Estimated Interest Expense</div><div class="v">${formatHumanNumber(intExpense)}</div></div>
        <div><div class="l">Interest Coverage Ratio</div><div class="v">${intCoverage != null ? intCoverage.toFixed(2) : '—'}</div></div>
        <div><div class="l">Synthetic Rating</div><div class="v" style="color:var(--amber);font-size:20px">${match ? match.rating : '—'}</div></div>
        <div><div class="l">Implied Default Spread</div><div class="v">${match ? (match.spread * 100).toFixed(2) + '%' : '—'}</div></div>
        <div><div class="l">Implied Cost of Debt</div><div class="v">${match ? ((state.inputs?.riskFreeRate / 100 || 0.045) + match.spread).toFixed(4) * 100 + '%' : '—'}</div></div>
      </div>
    </div>
  `);
}

// --- GMM: Global Market Monitor (sector ETFs + macro snapshot) ---
async function fnGMM() {
  openFnOverlay('GMM', '');

  let sheetHistory = null;
  try {
    const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
    if (cached?.data?.priceHistory) sheetHistory = cached.data.priceHistory;
  } catch {}

  if (!state.macro) {
    const cached = loadMacroCache();
    if (cached) await loadMacroTab(false);
  }
  if ((state.stockbook?.rows?.length ?? 0) === 0) {
    try { await loadStockBook(false); } catch {}
  }

  // Trigger Stooq fetch for sector ETFs in background if macro hasn't supplied them
  if (!state.macro?.sectors) {
    try {
      const sectorPerf = await fetchSectorPerf();
      if (state.macro) state.macro.sectors = sectorPerf;
    } catch {}
  }

  // Helper: parse %-style sheet cell (e.g. "1.21" → 0.0121)
  function parsePct(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.toUpperCase().startsWith('#')) return null;
    const isNeg = /^\(/.test(s) || /^-/.test(s);
    const cleaned = s.replace(/[%$,\s()+]/g, '').replace(/^-/, '');
    const num = parseFloat(cleaned);
    if (!isFinite(num)) return null;
    return (isNeg ? -num : num) / 100;
  }

  // Build full per-ETF row pulling from EVERY available source
  const sectorRows = SECTOR_ETFS.map(etf => {
    const sbRow = state.stockbook?.rows?.find(r => r.ticker === etf.ticker);
    const sheetSeries = sheetHistory?.[etf.ticker];
    const stooqSeries = state.macro?.sectors?.[etf.ticker];

    let last = null, r1d = null, r1m = null, r3m = null, r1y = null, r5y = null;

    // 1. Last price priority: stockbook → sheet history → stooq
    if (sbRow?.price != null) last = sbRow.price;
    else if (sheetSeries?.length) last = sheetSeries[sheetSeries.length - 1].price;
    else if (stooqSeries?.length) last = stooqSeries[stooqSeries.length - 1].close;

    // 2. 1D: sheet's changepct → date-aware lookup → stooq fallback
    if (sbRow?.rawRow) {
      r1d = parsePct(sbRow.rawRow['changepct']) ?? parsePct(sbRow.rawRow['return day']);
    }
    if (r1d == null && sheetSeries?.length >= 2) r1d = priceChangeOverDays(sheetSeries, 1);
    if (r1d == null && stooqSeries?.length >= 2) {
      r1d = (stooqSeries[stooqSeries.length - 1].close / stooqSeries[stooqSeries.length - 2].close) - 1;
    }

    // 3. Multi-period: USE ACTUAL DATES (calendar days) not trading-day indices
    // GoogleFinance return* columns are unreliable, so we always parse history directly.
    // Calendar windows: 1M=30d, 3M=91d, 1Y=365d, 5Y=1825d
    if (sheetSeries?.length >= 2) {
      r1m = priceChangeOverDays(sheetSeries, 30);
      r3m = priceChangeOverDays(sheetSeries, 91);
      r1y = priceChangeOverDays(sheetSeries, 365);
      r5y = priceChangeOverDays(sheetSeries, 1825);
    }
    // Stooq fallback for any periods sheet couldn't cover
    if (stooqSeries?.length >= 2) {
      const stooqAsHist = stooqSeries.map(s => ({ date: s.date, price: s.close }));
      if (r1m == null) r1m = priceChangeOverDays(stooqAsHist, 30);
      if (r3m == null) r3m = priceChangeOverDays(stooqAsHist, 91);
      if (r1y == null) r1y = priceChangeOverDays(stooqAsHist, 365);
      if (r5y == null) r5y = priceChangeOverDays(stooqAsHist, 1825);
    }

    return { ...etf, last, r1d, r1m, r3m, r1y, r5y };
  });

  const m = state.macro;
  const macroBlock = m ? `
    <div class="fn-section">
      <h3>Macro Snapshot</h3>
      <div class="fn-kv-grid">
        <div><div class="l">Current Quad</div><div class="v" style="color:var(--amber)">Q${m.current.quad} · ${QUADS[m.current.quad].name}</div></div>
        <div><div class="l">GDP YoY</div><div class="v">${(m.current.growthYoY * 100).toFixed(2)}%</div></div>
        <div><div class="l">CPI YoY</div><div class="v">${(m.current.inflationYoY * 100).toFixed(2)}%</div></div>
        <div><div class="l">10Y Treasury</div><div class="v">${isFinite(m.latest10y) ? m.latest10y.toFixed(2) + '%' : '—'}</div></div>
        <div><div class="l">Fed Funds</div><div class="v">${isFinite(m.latestFed) ? m.latestFed.toFixed(2) + '%' : '—'}</div></div>
      </div>
    </div>
  ` : '';

  const fmtPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const cls = v => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';

  // Count how many ETFs have data — if zero, show diagnostic
  const withData = sectorRows.filter(r => r.last != null).length;
  const dataNote = withData < 5 ? `
    <p style="color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.6;margin-bottom:14px;padding:10px;border-left:2px solid var(--amber);background:rgba(212,162,76,0.05)">
      <strong style="color:var(--amber)">Only ${withData} of ${sectorRows.length} ETFs found.</strong>
      Add the missing sector ETFs (XLK, XLY, XLF, XLV, XLI, XLE, XLP, XLU, XLRE, TLT, GLD) to your sheet for full coverage.
      The sheet's <code>return4</code>, <code>return13</code>, <code>return52</code>, <code>return260</code> columns provide 1M/3M/1Y/5Y.
    </p>
  ` : '';

  setFnOverlayBody(`
    ${macroBlock}
    <div class="fn-section">
      <h3>Sector ETFs · Multi-Timeframe Performance</h3>
      ${dataNote}
      <table class="fn-table">
        <thead>
          <tr>
            <th>Ticker</th><th>Name</th><th>Last</th>
            <th>1D</th><th>1M</th><th>3M</th><th>1Y</th><th>5Y</th>
          </tr>
        </thead>
        <tbody>
          ${sectorRows.map(r => `
            <tr style="cursor:pointer" onclick="executeCommand('${r.ticker}')">
              <td>${r.ticker}</td>
              <td style="text-align:left">${r.name}</td>
              <td>${r.last != null ? '$' + r.last.toFixed(2) : '—'}</td>
              <td class="${cls(r.r1d)}">${fmtPct(r.r1d)}</td>
              <td class="${cls(r.r1m)}">${fmtPct(r.r1m)}</td>
              <td class="${cls(r.r3m)}">${fmtPct(r.r3m)}</td>
              <td class="${cls(r.r1y)}">${fmtPct(r.r1y)}</td>
              <td class="${cls(r.r5y)}">${fmtPct(r.r5y)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `);
}

// --- IMAP: Sector heat map (Bloomberg-style treemap-ish view) ---
async function fnIMAP() {
  openFnOverlay('IMAP', '');
  if (!state.macro) {
    const cached = loadMacroCache();
    if (cached) await loadMacroTab(false);
  }
  // Make sure stockbook is loaded
  if ((state.stockbook?.rows?.length ?? 0) === 0) {
    try { await loadStockBook(false); } catch {}
  }

  // If no sector data yet, try to fetch from Stooq directly so we get prices for ETFs
  if (!state.macro?.sectors || Object.keys(state.macro.sectors).length === 0) {
    try {
      const sectors = await fetchSectorPerf();
      if (state.macro) state.macro.sectors = sectors;
      else state.macro = { sectors };
    } catch {}
  }

  // Pull sheet history first
  let sheetHistory = null;
  try {
    const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
    if (cached?.data?.priceHistory) sheetHistory = cached.data.priceHistory;
  } catch {}

  // Parse sheet's changepct cell directly (GoogleFinance stores e.g. "1.21" meaning 1.21%)
  function parsePctSheet(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === '—' || s === '-' || s.toUpperCase().startsWith('#')) return null;
    const isNeg = /^\(/.test(s) || /^-/.test(s);
    const cleaned = s.replace(/[%$,\s()+]/g, '').replace(/^-/, '');
    const num = parseFloat(cleaned);
    if (!isFinite(num)) return null;
    return (isNeg ? -num : num) / 100;
  }

  // Get pct change for any ticker — sheet's changepct → return day → price history → stooq
  function pctFor(ticker, fallbackHistory) {
    const sbRow = state.stockbook?.rows?.find(r => r.ticker === ticker);
    if (sbRow?.rawRow) {
      const fromCp = parsePctSheet(sbRow.rawRow['changepct']);
      if (fromCp != null) return fromCp;
      const fromRet = parsePctSheet(sbRow.rawRow['return day']);
      if (fromRet != null) return fromRet;
    }
    if (sheetHistory?.[ticker]?.length >= 2) {
      return priceChangeFromHistory(sheetHistory[ticker], 1);
    }
    if (fallbackHistory && fallbackHistory.length >= 2) {
      return (fallbackHistory[fallbackHistory.length - 1].close /
              fallbackHistory[fallbackHistory.length - 2].close) - 1;
    }
    return null;
  }

  function priceFor(ticker, fallbackHistory) {
    const sbRow = state.stockbook?.rows?.find(r => r.ticker === ticker);
    if (sbRow?.price != null) return sbRow.price;
    if (sheetHistory?.[ticker]?.length) return sheetHistory[ticker][sheetHistory[ticker].length - 1].price;
    if (fallbackHistory?.length) return fallbackHistory[fallbackHistory.length - 1].close;
    return null;
  }

  // Build sector tiles with returns + prices
  const sectorTiles = SECTOR_ETFS.map(etf => {
    const stooqSeries = state.macro?.sectors?.[etf.ticker];
    return {
      ...etf,
      r1d: pctFor(etf.ticker, stooqSeries),
      price: priceFor(etf.ticker, stooqSeries),
    };
  });

  // Build stock tiles, filter out junk + derivatives
  const stockBookRows = (state.stockbook?.rows || [])
    .filter(r => !r.isDerivative && r.marketCap && r.marketCap >= 5e9)
    .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
    .slice(0, 60);

  function tileColor(pct) {
    if (pct == null) return '#1c1a17';
    const clamped = Math.max(-0.05, Math.min(0.05, pct));
    if (clamped > 0) {
      const intensity = Math.min(1, clamped / 0.03);
      const g = Math.floor(60 + intensity * 110);
      return `rgb(20, ${g}, 40)`;
    } else {
      const intensity = Math.min(1, Math.abs(clamped) / 0.03);
      const r = Math.floor(60 + intensity * 110);
      return `rgb(${r}, 20, 30)`;
    }
  }
  function fmtPrice(p) { return p != null ? '$' + p.toFixed(2) : '—'; }
  function fmtPct(p)   { return p != null ? (p >= 0 ? '+' : '') + (p * 100).toFixed(2) + '%' : '—'; }
  function fmtMcap(v) {
    if (!v) return '';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return (v / 1e9).toFixed(0) + 'B';
    return (v / 1e6).toFixed(0) + 'M';
  }

  setFnOverlayBody(`
    <div class="fn-section">
      <h3>Sector ETFs · 1-Day Performance</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:4px">
        ${sectorTiles.map(t => `
          <div style="background:${tileColor(t.r1d)};padding:14px;cursor:pointer;border:1px solid #1a1815"
               onclick="executeCommand('${t.ticker}')">
            <div style="font-family:var(--mono);font-weight:800;font-size:14px;color:#fff;letter-spacing:0.1em">${t.ticker}</div>
            <div style="font-family:var(--mono);font-size:10px;color:rgba(255,255,255,0.7);margin-top:2px">${t.name}</div>
            <div style="font-family:var(--mono);font-size:13px;color:rgba(255,255,255,0.92);margin-top:6px">
              ${fmtPrice(t.price)}
            </div>
            <div style="font-family:var(--mono);font-size:16px;color:${t.r1d > 0 ? '#7fff7f' : t.r1d < 0 ? '#ff7f7f' : '#999'};margin-top:3px;font-weight:700">
              ${fmtPct(t.r1d)}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="fn-section">
      <h3>Your Stock Book · Top ${stockBookRows.length} by Market Cap</h3>
      <p style="color:var(--ink-faint);font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:10px">
        Tile color = today's % move · price + change shown
      </p>
      ${stockBookRows.length === 0
        ? '<p style="color:var(--ink-dim);text-align:center;padding:20px;font-family:var(--mono);font-size:12px">No equities found · check Stock Book is loaded</p>'
        : `<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(120px, 1fr));gap:2px">
            ${stockBookRows.map(r => {
              const pct = pctFor(r.ticker);
              return `
                <div style="background:${tileColor(pct)};padding:10px 8px;cursor:pointer;border:1px solid #1a1815;text-align:center"
                     onclick="executeCommand('${r.ticker}')"
                     title="${escapeHtml(r.name || '')} · ${fmtMcap(r.marketCap)}">
                  <div style="font-family:var(--mono);font-weight:800;font-size:12px;color:#fff;letter-spacing:0.05em">${r.ticker}</div>
                  <div style="font-family:var(--mono);font-size:11px;color:rgba(255,255,255,0.85);margin-top:3px">
                    ${fmtPrice(r.price)}
                  </div>
                  <div style="font-family:var(--mono);font-size:12px;color:${pct > 0 ? '#7fff7f' : pct < 0 ? '#ff7f7f' : '#999'};margin-top:2px;font-weight:700">
                    ${fmtPct(pct)}
                  </div>
                </div>
              `;
            }).join('')}
          </div>`}
    </div>
  `);
}

// --- SOVM: Sovereign Debt Monitor (yields, spreads, history) ---
async function fnSOVM() {
  openFnOverlay('SOVM', '');
  if (!state.macro) {
    const cached = loadMacroCache();
    if (cached) await loadMacroTab(false);
  }
  const m = state.macro;
  if (!m) {
    setFnOverlayBody('<div class="fn-section"><h3>Load Macro tab first</h3><p style="color:var(--ink-dim)">Click the Macro Quad tab and Refresh Macro Data, then come back here.</p></div>');
    return;
  }

  // Build a yields-vs-Fed-Funds spread visualization
  const tsy = m.latest10y;
  const fed = m.latestFed;
  const spread = (isFinite(tsy) && isFinite(fed)) ? tsy - fed : null;

  // Pull yield history if available
  const tsyHistory = m.raw?.tsyRaw || [];
  const fedHistory = m.raw?.fedRaw || [];

  // Compute a few historical reference points
  const tsy30d = tsyHistory[tsyHistory.length - 22]?.value;
  const tsy90d = tsyHistory[tsyHistory.length - 65]?.value;
  const tsy1y = tsyHistory[tsyHistory.length - 252]?.value;

  setFnOverlayBody(`
    <div class="fn-section">
      <h3>U.S. Sovereign Indicators · Live from FRED</h3>
      <table class="fn-table">
        <thead>
          <tr><th>Security</th><th>Yield</th><th>30d Δ</th><th>90d Δ</th><th>1y Δ</th><th>vs Fed Funds</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>10-Year Treasury (DGS10)</td>
            <td style="color:var(--amber);font-weight:700">${isFinite(tsy) ? tsy.toFixed(2) + '%' : '—'}</td>
            <td class="${tsy30d != null && tsy > tsy30d ? 'pos' : 'neg'}">${tsy30d != null ? ((tsy - tsy30d) * 100).toFixed(0) + 'bp' : '—'}</td>
            <td class="${tsy90d != null && tsy > tsy90d ? 'pos' : 'neg'}">${tsy90d != null ? ((tsy - tsy90d) * 100).toFixed(0) + 'bp' : '—'}</td>
            <td class="${tsy1y != null && tsy > tsy1y ? 'pos' : 'neg'}">${tsy1y != null ? ((tsy - tsy1y) * 100).toFixed(0) + 'bp' : '—'}</td>
            <td>${spread != null ? (spread >= 0 ? '+' : '') + spread.toFixed(2) + 'pp' : '—'}</td>
          </tr>
          <tr>
            <td>Effective Fed Funds (DFF)</td>
            <td>${isFinite(fed) ? fed.toFixed(2) + '%' : '—'}</td>
            <td>—</td><td>—</td><td>—</td><td>—</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="fn-section">
      <h3>Curve Status</h3>
      <div class="fn-kv-grid">
        <div><div class="l">Yield Curve (10Y - FF)</div><div class="v" style="color:${spread > 0 ? '#5b8a72' : '#a5645a'}">${spread != null ? (spread >= 0 ? '+' : '') + spread.toFixed(2) + 'pp' : '—'}</div></div>
        <div><div class="l">Curve State</div><div class="v">${spread > 1 ? 'Steep' : spread > 0 ? 'Normal' : spread > -0.5 ? 'Flat' : 'Inverted'}</div></div>
        <div><div class="l">10Y · 1Y Range</div><div class="v">${tsy1y != null ? Math.min(tsy, tsy1y).toFixed(2) + '–' + Math.max(tsy, tsy1y).toFixed(2) + '%' : '—'}</div></div>
        <div><div class="l">Data Source</div><div class="v">FRED</div></div>
      </div>
      <p style="color:var(--ink-faint);font-family:var(--mono);font-size:10px;line-height:1.6;margin-top:14px">
        Inverted curves (10Y &lt; FF) historically precede recessions. Steep curves (&gt;2pp) suggest the bond market expects strong nominal growth. The Fed targets the lower bound of the federal funds target range.
      </p>
    </div>
  `);
}

// --- HELP: List all functions ---
function fnHELP() {
  openFnOverlay('HELP', '');
  setFnOverlayBody(`
    ${TERMINAL_GROUPS.map(g => `
      <div class="fn-section">
        <h3>${g.label}</h3>
        <table class="fn-table">
          <thead><tr><th>Mnemonic</th><th>Function</th><th>Description</th><th></th></tr></thead>
          <tbody>
            ${g.mnemonics.map(m => {
              const fn = TERMINAL_FUNCTIONS[m];
              return `
                <tr style="cursor:pointer" onclick="executeCommand('${m}'); closeFnOverlay()">
                  <td>${m}</td>
                  <td style="text-align:left">${fn.name}</td>
                  <td style="text-align:left;color:var(--ink-dim)">${fn.desc}</td>
                  <td><span style="font-size:9px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:0.1em">${fn.scope === 'ticker' ? 'needs ticker' : 'global'}</span></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `).join('')}
    <div class="fn-section">
      <h3>Syntax</h3>
      <ul style="color:var(--ink-dim);font-family:var(--mono);font-size:12px;line-height:2">
        <li><strong style="color:var(--amber)">AAPL</strong> — load valuation for ticker</li>
        <li><strong style="color:var(--amber)">AAPL DES</strong> — show description for AAPL</li>
        <li><strong style="color:var(--amber)">DES</strong> — show description for currently loaded ticker</li>
        <li><strong style="color:var(--amber)">HELP</strong> — this menu</li>
        <li>Press <strong style="color:var(--amber)">/</strong> to focus the command bar from anywhere</li>
        <li>Press <strong style="color:var(--amber)">ESC</strong> to clear input or close overlay</li>
        <li><strong style="color:var(--amber)">Ctrl+1/2/3</strong> jumps between Valuation / Macro / Stock Book</li>
      </ul>
    </div>
  `);
}

// --- EQS: Equity Screen (filter stockbook) ---
function fnEQS() {
  switchTab('stockbook');
  document.getElementById('stockbook-search')?.focus();
}

// --- PORT: Portfolio summary of saved valuations ---
function fnPORT() {
  openFnOverlay('PORT', '');
  const saved = loadSaved();
  if (saved.length === 0) {
    setFnOverlayBody('<div class="fn-section"><h3>No saved valuations</h3><p>Run a valuation and click Save Valuation.</p></div>');
    return;
  }
  const totalUpside = saved.reduce((sum, v) => {
    if (v.fairValue && v.price) return sum + (v.fairValue - v.price) / v.price;
    return sum;
  }, 0) / saved.length;
  setFnOverlayBody(`
    <div class="fn-section">
      <h3>Portfolio Summary · ${saved.length} saved valuations</h3>
      <div class="fn-kv-grid">
        <div><div class="l">Avg Margin of Safety</div><div class="v" style="color:${totalUpside > 0 ? '#5b8a72' : '#a5645a'}">${(totalUpside * 100).toFixed(1)}%</div></div>
        <div><div class="l">Undervalued</div><div class="v up">${saved.filter(v => v.fairValue > v.price * 1.1).length}</div></div>
        <div><div class="l">Fair</div><div class="v">${saved.filter(v => v.fairValue && Math.abs(v.fairValue - v.price) <= v.price * 0.1).length}</div></div>
        <div><div class="l">Overvalued</div><div class="v down">${saved.filter(v => v.fairValue < v.price * 0.9).length}</div></div>
      </div>
    </div>
    <div class="fn-section">
      <h3>Holdings</h3>
      <table class="fn-table">
        <thead><tr><th>Ticker</th><th>Name</th><th>Sector</th><th>Price</th><th>Fair Value</th><th>MoS</th><th>Saved</th></tr></thead>
        <tbody>
          ${saved.map(v => {
            const mos = v.fairValue && v.price ? ((v.fairValue - v.price) / v.price) * 100 : null;
            return `
              <tr style="cursor:pointer" onclick="executeCommand('${v.ticker}'); closeFnOverlay()">
                <td>${v.ticker}</td>
                <td style="text-align:left">${v.name || '—'}</td>
                <td style="text-align:left;color:var(--ink-dim)">${v.sector || '—'}</td>
                <td>${v.price != null ? '$' + v.price.toFixed(2) : '—'}</td>
                <td>${v.fairValue != null ? '$' + v.fairValue.toFixed(2) : '—'}</td>
                <td class="${mos > 0 ? 'pos' : mos < 0 ? 'neg' : ''}">${mos != null ? (mos >= 0 ? '+' : '') + mos.toFixed(1) + '%' : '—'}</td>
                <td style="color:var(--ink-dim);font-size:10px">${new Date(v.savedAt).toLocaleDateString()}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `);
}

// ============================================================
//   COMMAND BAR UI WIRING
// ============================================================
const cmdInput = document.getElementById('cmd-input');
const cmdSuggest = document.getElementById('cmd-suggest');
const cmdGo = document.getElementById('cmd-go');
const cmdAsset = document.getElementById('cmd-asset');
const cmdCheat = document.getElementById('cmd-cheat');
const cmdCheatGrid = document.getElementById('cmd-cheat-grid');
const cmdCheatToggle = document.getElementById('cmd-cheat-toggle');

// Build cheatsheet grid
function renderCheatsheet() {
  cmdCheatGrid.innerHTML = TERMINAL_GROUPS.map(g => `
    <div class="cmd-cheat-section-head">${g.label}</div>
    ${g.mnemonics.map(m => {
      const fn = TERMINAL_FUNCTIONS[m];
      return `
        <div class="cmd-cheat-cell" data-mnem="${m}">
          <div class="cmd-cheat-mnem">${m}</div>
          <div class="cmd-cheat-name">${fn.name}</div>
          <div class="cmd-cheat-desc">${fn.desc}</div>
        </div>
      `;
    }).join('')}
  `).join('');
  cmdCheatGrid.querySelectorAll('.cmd-cheat-cell').forEach(el => {
    el.addEventListener('click', () => {
      const m = el.dataset.mnem;
      cmdInput.value = m;
      cmdInput.focus();
      cmdCheat.style.display = 'none';
    });
  });
}
renderCheatsheet();

cmdCheatToggle.addEventListener('click', () => {
  cmdCheat.style.display = cmdCheat.style.display === 'none' ? 'block' : 'none';
});

// Asset class picker
cmdAsset.addEventListener('click', () => {
  // Toggle a small dropdown
  const existing = document.getElementById('cmd-asset-menu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div');
  menu.id = 'cmd-asset-menu';
  menu.className = 'cmd-asset-menu';
  const classes = [
    { key: 'EQUITY', desc: 'Stocks' },
    { key: 'INDEX',  desc: 'Indices' },
    { key: 'CMDTY',  desc: 'Commodities' },
    { key: 'CURNCY', desc: 'FX' },
    { key: 'GOVT',   desc: 'Treasuries' },
  ];
  menu.innerHTML = classes.map(c => `
    <div class="cmd-asset-item" data-class="${c.key}">${c.key}<div class="desc">${c.desc}</div></div>
  `).join('');
  cmdAsset.parentElement.appendChild(menu);
  menu.addEventListener('click', e => {
    const item = e.target.closest('.cmd-asset-item');
    if (item) {
      state.terminal.assetClass = item.dataset.class;
      cmdAsset.textContent = item.dataset.class;
      menu.remove();
      cmdInput.focus();
    }
  });
});

// Autocomplete suggestions
function updateSuggestions(q) {
  q = q.trim().toUpperCase();
  if (!q) { cmdSuggest.style.display = 'none'; return; }
  // Match against mnemonics + tickers from stockbook
  const tokens = q.split(/\s+/);
  const lastToken = tokens[tokens.length - 1];

  const mnemMatches = Object.keys(TERMINAL_FUNCTIONS)
    .filter(m => m.startsWith(lastToken))
    .slice(0, 8)
    .map(m => ({
      type: 'mnem',
      key: m,
      name: TERMINAL_FUNCTIONS[m].name,
      desc: TERMINAL_FUNCTIONS[m].desc,
    }));

  const tickerMatches = state.stockbook.rows
    .filter(r => r.ticker.startsWith(lastToken))
    .slice(0, 6)
    .map(r => ({
      type: 'ticker',
      key: r.ticker,
      name: r.name || r.ticker,
      desc: r.sector || '',
    }));

  const all = [...mnemMatches, ...tickerMatches];
  if (all.length === 0) { cmdSuggest.style.display = 'none'; return; }

  state.terminal.selectedSuggest = 0;
  cmdSuggest.innerHTML = all.map((s, i) => `
    <div class="cmd-suggest-item ${i === 0 ? 'selected' : ''}" data-idx="${i}" data-key="${s.key}" data-type="${s.type}">
      <span class="cmd-suggest-mnem">${s.key}</span>
      <span class="cmd-suggest-name">${s.name}</span>
      <span class="cmd-suggest-desc">${s.desc}</span>
    </div>
  `).join('');
  cmdSuggest.style.display = 'block';

  cmdSuggest.querySelectorAll('.cmd-suggest-item').forEach((el, i) => {
    el.addEventListener('mouseenter', () => {
      cmdSuggest.querySelectorAll('.cmd-suggest-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      state.terminal.selectedSuggest = i;
    });
    el.addEventListener('click', () => {
      acceptSuggestion(i);
    });
  });
}

function acceptSuggestion(idx) {
  const items = cmdSuggest.querySelectorAll('.cmd-suggest-item');
  const sel = items[idx];
  if (!sel) return;
  const key = sel.dataset.key;
  // Replace last token with the suggestion
  const parts = cmdInput.value.trim().split(/\s+/);
  parts[parts.length - 1] = key;
  cmdInput.value = parts.join(' ') + ' ';
  cmdSuggest.style.display = 'none';
  cmdInput.focus();
}

cmdInput.addEventListener('input', e => updateSuggestions(e.target.value));

cmdInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (cmdSuggest.style.display === 'block' && state.terminal.selectedSuggest >= 0) {
      // If cursor is at end and there's a suggestion, accept it instead of executing
      // But if user has full command typed, just execute
      const items = cmdSuggest.querySelectorAll('.cmd-suggest-item');
      if (items.length > 0 && cmdInput.value.trim().split(/\s+/).length === 1) {
        // Single token, accept suggestion
        acceptSuggestion(state.terminal.selectedSuggest);
        return;
      }
    }
    cmdSuggest.style.display = 'none';
    executeCommand(cmdInput.value);
    cmdInput.value = '';
  } else if (e.key === 'ArrowDown' && cmdSuggest.style.display === 'block') {
    e.preventDefault();
    const items = cmdSuggest.querySelectorAll('.cmd-suggest-item');
    state.terminal.selectedSuggest = Math.min(items.length - 1, state.terminal.selectedSuggest + 1);
    items.forEach((el, i) => el.classList.toggle('selected', i === state.terminal.selectedSuggest));
  } else if (e.key === 'ArrowUp' && cmdSuggest.style.display === 'block') {
    e.preventDefault();
    const items = cmdSuggest.querySelectorAll('.cmd-suggest-item');
    state.terminal.selectedSuggest = Math.max(0, state.terminal.selectedSuggest - 1);
    items.forEach((el, i) => el.classList.toggle('selected', i === state.terminal.selectedSuggest));
  } else if (e.key === 'Escape') {
    if (cmdSuggest.style.display === 'block') {
      cmdSuggest.style.display = 'none';
    } else {
      cmdInput.value = '';
    }
  }
});

cmdGo.addEventListener('click', () => {
  executeCommand(cmdInput.value);
  cmdInput.value = '';
});

// ----- GLOBAL KEYBOARD SHORTCUTS -----
document.addEventListener('keydown', e => {
  // Don't intercept if user is typing in an input/textarea other than command bar
  const target = e.target;
  const inOtherInput = (target.tagName === 'INPUT' && target.id !== 'cmd-input') || target.tagName === 'TEXTAREA';

  if (e.key === '/' && !inOtherInput && target.id !== 'cmd-input') {
    e.preventDefault();
    cmdInput.focus();
    cmdInput.select();
  } else if (e.key === 'Escape') {
    if (document.getElementById('fn-overlay').style.display !== 'none') {
      closeFnOverlay();
    }
  } else if (e.key === 'F1') {
    e.preventDefault();
    fnHELP();
  } else if (e.key === 'F2') {
    e.preventDefault();
    cmdCheat.style.display = cmdCheat.style.display === 'none' ? 'block' : 'none';
  } else if (e.ctrlKey && e.key === '1') {
    e.preventDefault();
    switchTab('valuation');
  } else if (e.ctrlKey && e.key === '2') {
    e.preventDefault();
    switchTab('macro');
  } else if (e.ctrlKey && e.key === '3') {
    e.preventDefault();
    switchTab('stockbook');
  } else if (e.ctrlKey && e.key === '4') {
    e.preventDefault();
    switchTab('probability');
  } else if (e.ctrlKey && e.key === '5') {
    e.preventDefault();
    switchTab('risk');
  } else if (e.ctrlKey && e.key === '6') {
    e.preventDefault();
    switchTab('bonds');
  }
});

// Click outside to close suggestions / asset menu
document.addEventListener('click', e => {
  if (!e.target.closest('.cmd-bar') && !e.target.closest('#cmd-suggest')) {
    cmdSuggest.style.display = 'none';
    document.getElementById('cmd-asset-menu')?.remove();
  }
});

// ============================================================
//   PROBABILITY TAB — binary thesis odds, blended from priors
// ============================================================
//
// Each thesis answers a yes/no question:  P(price > strike at time T)
//
// Probability blending uses inverse-variance-weighted log-odds:
//   logit(p_blended) = Σ w_i · logit(p_i)  where Σw_i = 1
//
// Component priors:
//
// 1. HISTORICAL — fit log-normal to sheet history.
//    log returns r_t = ln(P_t / P_{t-1})
//    μ_daily = mean(r), σ_daily = stddev(r)
//    At horizon T (trading days): mean log-price = ln(P_0) + μ·T,  σ = σ·sqrt(T)
//    P(P_T > K) = 1 - Φ((ln(K) - ln(P_0) - μT) / (σ√T))
//
// 2. VALUATION — uses DCF margin of safety to nudge probability.
//    If MoS = (FairValue / Price - 1), then valuation prior:
//    p_val = sigmoid(k * MoS)  with k chosen so MoS=20% → p≈0.65, MoS=-20% → p≈0.35
//
// 3. MACRO — current Quad's stance on the stock's sector:
//    favor → +0.10 prob bias above 0.5
//    hurt  → -0.10 prob bias below 0.5
//    neutral → 0.50
//
// 4. MANUAL — user slider (0.05 to 0.95)
//
// All four converted to log-odds, weighted-averaged, converted back.

state.probability = {
  theses: [],   // loaded from localStorage
};
const PROB_STORAGE = 'valuatio.probability.theses.v1';

function loadTheses() {
  try {
    const arr = JSON.parse(localStorage.getItem(PROB_STORAGE) || '[]');
    // Migrate: add AI weight to old theses that don't have one
    return arr.map(t => {
      if (t.weights && t.weights.ai == null) {
        // Re-balance: take 40% from hist, redistribute
        const w = { ai: 0.40, hist: 0.20, val: 0.20, macro: 0.10, manual: 0.10 };
        return { ...t, weights: w };
      }
      return t;
    });
  } catch { return []; }
}
function saveTheses(arr) {
  localStorage.setItem(PROB_STORAGE, JSON.stringify(arr));
}

// ---------- MATH ----------
// Standard normal CDF using Abramowitz & Stegun approximation
function normCdf(z) {
  if (z < -8) return 0;
  if (z > 8) return 1;
  // Abramowitz & Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804 * Math.exp(-z * z / 2);
  let p = d * t * (
    0.31938153 +
    t * (-0.356563782 +
    t * (1.781477937 +
    t * (-1.821255978 +
    t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
function logit(p) {
  // Clamp to avoid infinity
  const c = Math.max(0.001, Math.min(0.999, p));
  return Math.log(c / (1 - c));
}
function invLogit(x) { return 1 / (1 + Math.exp(-x)); }
function sigmoid(x, k = 1) { return 1 / (1 + Math.exp(-k * x)); }

// ---------- COMPONENT PROBABILITIES ----------

// Historical: log-normal fit on sheet history → P(price > strike at T trading days)
function probHistorical(history, currentPrice, strike, direction, daysAhead) {
  if (!history || history.length < 30) return null;
  // Daily log returns
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    const r = Math.log(history[i].price / history[i - 1].price);
    if (isFinite(r)) returns.push(r);
  }
  if (returns.length < 20) return null;
  const mu = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mu) ** 2, 0) / (returns.length - 1);
  const sigma = Math.sqrt(variance);
  if (!isFinite(sigma) || sigma <= 0) return null;
  // Project to T trading days
  const T = daysAhead;
  const meanLogP = Math.log(currentPrice) + mu * T;
  const sdLogP = sigma * Math.sqrt(T);
  // P(P_T > K) for direction='above'; otherwise complement
  const z = (Math.log(strike) - meanLogP) / sdLogP;
  const probAbove = 1 - normCdf(z);
  return {
    p: direction === 'above' ? probAbove : 1 - probAbove,
    annualizedVol: sigma * Math.sqrt(252),
    annualizedDrift: mu * 252,
    realizedVol52w: sigma * Math.sqrt(252),
  };
}

// Valuation: DCF margin of safety → probability shift
// Looks up saved valuations for this ticker, picks the most recent with a fairValue
function probValuation(ticker, currentPrice, strike, direction) {
  const saved = loadSaved();
  const v = saved.find(s => s.ticker === ticker.toUpperCase());
  if (!v || !v.fairValue || !currentPrice) return null;
  // Margin of safety relative to STRIKE (where we're betting price will be)
  // If fair value is well above strike, "above strike" thesis gets a lift
  const mosVsStrike = (v.fairValue - strike) / strike;
  // Sigmoid with k=4: MoS=20% → 0.69, MoS=-20% → 0.31, MoS=50% → 0.88
  const pAbove = sigmoid(mosVsStrike, 4);
  return {
    p: direction === 'above' ? pAbove : 1 - pAbove,
    fairValue: v.fairValue,
    mosVsStrike,
    savedAt: v.savedAt,
  };
}

// Macro: current Quad stance on sector
// Resolve the best sector classification from any row object — for derivatives like SPY
// the user puts "S&P 500" in sector; we fall back to subSector or industry to find an ETF mapping.
function resolveMacroETF(rowOrSector) {
  if (typeof rowOrSector === 'string') return sectorNameToETF(rowOrSector);
  if (!rowOrSector) return null;
  return sectorNameToETF(rowOrSector.sector)
      || sectorNameToETF(rowOrSector.subSector)
      || sectorNameToETF(rowOrSector.industry)
      || null;
}

function probMacro(sectorOrRow, direction) {
  const m = state.macro;
  if (!m?.current?.quad) return null;
  if (!sectorOrRow) return null;
  const etf = resolveMacroETF(sectorOrRow);
  if (!etf) return null;
  const etfData = SECTOR_ETFS.find(e => e.ticker === etf);
  if (!etfData) return null;
  const quad = m.current.quad;
  let pAbove = 0.50;
  let stance = 'neutral';
  if (etfData.favors.includes(quad)) { pAbove = 0.60; stance = 'tailwind'; }
  else if (etfData.hurts.includes(quad)) { pAbove = 0.40; stance = 'headwind'; }
  return {
    p: direction === 'above' ? pAbove : 1 - pAbove,
    quad,
    quadName: QUADS[quad].name,
    etf,
    stance,
  };
}

// ---------- BLENDING ----------
// Weighted log-odds average — equivalent to multiplying odds with exponents
function blendProbabilities(components, weights) {
  // components = { hist: 0.62, val: 0.55, macro: 0.50, manual: 0.70 }
  // weights = { hist: 0.4, val: 0.3, macro: 0.2, manual: 0.1 }  (must sum to 1)
  let totalW = 0;
  let weightedLogit = 0;
  for (const k of Object.keys(components)) {
    const p = components[k];
    if (p == null) continue;
    const w = weights[k] || 0;
    weightedLogit += w * logit(p);
    totalW += w;
  }
  if (totalW === 0) return 0.5;
  // Normalize so the available components reflect their full weight
  return invLogit(weightedLogit / totalW);
}

// ---------- COMPUTE ONE THESIS ----------
async function computeThesisProbability(thesis) {
  const ticker = thesis.ticker.toUpperCase();

  // Try multiple sources for current price + sector
  // 1. Stockbook row (sheet-derived)
  let sbRow = state.stockbook?.rows?.find(r => r.ticker === ticker);

  // 2. If stockbook empty, force a load
  if (!sbRow && (state.stockbook?.rows?.length ?? 0) === 0) {
    try {
      await loadStockBook(false);
      sbRow = state.stockbook?.rows?.find(r => r.ticker === ticker);
    } catch {}
  }

  // 3. Sector fallback: pull from enrichment cache if sheet doesn't have it
  let sector = sbRow?.sector;
  if (!sector) {
    try {
      const cache = JSON.parse(localStorage.getItem(DESC_CACHE_KEY) || '{}');
      if (cache[ticker]?.sector) sector = cache[ticker].sector;
    } catch {}
  }
  // 4. If still no sector, fetch via enrichTicker (Finnhub → Wikipedia)
  if (!sector) {
    try {
      const enriched = await enrichTicker(ticker, sbRow?.name);
      if (enriched?.sector) sector = enriched.sector;
    } catch {}
  }

  // Current price: stockbook → sheet history (last point) → state.stock
  let currentPrice = sbRow?.price;
  let priceSource = 'sheet';
  if (!currentPrice) {
    const hist = await getPriceHistory(ticker).catch(() => null);
    if (hist && hist.length > 0) {
      currentPrice = hist[hist.length - 1].price;
      priceSource = 'sheet-history';
    }
  }
  if (!currentPrice && state.stock?.ticker === ticker) {
    currentPrice = state.stock.price;
    priceSource = 'memory';
  }
  if (!currentPrice) {
    return {
      error: 'No current price for ' + ticker + '. Add it to your sheet, or load it on the Valuation tab first.',
      diagnostics: {
        stockbookHasTicker: !!sbRow,
        stockbookSize: state.stockbook?.rows?.length || 0,
        sector: sector || null,
      },
    };
  }

  // 1. Historical
  const hist = await getPriceHistory(ticker).catch(() => null);
  const histResult = probHistorical(hist, currentPrice, thesis.strike, thesis.direction, thesis.days);
  const histDiag = {
    historyFound: !!hist,
    historyLength: hist?.length || 0,
    needsAtLeast: 30,
  };

  // 2. Valuation
  const valResult = probValuation(ticker, currentPrice, thesis.strike, thesis.direction);
  const savedAll = loadSaved();
  const valDiag = {
    savedValuationsTotal: savedAll.length,
    savedForThisTicker: savedAll.filter(v => v.ticker === ticker).length,
  };

  // 3. Macro — pass the full row so SPY etc. can fall back to subSector
  const macroInput = sbRow ? {
    sector: sbRow.sector || sector,
    subSector: sbRow.subSector,
    industry: sbRow.industry,
  } : sector;
  const macroResult = probMacro(macroInput, thesis.direction);
  const macroDiag = {
    sector: sector || null,
    subSector: sbRow?.subSector || null,
    sectorSource: sbRow?.sector ? 'sheet' : sector ? 'enrichment' : 'missing',
    macroLoaded: !!state.macro?.current?.quad,
  };

  // 4. Manual
  const manualP = thesis.manualPrior ?? 0.5;

  // 5. AI Inference — multi-feature gradient model
  const aiResult = await probAIInference(thesis, sbRow);

  const components = {
    ai: aiResult?.p ?? null,
    hist: histResult?.p ?? null,
    val: valResult?.p ?? null,
    macro: macroResult?.p ?? null,
    manual: manualP,
  };
  const blended = blendProbabilities(components, thesis.weights);

  return {
    currentPrice,
    priceSource,
    sector,
    components,
    weights: thesis.weights,
    blended,
    details: {
      ai: aiResult,
      hist: histResult,
      val: valResult,
      macro: macroResult,
      manual: { p: manualP }
    },
    diagnostics: { hist: histDiag, val: valDiag, macro: macroDiag },
  };
}

// ---------- RENDER ----------
async function renderProbabilityTab() {
  const grid = document.getElementById('prob-grid');
  const empty = document.getElementById('prob-empty');
  const theses = state.probability.theses;
  if (theses.length === 0) {
    grid.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  // Compute each in parallel
  const computed = await Promise.all(theses.map(t =>
    computeThesisProbability(t).then(r => ({ thesis: t, result: r }))
  ));

  // Build dashboard summary across all theses
  const valid = computed.filter(c => !c.result.error);
  const summaryHtml = renderProbabilitySummary(valid);

  grid.innerHTML = summaryHtml + computed.map(({ thesis, result }) =>
    renderThesisCard(thesis, result)).join('');

  // Wire up interactions
  computed.forEach(({ thesis }) => {
    wireThesisCard(thesis);
  });
}

// Top-of-page dashboard: aggregate view across all theses
function renderProbabilitySummary(computed) {
  if (computed.length === 0) return '';

  // Categorize each thesis by probability
  const buckets = {
    veryLikely: computed.filter(c => c.result.blended >= 0.70),
    likely:     computed.filter(c => c.result.blended >= 0.55 && c.result.blended < 0.70),
    coinflip:   computed.filter(c => c.result.blended >= 0.45 && c.result.blended < 0.55),
    unlikely:   computed.filter(c => c.result.blended >= 0.30 && c.result.blended < 0.45),
    veryUnlikely: computed.filter(c => c.result.blended < 0.30),
  };

  // Average blended probability across all
  const avgProb = computed.reduce((s, c) => s + c.result.blended, 0) / computed.length;

  // Sector exposure breakdown
  const sectorMap = {};
  computed.forEach(c => {
    const s = c.result.sector || 'Unknown';
    if (!sectorMap[s]) sectorMap[s] = { count: 0, totalProb: 0 };
    sectorMap[s].count++;
    sectorMap[s].totalProb += c.result.blended;
  });
  const sectorRows = Object.entries(sectorMap)
    .map(([s, d]) => ({ sector: s, count: d.count, avgProb: d.totalProb / d.count }))
    .sort((a, b) => b.count - a.count);

  // Highest-conviction thesis (highest probability * how far above 50%)
  const topThesis = [...computed].sort((a, b) => b.result.blended - a.result.blended)[0];
  const bottomThesis = [...computed].sort((a, b) => a.result.blended - b.result.blended)[0];

  const macroQuad = state.macro?.current?.quad;
  const macroLabel = macroQuad ? `Q${macroQuad} · ${QUADS[macroQuad].name}` : 'Macro not loaded';

  return `
    <div class="prob-summary">
      <div class="prob-summary-head">
        <div>
          <div class="prob-summary-title">Probability Dashboard</div>
          <div class="prob-summary-sub">${computed.length} theses · ${macroLabel}</div>
        </div>
        <div class="prob-summary-avg">
          <div class="prob-summary-avg-label">Average Probability</div>
          <div class="prob-summary-avg-pct" style="color:${avgProb > 0.5 ? '#5b8a72' : '#a5645a'}">
            ${(avgProb * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      <!-- Probability distribution histogram (5 buckets) -->
      <div class="prob-summary-buckets">
        ${[
          { key: 'veryLikely', label: 'Very Likely', sub: '≥70%', color: '#5b8a72' },
          { key: 'likely', label: 'Likely', sub: '55–70%', color: '#7aa085' },
          { key: 'coinflip', label: 'Coin Flip', sub: '45–55%', color: '#c4965a' },
          { key: 'unlikely', label: 'Unlikely', sub: '30–45%', color: '#b88578' },
          { key: 'veryUnlikely', label: 'Very Unlikely', sub: '<30%', color: '#a5645a' },
        ].map(b => `
          <div class="prob-bucket" style="border-top:3px solid ${b.color}">
            <div class="prob-bucket-count">${buckets[b.key].length}</div>
            <div class="prob-bucket-label">${b.label}</div>
            <div class="prob-bucket-sub">${b.sub}</div>
          </div>
        `).join('')}
      </div>

      <!-- Top picks: most & least likely outcomes -->
      <div class="prob-summary-picks">
        <div class="prob-pick">
          <div class="prob-pick-label up">▲ Highest probability</div>
          <div class="prob-pick-thesis">
            <span class="tic">${topThesis.thesis.ticker}</span>
            ${topThesis.thesis.direction} $${topThesis.thesis.strike.toFixed(2)} in ${topThesis.thesis.days}d
          </div>
          <div class="prob-pick-pct" style="color:#5b8a72">${(topThesis.result.blended * 100).toFixed(1)}%</div>
        </div>
        <div class="prob-pick">
          <div class="prob-pick-label down">▼ Lowest probability</div>
          <div class="prob-pick-thesis">
            <span class="tic">${bottomThesis.thesis.ticker}</span>
            ${bottomThesis.thesis.direction} $${bottomThesis.thesis.strike.toFixed(2)} in ${bottomThesis.thesis.days}d
          </div>
          <div class="prob-pick-pct" style="color:#a5645a">${(bottomThesis.result.blended * 100).toFixed(1)}%</div>
        </div>
      </div>

      ${sectorRows.length > 1 ? `
      <div class="prob-summary-sectors">
        <div class="prob-summary-sectors-title">Sector Exposure (avg probability per sector)</div>
        <table class="prob-summary-table">
          <thead><tr><th>Sector</th><th>Theses</th><th>Avg Probability</th><th></th></tr></thead>
          <tbody>
            ${sectorRows.map(s => {
              const w = (s.avgProb * 100).toFixed(0);
              return `
                <tr>
                  <td>${s.sector}</td>
                  <td>${s.count}</td>
                  <td style="color:${s.avgProb > 0.5 ? '#5b8a72' : '#a5645a'}">${(s.avgProb * 100).toFixed(1)}%</td>
                  <td><div class="prob-summary-bar"><div style="width:${w}%;background:${s.avgProb > 0.5 ? '#5b8a72' : '#a5645a'}"></div></div></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      ` : ''}
    </div>
  `;
}

function renderThesisCard(thesis, result) {
  if (result.error) {
    return `
      <div class="thesis-card" data-id="${thesis.id}">
        <div class="thesis-question">
          <span class="tic">${thesis.ticker}</span> ${thesis.direction} $${thesis.strike} in ${thesis.days}d
        </div>
        <div style="color:var(--red);font-family:var(--mono);font-size:11px">${result.error}</div>
        <div class="thesis-actions">
          <button class="thesis-action-btn danger" data-act="delete" data-id="${thesis.id}">Delete</button>
        </div>
      </div>
    `;
  }

  const { components, weights, blended, currentPrice, details, sector } = result;
  const pct = (blended * 100).toFixed(1);
  const horizonLabel = thesis.days >= 365 ? Math.round(thesis.days / 365) + 'y'
    : thesis.days >= 30 ? Math.round(thesis.days / 30) + 'mo' : thesis.days + 'd';
  const targetDate = new Date(Date.now() + thesis.days * 86400000)
    .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const targetMove = ((thesis.strike / currentPrice - 1) * 100);
  const moveLabel = (targetMove >= 0 ? '+' : '') + targetMove.toFixed(1) + '%';

  // Component cells
  const compCell = (key, label, value, weight, hint) => {
    const v = value;
    const valDisplay = v == null ? '—'
      : key === 'manual' ? (v * 100).toFixed(0) + '%'
      : (v * 100).toFixed(1) + '%';
    const muted = v == null ? 'muted' : (v > 0.5 ? 'up' : v < 0.5 ? 'down' : '');
    return `
      <div class="thesis-component">
        <div class="name">${label}</div>
        <div class="value ${muted}">${valDisplay}</div>
        ${hint ? `<div style="color:var(--ink-faint);font-size:9px;margin-top:2px">${hint}</div>` : ''}
        <div class="weight">
          <input type="range" min="0" max="100" value="${(weight * 100).toFixed(0)}"
                 data-comp="${key}" data-id="${thesis.id}">
          <span class="weight-val">${(weight * 100).toFixed(0)}%</span>
        </div>
      </div>
    `;
  };

  return `
    <div class="thesis-card" data-id="${thesis.id}">
      <div class="thesis-question">
        <span class="tic">${thesis.ticker}</span>
        closes <strong>${thesis.direction}</strong> $${thesis.strike.toFixed(2)} by ${targetDate}
      </div>

      <div class="thesis-prob">
        <div class="thesis-prob-pct">${pct}<span style="font-size:24px">%</span></div>
        <div>
          <div class="thesis-prob-label">Implied Probability</div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);margin-top:2px">
            Current: $${currentPrice.toFixed(2)} · Move needed: ${moveLabel}
          </div>
        </div>
      </div>
      <div class="thesis-prob-bar">
        <div class="thesis-prob-bar-fill" style="width:${pct}%"></div>
      </div>

      <div class="thesis-components">
        ${compCell('ai', 'AI Inference', components.ai, weights.ai,
          details.ai?.interpretation || (details.ai?.error || 'Need 30+ days of history'))}
        ${compCell('hist', 'Historical', components.hist, weights.hist,
          details.hist ? `Realized vol ${(details.hist.realizedVol52w * 100).toFixed(0)}% ann`
            : result.diagnostics?.hist?.historyFound
              ? `Only ${result.diagnostics.hist.historyLength} days · need 30+`
              : 'No price history in sheet')}
        ${compCell('val', 'Valuation (DCF)', components.val, weights.val,
          details.val ? `Saved FV $${details.val.fairValue.toFixed(2)}`
            : result.diagnostics?.val?.savedValuationsTotal === 0
              ? 'No saved valuations · run Save on Valuation tab'
              : `No saved DCF for ${thesis.ticker}`)}
        ${compCell('macro', 'Macro Quad', components.macro, weights.macro,
          details.macro ? `Q${details.macro.quad} ${details.macro.stance}`
            : !result.diagnostics?.macro?.macroLoaded ? 'Macro tab not loaded'
            : !result.diagnostics?.macro?.sector ? 'No sector found · enrich Stock Book'
            : 'Sector not mapped to ETF')}
        ${compCell('manual', 'Your Prior', components.manual, weights.manual,
          'Drag the value slider →')}
      </div>

      <div class="thesis-meta">
        <span class="thesis-meta-item">Horizon <strong>${horizonLabel}</strong></span>
        <span class="thesis-meta-item">Sector <strong>${sector || '—'}</strong></span>
        <span class="thesis-meta-item">Created <strong>${new Date(thesis.createdAt).toLocaleDateString()}</strong></span>
      </div>

      <!-- Manual prior slider (separate from component weights) -->
      <div style="display:flex;gap:10px;align-items:center;font-family:var(--mono);font-size:10px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:0.12em">
        <span>Your Conviction</span>
        <input type="range" min="5" max="95" value="${(thesis.manualPrior * 100).toFixed(0)}"
               data-prior data-id="${thesis.id}" style="flex:1;accent-color:var(--amber)">
        <span style="color:var(--amber);font-weight:700">${(thesis.manualPrior * 100).toFixed(0)}%</span>
      </div>

      <div class="thesis-actions">
        <button class="thesis-action-btn" data-act="value" data-tic="${thesis.ticker}">Open in GP</button>
        <button class="thesis-action-btn" data-act="duplicate" data-id="${thesis.id}">Duplicate</button>
        <button class="thesis-action-btn danger" data-act="delete" data-id="${thesis.id}">Delete</button>
      </div>
    </div>
  `;
}

function wireThesisCard(thesis) {
  const card = document.querySelector(`.thesis-card[data-id="${thesis.id}"]`);
  if (!card) return;

  // Component weight sliders — debounced re-render
  card.querySelectorAll('input[data-comp]').forEach(slider => {
    slider.addEventListener('input', e => {
      const compKey = e.target.dataset.comp;
      const newW = parseInt(e.target.value) / 100;
      // Update weight, normalize so all sum to 1
      const t = state.probability.theses.find(x => x.id === thesis.id);
      if (!t) return;
      t.weights[compKey] = newW;
      // Normalize
      const sum = Object.values(t.weights).reduce((a, b) => a + b, 0);
      if (sum > 0) {
        for (const k of Object.keys(t.weights)) t.weights[k] /= sum;
      }
      saveTheses(state.probability.theses);
      // Update only this card
      computeThesisProbability(t).then(result => {
        const newCard = document.createElement('div');
        newCard.innerHTML = renderThesisCard(t, result);
        card.replaceWith(newCard.firstElementChild);
        wireThesisCard(t);
      });
    });
  });

  // Manual prior slider
  const priorSlider = card.querySelector('input[data-prior]');
  if (priorSlider) {
    priorSlider.addEventListener('input', e => {
      const val = parseInt(e.target.value) / 100;
      const t = state.probability.theses.find(x => x.id === thesis.id);
      if (!t) return;
      t.manualPrior = val;
      saveTheses(state.probability.theses);
      computeThesisProbability(t).then(result => {
        const newCard = document.createElement('div');
        newCard.innerHTML = renderThesisCard(t, result);
        card.replaceWith(newCard.firstElementChild);
        wireThesisCard(t);
      });
    });
  }

  // Action buttons
  card.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', e => {
      const act = btn.dataset.act;
      if (act === 'delete') {
        if (!confirm('Delete this thesis?')) return;
        state.probability.theses = state.probability.theses.filter(t => t.id !== thesis.id);
        saveTheses(state.probability.theses);
        renderProbabilityTab();
      } else if (act === 'duplicate') {
        const copy = {
          ...thesis,
          id: 't' + Date.now(),
          createdAt: new Date().toISOString(),
        };
        state.probability.theses.push(copy);
        saveTheses(state.probability.theses);
        renderProbabilityTab();
      } else if (act === 'value') {
        document.getElementById('ticker').value = btn.dataset.tic;
        switchTab('valuation');
        loadValuation();
      }
    });
  });
}

// ---------- THESIS CREATION MODAL ----------
function openThesisModal() {
  document.getElementById('thesis-modal').style.display = 'flex';
  document.getElementById('thesis-ticker').value = state.stock?.ticker || '';
  document.getElementById('thesis-strike').value = '';
  document.querySelectorAll('#thesis-direction .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.val === 'above');
  });
  document.querySelectorAll('#thesis-horizon .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.days === '90');
  });
  document.getElementById('thesis-ticker').focus();
}
function closeThesisModal() {
  document.getElementById('thesis-modal').style.display = 'none';
}

document.getElementById('thesis-close').addEventListener('click', closeThesisModal);

// Direction segmented control
document.querySelectorAll('#thesis-direction .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#thesis-direction .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Horizon segmented control
document.querySelectorAll('#thesis-horizon .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#thesis-horizon .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('thesis-create').addEventListener('click', () => {
  const ticker = document.getElementById('thesis-ticker').value.trim().toUpperCase();
  const strike = parseFloat(document.getElementById('thesis-strike').value);
  const direction = document.querySelector('#thesis-direction .seg-btn.active')?.dataset.val || 'above';
  const days = parseInt(document.querySelector('#thesis-horizon .seg-btn.active')?.dataset.days || '90');

  if (!ticker || !strike || strike <= 0) {
    alert('Need a valid ticker and strike price.');
    return;
  }

  const thesis = {
    id: 't' + Date.now(),
    ticker, strike, direction, days,
    createdAt: new Date().toISOString(),
    manualPrior: 0.5,
    weights: { ai: 0.40, hist: 0.20, val: 0.20, macro: 0.10, manual: 0.10 },
  };

  state.probability.theses.push(thesis);
  saveTheses(state.probability.theses);
  closeThesisModal();
  renderProbabilityTab();
});

document.getElementById('prob-new-btn').addEventListener('click', openThesisModal);
document.getElementById('prob-recalc-btn').addEventListener('click', renderProbabilityTab);
document.getElementById('prob-clear-btn').addEventListener('click', () => {
  if (!confirm('Delete all theses?')) return;
  state.probability.theses = [];
  saveTheses([]);
  renderProbabilityTab();
});

// Quick-add a "PROB" mnemonic to the terminal command bar so users can do "AAPL PROB"
if (typeof TERMINAL_FUNCTIONS !== 'undefined') {
  TERMINAL_FUNCTIONS.PROB = {
    name: 'Probability',
    desc: 'Open the binary-thesis odds tab',
    scope: 'global',
    handler: () => switchTab('probability'),
  };
}

// ============================================================
//   VALUATION SUB-TABS: OVERVIEW / FINANCIALS
// ============================================================

state.valSubtab = 'overview';
state.financials = {
  ticker: null,
  period: 'annual',  // 'annual' or 'quarter'
  statement: 'income', // 'income', 'balance', 'cashflow'
  data: null,        // { income: [...], balance: [...], cashflow: [...] }
};

document.querySelectorAll('.val-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    const subtab = btn.dataset.subtab;
    state.valSubtab = subtab;
    document.querySelectorAll('.val-subtab').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    document.querySelectorAll('.val-subpanel').forEach(p => {
      p.style.display = p.dataset.subpanel === subtab ? '' : 'none';
    });
    if (subtab === 'financials' && state.stock) {
      loadFinancials(state.stock.ticker);
    }
  });
});

document.querySelectorAll('#fin-period-control .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.financials.period = btn.dataset.period;
    document.querySelectorAll('#fin-period-control .seg-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    if (state.stock) loadFinancials(state.stock.ticker, true);
  });
});

document.querySelectorAll('#fin-statement-control .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    state.financials.statement = btn.dataset.stmt;
    document.querySelectorAll('#fin-statement-control .seg-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    renderFinancials();
  });
});

async function loadFinancials(ticker, forceRefresh = false) {
  const el = document.getElementById('financials-content');
  if (!el) return;

  if (!getFmpKey()) {
    el.innerHTML = `
      <div class="empty" style="padding:40px;text-align:center;line-height:1.7">
        <div style="color:var(--amber);font-size:16px;margin-bottom:12px">Financial Modeling Prep API key required</div>
        <p style="color:var(--ink-dim);font-family:var(--mono);font-size:12px">
          Free tier: 250 calls/day · <a href="https://site.financialmodelingprep.com/register" target="_blank" style="color:var(--amber)">financialmodelingprep.com/register</a>
        </p>
        <p style="color:var(--ink-dim);font-family:var(--mono);font-size:11px;margin-top:14px">
          Then click <strong>Data Sources</strong> → paste the FMP key → Save.
        </p>
      </div>
    `;
    return;
  }

  // Cache check (avoid re-fetching when toggling statements)
  const cacheKey = ticker + ':' + state.financials.period;
  if (!forceRefresh && state.financials.ticker === cacheKey && state.financials.data) {
    renderFinancials();
    return;
  }

  el.innerHTML = '<div class="empty" style="padding:40px;text-align:center;color:var(--ink-dim);font-family:var(--mono);font-size:12px">Loading financials from FMP…</div>';

  try {
    const period = state.financials.period;
    const limit = period === 'annual' ? 5 : 8; // 5 years annual, 8 quarters
    const [income, balance, cashflow] = await Promise.all([
      fetchFmpIncome(ticker, period, limit),
      fetchFmpBalance(ticker, period, limit),
      fetchFmpCashflow(ticker, period, limit),
    ]);

    if (!income?.length && !balance?.length && !cashflow?.length) {
      const isQuarterly = period === 'quarter';
      el.innerHTML = `
        <div class="empty" style="padding:40px;text-align:center;line-height:1.7;font-family:var(--mono);font-size:12px">
          <div style="color:var(--red);font-size:14px;margin-bottom:12px">No ${period} data returned for ${ticker}</div>
          <div style="color:var(--ink-dim);max-width:520px;margin:0 auto">
            ${isQuarterly
              ? `Quarterly data may not be available on the FMP free tier for this ticker.<br>Try <strong style="color:var(--amber)">Annual</strong> instead, or check your FMP dashboard for daily quota usage.<br><br>Open browser DevTools (F12) → Console — FMP's exact error will be logged there.`
              : `Possible reasons: ticker symbol is wrong, FMP daily quota (250) exhausted, or this ticker isn't covered.<br>Open browser DevTools (F12) → Console for the exact error.`}
          </div>
        </div>
      `;
      return;
    }

    state.financials.ticker = cacheKey;
    state.financials.data = { income: income || [], balance: balance || [], cashflow: cashflow || [] };
    renderFinancials();
  } catch (e) {
    el.innerHTML = `<div class="empty" style="padding:40px;text-align:center;color:var(--red)">Error: ${e.message}</div>`;
  }
}

function renderFinancials() {
  const el = document.getElementById('financials-content');
  if (!el || !state.financials.data) return;

  const stmt = state.financials.statement;
  const data = state.financials.data;

  let rows, table;
  if (stmt === 'income') {
    rows = data.income;
    table = renderIncomeStatement(rows);
  } else if (stmt === 'balance') {
    rows = data.balance;
    table = renderBalanceSheet(rows);
  } else {
    rows = data.cashflow;
    table = renderCashFlow(rows);
  }

  if (!rows || rows.length === 0) {
    el.innerHTML = `<div class="empty" style="padding:40px;text-align:center;color:var(--ink-dim)">No ${stmt} data available.</div>`;
    return;
  }

  const periodLabel = state.financials.period === 'annual' ? 'Annual' : 'Quarterly';
  el.innerHTML = `
    ${table}
    <div class="financials-meta">
      ${periodLabel} · ${rows.length} periods · Source: Financial Modeling Prep · Reported in millions unless noted
    </div>
  `;
}

// Helper: render a financial statement table from FMP data + a row spec
// rowSpec: array of { label, key, indent?, subtotal? }
function renderStatementTable(rows, rowSpec) {
  const cols = rows.map(r => {
    if (state.financials.period === 'quarter') {
      // e.g. "Q3 2024"
      const date = r.date || '';
      const period = r.period || '';
      const yr = date.slice(0, 4);
      return period ? `${period} ${yr}` : date.slice(0, 7);
    }
    return r.calendarYear || r.date?.slice(0, 4) || '—';
  });

  const fmt = (n) => {
    if (n == null || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return n.toFixed(2);
  };

  return `
    <table class="financials-table">
      <thead>
        <tr>
          <th>Line Item</th>
          ${cols.map(c => `<th>${c}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${rowSpec.map(spec => `
          <tr class="${spec.subtotal ? 'subtotal' : spec.indent ? 'indent' : ''}">
            <td>${spec.label}</td>
            ${rows.map(r => `<td>${fmt(r[spec.key])}</td>`).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderIncomeStatement(rows) {
  return renderStatementTable(rows, [
    { label: 'Revenue', key: 'revenue', subtotal: true },
    { label: 'Cost of Revenue', key: 'costOfRevenue', indent: true },
    { label: 'Gross Profit', key: 'grossProfit', subtotal: true },
    { label: 'R&D Expense', key: 'researchAndDevelopmentExpenses', indent: true },
    { label: 'SG&A Expense', key: 'sellingGeneralAndAdministrativeExpenses', indent: true },
    { label: 'Operating Expenses', key: 'operatingExpenses', indent: true },
    { label: 'Operating Income', key: 'operatingIncome', subtotal: true },
    { label: 'Interest Expense', key: 'interestExpense', indent: true },
    { label: 'Income Before Tax', key: 'incomeBeforeTax' },
    { label: 'Income Tax Expense', key: 'incomeTaxExpense', indent: true },
    { label: 'Net Income', key: 'netIncome', subtotal: true },
    { label: 'EPS (Basic)', key: 'eps' },
    { label: 'EPS (Diluted)', key: 'epsdiluted' },
    { label: 'EBITDA', key: 'ebitda' },
    { label: 'Weighted Avg Shares (Diluted)', key: 'weightedAverageShsOutDil' },
  ]);
}

function renderBalanceSheet(rows) {
  return renderStatementTable(rows, [
    { label: 'ASSETS', key: '_section', subtotal: true },
    { label: 'Cash & Equivalents', key: 'cashAndCashEquivalents', indent: true },
    { label: 'Short-Term Investments', key: 'shortTermInvestments', indent: true },
    { label: 'Net Receivables', key: 'netReceivables', indent: true },
    { label: 'Inventory', key: 'inventory', indent: true },
    { label: 'Total Current Assets', key: 'totalCurrentAssets', subtotal: true },
    { label: 'Property, Plant & Equipment', key: 'propertyPlantEquipmentNet', indent: true },
    { label: 'Goodwill', key: 'goodwill', indent: true },
    { label: 'Intangible Assets', key: 'intangibleAssets', indent: true },
    { label: 'Total Non-Current Assets', key: 'totalNonCurrentAssets', subtotal: true },
    { label: 'Total Assets', key: 'totalAssets', subtotal: true },
    { label: 'LIABILITIES', key: '_section', subtotal: true },
    { label: 'Accounts Payable', key: 'accountPayables', indent: true },
    { label: 'Short-Term Debt', key: 'shortTermDebt', indent: true },
    { label: 'Total Current Liabilities', key: 'totalCurrentLiabilities', subtotal: true },
    { label: 'Long-Term Debt', key: 'longTermDebt', indent: true },
    { label: 'Total Non-Current Liabilities', key: 'totalNonCurrentLiabilities', subtotal: true },
    { label: 'Total Liabilities', key: 'totalLiabilities', subtotal: true },
    { label: 'Total Debt', key: 'totalDebt' },
    { label: 'Net Debt', key: 'netDebt' },
    { label: "EQUITY", key: '_section', subtotal: true },
    { label: 'Common Stock', key: 'commonStock', indent: true },
    { label: 'Retained Earnings', key: 'retainedEarnings', indent: true },
    { label: 'Total Stockholders\' Equity', key: 'totalStockholdersEquity', subtotal: true },
  ]);
}

function renderCashFlow(rows) {
  return renderStatementTable(rows, [
    { label: 'OPERATING ACTIVITIES', key: '_section', subtotal: true },
    { label: 'Net Income', key: 'netIncome', indent: true },
    { label: 'D&A', key: 'depreciationAndAmortization', indent: true },
    { label: 'Stock-Based Compensation', key: 'stockBasedCompensation', indent: true },
    { label: 'Change in Working Capital', key: 'changeInWorkingCapital', indent: true },
    { label: 'Operating Cash Flow', key: 'operatingCashFlow', subtotal: true },
    { label: 'INVESTING ACTIVITIES', key: '_section', subtotal: true },
    { label: 'Capital Expenditure', key: 'capitalExpenditure', indent: true },
    { label: 'Acquisitions (Net)', key: 'acquisitionsNet', indent: true },
    { label: 'Investments Purchased', key: 'purchasesOfInvestments', indent: true },
    { label: 'Investments Sold', key: 'salesMaturitiesOfInvestments', indent: true },
    { label: 'Net Cash from Investing', key: 'netCashUsedForInvestingActivites', subtotal: true },
    { label: 'FINANCING ACTIVITIES', key: '_section', subtotal: true },
    { label: 'Debt Repayment', key: 'debtRepayment', indent: true },
    { label: 'Common Stock Issued', key: 'commonStockIssued', indent: true },
    { label: 'Common Stock Repurchased', key: 'commonStockRepurchased', indent: true },
    { label: 'Dividends Paid', key: 'dividendsPaid', indent: true },
    { label: 'Net Cash from Financing', key: 'netCashUsedProvidedByFinancingActivities', subtotal: true },
    { label: 'Free Cash Flow', key: 'freeCashFlow', subtotal: true },
    { label: 'Net Change in Cash', key: 'netChangeInCash' },
    { label: 'Cash at End of Period', key: 'cashAtEndOfPeriod' },
  ]);
}

// Auto-clear cached financials when ticker changes (so switching tickers refetches)
// Hook listens for the ticker input to detect changes
const _ticker_input_for_fin = document.getElementById('ticker');
if (_ticker_input_for_fin) {
  _ticker_input_for_fin.addEventListener('change', () => {
    state.financials.ticker = null;
    state.financials.data = null;
    if (state.valSubtab === 'financials') {
      const t = _ticker_input_for_fin.value.trim().toUpperCase();
      if (t) loadFinancials(t);
    }
  });
}

// ============================================================
//   FMP → ASSUMPTIONS AUTO-MERGE
//   When user loads a ticker AND has an FMP key set, pull the most recent annual
//   statements and overlay onto state.inputs (where state.inputs has missing/zero values).
// ============================================================
async function autoMergeFmpToAssumptions(ticker) {
  if (!state.inputs) return;
  const i = state.inputs;
  let touched = false;

  // 1. Most recent annual income/balance/cashflow
  const [income, balance, cashflow] = await Promise.all([
    fetchFmpIncome(ticker, 'annual', 1),
    fetchFmpBalance(ticker, 'annual', 1),
    fetchFmpCashflow(ticker, 'annual', 1),
  ]);

  // Helper: only set if current value looks "missing" (0 or null)
  const setIfEmpty = (key, val, label) => {
    if (val == null || !isFinite(val)) return;
    if (i[key] === 0 || i[key] == null || (label === 'pct' && Math.abs(i[key]) < 0.001)) {
      i[key] = val;
      touched = true;
    }
  };
  // Always overwrite (use FMP as truth source for these specific values)
  const setAlways = (key, val) => {
    if (val == null || !isFinite(val)) return;
    i[key] = val;
    touched = true;
  };

  if (income && income.length > 0) {
    const inc = income[0];
    setIfEmpty('revenue', inc.revenue);
    setIfEmpty('ebitda', inc.ebitda);
    setIfEmpty('eps', inc.eps || inc.epsdiluted);
    if (inc.weightedAverageShsOutDil) setIfEmpty('sharesOutstanding', inc.weightedAverageShsOutDil);
    if (inc.operatingIncome && inc.revenue) {
      const opMargin = (inc.operatingIncome / inc.revenue) * 100;
      // Only auto-fill if current is the default 15
      if (Math.abs(i.operatingMargin - 15) < 0.5) {
        i.operatingMargin = opMargin;
        touched = true;
      }
    }
    if (inc.incomeTaxExpense && inc.incomeBeforeTax && inc.incomeBeforeTax > 0) {
      const taxRate = (inc.incomeTaxExpense / inc.incomeBeforeTax) * 100;
      // Only set if reasonable (5-50%) and current is default 21
      if (taxRate > 5 && taxRate < 50 && Math.abs(i.taxRate - 21) < 0.5) {
        i.taxRate = taxRate;
        touched = true;
      }
    }
  }

  if (balance && balance.length > 0) {
    const bal = balance[0];
    setAlways('totalDebt', bal.totalDebt);
    setAlways('cash', bal.cashAndCashEquivalents);
  }

  if (cashflow && cashflow.length > 0) {
    const cf = cashflow[0];
    // Use Free Cash Flow if available, otherwise OCF - CapEx
    let fcf = cf.freeCashFlow;
    if (fcf == null && cf.operatingCashFlow != null && cf.capitalExpenditure != null) {
      fcf = cf.operatingCashFlow + cf.capitalExpenditure; // capex is negative
    }
    if (fcf != null && isFinite(fcf)) {
      // Always overwrite when FMP provides — this is the most accurate source
      i.fcf = fcf;
      touched = true;
    }
  }

  if (touched) {
    renderInputs();
    recalculate();
    flashStatus('Auto-filled assumptions from FMP', 'success');
  }
}

// --- HEAT: Heat map of your stockbook grouped by sector ---
// Each sector is a row. Tickers in that sector are tiles colored by 1-day % change.
// Inspired by Bloomberg IMAP and Finviz heatmap.
async function fnHEAT() {
  openFnOverlay('HEAT', '');

  // Make sure stockbook is loaded
  if ((state.stockbook?.rows?.length ?? 0) === 0) {
    try { await loadStockBook(false); } catch {}
  }

  const rows = state.stockbook?.rows || [];
  if (rows.length === 0) {
    setFnOverlayBody(`
      <div class="fn-section">
        <h3>No tickers in your Stock Book</h3>
        <p style="color:var(--ink-dim)">Add tickers via the Stock Book tab first.</p>
      </div>
    `);
    return;
  }

  // Pull sheet history (for fallback if changepct not in raw row)
  let sheetHistory = null;
  try {
    const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
    if (cached?.data?.priceHistory) sheetHistory = cached.data.priceHistory;
  } catch {}
  const extCache = loadPriceHistCache();

  // Parse a sheet cell as a fractional percent.
  // GoogleFinance returns changepct as e.g. "1.21" meaning 1.21% (NOT 121%).
  // ALWAYS divide by 100 — sheet stores in percent units.
  function parsePctSheet(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === '—' || s === '-' || s.toUpperCase().startsWith('#')) return null;
    const isNeg = /^\(/.test(s) || /^-/.test(s);
    const cleaned = s.replace(/[%$,\s()+]/g, '').replace(/^-/, '');
    const num = parseFloat(cleaned);
    if (!isFinite(num)) return null;
    const signed = isNeg ? -num : num;
    return signed / 100;
  }

  function pctChangeForRow(r) {
    // 1. Try sheet's changepct column directly (GoogleFinance value)
    const raw = r.rawRow;
    if (raw) {
      const fromSheet = parsePctSheet(raw['changepct']);
      if (fromSheet != null) return fromSheet;
      // Try return day as alternative
      const fromReturn = parsePctSheet(raw['return day']);
      if (fromReturn != null) return fromReturn;
    }
    // 2. Fallback to price history
    if (sheetHistory?.[r.ticker]?.length >= 2) {
      return priceChangeFromHistory(sheetHistory[r.ticker], 1);
    }
    if (extCache[r.ticker]?.data?.length >= 2) {
      return priceChangeFromHistory(extCache[r.ticker].data, 1);
    }
    return null;
  }

  // Filter: exclude derivatives/ETFs (those have their own bucket via the function field),
  // and exclude tiny caps so the map stays focused on relevant equities.
  // Threshold: $10B (mid cap or larger). Tickers without a market cap also excluded.
  const MIN_MCAP_FOR_HEAT = 10e9;
  const filteredRows = rows.filter(r =>
    !r.isDerivative &&
    r.marketCap != null && r.marketCap >= MIN_MCAP_FOR_HEAT
  );

  if (filteredRows.length === 0) {
    setFnOverlayBody(`
      <div class="fn-section">
        <h3>No qualifying tickers</h3>
        <p style="color:var(--ink-dim)">Heat map shows equities with market cap ≥ $2B from your Stock Book. Make sure your sheet has the <strong style="color:var(--amber)">marketcap</strong> column populated.</p>
      </div>
    `);
    return;
  }

  // Group tickers by sector ETF
  const bySector = {};
  for (const r of filteredRows) {
    let etf = r.sector ? sectorNameToETF(r.sector) : null;
    if (!etf && r.subSector) etf = sectorNameToETF(r.subSector);
    if (!etf && r.industry) etf = sectorNameToETF(r.industry);
    if (!etf && HARDCODED_SECTORS[r.ticker]) {
      etf = sectorNameToETF(HARDCODED_SECTORS[r.ticker].sector);
    }
    const key = etf || 'Other';
    if (!bySector[key]) bySector[key] = [];
    bySector[key].push({ ...r, pctChange: pctChangeForRow(r) });
  }

  // Sort each sector by market cap desc (so big tiles come first within sector)
  for (const k of Object.keys(bySector)) {
    bySector[k].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  }

  // Sort sectors by total cap (so largest sector blocks come first)
  const sectorTotalCap = (k) => bySector[k].reduce((s, r) => s + (r.marketCap || 0), 0);

  // Calculate market cap weights for sizing
  function sizeClass(mcap) {
    if (!mcap || !isFinite(mcap)) return 1;
    if (mcap >= 1e12) return 6;
    if (mcap >= 2e11) return 5;
    if (mcap >= 5e10) return 4;
    if (mcap >= 1e10) return 3;
    if (mcap >= 2e9)  return 2;
    return 1;
  }

  // Order sectors: known ETFs in standard order, weighted by total cap, "Other" last
  const sectorOrder = ['XLK', 'XLY', 'XLF', 'XLV', 'XLI', 'XLE', 'XLP', 'XLU', 'XLRE'];
  const orderedKeys = [
    ...sectorOrder.filter(k => bySector[k]),
    ...Object.keys(bySector).filter(k => !sectorOrder.includes(k) && k !== 'Other')
      .sort((a, b) => sectorTotalCap(b) - sectorTotalCap(a)),
    ...(bySector['Other'] ? ['Other'] : []),
  ];

  function tileColor(pct) {
    if (pct == null) return '#1c1a17';
    const clamped = Math.max(-0.05, Math.min(0.05, pct));
    if (clamped > 0) {
      const intensity = Math.min(1, clamped / 0.03);
      const g = Math.floor(60 + intensity * 110);
      return `rgb(20, ${g}, 40)`;
    } else {
      const intensity = Math.min(1, Math.abs(clamped) / 0.03);
      const rr = Math.floor(60 + intensity * 110);
      return `rgb(${rr}, 20, 30)`;
    }
  }

  const sectorLabels = {
    XLK: 'Technology · XLK',
    XLY: 'Consumer Cyclical · XLY',
    XLF: 'Financial Services · XLF',
    XLV: 'Healthcare · XLV',
    XLI: 'Industrials · XLI',
    XLE: 'Energy · XLE',
    XLP: 'Consumer Defensive · XLP',
    XLU: 'Utilities · XLU',
    XLRE: 'Real Estate · XLRE',
    Other: 'Unclassified',
  };

  function sectorAvgPct(tickers) {
    // Market-cap weighted average
    let totalCap = 0; let weightedSum = 0;
    for (const t of tickers) {
      if (t.pctChange == null) continue;
      const w = t.marketCap || 1e9;
      totalCap += w;
      weightedSum += w * t.pctChange;
    }
    return totalCap > 0 ? weightedSum / totalCap : null;
  }

  function fmtMcap(v) {
    if (!v) return '';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return (v / 1e9).toFixed(0) + 'B';
    if (v >= 1e6)  return (v / 1e6).toFixed(0) + 'M';
    return v.toFixed(0);
  }

  const sectorBlocks = orderedKeys.map(key => {
    const tickers = bySector[key];
    const avgPct = sectorAvgPct(tickers);
    const headColor = tileColor(avgPct);
    return `
      <div class="heat-sector">
        <div class="heat-sector-head" style="background:linear-gradient(to right, ${headColor}, transparent 80%)">
          <div class="heat-sector-name">${sectorLabels[key] || key}</div>
          <div class="heat-sector-meta">
            ${tickers.length} ${tickers.length === 1 ? 'ticker' : 'tickers'}
            ${avgPct != null ? ` · cap-weighted <strong style="color:${avgPct > 0 ? '#7fff7f' : '#ff7f7f'}">${avgPct >= 0 ? '+' : ''}${(avgPct * 100).toFixed(2)}%</strong>` : ''}
          </div>
        </div>
        <div class="heat-tile-grid">
          ${tickers.map(t => {
            const sc = sizeClass(t.marketCap);
            const pctText = t.pctChange != null ? (t.pctChange >= 0 ? '+' : '') + (t.pctChange * 100).toFixed(2) + '%' : '—';
            const pctColor = t.pctChange > 0 ? '#7fff7f' : t.pctChange < 0 ? '#ff7f7f' : '#999';
            const priceText = t.price != null ? '$' + t.price.toFixed(2) : '';
            return `
              <div class="heat-tile heat-tile-${sc}" style="background:${tileColor(t.pctChange)}"
                   onclick="executeCommand('${t.ticker}')"
                   title="${escapeHtml(t.name || '')}${t.industry ? ' · ' + escapeHtml(t.industry) : ''} · ${fmtMcap(t.marketCap)}">
                <div class="heat-tic">${t.ticker}</div>
                ${priceText ? `<div class="heat-price-large">${priceText}</div>` : ''}
                <div class="heat-pct" style="color:${pctColor}">${pctText}</div>
                ${sc >= 3 && t.marketCap ? `<div class="heat-mcap">${fmtMcap(t.marketCap)}</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');

  setFnOverlayBody(`
    <div class="fn-section">
      <p style="color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.6;margin-bottom:14px">
        ${filteredRows.length} of ${rows.length} tickers shown · equities ≥ $2B market cap · sized by market cap · color = % change · click any tile to open
      </p>
      ${sectorBlocks}
    </div>
  `);
}

// ============================================================
//   TODAY'S PRICE STRIP — pulls from sheet's intraday columns
//   Uses changepct, change, open, high, low, prev close, volume, tradetime
// ============================================================
function renderTodayStrip(stock) {
  const strip = document.getElementById('today-strip');
  if (!strip) return;
  if (!stock || !stock.ticker) { strip.style.display = 'none'; return; }

  // Try to pull intraday data from the stockbook row (which has the raw sheet row)
  const sbRow = state.stockbook?.rows?.find(r => r.ticker === stock.ticker);
  const raw = sbRow?.rawRow || {};

  // Helper to parse a numeric sheet cell. Returns just the number value.
  function parseNum(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === '—' || s === '-' || s.toUpperCase().startsWith('#')) return null;
    const isNeg = /^\(/.test(s) || /^-/.test(s);
    // Strip $ , whitespace ( ) + and a leading -
    const cleaned = s.replace(/[%$,\s()+]/g, '').replace(/^-/, '');
    const num = parseFloat(cleaned);
    if (!isFinite(num)) return null;
    return isNeg ? -num : num;
  }

  // changepct from GoogleFinance comes back as a number in percent units already
  // (e.g. 1.21 means 1.21%, NOT 121%).  We store as a fraction (0.0121) for display math.
  // Parse a "% change" cell value into a fraction (0.0121 = 1.21%).
  // Master sheet from GoogleFinance stores 'changepct' as a number where
  // 1.21 means 1.21% (not 121%). If a "%" is in the string, we strip and divide.
  // Heuristic safeguards against >100% absurd values.
  function parsePctCell(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s === '—' || s === '-' || s.toUpperCase().startsWith('#')) return null;
    const hasPctSign = s.includes('%');
    const num = parseNum(v);
    if (num == null) return null;
    // ALWAYS divide by 100 — sheet stores percent units (1.21 = 1.21%, 0.5 = 0.5%, -2 = -2%)
    // The only time we DON'T divide is if the value is suspiciously fractional already
    // AND there's no % sign — that suggests it's stored as 0.0121 instead of 1.21.
    // But in practice GoogleFinance NEVER does that, so default is /100.
    return num / 100;
  }

  const last = stock.price ?? parseNum(raw['last price'] || raw['price'] || raw['close']);
  const change = parseNum(raw['change']);
  const changePct = parsePctCell(raw['changepct']);
  const open = parseNum(raw['price open'] || raw['open']);
  const high = parseNum(raw['high']);
  const low = parseNum(raw['low']);
  const prevClose = parseNum(raw['closeyest'] || raw['prev close']);
  const volume = parseNum(raw['volume']);
  const tradetime = (raw['tradetime'] || raw['date'] || '').toString().trim();

  // If we don't have meaningful intraday data, hide the strip
  if (last == null && change == null && open == null) {
    strip.style.display = 'none';
    return;
  }

  strip.style.display = 'block';

  const fmtPrice = (v) => v != null ? '$' + v.toFixed(2) : '—';
  const fmtChange = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2);
  const fmtPct = (v) => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const fmtVol = (v) => {
    if (v == null) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return v.toString();
  };

  document.getElementById('today-last').textContent = fmtPrice(last);
  const elChange = document.getElementById('today-change');
  elChange.textContent = fmtChange(change);
  elChange.className = 'today-value ' + (change > 0 ? 'up' : change < 0 ? 'down' : '');
  const elPct = document.getElementById('today-changepct');
  elPct.textContent = fmtPct(changePct);
  elPct.className = 'today-value ' + (changePct > 0 ? 'up' : changePct < 0 ? 'down' : '');
  document.getElementById('today-open').textContent = fmtPrice(open);
  document.getElementById('today-high').textContent = fmtPrice(high);
  document.getElementById('today-low').textContent = fmtPrice(low);
  document.getElementById('today-prevclose').textContent = fmtPrice(prevClose);
  document.getElementById('today-volume').textContent = fmtVol(volume);
  document.getElementById('today-tradetime').textContent = tradetime || '—';
}

// ============================================================
//   ROLLING TICKER TAPE — sticky at top, all stockbook tickers
//   Refreshes when stockbook changes. Sort modes rotate every minute.
// ============================================================
const TICKER_TAPE_SORTS = [
  { key: 'mcap_desc',    label: 'BY MARKET CAP', fn: (a, b) => (b.marketCap || 0) - (a.marketCap || 0) },
  { key: 'gainers',      label: 'TOP GAINERS',   fn: (a, b) => (b.changePct || 0) - (a.changePct || 0) },
  { key: 'losers',       label: 'TOP LOSERS',    fn: (a, b) => (a.changePct || 0) - (b.changePct || 0) },
  { key: 'volume_desc',  label: 'MOST ACTIVE',   fn: (a, b) => (b.volume || 0) - (a.volume || 0) },
  { key: 'sector',       label: 'BY SECTOR',     fn: (a, b) => (a.sector || 'zzz').localeCompare(b.sector || 'zzz') || (b.marketCap || 0) - (a.marketCap || 0) },
  { key: 'random',       label: 'SHUFFLED',      fn: () => Math.random() - 0.5 },
];
let _tickerTapeSortIdx = 0;
let _tickerTapeRotateTimer = null;

function renderTickerTape() {
  const tape = document.getElementById('ticker-tape');
  const track = document.getElementById('ticker-tape-track');
  if (!tape || !track) return;

  const rows = state.stockbook?.rows || [];
  if (rows.length === 0) { tape.style.display = 'none'; return; }

  // Compute change% from price history for each ticker
  const sheetHistory = (() => {
    try {
      const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
      return cached?.data?.priceHistory || null;
    } catch { return null; }
  })();
  const extCache = loadPriceHistCache();
  const priceChange = (tic) => {
    if (sheetHistory?.[tic]?.length >= 2) return priceChangeFromHistory(sheetHistory[tic], 1);
    if (extCache[tic]?.data?.length >= 2) return priceChangeFromHistory(extCache[tic].data, 1);
    return null;
  };

  // Augment rows with computed changePct
  const augmented = rows.map(r => ({ ...r, changePct: priceChange(r.ticker) }));

  // Apply current sort
  const sort = TICKER_TAPE_SORTS[_tickerTapeSortIdx];
  const sorted = [...augmented].sort(sort.fn);

  // Limit to top 60 to keep DOM manageable
  const display = sorted.slice(0, 60);

  // Build items HTML
  const sortLabel = `<span class="ticker-tape-sort">${sort.label} ›</span>`;
  const itemsHtml = display.map(r => {
    const pct = r.changePct;
    const pctClass = pct == null ? 'flat' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const pctText = pct == null ? '' : (pct >= 0 ? '+' : '') + (pct * 100).toFixed(2) + '%';
    const arrow = pct == null ? '' : pct > 0 ? '▲ ' : pct < 0 ? '▼ ' : '';
    const priceText = r.price != null ? '$' + r.price.toFixed(2) : '—';
    return `
      <span class="ticker-tape-item" onclick="executeCommand('${r.ticker}')">
        <span class="ticker-tape-tic">${r.ticker}</span>
        <span class="ticker-tape-price">${priceText}</span>
        <span class="ticker-tape-pct ${pctClass}">${arrow}${pctText}</span>
      </span>
    `;
  }).join('');

  // Duplicate the content twice so the scroll is seamless
  track.innerHTML = sortLabel + itemsHtml + sortLabel + itemsHtml;
  tape.style.display = 'block';
}

// Rotate the sort mode every 90 seconds (so user sees different views over time)
function startTickerTapeRotation() {
  if (_tickerTapeRotateTimer) return;
  _tickerTapeRotateTimer = setInterval(() => {
    _tickerTapeSortIdx = (_tickerTapeSortIdx + 1) % TICKER_TAPE_SORTS.length;
    renderTickerTape();
  }, 90000);
}

// Show ticker tape once stockbook loads (called from loadStockBook)
function maybeShowTickerTape() {
  if ((state.stockbook?.rows?.length ?? 0) > 0) {
    renderTickerTape();
    startTickerTapeRotation();
  }
}

// ============================================================
//   AI-STYLE PREDICTION ENGINE
//   Multi-feature gradient model: combines technical, momentum, mean-reversion,
//   trend-strength, volatility regime, and fundamental signals into a calibrated
//   probability estimate. This is NOT a true neural net — it's a hand-tuned
//   logistic model with feature engineering inspired by financial ML literature.
// ============================================================

// Feature: technical momentum across multiple timeframes
// Returns a score 0-1 where 1 = strong upward momentum
function featureMomentum(history, currentPrice) {
  if (!history || history.length < 60) return null;
  const last = history[history.length - 1].price;
  // Look-back periods (trading days)
  const periods = [5, 20, 60, 120];
  const scores = [];
  for (const p of periods) {
    if (history.length < p + 1) continue;
    const past = history[history.length - 1 - p].price;
    if (past <= 0) continue;
    const ret = (last / past) - 1;
    // Convert return to a 0-1 score using sigmoid
    scores.push(1 / (1 + Math.exp(-10 * ret)));
  }
  if (scores.length === 0) return null;
  // Equal-weighted combo
  return scores.reduce((s, x) => s + x, 0) / scores.length;
}

// Feature: mean reversion potential (z-score relative to 60d mean)
// Returns probability that price will revert toward mean within horizon
function featureMeanReversion(history, currentPrice, strike, direction, daysAhead) {
  if (!history || history.length < 60) return null;
  const recent = history.slice(-60).map(h => h.price);
  const mean = recent.reduce((s, x) => s + x, 0) / recent.length;
  const variance = recent.reduce((s, x) => s + (x - mean) ** 2, 0) / recent.length;
  const std = Math.sqrt(variance);
  if (std === 0) return null;
  const z = (currentPrice - mean) / std;
  // Strong negative z (price oversold) → bullish signal for "above" theses
  // Strong positive z (overbought) → bearish signal for "above" theses
  // Use a calibrated tanh-based mapping
  const reversionScore = -Math.tanh(z / 2); // -1 to +1, +1 = bullish reversion
  // Convert to probability for the direction
  const p = 0.5 + 0.25 * reversionScore;
  return direction === 'above' ? p : 1 - p;
}

// Feature: trend strength via R² of linear fit over last N days
function featureTrendStrength(history) {
  if (!history || history.length < 30) return null;
  const recent = history.slice(-30);
  const n = recent.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  recent.forEach((h, i) => {
    sumX += i;
    sumY += h.price;
    sumXY += i * h.price;
    sumX2 += i * i;
    sumY2 += h.price * h.price;
  });
  const meanX = sumX / n;
  const meanY = sumY / n;
  const slope = (sumXY - n * meanX * meanY) / (sumX2 - n * meanX * meanX);
  const r2num = (sumXY - n * meanX * meanY) ** 2;
  const r2den = (sumX2 - n * meanX * meanX) * (sumY2 - n * meanY * meanY);
  if (r2den === 0) return null;
  const r2 = r2num / r2den;
  // Sign of slope tells direction; magnitude of r2 tells confidence
  return { slope, r2, slopePerDayPct: slope / meanY };
}

// Feature: volatility regime — ratio of recent vol to long-term vol
// >1 means expanding vol (riskier), <1 means contracting (calmer)
function featureVolRegime(history) {
  if (!history || history.length < 60) return null;
  const returns = [];
  for (let i = 1; i < history.length; i++) {
    if (history[i - 1].price > 0) {
      returns.push(Math.log(history[i].price / history[i - 1].price));
    }
  }
  if (returns.length < 60) return null;
  const recent = returns.slice(-20);
  const long = returns.slice(-60);
  const stdRecent = Math.sqrt(recent.reduce((s, x) => s + x * x, 0) / recent.length);
  const stdLong = Math.sqrt(long.reduce((s, x) => s + x * x, 0) / long.length);
  if (stdLong === 0) return null;
  return stdRecent / stdLong;
}

// Master AI inference function — combines all features into a single probability.
// This replaces the simple "historical" channel with a richer model.
async function probAIInference(thesis, sbRow) {
  const ticker = thesis.ticker.toUpperCase();
  const history = await getPriceHistory(ticker).catch(() => null);
  if (!history || history.length < 30) {
    return { p: null, error: 'Need 30+ days of price history for AI inference' };
  }

  const currentPrice = history[history.length - 1].price;
  const strike = thesis.strike;
  const direction = thesis.direction;
  const daysAhead = thesis.days;

  // === FEATURE EXTRACTION ===
  const features = {};

  // 1. Log-normal baseline (the original historical signal)
  const baseline = probHistorical(history, currentPrice, strike, direction, daysAhead);
  features.baseline = baseline?.p ?? 0.5;

  // 2. Momentum
  const momentum = featureMomentum(history, currentPrice);
  features.momentum = momentum;

  // 3. Mean reversion
  const reversion = featureMeanReversion(history, currentPrice, strike, direction, daysAhead);
  features.reversion = reversion;

  // 4. Trend strength
  const trend = featureTrendStrength(history);
  features.trendDirection = trend ? Math.tanh(trend.slopePerDayPct * 50) : 0; // -1 to +1
  features.trendConfidence = trend ? trend.r2 : 0; // 0 to 1

  // 5. Volatility regime
  const volRegime = featureVolRegime(history);
  features.volRegime = volRegime;

  // 6. Distance to strike (in %)
  const pctToStrike = (strike - currentPrice) / currentPrice;
  features.pctToStrike = pctToStrike;

  // 7. Fundamental: P/E percentile if available
  if (sbRow?.pe) {
    // Cheap P/E is bullish for "above" theses; expensive is bearish
    const peScore = 1 / (1 + Math.exp((sbRow.pe - 25) / 10)); // 0 (expensive) to 1 (cheap)
    features.fundamental = direction === 'above' ? peScore : 1 - peScore;
  }

  // === FEATURE COMBINATION via logistic regression ===
  // Weights are hand-tuned; in a real ML model these would be learned from data.
  // Each weight reflects the empirical importance of that feature.

  // Start with baseline log-odds
  const logit = (p) => Math.log(Math.max(0.001, Math.min(0.999, p)) / (1 - Math.max(0.001, Math.min(0.999, p))));
  const invLogit = (x) => 1 / (1 + Math.exp(-x));

  let score = logit(features.baseline);

  // Momentum adjustment — strong upmomentum boosts above-theses, dampens below
  if (features.momentum != null) {
    const momAdjust = (features.momentum - 0.5) * 1.5;
    score += direction === 'above' ? momAdjust : -momAdjust;
  }

  // Mean reversion adjustment — only weight if mean reversion strongly disagrees with momentum
  if (features.reversion != null) {
    score += (logit(features.reversion) - 0) * 0.5; // 50% weight
  }

  // Trend adjustment, weighted by R²
  if (features.trendDirection !== 0 && features.trendConfidence > 0.3) {
    const trendAdjust = features.trendDirection * features.trendConfidence * 1.0;
    score += direction === 'above' ? trendAdjust : -trendAdjust;
  }

  // Volatility regime: expanding vol increases uncertainty (pull toward 0.5)
  if (features.volRegime != null && features.volRegime > 1.3) {
    score *= 0.8; // shrink toward 0
  }

  // Fundamental adjustment
  if (features.fundamental != null) {
    score += (logit(features.fundamental) - 0) * 0.3; // small weight
  }

  // Calibration: sigmoid back to probability
  const p = invLogit(score);

  return {
    p,
    features,
    interpretation: interpretAIFeatures(features, direction),
  };
}

function interpretAIFeatures(f, direction) {
  const tags = [];
  if (f.momentum != null) {
    if (f.momentum > 0.7) tags.push(direction === 'above' ? 'strong momentum favors thesis' : 'strong momentum against thesis');
    else if (f.momentum < 0.3) tags.push(direction === 'above' ? 'weak momentum opposes thesis' : 'weak momentum supports thesis');
  }
  if (f.reversion != null) {
    if (Math.abs(f.reversion - 0.5) > 0.15) {
      tags.push(f.reversion > 0.5 ? 'oversold (mean reversion)' : 'overbought (mean reversion)');
    }
  }
  if (f.trendConfidence > 0.5) {
    tags.push(f.trendDirection > 0 ? 'strong uptrend' : 'strong downtrend');
  }
  if (f.volRegime != null) {
    if (f.volRegime > 1.5) tags.push('expanding volatility');
    else if (f.volRegime < 0.7) tags.push('contracting volatility');
  }
  if (f.fundamental != null && Math.abs(f.fundamental - 0.5) > 0.15) {
    tags.push(f.fundamental > 0.5 ? 'attractive valuation' : 'expensive valuation');
  }
  return tags.join(' · ') || 'mixed signals';
}

// ============================================================
//   MANUAL OVERRIDES — sector, sub-sector, industry, status
//   Saved per ticker in localStorage; applied as final layer over sheet+API+enrichment.
// ============================================================
const OVERRIDES_STORAGE = 'valuatio.overrides.v1';

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_STORAGE) || '{}'); }
  catch { return {}; }
}
function saveOverrides(o) {
  localStorage.setItem(OVERRIDES_STORAGE, JSON.stringify(o));
}
function setOverride(ticker, field, value) {
  const all = loadOverrides();
  if (!all[ticker]) all[ticker] = {};
  if (value == null || value === '') delete all[ticker][field];
  else all[ticker][field] = value;
  if (Object.keys(all[ticker]).length === 0) delete all[ticker];
  saveOverrides(all);
}
function getOverride(ticker, field) {
  const all = loadOverrides();
  return all[ticker]?.[field] ?? null;
}
function clearOverrides(ticker) {
  const all = loadOverrides();
  delete all[ticker];
  saveOverrides(all);
}

// Apply overrides to a stockbook row in-place. Returns true if anything changed.
function applyOverridesToRow(row) {
  const ovr = loadOverrides()[row.ticker];
  if (!ovr) return false;
  let changed = false;
  for (const field of ['sector', 'subSector', 'industry', 'status', 'function']) {
    if (ovr[field] != null && ovr[field] !== row[field]) {
      row[field] = ovr[field];
      changed = true;
    }
  }
  if (changed) {
    row.source = (row.source || 'sheet').includes('override') ? row.source : (row.source + '+override');
  }
  return changed;
}

// Collect all unique sectors/sub-sectors/industries seen across the stockbook
// for use in the override dropdowns.
function collectTaxonomyValues() {
  const sectors = new Set();
  const subSectors = new Set();
  const industries = new Set();
  for (const r of (state.stockbook?.rows || [])) {
    if (r.sector) sectors.add(r.sector);
    if (r.subSector) subSectors.add(r.subSector);
    if (r.industry) industries.add(r.industry);
  }
  return {
    sectors: Array.from(sectors).sort(),
    subSectors: Array.from(subSectors).sort(),
    industries: Array.from(industries).sort(),
  };
}

const STATUS_OPTIONS = ['', 'Trading', 'Watching', 'Tracking', 'Avoid', 'ETF', 'Leveraged'];

// ============================================================
//   OVERRIDE MODAL — edit sector/sub-sector/industry/status per ticker
// ============================================================
function openOverrideModal(ticker) {
  const row = state.stockbook?.rows?.find(r => r.ticker === ticker);
  if (!row) { alert('Ticker not in stock book'); return; }

  const tax = collectTaxonomyValues();
  const ovr = loadOverrides()[ticker] || {};

  // Build datalist options for typeahead
  const sectorOptions = Array.from(new Set([...tax.sectors, 'Technology', 'Consumer Cyclical', 'Consumer Defensive', 'Financial Services', 'Healthcare', 'Industrials', 'Energy', 'Utilities', 'Real Estate', 'Communication Services', 'Basic Materials', 'ETF', 'S&P 500'])).sort();
  const sectorOptsHtml = sectorOptions.map(s => `<option value="${escapeHtml(s)}">`).join('');
  const subOptsHtml = tax.subSectors.map(s => `<option value="${escapeHtml(s)}">`).join('');
  const indOptsHtml = tax.industries.map(s => `<option value="${escapeHtml(s)}">`).join('');
  const statusOpts = STATUS_OPTIONS.map(s => `<option value="${escapeHtml(s)}" ${(ovr.status || row.status || '') === s ? 'selected' : ''}>${escapeHtml(s || '— none —')}</option>`).join('');

  const html = `
    <div class="modal-backdrop" id="ovr-modal" style="display:flex">
      <div class="modal-box" style="max-width:560px">
        <div class="modal-head">
          <div class="modal-title">Override · ${ticker}</div>
          <button class="modal-close" onclick="document.getElementById('ovr-modal').remove()">×</button>
        </div>
        <div class="modal-section">
          <div class="modal-help" style="margin-bottom:14px">
            Manual edits save to local storage and override the sheet. Leave blank to clear.
            ${row.name ? `<br><strong style="color:var(--ink)">${escapeHtml(row.name)}</strong>` : ''}
          </div>
          <div class="modal-label">Sector</div>
          <input type="text" class="modal-input" id="ovr-sector" list="ovr-sector-list"
                 value="${escapeHtml(ovr.sector || row.sector || '')}" placeholder="e.g. Technology">
          <datalist id="ovr-sector-list">${sectorOptsHtml}</datalist>
        </div>
        <div class="modal-section">
          <div class="modal-label">Sub-Sector</div>
          <input type="text" class="modal-input" id="ovr-sub" list="ovr-sub-list"
                 value="${escapeHtml(ovr.subSector || row.subSector || '')}" placeholder="e.g. Software—Application">
          <datalist id="ovr-sub-list">${subOptsHtml}</datalist>
        </div>
        <div class="modal-section">
          <div class="modal-label">Industry</div>
          <input type="text" class="modal-input" id="ovr-industry" list="ovr-ind-list"
                 value="${escapeHtml(ovr.industry || row.industry || '')}" placeholder="e.g. Semiconductors">
          <datalist id="ovr-ind-list">${indOptsHtml}</datalist>
        </div>
        <div class="modal-section">
          <div class="modal-label">Status</div>
          <select class="modal-input" id="ovr-status">${statusOpts}</select>
        </div>
        <div class="modal-section" style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--rule);padding-top:14px">
          <button class="btn btn-ghost" id="ovr-clear">Clear All Overrides</button>
          <button class="btn btn-ghost" onclick="document.getElementById('ovr-modal').remove()">Cancel</button>
          <button class="btn" id="ovr-save">Save</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  document.getElementById('ovr-save').addEventListener('click', () => {
    const sector    = document.getElementById('ovr-sector').value.trim();
    const subSector = document.getElementById('ovr-sub').value.trim();
    const industry  = document.getElementById('ovr-industry').value.trim();
    const status    = document.getElementById('ovr-status').value;

    setOverride(ticker, 'sector',    sector ? normalizeSectorName(sector) : null);
    setOverride(ticker, 'subSector', subSector ? normalizeSectorName(subSector) : null);
    setOverride(ticker, 'industry',  industry ? normalizeSectorName(industry) : null);
    setOverride(ticker, 'status',    status || null);

    document.getElementById('ovr-modal').remove();
    // Re-apply overrides to the in-memory row and re-render
    applyOverridesToRow(row);
    renderStockBook();
    flashStatus('Override saved · ' + ticker, 'success');
  });

  document.getElementById('ovr-clear').addEventListener('click', () => {
    if (!confirm('Clear all overrides for ' + ticker + '?')) return;
    clearOverrides(ticker);
    document.getElementById('ovr-modal').remove();
    // Reload from sheet to drop overrides
    loadStockBook(false);
    flashStatus('Overrides cleared · ' + ticker, 'success');
  });
}

// ============================================================
//   ETF HOLDINGS VIEWER — what does this ETF hold?
// ============================================================
// Curated top-10 holdings for popular ETFs as of late 2025 — used as fallback
// when FMP key isn't set or returns empty. Approximate weights — refresh manually.
const CURATED_ETF_HOLDINGS = {
  'SPY': [
    { asset: 'NVDA', name: 'NVIDIA Corp',           weight: 7.2 },
    { asset: 'MSFT', name: 'Microsoft Corp',        weight: 6.5 },
    { asset: 'AAPL', name: 'Apple Inc',             weight: 6.4 },
    { asset: 'AMZN', name: 'Amazon.com Inc',        weight: 3.8 },
    { asset: 'META', name: 'Meta Platforms Inc',    weight: 2.6 },
    { asset: 'GOOGL', name: 'Alphabet Class A',     weight: 2.2 },
    { asset: 'AVGO', name: 'Broadcom Inc',          weight: 2.1 },
    { asset: 'GOOG', name: 'Alphabet Class C',      weight: 1.9 },
    { asset: 'TSLA', name: 'Tesla Inc',             weight: 1.8 },
    { asset: 'BRK.B', name: 'Berkshire Hathaway B', weight: 1.6 },
  ],
  'QQQ': [
    { asset: 'NVDA', name: 'NVIDIA Corp',         weight: 8.9 },
    { asset: 'MSFT', name: 'Microsoft Corp',      weight: 8.4 },
    { asset: 'AAPL', name: 'Apple Inc',           weight: 8.3 },
    { asset: 'AMZN', name: 'Amazon.com Inc',      weight: 5.4 },
    { asset: 'AVGO', name: 'Broadcom Inc',        weight: 4.8 },
    { asset: 'META', name: 'Meta Platforms Inc',  weight: 4.0 },
    { asset: 'TSLA', name: 'Tesla Inc',           weight: 3.0 },
    { asset: 'GOOGL', name: 'Alphabet Class A',   weight: 2.7 },
    { asset: 'GOOG', name: 'Alphabet Class C',    weight: 2.7 },
    { asset: 'COST', name: 'Costco Wholesale',    weight: 2.5 },
  ],
  'XRT': [
    { asset: 'CHWY', name: 'Chewy Inc',                weight: 1.4 },
    { asset: 'GME',  name: 'GameStop Corp',            weight: 1.3 },
    { asset: 'CVNA', name: 'Carvana Co',               weight: 1.3 },
    { asset: 'AMZN', name: 'Amazon.com Inc',           weight: 1.3 },
    { asset: 'WMT',  name: 'Walmart Inc',              weight: 1.3 },
    { asset: 'COST', name: 'Costco Wholesale',         weight: 1.3 },
    { asset: 'TGT',  name: 'Target Corp',              weight: 1.2 },
    { asset: 'BBY',  name: 'Best Buy Co',              weight: 1.2 },
    { asset: 'ROST', name: 'Ross Stores',              weight: 1.2 },
    { asset: 'CRI',  name: 'Carter\'s Inc',            weight: 1.2 },
  ],
  'XLK': [
    { asset: 'NVDA', name: 'NVIDIA Corp',     weight: 19.0 },
    { asset: 'MSFT', name: 'Microsoft Corp',  weight: 17.5 },
    { asset: 'AAPL', name: 'Apple Inc',       weight: 14.5 },
    { asset: 'AVGO', name: 'Broadcom Inc',    weight: 5.6 },
    { asset: 'CRM',  name: 'Salesforce Inc',  weight: 2.3 },
    { asset: 'ORCL', name: 'Oracle Corp',     weight: 2.2 },
    { asset: 'AMD',  name: 'Advanced Micro',  weight: 1.9 },
    { asset: 'CSCO', name: 'Cisco Systems',   weight: 1.7 },
    { asset: 'IBM',  name: 'IBM Corp',        weight: 1.6 },
    { asset: 'INTU', name: 'Intuit Inc',      weight: 1.5 },
  ],
  'TLT': [
    { asset: 'US Treasury 4.625% 2052', name: 'US Treasury Bond',  weight: 9.5 },
    { asset: 'US Treasury 4.5% 2054',   name: 'US Treasury Bond',  weight: 7.8 },
    { asset: 'US Treasury 4.625% 2053', name: 'US Treasury Bond',  weight: 6.2 },
    { asset: 'US Treasury 4.75% 2053',  name: 'US Treasury Bond',  weight: 5.8 },
    { asset: 'US Treasury 4.25% 2054',  name: 'US Treasury Bond',  weight: 5.5 },
  ],
};

async function showEtfHoldings(ticker) {
  // Show modal immediately with loading state
  const html = `
    <div class="modal-backdrop" id="holdings-modal" style="display:flex">
      <div class="modal-box" style="max-width:760px;max-height:85vh;overflow-y:auto">
        <div class="modal-head">
          <div class="modal-title">${ticker} — Holdings</div>
          <button class="modal-close" onclick="document.getElementById('holdings-modal').remove()">×</button>
        </div>
        <div class="modal-section" id="holdings-content">
          <div style="text-align:center;padding:40px;color:var(--ink-dim);font-family:var(--mono);font-size:12px">
            Loading holdings…
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  let holdings = null;
  let source = '';

  // Try FMP first if key is set
  if (getFmpKey()) {
    try {
      holdings = await fetchEtfHoldings(ticker);
      if (holdings && holdings.length > 0) source = 'FMP (live)';
    } catch {}
  }

  // Fall back to curated list
  if ((!holdings || holdings.length === 0) && CURATED_ETF_HOLDINGS[ticker]) {
    holdings = CURATED_ETF_HOLDINGS[ticker];
    source = 'Curated · approximate · top 10';
  }

  const content = document.getElementById('holdings-content');
  if (!content) return;

  if (!holdings || holdings.length === 0) {
    content.innerHTML = `
      <div style="text-align:center;padding:40px">
        <div style="color:var(--amber);font-family:var(--mono);font-size:13px;margin-bottom:14px">No holdings data available for ${ticker}</div>
        <div style="color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.7;max-width:420px;margin:0 auto">
          ${getFmpKey() ? 'FMP returned no data — this ticker may not be an ETF.' : 'Add an <strong style="color:var(--amber)">FMP API key</strong> in Data Sources for live holdings on any ETF.'}
          <br><br>Curated holdings available for: ${Object.keys(CURATED_ETF_HOLDINGS).join(', ')}
        </div>
      </div>
    `;
    return;
  }

  // Show top 50
  const top = holdings.slice(0, 50);
  const totalWeight = holdings.reduce((s, h) => s + (h.weight || 0), 0);
  const fmtWeight = w => w == null ? '—' : w.toFixed(2) + '%';
  const fmtShares = s => s == null ? '—' : s >= 1e6 ? (s/1e6).toFixed(2) + 'M' : s >= 1e3 ? (s/1e3).toFixed(0) + 'K' : s.toFixed(0);
  const fmtMV = v => v == null ? '—' : v >= 1e9 ? '$' + (v/1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : '$' + v.toFixed(0);

  content.innerHTML = `
    <div style="margin-bottom:14px;font-family:var(--mono);font-size:11px;color:var(--ink-dim);line-height:1.6">
      <strong style="color:var(--ink)">${holdings.length} holdings</strong>
      ${totalWeight > 0 ? ` · total weight ${totalWeight.toFixed(1)}%` : ''}
      · ${source}
    </div>
    <table class="financials-table" style="font-size:11px">
      <thead>
        <tr>
          <th>#</th><th>Ticker</th><th>Name</th><th>Weight</th>
          ${top[0].sharesNumber != null ? '<th>Shares</th>' : ''}
          ${top[0].marketValue != null ? '<th>Market Value</th>' : ''}
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${top.map((h, i) => `
          <tr>
            <td>${i + 1}</td>
            <td style="color:var(--amber);font-weight:700">${escapeHtml(h.asset || '')}</td>
            <td>${escapeHtml(h.name || '—')}</td>
            <td>${fmtWeight(h.weight)}</td>
            ${top[0].sharesNumber != null ? `<td>${fmtShares(h.sharesNumber)}</td>` : ''}
            ${top[0].marketValue != null ? `<td>${fmtMV(h.marketValue)}</td>` : ''}
            <td><button class="sb-icon-btn" onclick="document.getElementById('holdings-modal').remove(); executeCommand('${h.asset}')">Open</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${holdings.length > 50 ? `<div style="margin-top:14px;font-family:var(--mono);font-size:10px;color:var(--ink-faint)">…and ${holdings.length - 50} more</div>` : ''}
  `;
}

// ============================================================
//   RISK CALCULATOR — Holy Grail of Investing
//   Plots portfolio risk vs. number of bets at varying correlations.
//   Includes a custom portfolio builder for 1-30 user-defined legs.
// ============================================================

const RISK_STORAGE = 'valuatio.risk.portfolio.v1';

state.risk = {
  legs: [],           // [{name, expectedReturn, volatility, weight, avgCorr}]
  globalVol: 0.15,    // 15% — Dalio's typical bet vol
  globalReturn: 0.10, // 10% — typical bet return
  riskFreeRate: 0.04, // 4%
  compCorr: 0.60,     // comparison curve uses 60% (typical equity correlation)
};

function loadRiskPortfolio() {
  try {
    const raw = JSON.parse(localStorage.getItem(RISK_STORAGE) || 'null');
    if (raw && Array.isArray(raw.legs)) state.risk.legs = raw.legs;
  } catch {}
}
function saveRiskPortfolio() {
  try {
    localStorage.setItem(RISK_STORAGE, JSON.stringify({ legs: state.risk.legs }));
  } catch {}
}

// ============================================================
//   PORTFOLIO MATH
// ============================================================

// ============================================================
//   CORRELATION ENGINE — computes pairwise correlation from price history
//   using daily log returns. Works on any tickers with ≥60 overlapping bars.
// ============================================================

// Computes daily log returns from a {date, price} history series.
// Returns Map<date, logReturn>.
function dailyLogReturns(history) {
  const map = new Map();
  if (!history || history.length < 2) return map;
  for (let i = 1; i < history.length; i++) {
    const p0 = history[i - 1].price;
    const p1 = history[i].price;
    if (p0 > 0 && p1 > 0) {
      map.set(history[i].date, Math.log(p1 / p0));
    }
  }
  return map;
}

// Pearson correlation between two series of overlapping log returns.
// Returns {rho, n, stdA, stdB} or null if too few overlapping points.
function pairwiseCorrelation(historyA, historyB, minOverlap = 60) {
  const retA = dailyLogReturns(historyA);
  const retB = dailyLogReturns(historyB);
  // Find overlapping dates
  const pairs = [];
  for (const [date, rA] of retA) {
    const rB = retB.get(date);
    if (rB != null) pairs.push([rA, rB]);
  }
  if (pairs.length < minOverlap) return null;
  const n = pairs.length;
  const meanA = pairs.reduce((s, p) => s + p[0], 0) / n;
  const meanB = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sumNum = 0, sumA2 = 0, sumB2 = 0;
  for (const [a, b] of pairs) {
    const da = a - meanA, db = b - meanB;
    sumNum += da * db;
    sumA2 += da * da;
    sumB2 += db * db;
  }
  if (sumA2 === 0 || sumB2 === 0) return null;
  const rho = sumNum / Math.sqrt(sumA2 * sumB2);
  // Annualize std (252 trading days)
  const stdA = Math.sqrt(sumA2 / (n - 1)) * Math.sqrt(252);
  const stdB = Math.sqrt(sumB2 / (n - 1)) * Math.sqrt(252);
  return { rho, n, stdA, stdB };
}

// Annualized volatility from history alone
function annualizedVol(history, lookbackDays = 252) {
  const ret = dailyLogReturns(history);
  const arr = Array.from(ret.values());
  if (arr.length < 30) return null;
  const recent = arr.slice(-lookbackDays);
  const n = recent.length;
  const mean = recent.reduce((s, x) => s + x, 0) / n;
  const variance = recent.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

// Average annualized return from history (last N days)
function annualizedReturn(history, lookbackDays = 252) {
  const ret = dailyLogReturns(history);
  const arr = Array.from(ret.values());
  if (arr.length < 30) return null;
  const recent = arr.slice(-lookbackDays);
  const sumLogRet = recent.reduce((s, x) => s + x, 0);
  const days = recent.length;
  return Math.exp(sumLogRet * 252 / days) - 1;
}

// Get history for a ticker from any available source (sheet / cache).
function getHistoryForTicker(ticker) {
  let sheetHistory = null;
  try {
    const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
    sheetHistory = cached?.data?.priceHistory;
  } catch {}
  if (sheetHistory?.[ticker]?.length >= 30) return sheetHistory[ticker];
  // Fall back to external cache
  const ext = loadPriceHistCache()[ticker];
  if (ext?.data?.length >= 30) return ext.data;
  return null;
}

// Compute the FULL correlation matrix for a list of tickers.
// Returns { matrix: [[1, rho_AB, rho_AC], [rho_BA, 1, rho_BC], ...], avgRho, missingPairs }
function computeCorrelationMatrix(tickers) {
  const n = tickers.length;
  const histories = tickers.map(t => getHistoryForTicker(t));
  const matrix = Array.from({ length: n }, () => Array(n).fill(null));
  let totalPairs = 0;
  let missingPairs = 0;
  let sumRho = 0;

  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      totalPairs++;
      if (!histories[i] || !histories[j]) {
        missingPairs++;
        continue;
      }
      const result = pairwiseCorrelation(histories[i], histories[j]);
      if (!result) { missingPairs++; continue; }
      matrix[i][j] = matrix[j][i] = result.rho;
      sumRho += result.rho;
    }
  }
  const validPairs = totalPairs - missingPairs;
  const avgRho = validPairs > 0 ? sumRho / validPairs : null;
  return { matrix, avgRho, totalPairs, missingPairs };
}

// Equal-volatility, equal-correlation portfolio variance (closed form).
// σ_p² = σ²/N · (1 + (N-1)·ρ)
// This is the canonical Dalio "Holy Grail" formula assuming each bet
// has the same volatility and pairwise correlation.
function portfolioVolEqual(N, sigma, rho) {
  if (N <= 0) return 0;
  if (N === 1) return sigma;
  const variance = (sigma * sigma / N) * (1 + (N - 1) * rho);
  return Math.sqrt(Math.max(0, variance));
}

// Full covariance-matrix portfolio variance using a SUPPLIED correlation matrix
// (replaces the avgCorr midpoint hack when we have real pairwise corr).
function portfolioVolFromMatrix(legs, corrMatrix) {
  if (legs.length === 0) return 0;
  const n = legs.length;
  const totalW = legs.reduce((s, l) => s + (l.weight || 0), 0);
  const w = totalW > 0
    ? legs.map(l => (l.weight || 0) / totalW)
    : legs.map(() => 1 / n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const si = legs[i].volatility / 100;
      const sj = legs[j].volatility / 100;
      let rho;
      if (i === j) rho = 1;
      else if (corrMatrix && corrMatrix[i] && corrMatrix[i][j] != null) rho = corrMatrix[i][j];
      else {
        // Fallback to user-supplied avgCorr midpoint
        const ri = (legs[i].avgCorr ?? 30) / 100;
        const rj = (legs[j].avgCorr ?? 30) / 100;
        rho = (ri + rj) / 2;
      }
      v += w[i] * w[j] * si * sj * rho;
    }
  }
  return Math.sqrt(Math.max(0, v));
}

// Full covariance-matrix portfolio variance for custom legs.
// σ_p² = Σᵢ Σⱼ wᵢ wⱼ σᵢ σⱼ ρᵢⱼ
// We approximate the full corr matrix using each leg's "avg corr w/ others".
// Mid-point trick: ρᵢⱼ ≈ (avgCorr_i + avgCorr_j) / 2.
// Extract ticker symbol from leg name. Leg names are formatted like
// "GME · GameStop Corp" or "AAPL — Apple Inc" or just "Trend Following" (no ticker).
function extractTickerFromLeg(leg) {
  if (!leg.name) return null;
  // Look for a 1-5 letter all-caps ticker at the start
  const m = String(leg.name).match(/^([A-Z][A-Z0-9.\-]{0,5})\b/);
  if (!m) return null;
  // Avoid false positives like "ETF" or "USD" — must be in stockbook to count
  const sb = state.stockbook?.rows?.find(r => r.ticker === m[1]);
  return sb ? m[1] : null;
}

// Compute pairwise correlation matrix from leg tickers (where available).
// For non-ticker legs, falls back to user's avgCorr setting.
// Returns matrix with measured correlations where computable, null otherwise.
function correlationMatrixForLegs(legs) {
  const n = legs.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(null));
  let measuredCount = 0;
  let estimatedCount = 0;
  let pairCount = 0;
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    const ticI = extractTickerFromLeg(legs[i]);
    const histI = ticI ? getHistoryForTicker(ticI) : null;
    for (let j = i + 1; j < n; j++) {
      pairCount++;
      const ticJ = extractTickerFromLeg(legs[j]);
      const histJ = ticJ ? getHistoryForTicker(ticJ) : null;
      if (histI && histJ) {
        const result = pairwiseCorrelation(histI, histJ);
        if (result) {
          matrix[i][j] = matrix[j][i] = result.rho;
          measuredCount++;
          continue;
        }
      }
      // Fall back to user's avgCorr midpoint
      const ri = (legs[i].avgCorr ?? 30) / 100;
      const rj = (legs[j].avgCorr ?? 30) / 100;
      matrix[i][j] = matrix[j][i] = (ri + rj) / 2;
      estimatedCount++;
    }
  }
  return { matrix, measuredCount, estimatedCount, pairCount };
}

function portfolioVolCustom(legs) {
  if (legs.length === 0) return 0;
  const { matrix } = correlationMatrixForLegs(legs);
  return portfolioVolFromMatrix(legs, matrix);
}

function portfolioReturnCustom(legs) {
  if (legs.length === 0) return 0;
  const totalW = legs.reduce((s, l) => s + (l.weight || 0), 0);
  if (totalW === 0) {
    // Equal weight
    return legs.reduce((s, l) => s + (l.expectedReturn / 100), 0) / legs.length;
  }
  return legs.reduce((s, l) => s + ((l.weight || 0) / totalW) * (l.expectedReturn / 100), 0);
}

// ============================================================
//   HOLY GRAIL CHART RENDERING
// ============================================================
function renderHolyGrailChart() {
  const svg = document.getElementById('holy-grail-svg');
  if (!svg) return;

  const W = 900, H = 460;
  const margin = { top: 60, right: 70, bottom: 70, left: 70 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const sigma = state.risk.globalVol;
  const expRet = state.risk.globalReturn;
  const rf = state.risk.riskFreeRate;
  const compCorr = state.risk.compCorr;

  // Generate curve data: N from 1 to 25
  // We draw multiple example curves at canonical correlation levels (Dalio's book style):
  //   0% (uncorrelated ideal), 20%, 40%, 60% (typical stocks)
  // PLUS the user's actual portfolio plotted at its measured correlation.
  const Nmax = 25;
  const exampleCurves = [
    { rho: 0,    color: '#1a3a5e', dash: '',           label: '0% (ideal)',   weight: 2.5 },
    { rho: 0.20, color: '#3d6080', dash: '4 3',        label: '20% corr',     weight: 1.4 },
    { rho: 0.40, color: '#7a6850', dash: '6 4',        label: '40% corr',     weight: 1.4 },
    { rho: 0.60, color: '#a85a3a', dash: '5 4',        label: '60% (stocks)', weight: 2.0 },
  ];
  const curveData = exampleCurves.map(c => ({
    ...c,
    points: Array.from({ length: Nmax }, (_, i) => ({
      n: i + 1,
      vol: portfolioVolEqual(i + 1, sigma, c.rho),
    })),
  }));

  // Y-axis range: from 0 up to slightly above sigma (1 bet)
  const yMax = sigma * 1.1;
  const yMin = 0;

  const xScale = n => margin.left + ((n - 1) / (Nmax - 1)) * innerW;
  const yScale = v => margin.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Smooth curve using bezier interpolation for prettier display
  const buildSmoothPath = (data) => {
    if (data.length < 2) return '';
    let d = `M ${xScale(data[0].n).toFixed(2)} ${yScale(data[0].vol).toFixed(2)}`;
    for (let i = 1; i < data.length; i++) {
      const x0 = xScale(data[i - 1].n);
      const y0 = yScale(data[i - 1].vol);
      const x1 = xScale(data[i].n);
      const y1 = yScale(data[i].vol);
      const cx = (x0 + x1) / 2;
      d += ` C ${cx.toFixed(2)} ${y0.toFixed(2)}, ${cx.toFixed(2)} ${y1.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }
    return d;
  };

  // X-axis ticks: 1, 5, 10, 15, 20, 25
  const xTicks = [1, 5, 10, 15, 20, 25];
  // Y-axis ticks: 5 evenly-spaced
  const yTickVals = [];
  const yStep = yMax / 5;
  for (let i = 0; i <= 5; i++) yTickVals.push(i * yStep);

  // Find the "Holy Grail" point — N=15 on the uncorrelated curve
  const holyN = 15;
  const holyVol = portfolioVolEqual(holyN, sigma, 0);
  const reductionPct = ((1 - holyVol / sigma) * 100).toFixed(0);

  // Custom portfolio plot point + measured average correlation (if any legs defined)
  const legs = state.risk.legs;
  let portfolioPoint = null;
  let measuredAvgCorr = null;
  let corrSummary = null;
  if (legs.length > 0) {
    const corrInfo = correlationMatrixForLegs(legs);
    const pVol = portfolioVolFromMatrix(legs, corrInfo.matrix);
    portfolioPoint = { n: legs.length, vol: pVol };
    // Compute average off-diagonal correlation (the "effective rho" for this portfolio)
    let sumRho = 0, ct = 0;
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        if (corrInfo.matrix[i][j] != null) {
          sumRho += corrInfo.matrix[i][j];
          ct++;
        }
      }
    }
    measuredAvgCorr = ct > 0 ? sumRho / ct : null;
    corrSummary = { measured: corrInfo.measuredCount, estimated: corrInfo.estimatedCount, total: corrInfo.pairCount };
  }

  // ─── BUILD SVG ───
  let s = '';

  // Title + subtitle
  s += `<text class="chart-title" x="${W / 2}" y="26" text-anchor="middle">The Holy Grail of Investing</text>`;
  s += `<text class="chart-subtitle" x="${W / 2}" y="44" text-anchor="middle">15-20 uncorrelated return streams reduce portfolio risk by ~80% (each bet ~${(expRet * 100).toFixed(0)}% return, ${(sigma * 100).toFixed(0)}% vol)</text>`;

  // Grid lines (horizontal)
  s += `<g class="grid">`;
  for (const v of yTickVals) {
    const y = yScale(v);
    s += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + innerW}" y2="${y}"/>`;
  }
  for (const t of xTicks) {
    const x = xScale(t);
    s += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + innerH}"/>`;
  }
  s += `</g>`;

  // Axes
  s += `<g class="axis">`;
  // X axis
  s += `<line x1="${margin.left}" y1="${margin.top + innerH}" x2="${margin.left + innerW}" y2="${margin.top + innerH}"/>`;
  // Y axis
  s += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerH}"/>`;

  // X tick labels
  for (const t of xTicks) {
    const x = xScale(t);
    s += `<text x="${x}" y="${margin.top + innerH + 18}" text-anchor="middle">${t}</text>`;
    s += `<line x1="${x}" y1="${margin.top + innerH}" x2="${x}" y2="${margin.top + innerH + 5}"/>`;
  }
  // Y tick labels
  for (const v of yTickVals) {
    const y = yScale(v);
    s += `<text x="${margin.left - 10}" y="${y + 4}" text-anchor="end">${(v * 100).toFixed(0)}%</text>`;
    s += `<line x1="${margin.left - 5}" y1="${y}" x2="${margin.left}" y2="${y}"/>`;
  }
  s += `</g>`;

  // Axis labels
  s += `<text class="axis-label" x="${margin.left + innerW / 2}" y="${H - 18}" text-anchor="middle">Number of Return Streams (Bets / Legs)</text>`;
  s += `<text class="axis-label" x="${20}" y="${margin.top + innerH / 2}" text-anchor="middle" transform="rotate(-90, 20, ${margin.top + innerH / 2})">Portfolio Risk (Standard Deviation)</text>`;

  // Draw all example correlation curves
  curveData.forEach(c => {
    s += `<path d="${buildSmoothPath(c.points)}" stroke="${c.color}" stroke-width="${c.weight}" fill="none" ${c.dash ? `stroke-dasharray="${c.dash}"` : ''}/>`;
  });

  // Annotation: holy grail point
  const holyX = xScale(holyN);
  const holyY = yScale(holyVol);
  s += `<line class="annotation-line" x1="${holyX}" y1="${margin.top + innerH}" x2="${holyX}" y2="${holyY}"/>`;
  s += `<line class="annotation-line" x1="${margin.left}" y1="${holyY}" x2="${holyX}" y2="${holyY}"/>`;
  s += `<circle cx="${holyX}" cy="${holyY}" r="5" fill="#c4965a" stroke="#1a3a5e" stroke-width="1.5"/>`;
  s += `<text class="callout" x="${holyX + 12}" y="${holyY - 8}">Risk cut ~${reductionPct}% at ${holyN} bets</text>`;

  // Curve labels at right end (each curve gets its own label)
  curveData.forEach(c => {
    const lastY = yScale(c.points[c.points.length - 1].vol);
    s += `<text class="legend-text" x="${margin.left + innerW + 8}" y="${lastY + 4}" fill="${c.color}" font-weight="600" font-size="10">${c.label}</text>`;
  });

  // Custom portfolio marker (if user has built one)
  if (portfolioPoint && portfolioPoint.n <= Nmax) {
    const px = xScale(portfolioPoint.n);
    const py = yScale(portfolioPoint.vol);
    s += `<circle class="portfolio-marker" cx="${px}" cy="${py}" r="7"/>`;
    const corrLabel = measuredAvgCorr != null
      ? `ρ̄=${(measuredAvgCorr * 100).toFixed(0)}%`
      : 'estimated corr';
    s += `<text class="callout" x="${px + 12}" y="${py + 4}" fill="#c4965a">YOUR PORTFOLIO · ${legs.length} legs · ${(portfolioPoint.vol * 100).toFixed(1)}% vol · ${corrLabel}</text>`;
    if (corrSummary && corrSummary.measured > 0) {
      s += `<text x="${px + 12}" y="${py + 17}" fill="var(--ink-faint)" font-family="var(--mono)" font-size="9">${corrSummary.measured} of ${corrSummary.total} pairs measured from price history</text>`;
    }
  }

  // "Dalio's Holy Grail" tagline in upper-left
  s += `<text x="${margin.left + 12}" y="${margin.top + 16}" font-family="'Inter',Arial,sans-serif" font-size="10" font-style="italic" fill="#888">— Ray Dalio, Principles</text>`;

  // ── HOVER LAYER ──
  // Invisible rectangles per N value trigger an event that updates the tooltip.
  // We stash all curve data on the SVG element so the tooltip handler can read it.
  s += `<g id="hg-hover-layer">`;
  for (let n = 1; n <= Nmax; n++) {
    const x = xScale(n);
    const half = innerW / (Nmax - 1) / 2;
    s += `<rect x="${x - half}" y="${margin.top}" width="${half * 2}" height="${innerH}" fill="transparent"
                onmouseover="showHGTooltip(${n})"
                onmouseout="hideHGTooltip()"
                style="cursor:crosshair"/>`;
  }
  s += `</g>`;

  // Tooltip elements — empty container, populated dynamically
  s += `<g id="hg-tooltip-group" style="display:none;pointer-events:none">
    <line id="hg-vline" x1="0" y1="${margin.top}" x2="0" y2="${margin.top + innerH}" stroke="#888" stroke-width="0.8" stroke-dasharray="4 3"/>
    <g id="hg-dots"></g>
    <rect id="hg-tip-bg" rx="3" ry="3" fill="#0a0a0a" fill-opacity="0.92"/>
    <g id="hg-tip-text"></g>
  </g>`;

  svg.innerHTML = s;

  // Stash chart context for hover handlers
  svg._hgChartCtx = {
    sigma, margin, innerW, innerH, Nmax,
    curveData,
    xScale: n => margin.left + ((n - 1) / (Nmax - 1)) * innerW,
    yScale: v => margin.top + innerH - ((v - 0) / (sigma * 1.1 - 0)) * innerH,
    portfolioPoint, measuredAvgCorr, legCount: legs.length,
  };
}

// Hover handlers — globally accessible since they're inline in SVG
window.showHGTooltip = function(n) {
  const svg = document.getElementById('holy-grail-svg');
  if (!svg?._hgChartCtx) return;
  const ctx = svg._hgChartCtx;
  const grp = document.getElementById('hg-tooltip-group');
  const vline = document.getElementById('hg-vline');
  const dotsG = document.getElementById('hg-dots');
  const tipBg = document.getElementById('hg-tip-bg');
  const tipTextG = document.getElementById('hg-tip-text');
  if (!grp) return;

  const cx = ctx.xScale(n);
  vline.setAttribute('x1', cx);
  vline.setAttribute('x2', cx);

  // Clear and rebuild dots + text
  dotsG.innerHTML = '';
  tipTextG.innerHTML = '';

  // Build a row per curve at this N
  const lines = [{ t: `N = ${n} ${n === 1 ? 'bet' : 'bets'}`, color: '#c4965a', weight: '700' }];
  let firstY = null;
  ctx.curveData.forEach(c => {
    const point = c.points[n - 1];
    if (!point) return;
    const y = ctx.yScale(point.vol);
    if (firstY == null) firstY = y;
    // Add dot for this curve
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', c.color);
    dot.setAttribute('stroke', '#fafaf6');
    dot.setAttribute('stroke-width', '1.5');
    dotsG.appendChild(dot);
    const reduction = ((1 - point.vol / ctx.sigma) * 100).toFixed(0);
    lines.push({
      t: `${c.label}: ${(point.vol * 100).toFixed(2)}%  (-${reduction}%)`,
      color: c.color,
    });
  });

  // If portfolio dot lands on this N, add it
  if (ctx.portfolioPoint && ctx.portfolioPoint.n === n) {
    const py = ctx.yScale(ctx.portfolioPoint.vol);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', py);
    dot.setAttribute('r', '6');
    dot.setAttribute('fill', '#c4965a');
    dot.setAttribute('stroke', '#1a1a1a');
    dot.setAttribute('stroke-width', '1.5');
    dotsG.appendChild(dot);
    lines.push({
      t: `Your portfolio: ${(ctx.portfolioPoint.vol * 100).toFixed(2)}%${ctx.measuredAvgCorr != null ? ` (ρ̄=${(ctx.measuredAvgCorr * 100).toFixed(0)}%)` : ''}`,
      color: '#c4965a',
      weight: '700',
    });
  }

  // Render text lines
  const lineH = 14;
  const tipH = lines.length * lineH + 12;
  const tipW = 240;
  const flipped = (cx + tipW + 14) > (ctx.margin.left + ctx.innerW);
  const bgX = flipped ? cx - tipW - 8 : cx + 8;
  const tipY = Math.max(ctx.margin.top + 4, Math.min(ctx.margin.top + ctx.innerH - tipH - 4, (firstY ?? ctx.margin.top + 50) - 6));

  lines.forEach((line, i) => {
    const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tspan.setAttribute('x', bgX + 8);
    tspan.setAttribute('y', tipY + 14 + i * lineH);
    tspan.setAttribute('fill', line.color);
    tspan.setAttribute('font-family', "'Inter',Arial,sans-serif");
    tspan.setAttribute('font-size', '11');
    if (line.weight) tspan.setAttribute('font-weight', line.weight);
    tspan.textContent = line.t;
    tipTextG.appendChild(tspan);
  });

  tipBg.setAttribute('x', bgX);
  tipBg.setAttribute('y', tipY);
  tipBg.setAttribute('width', tipW);
  tipBg.setAttribute('height', tipH);
  grp.style.display = '';
};

window.hideHGTooltip = function() {
  const grp = document.getElementById('hg-tooltip-group');
  if (grp) grp.style.display = 'none';
};

// ============================================================
//   PORTFOLIO BUILDER UI
// ============================================================
function renderRiskLegsTable() {
  const tbody = document.getElementById('risk-legs-body');
  if (!tbody) return;

  // Build datalist of all stockbook tickers with names
  const sbRows = state.stockbook?.rows || [];
  const datalistOptions = sbRows.map(r => {
    const label = `${r.ticker}${r.name ? ' — ' + r.name.slice(0, 60) : ''}`;
    return `<option value="${escapeHtml(label)}" data-tic="${r.ticker}">`;
  }).join('');

  if (state.risk.legs.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7" style="text-align:center;padding:32px;color:var(--ink-faint);font-size:12px;font-style:italic">
        No legs yet · click <strong style="color:var(--amber)">+ Add Leg</strong> or <strong style="color:var(--amber)">Load Presets</strong> to start
      </td></tr>
    `;
    document.getElementById('risk-leg-count').textContent = '0 legs';
    return;
  }

  // Datalist must be in the DOM exactly once; refresh it each render
  let dl = document.getElementById('risk-stockbook-datalist');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'risk-stockbook-datalist';
    document.body.appendChild(dl);
  }
  dl.innerHTML = datalistOptions;

  tbody.innerHTML = state.risk.legs.map((leg, idx) => `
    <tr>
      <td class="risk-leg-num">${idx + 1}</td>
      <td><input type="text" class="risk-leg-input" data-field="name" data-idx="${idx}" list="risk-stockbook-datalist" value="${escapeHtml(leg.name || '')}" placeholder="Type GME or 'Trend Following'…" autocomplete="off"></td>
      <td><input type="number" class="risk-leg-input risk-num" data-field="expectedReturn" data-idx="${idx}" value="${leg.expectedReturn}" step="0.5" min="-50" max="100"></td>
      <td><input type="number" class="risk-leg-input risk-num" data-field="volatility" data-idx="${idx}" value="${leg.volatility}" step="0.5" min="0" max="200"></td>
      <td><input type="number" class="risk-leg-input risk-num" data-field="weight" data-idx="${idx}" value="${leg.weight}" step="1" min="0" max="100"></td>
      <td><input type="number" class="risk-leg-input risk-num" data-field="avgCorr" data-idx="${idx}" value="${leg.avgCorr}" step="5" min="-100" max="100"></td>
      <td><button class="risk-leg-remove" data-remove="${idx}" title="Remove">×</button></td>
    </tr>
  `).join('');

  document.getElementById('risk-leg-count').textContent =
    state.risk.legs.length === 1 ? '1 leg' : `${state.risk.legs.length} legs`;

  // Wire input changes
  tbody.querySelectorAll('.risk-leg-input').forEach(inp => {
    const handleChange = () => {
      const idx = parseInt(inp.dataset.idx);
      const field = inp.dataset.field;
      const leg = state.risk.legs[idx];
      if (!leg) return;
      if (field === 'name') {
        const val = inp.value;
        leg.name = val;
        // Detect if user picked a ticker from the datalist (format: "TIC — Company Name")
        // Match a leading ticker symbol followed by " — "
        const m = val.match(/^([A-Z][A-Z0-9.\-]{0,5})(?:\s*[—\-]\s*(.+))?$/);
        if (m) {
          const tic = m[1];
          const sbRow = state.stockbook?.rows?.find(r => r.ticker === tic);
          if (sbRow) {
            // Try to measure vol from actual price history first
            const hist = getHistoryForTicker(tic);
            const measuredVol = hist ? annualizedVol(hist, 252) : null;
            const measuredRet = hist ? annualizedReturn(hist, 252) : null;
            if (measuredVol != null) {
              leg.volatility = Math.max(5, Math.min(150, measuredVol * 100));
            } else if (sbRow.beta && isFinite(sbRow.beta)) {
              leg.volatility = Math.max(15, Math.min(60, sbRow.beta * 18));
            } else if (!leg.volatility || leg.volatility === state.risk.globalVol * 100) {
              leg.volatility = 25;
            }
            if (measuredRet != null) {
              leg.expectedReturn = Math.max(-50, Math.min(100, measuredRet * 100));
            }
            // Default avg corr — will be overridden by measured pairwise correlation in matrix calc
            if (leg.avgCorr === 30 || leg.avgCorr == null) {
              leg.avgCorr = sbRow.isDerivative ? 70 : 55;
            }
            const cleanLabel = `${tic} · ${sbRow.name?.slice(0, 30) || ''}`.trim();
            leg.name = cleanLabel;
            saveRiskPortfolio();
            renderRiskLegsTable();
            renderHolyGrailChart();
            renderRiskMetrics();
            setTimeout(() => {
              const nextInput = document.querySelector(`[data-field="expectedReturn"][data-idx="${idx}"]`);
              if (nextInput) nextInput.focus();
            }, 0);
            return;
          }
        }
      } else {
        const v = parseFloat(inp.value);
        leg[field] = isFinite(v) ? v : 0;
      }
      saveRiskPortfolio();
      renderHolyGrailChart();
      renderRiskMetrics();
    };
    inp.addEventListener('input', handleChange);
    inp.addEventListener('change', handleChange);
  });
  tbody.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.remove);
      state.risk.legs.splice(idx, 1);
      saveRiskPortfolio();
      renderRiskLegsTable();
      renderHolyGrailChart();
      renderRiskMetrics();
    });
  });
}

function addRiskLeg(preset) {
  if (state.risk.legs.length >= 30) {
    alert('Max 30 legs');
    return;
  }
  const defaultLeg = {
    name: '',
    expectedReturn: state.risk.globalReturn * 100,
    volatility: state.risk.globalVol * 100,
    weight: 100 / Math.max(1, state.risk.legs.length + 1),
    avgCorr: 30,
  };
  state.risk.legs.push(preset ? { ...defaultLeg, ...preset } : defaultLeg);

  // Auto-rebalance weights to equal-weight if no manual weights set
  const allEqual = state.risk.legs.every((l, i, arr) =>
    Math.abs(l.weight - arr[0].weight) < 1
  );
  if (allEqual) {
    const eq = 100 / state.risk.legs.length;
    state.risk.legs.forEach(l => l.weight = eq);
  }
  saveRiskPortfolio();
  renderRiskLegsTable();
  renderHolyGrailChart();
  renderRiskMetrics();
}

const RISK_PRESETS = [
  { name: 'Trend Following', expectedReturn: 8,  volatility: 12, weight: 12.5, avgCorr: 10 },
  { name: 'Value Stocks',    expectedReturn: 9,  volatility: 16, weight: 12.5, avgCorr: 50 },
  { name: 'Carry Trade',     expectedReturn: 7,  volatility: 10, weight: 12.5, avgCorr: 20 },
  { name: 'Long-Term Bonds', expectedReturn: 5,  volatility: 8,  weight: 12.5, avgCorr: -10 },
  { name: 'Gold',            expectedReturn: 6,  volatility: 18, weight: 12.5, avgCorr: 5 },
  { name: 'Real Estate',     expectedReturn: 8,  volatility: 14, weight: 12.5, avgCorr: 35 },
  { name: 'Emerging Markets',expectedReturn: 10, volatility: 22, weight: 12.5, avgCorr: 45 },
  { name: 'Commodities',     expectedReturn: 7,  volatility: 20, weight: 12.5, avgCorr: 15 },
];

function loadRiskPresets() {
  if (state.risk.legs.length > 0) {
    if (!confirm('Replace current portfolio with Dalio preset (8 classic uncorrelated bets)?')) return;
  }
  state.risk.legs = RISK_PRESETS.map(p => ({ ...p }));
  saveRiskPortfolio();
  renderRiskLegsTable();
  renderHolyGrailChart();
  renderRiskMetrics();
}

function importFromStockBook() {
  const rows = state.stockbook?.rows || [];
  const equities = rows.filter(r => !r.isDerivative && r.marketCap && r.marketCap >= 10e9);
  if (equities.length === 0) {
    alert('No mid+ cap equities found in Stock Book. Make sure your Stock Book is loaded.');
    return;
  }
  // Take top 8 by market cap; group different sectors when possible
  const top = [...equities].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 12);
  if (state.risk.legs.length > 0 && !confirm(`Add top ${top.length} stocks from your Stock Book? (Current portfolio will be replaced.)`)) return;

  // Estimate vol from sheet (fallback to 25%) — uses sheet's `return52` or beta
  state.risk.legs = top.map(r => {
    let vol = 25;
    if (r.beta && isFinite(r.beta)) vol = Math.max(15, Math.min(60, r.beta * 18)); // rough mapping
    return {
      name: r.ticker + (r.name ? ' · ' + r.name.slice(0, 28) : ''),
      expectedReturn: 10,
      volatility: vol,
      weight: 100 / top.length,
      avgCorr: 55, // equities typically ~50-60%
    };
  });
  saveRiskPortfolio();
  renderRiskLegsTable();
  renderHolyGrailChart();
  renderRiskMetrics();
}

// ============================================================
//   PORTFOLIO METRICS
// ============================================================
function renderRiskMetrics() {
  const el = document.getElementById('risk-metrics');
  if (!el) return;
  const legs = state.risk.legs;
  const rf = state.risk.riskFreeRate;

  if (legs.length === 0) {
    el.innerHTML = `
      <div class="risk-metric" style="grid-column:1/-1;text-align:center">
        <div class="risk-metric-label">Build a portfolio above to see risk metrics</div>
      </div>
    `;
    document.getElementById('risk-corr-section').style.display = 'none';
    return;
  }

  const corrInfo = correlationMatrixForLegs(legs);
  const portRet = portfolioReturnCustom(legs);
  const portVol = portfolioVolFromMatrix(legs, corrInfo.matrix);
  const sharpe = portVol > 0 ? (portRet - rf) / portVol : 0;
  const z = portVol > 0 ? -portRet / portVol : 0;
  const drawdownProb = normCdf(z);

  // Average measured correlation
  let sumRho = 0, ct = 0;
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      if (corrInfo.matrix[i][j] != null) {
        sumRho += corrInfo.matrix[i][j];
        ct++;
      }
    }
  }
  const avgRho = ct > 0 ? sumRho / ct : null;

  // Diversification ratio
  const totalW = legs.reduce((s, l) => s + (l.weight || 0), 0) || legs.length;
  const weightedAvgVol = legs.reduce((s, l) => {
    const w = totalW > 0 ? (l.weight || 0) / totalW : 1 / legs.length;
    return s + w * (l.volatility / 100);
  }, 0);
  const divRatio = portVol > 0 ? weightedAvgVol / portVol : 1;

  const m = (label, value, sub, cls) => `
    <div class="risk-metric">
      <div class="risk-metric-label">${label}</div>
      <div class="risk-metric-value ${cls || ''}">${value}</div>
      ${sub ? `<div class="risk-metric-sub">${sub}</div>` : ''}
    </div>
  `;

  el.innerHTML = [
    m('Expected Return',  (portRet * 100).toFixed(2) + '%', 'weighted avg', portRet > 0 ? 'up' : 'down'),
    m('Portfolio Vol',    (portVol * 100).toFixed(2) + '%', 'std dev'),
    m('Avg Correlation',  avgRho != null ? (avgRho * 100).toFixed(0) + '%' : 'estimated', avgRho != null ? `${ct} of ${corrInfo.pairCount} pairs measured` : 'no price data'),
    m('Sharpe Ratio',     sharpe.toFixed(2), `RF = ${(rf * 100).toFixed(1)}%`, sharpe > 1 ? 'up' : sharpe < 0 ? 'down' : ''),
    m('Diversification',  divRatio.toFixed(2) + 'x', divRatio > 1.5 ? 'excellent' : divRatio > 1.2 ? 'good' : 'low'),
    m('P(loss this year)', (drawdownProb * 100).toFixed(1) + '%', 'normal approx', drawdownProb < 0.20 ? 'up' : drawdownProb > 0.40 ? 'down' : ''),
  ].join('');

  // Render correlation matrix if 2+ legs
  renderCorrelationMatrix(legs, corrInfo);
}

// ============================================================
//   CORRELATION MATRIX VIEWER
//   Color-coded heatmap of pairwise correlations.
//   Red = high positive correlation (move together — concentration risk)
//   White = uncorrelated (Holy Grail)
//   Blue = negative correlation (hedge)
// ============================================================
function renderCorrelationMatrix(legs, corrInfo) {
  const section = document.getElementById('risk-corr-section');
  const wrap = document.getElementById('risk-corr-matrix');
  const status = document.getElementById('risk-corr-status');
  if (!section || !wrap) return;

  if (legs.length < 2) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const n = legs.length;

  // Color scale for correlation
  const corrColor = rho => {
    if (rho == null) return '#1c1a17';
    // -1 → blue, 0 → near-black, +1 → red
    if (rho >= 0) {
      const intensity = Math.min(1, rho);
      const r = Math.floor(40 + intensity * 175);
      const g = Math.floor(30 - intensity * 20);
      const b = Math.floor(30 - intensity * 20);
      return `rgb(${r}, ${Math.max(0, g)}, ${Math.max(0, b)})`;
    } else {
      const intensity = Math.min(1, -rho);
      const r = Math.floor(30 - intensity * 20);
      const g = Math.floor(40 + intensity * 80);
      const b = Math.floor(60 + intensity * 130);
      return `rgb(${Math.max(0, r)}, ${g}, ${b})`;
    }
  };

  const labels = legs.map((l, i) => {
    // Truncate name if very long
    const fullName = l.name || `Leg ${i + 1}`;
    return fullName.length > 14 ? fullName.slice(0, 13) + '…' : fullName;
  });

  // Build table — labels along top and left
  let html = '<div class="corr-matrix-wrap"><table class="corr-matrix-table">';
  html += '<thead><tr><th></th>';
  for (let j = 0; j < n; j++) {
    html += `<th title="${escapeHtml(legs[j].name || '')}">${escapeHtml(labels[j])}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (let i = 0; i < n; i++) {
    html += `<tr><th title="${escapeHtml(legs[i].name || '')}">${escapeHtml(labels[i])}</th>`;
    for (let j = 0; j < n; j++) {
      const rho = corrInfo.matrix[i][j];
      const cellColor = i === j ? '#3a342a' : corrColor(rho);
      const text = rho == null ? '—' : (rho * 100).toFixed(0);
      const isMeasured = i !== j && rho != null && corrInfo.matrix[i][j] != null;
      const tipBits = [
        legs[i].name + ' vs ' + legs[j].name,
        rho != null ? `ρ = ${rho.toFixed(3)}` : 'no overlap data',
        i === j ? 'self' : isMeasured ? 'measured from history' : 'estimated',
      ];
      html += `<td style="background:${cellColor}" title="${escapeHtml(tipBits.join(' | '))}">${text}${i === j ? '' : ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  // Insight summary — flag high-correlation pairs
  const concerns = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const rho = corrInfo.matrix[i][j];
      if (rho != null && rho > 0.7) {
        concerns.push({
          pair: `${legs[i].name} ↔ ${legs[j].name}`,
          rho,
          interp: 'highly correlated (moves together)',
          color: '#a85a3a',
        });
      } else if (rho != null && rho < -0.3) {
        concerns.push({
          pair: `${legs[i].name} ↔ ${legs[j].name}`,
          rho,
          interp: 'negatively correlated (natural hedge)',
          color: '#5b8a72',
        });
      }
    }
  }
  if (concerns.length > 0) {
    html += '<div class="corr-insights"><div class="corr-insights-label">Notable Relationships</div>';
    concerns.forEach(c => {
      html += `<div class="corr-insight-row" style="border-left-color:${c.color}">
        <span class="corr-insight-pair">${escapeHtml(c.pair)}</span>
        <span class="corr-insight-rho" style="color:${c.color}">${c.rho >= 0 ? '+' : ''}${(c.rho * 100).toFixed(0)}%</span>
        <span class="corr-insight-interp">${c.interp}</span>
      </div>`;
    });
    html += '</div>';
  }

  // Status
  const measured = corrInfo.measuredCount;
  const total = corrInfo.pairCount;
  if (status) {
    if (total === 0) {
      status.textContent = 'Add 2+ legs to see correlations';
    } else if (measured === 0) {
      status.innerHTML = `<span style="color:#c4965a">No pairs measured — leg names need ticker symbols (e.g. "GME · GameStop") and tickers must be in your sheet's price history</span>`;
    } else {
      status.innerHTML = `<strong style="color:var(--ink)">${measured} of ${total} pairs measured</strong> from daily log returns · ${total - measured} estimated from your "avg corr" inputs · color: red=high+, blue=negative, dark=uncorrelated`;
    }
  }

  wrap.innerHTML = html;
}

// ============================================================
//   WIRE EVERYTHING
// ============================================================
function initRiskCalculator() {
  loadRiskPortfolio();

  // Load stockbook in background so autocomplete has data
  if ((state.stockbook?.rows?.length ?? 0) === 0 && getSheetUrls().length > 0) {
    loadStockBook(false).then(() => renderRiskLegsTable()).catch(() => {});
  }

  // Param sliders
  const wireSlider = (id, valId, key, fmt, scale) => {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(valId);
    if (!slider) return;
    const apply = () => {
      const val = parseFloat(slider.value);
      state.risk[key] = scale ? val / scale : val;
      valEl.textContent = fmt(val);
      renderHolyGrailChart();
      renderRiskMetrics();
    };
    slider.addEventListener('input', apply);
    // Set initial display
    valEl.textContent = fmt(parseFloat(slider.value));
  };
  wireSlider('risk-vol',       'risk-vol-val',       'globalVol',     v => v.toFixed(1) + '%', 100);
  wireSlider('risk-ret',       'risk-ret-val',       'globalReturn',  v => v.toFixed(1) + '%', 100);
  wireSlider('risk-rf',        'risk-rf-val',        'riskFreeRate',  v => v.toFixed(1) + '%', 100);
  wireSlider('risk-comp-corr', 'risk-comp-corr-val', 'compCorr',      v => v.toFixed(0) + '%', 100);

  // Buttons
  document.getElementById('risk-add-leg')?.addEventListener('click', () => addRiskLeg());
  document.getElementById('risk-load-presets')?.addEventListener('click', loadRiskPresets);
  document.getElementById('risk-import-stockbook')?.addEventListener('click', importFromStockBook);
  document.getElementById('risk-clear-portfolio')?.addEventListener('click', () => {
    if (state.risk.legs.length === 0) return;
    if (!confirm('Clear all legs?')) return;
    state.risk.legs = [];
    saveRiskPortfolio();
    renderRiskLegsTable();
    renderHolyGrailChart();
    renderRiskMetrics();
  });

  // Initial render
  renderRiskLegsTable();
  renderHolyGrailChart();
  renderRiskMetrics();
}

// Add RISK mnemonic to terminal
if (typeof TERMINAL_FUNCTIONS !== 'undefined') {
  TERMINAL_FUNCTIONS.RISK = {
    name: 'Risk Calculator',
    desc: 'Holy Grail diversification chart',
    scope: 'global',
    handler: () => switchTab('risk'),
  };
  TERMINAL_FUNCTIONS.HG = {
    name: 'Holy Grail',
    desc: 'Open the Risk Calculator',
    scope: 'global',
    handler: () => switchTab('risk'),
  };
}

// ============================================================
//   MARKET CAP DISCREPANCY DETECTION
//   Compares sheet's market cap to derived (price × shares) and
//   FMP's reported market cap. Flags >25% discrepancy.
// ============================================================
async function checkMarketCapDiscrepancy(stock) {
  if (!stock?.ticker || !stock?.marketCap) return null;
  const sheetMcap = stock.marketCap;
  const sources = [{ name: 'Sheet (Google Finance)', value: sheetMcap }];

  // Sheet has its own FMP value via =FMPDATA() — use it directly (no API call needed)
  if (stock.fmpMarketCap && isFinite(stock.fmpMarketCap)) {
    sources.push({ name: 'Sheet (FMP)', value: stock.fmpMarketCap });
  }

  // Derive from price × shares (most reliable cross-check)
  if (stock.price && stock.sharesOutstanding) {
    sources.push({ name: 'Price × Shares', value: stock.price * stock.sharesOutstanding });
  }

  // Live FMP API call (only if sheet doesn't already have FMP data)
  const fetchers = [];
  if (getFmpKey() && !stock.fmpMarketCap) {
    fetchers.push((async () => {
      const profileUrls = [
        `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(stock.ticker)}&apikey=${getFmpKey()}`,
        `https://financialmodelingprep.com/api/v3/profile/${stock.ticker}?apikey=${getFmpKey()}`,
      ];
      for (const url of profileUrls) {
        try {
          const r = await fetch(url);
          if (!r.ok) continue;
          const j = await r.json();
          const profile = Array.isArray(j) ? j[0] : j;
          const v = profile?.mktCap || profile?.marketCap;
          if (v && isFinite(v) && v > 0) return { name: 'FMP API', value: v };
        } catch {}
      }
      return null;
    })());
  }

  // Finnhub's market cap (returns in millions)
  if (getFinnhubKey()) {
    fetchers.push((async () => {
      try {
        const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${stock.ticker}&token=${getFinnhubKey()}`;
        const r = await fetch(url);
        if (!r.ok) return null;
        const j = await r.json();
        if (j.marketCapitalization && isFinite(j.marketCapitalization)) {
          return { name: 'Finnhub', value: j.marketCapitalization * 1e6 };
        }
      } catch {}
      return null;
    })());
  }

  const apiSources = (await Promise.all(fetchers)).filter(Boolean);
  sources.push(...apiSources);

  // Compare sheet (Google Finance) vs all OTHER sources (FMP, Finnhub, derived)
  const externals = sources
    .filter(s => s.name !== 'Sheet (Google Finance)')
    .map(s => s.value)
    .filter(v => v && isFinite(v));

  if (externals.length === 0) return { sources, status: 'unverified' };

  externals.sort((a, b) => a - b);
  const median = externals[Math.floor(externals.length / 2)];
  const ratio = sheetMcap / median;
  let status;
  if (Math.abs(ratio - 1) <= 0.05) status = 'confirmed';
  else if (Math.abs(ratio - 1) <= 0.15) status = 'minor';
  else status = 'discrepancy';

  return { sources, median, ratio, status };
}

// Render the discrepancy badge near market cap on the summary card.
// Now ALWAYS renders — green ✓ if confirmed, amber ? if discrepant
async function renderMarketCapCheck(stock) {
  const el = document.getElementById('s-mcap');
  if (!el) return;
  const result = await checkMarketCapDiscrepancy(stock);
  if (!result) return;

  const container = el.parentElement;
  if (!container) return;
  container.querySelectorAll('.mcap-check').forEach(n => n.remove());

  const fmtMcap = v => v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T'
                    : v >= 1e9  ? '$' + (v / 1e9).toFixed(2) + 'B'
                    : v >= 1e6  ? '$' + (v / 1e6).toFixed(0) + 'M'
                    : '$' + v.toFixed(0);

  const tooltip = result.sources.map(s => `${s.name}: ${fmtMcap(s.value)}`).join('\n');

  const badge = document.createElement('div');
  badge.className = 'mcap-check';
  badge.title = tooltip + (result.ratio ? `\nRatio: ${result.ratio.toFixed(3)}` : '');
  badge.style.cssText = 'font-family:var(--mono);font-size:10px;margin-top:4px;cursor:help;letter-spacing:0.05em';

  if (result.status === 'confirmed') {
    badge.style.color = '#5b8a72';
    badge.innerHTML = `✓ Confirmed across ${result.sources.length} sources`;
  } else if (result.status === 'minor') {
    badge.style.color = '#7aa085';
    badge.innerHTML = `≈ ${result.ratio.toFixed(2)}× consensus · minor variance`;
  } else if (result.status === 'discrepancy') {
    badge.style.color = '#c4965a';
    badge.innerHTML = `? Discrepancy · sheet ${result.ratio.toFixed(2)}× consensus · hover for details`;
  } else {
    badge.style.color = 'var(--ink-faint)';
    badge.innerHTML = `· no external sources to verify`;
  }
  container.appendChild(badge);
}

// ============================================================
//   PORTFOLIO — user-curated tracked positions
//   Stored in localStorage. Each entry: ticker, addedAt, position, qty, costBasis, notes
// ============================================================
const PORTFOLIO_STORAGE = 'valuatio.portfolio.v1';

function loadPortfolio() {
  try {
    const arr = JSON.parse(localStorage.getItem(PORTFOLIO_STORAGE) || '[]');
    // Migrate: convert string notes → array of timestamped notes
    return arr.map(e => {
      if (typeof e.notes === 'string') {
        const text = e.notes.trim();
        e.notes = text ? [{ ts: e.addedAt || new Date().toISOString(), text }] : [];
      }
      if (!Array.isArray(e.notes)) e.notes = [];
      return e;
    });
  } catch { return []; }
}
function savePortfolio(arr) {
  try { localStorage.setItem(PORTFOLIO_STORAGE, JSON.stringify(arr)); } catch {}
}
function addToPortfolio(entry) {
  const arr = loadPortfolio();
  const existing = arr.findIndex(e => e.ticker === entry.ticker);
  if (existing >= 0) arr[existing] = { ...arr[existing], ...entry };
  else arr.push({ ...entry, addedAt: new Date().toISOString() });
  savePortfolio(arr);
}
function removeFromPortfolio(ticker) {
  const arr = loadPortfolio().filter(e => e.ticker !== ticker);
  savePortfolio(arr);
}

// Position categories
const PORTFOLIO_POSITIONS = ['Watching', 'Tracking', 'Trading', 'Long', 'Short', 'Sold', 'Avoid'];
// Positions where qty/cost basis matter (P/L is meaningful)
const ACTIVE_POSITIONS = ['Trading', 'Long', 'Short'];

// Portfolio sub-tab state — persists across re-renders
state.portfolioSubTab = state.portfolioSubTab || 'all';

function renderStockBookPortfolio(content) {
  const portfolio = loadPortfolio();
  const sbRows = state.stockbook?.rows || [];

  // Helper: parse changepct from sheet (1.21 → 0.0121)
  function parsePct(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.toUpperCase().startsWith('#')) return null;
    const isNeg = /^\(/.test(s) || /^-/.test(s);
    const n = parseFloat(s.replace(/[%$,\s()+]/g, '').replace(/^-/, ''));
    if (!isFinite(n)) return null;
    return (isNeg ? -n : n) / 100;
  }

  // Compute P/L for a single entry. Returns { plPct, plDollar } or {plPct: null, plDollar: null}
  // Uses ENTRY PRICE (costBasis) — NOT sheet's "P/L since" column.
  // Short positions: P/L = (cost - current) / cost (inverted)
  // P/L % is computed whenever costBasis exists, regardless of position type.
  // P/L $ requires qty too (so only active positions show dollar amounts).
  function computePL(entry, currentPrice) {
    if (!entry.costBasis || !currentPrice || !isFinite(entry.costBasis) || !isFinite(currentPrice)) {
      return { plPct: null, plDollar: null };
    }
    const direction = entry.position === 'Short' ? -1 : 1;
    const plPct = direction * (currentPrice - entry.costBasis) / entry.costBasis;
    const qty = entry.qty || 0;
    const isActive = ACTIVE_POSITIONS.includes(entry.position);
    const plDollar = (isActive && qty > 0)
      ? direction * (currentPrice - entry.costBasis) * qty
      : null;
    return { plPct, plDollar };
  }

  // Join portfolio entries with live stockbook data
  const enriched = portfolio.map(entry => {
    const sbRow = sbRows.find(r => r.ticker === entry.ticker);
    const livePrice = sbRow?.price ?? sbRow?.fmpPrice ?? null;
    const { plPct, plDollar } = computePL(entry, livePrice);
    return { ...entry, sbRow, livePrice, plPct, plDollar };
  });

  // Aggregate stats — only across ACTIVE positions
  let totalCost = 0, totalValue = 0, totalPL = 0;
  let activeCount = 0, watchingCount = 0, trackingCount = 0;
  enriched.forEach(e => {
    if (ACTIVE_POSITIONS.includes(e.position)) {
      activeCount++;
      if (e.qty && e.costBasis) {
        const cost = e.qty * e.costBasis;
        const direction = e.position === 'Short' ? -1 : 1;
        const value = e.qty * (e.livePrice || e.costBasis);
        const positionPL = direction * (value - cost);
        totalCost += cost;
        totalValue += value;
        totalPL += positionPL;
      }
    }
    if (e.position === 'Watching') watchingCount++;
    if (e.position === 'Tracking') trackingCount++;
  });
  const totalPLPct = totalCost > 0 ? totalPL / totalCost : null;

  const fmt$ = v => v == null ? '—' : '$' + v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const fmtPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const fmtMcap = v => !v ? '—' : v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : '$' + (v / 1e6).toFixed(0) + 'M';

  // ── PORTFOLIO PERFORMANCE CHART ──
  // Shows price evolution from entry date for each position.
  // - Active w/ qty: portfolio value (qty × price), shorts inverted
  // - Active w/o qty: equally-weighted index from entry date
  // - Watching/Tracking: price-only, normalized to 100 at entry
  // Always renders when at least 1 position with a ticker that has history exists.
  const chartHtml = enriched.length > 0
    ? `<section class="portfolio-chart-section">
        <div class="portfolio-chart-head">
          <div class="portfolio-chart-title">Position Performance</div>
          <div class="portfolio-range" id="portfolio-range">
            ${['1W', '1M', '3M', '6M', '1Y', '3Y', 'ALL'].map(r =>
              `<button class="portfolio-range-btn ${r === '3M' ? 'active' : ''}" data-range="${r}">${r}</button>`
            ).join('')}
          </div>
        </div>
        <svg id="portfolio-chart-svg" viewBox="0 0 1100 320" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block"></svg>
        <div id="portfolio-chart-legend" style="font-family:var(--mono);font-size:10px;color:var(--ink-dim);margin-top:8px;display:flex;gap:14px;flex-wrap:wrap"></div>
      </section>`
    : '';

  const summary = `
    <div class="portfolio-summary">
      <div class="portfolio-stat">
        <div class="portfolio-stat-label">Positions</div>
        <div class="portfolio-stat-value">${portfolio.length}</div>
        <div class="portfolio-stat-sub">${activeCount} active · ${watchingCount} watching · ${trackingCount} tracking</div>
      </div>
      ${activeCount > 0 ? `
      <div class="portfolio-stat">
        <div class="portfolio-stat-label">Cost Basis</div>
        <div class="portfolio-stat-value">${fmt$(totalCost)}</div>
        <div class="portfolio-stat-sub">across ${activeCount} active</div>
      </div>
      <div class="portfolio-stat">
        <div class="portfolio-stat-label">Market Value</div>
        <div class="portfolio-stat-value">${fmt$(totalValue)}</div>
      </div>
      <div class="portfolio-stat">
        <div class="portfolio-stat-label">Unrealized P/L</div>
        <div class="portfolio-stat-value" style="color:${totalPL >= 0 ? '#5b8a72' : '#a5645a'}">${totalPL >= 0 ? '+' : ''}${fmt$(totalPL)}</div>
        <div class="portfolio-stat-sub" style="color:${totalPL >= 0 ? '#5b8a72' : '#a5645a'}">${totalPLPct != null ? (totalPLPct >= 0 ? '+' : '') + (totalPLPct * 100).toFixed(2) + '%' : ''}</div>
      </div>
      ` : ''}
    </div>
  `;

  // ── PORTFOLIO SUB-TABS ──
  // All / Trading / Watching / Tracking
  const subTabs = `
    <div class="portfolio-subtabs">
      <button class="portfolio-subtab ${state.portfolioSubTab === 'all' ? 'active' : ''}" data-sub="all">All <span class="count">${portfolio.length}</span></button>
      <button class="portfolio-subtab ${state.portfolioSubTab === 'trading' ? 'active' : ''}" data-sub="trading">Trading <span class="count">${enriched.filter(e => ACTIVE_POSITIONS.includes(e.position)).length}</span></button>
      <button class="portfolio-subtab ${state.portfolioSubTab === 'watching' ? 'active' : ''}" data-sub="watching">Watching <span class="count">${watchingCount}</span></button>
      <button class="portfolio-subtab ${state.portfolioSubTab === 'tracking' ? 'active' : ''}" data-sub="tracking">Tracking <span class="count">${trackingCount}</span></button>
    </div>
  `;

  const toolbar = `
    <div class="portfolio-toolbar">
      <button class="btn" id="portfolio-add-btn">+ Add Position</button>
      <button class="btn btn-ghost" id="portfolio-import-watch" title="Add positions from sheet status">Import from Sheet Status</button>
      <button class="btn btn-ghost" id="portfolio-export" title="Download as JSON">Export</button>
    </div>
  `;

  if (portfolio.length === 0) {
    content.innerHTML = summary + toolbar + `
      <div class="empty" style="text-align:center;padding:60px 20px;font-family:var(--mono);font-size:13px;line-height:1.7">
        <div style="color:var(--ink);font-family:var(--serif);font-style:italic;font-size:24px;margin-bottom:14px">Empty Portfolio</div>
        <div style="color:var(--ink-dim);max-width:520px;margin:0 auto">
          Track positions you own, are watching, or are considering.<br>
          Click <strong style="color:var(--amber)">+ Add Position</strong> to start, or pull from your sheet's Status column.
        </div>
      </div>
    `;
    wirePortfolioToolbar();
    return;
  }

  // Filter rows by sub-tab
  let filtered = enriched;
  if (state.portfolioSubTab === 'trading') filtered = enriched.filter(e => ACTIVE_POSITIONS.includes(e.position));
  else if (state.portfolioSubTab === 'watching') filtered = enriched.filter(e => e.position === 'Watching');
  else if (state.portfolioSubTab === 'tracking') filtered = enriched.filter(e => e.position === 'Tracking');

  const positionColor = pos => {
    if (pos === 'Trading' || pos === 'Long') return '#5b8a72';
    if (pos === 'Short') return '#a85a3a';
    if (pos === 'Watching') return '#c4965a';
    if (pos === 'Tracking') return '#7faaca';
    if (pos === 'Sold') return 'var(--ink-faint)';
    if (pos === 'Avoid') return '#a5645a';
    return 'var(--ink)';
  };

  const rowsHtml = filtered.map(e => {
    const r = e.sbRow;
    const todayPct = r?.rawRow ? parsePct(r.rawRow['changepct']) : null;
    const noteCount = (e.notes || []).length;
    const lastNote = noteCount > 0 ? e.notes[e.notes.length - 1] : null;
    const isActive = ACTIVE_POSITIONS.includes(e.position);
    return `
      <tr data-tic="${e.ticker}" data-pos="${e.position || ''}">
        <td class="sb-tic">${e.ticker}</td>
        <td>
          <select class="portfolio-position" data-tic="${e.ticker}" style="color:${positionColor(e.position)};font-weight:600">
            ${PORTFOLIO_POSITIONS.map(p => `<option value="${p}" ${e.position === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </td>
        <td>${r?.name || e.ticker}</td>
        <td>${r?.sector || '—'}</td>
        <td>${e.livePrice != null ? '$' + e.livePrice.toFixed(2) : '—'}</td>
        <td style="color:${todayPct > 0 ? '#5b8a72' : todayPct < 0 ? '#a5645a' : 'var(--ink-dim)'}">${fmtPct(todayPct)}</td>
        <td><input type="number" class="portfolio-qty" data-tic="${e.ticker}" value="${e.qty || ''}" step="any" placeholder="${isActive ? '—' : ''}" style="width:75px" ${!isActive ? 'disabled' : ''}></td>
        <td><input type="number" class="portfolio-cost" data-tic="${e.ticker}" value="${e.costBasis || ''}" step="0.01" placeholder="—" style="width:85px" title="Entry price — drives P/L %"></td>
        <td style="color:${e.plPct == null ? 'var(--ink-faint)' : e.plPct > 0 ? '#5b8a72' : '#a5645a'};font-weight:${e.plPct != null ? '600' : '400'}">${fmtPct(e.plPct)}</td>
        <td style="color:${e.plDollar == null ? 'var(--ink-faint)' : e.plDollar > 0 ? '#5b8a72' : '#a5645a'};font-weight:${e.plDollar != null ? '600' : '400'}">${e.plDollar == null ? '—' : (e.plDollar >= 0 ? '+' : '') + fmt$(e.plDollar)}</td>
        <td>${fmtMcap(r?.marketCap)}</td>
        <td>
          <button class="sb-icon-btn portfolio-notes-btn" data-tic="${e.ticker}" title="${noteCount === 0 ? 'No notes' : `${noteCount} note${noteCount === 1 ? '' : 's'}\nLast: ${lastNote ? lastNote.text.slice(0, 100) : ''}`}">
            ${noteCount === 0 ? '+ Note' : `📝 ${noteCount}`}
          </button>
        </td>
        <td class="sb-action-cell">
          <button class="sb-icon-btn" data-portfolio-act="value" data-tic="${e.ticker}">Value</button>
          <button class="sb-icon-btn danger" data-portfolio-act="remove" data-tic="${e.ticker}">×</button>
        </td>
      </tr>
    `;
  }).join('');

  content.innerHTML = summary + chartHtml + subTabs + toolbar + `
    <div class="sb-table-wrap">
      <table class="sb-table portfolio-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Position</th>
            <th>Name</th>
            <th>Sector</th>
            <th>Last</th>
            <th>Today</th>
            <th>Qty</th>
            <th>Entry Price</th>
            <th>P/L %</th>
            <th>P/L $</th>
            <th>Mkt Cap</th>
            <th>Notes</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="13" style="text-align:center;padding:30px;color:var(--ink-faint);font-style:italic">No positions in this category</td></tr>'}</tbody>
      </table>
    </div>
  `;

  // Wire sub-tabs
  document.querySelectorAll('.portfolio-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.portfolioSubTab = btn.dataset.sub;
      renderStockBookPortfolio(content);
    });
  });

  // Wire range buttons + render the chart
  if (chartHtml) {
    document.querySelectorAll('.portfolio-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.portfolio-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderPortfolioChart(enriched, btn.dataset.range);
      });
    });
    renderPortfolioChart(enriched, '3M');
  }

  wirePortfolioToolbar();
  wirePortfolioRowEvents();
}

// ============================================================
//   PORTFOLIO PERFORMANCE CHART
//   Plots aggregate portfolio value over time. Active positions only.
//   Honors short positions (price up = portfolio down).
//   Watching / Tracking are excluded.
// ============================================================
function renderPortfolioChart(enriched, range) {
  const svg = document.getElementById('portfolio-chart-svg');
  const legend = document.getElementById('portfolio-chart-legend');
  if (!svg) return;

  // Range → calendar days. 'ALL' = use entry date for each position
  const dayMap = { '1W': 7, '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '3Y': 1095 };
  const days = dayMap[range] || null;

  // Pull sheet history
  let sheetHistory = null;
  try {
    const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
    if (cached?.data?.priceHistory) sheetHistory = cached.data.priceHistory;
  } catch {}
  const extCache = loadPriceHistCache();

  function getHist(ticker) {
    if (sheetHistory?.[ticker]?.length >= 2) return sheetHistory[ticker];
    if (extCache[ticker]?.data?.length >= 2) return extCache[ticker].data;
    return null;
  }

  // Filter — drop Sold/Avoid
  const candidates = enriched.filter(e => e.position !== 'Sold' && e.position !== 'Avoid');
  if (candidates.length === 0) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--ink-faint)" font-family="var(--mono)" font-size="11">No positions to chart</text>`;
    if (legend) legend.innerHTML = '';
    return;
  }

  // Determine latest available date across all positions
  let latestDate = null;
  for (const e of candidates) {
    const h = getHist(e.ticker);
    if (h?.length > 0) {
      const last = h[h.length - 1].date;
      if (!latestDate || last > latestDate) latestDate = last;
    }
  }
  if (!latestDate) latestDate = new Date().toISOString().slice(0, 10);
  const latestTime = new Date(latestDate + 'T00:00:00Z').getTime();

  // Per-position normalized window
  // Each position contributes (qty × price) on each date where we have a price.
  // For positions without qty (Watching/Tracking), we synthesize 1-share equivalent
  // so they appear in the chart at their actual price evolution.
  const positionSeries = candidates.map(e => {
    const hist = getHist(e.ticker);
    if (!hist || hist.length < 2) return null;

    // Determine start date
    let startTime;
    if (range === 'ALL') {
      startTime = e.addedAt ? new Date(e.addedAt).getTime() : new Date(hist[0].date + 'T00:00:00Z').getTime();
    } else {
      const cutoff = latestTime - days * 86400000;
      const entryTime = e.addedAt ? new Date(e.addedAt).getTime() : 0;
      startTime = Math.max(cutoff, entryTime);
    }
    const startIso = new Date(startTime).toISOString().slice(0, 10);
    const windowed = hist.filter(p => p.date >= startIso);
    if (windowed.length < 2) return null;

    // Quantity: real qty for active positions, synthetic 1 share for watching/tracking
    const isActive = ACTIVE_POSITIONS.includes(e.position);
    const realQty = isActive && e.qty ? e.qty : null;
    const direction = e.position === 'Short' ? -1 : 1;
    const cost = e.costBasis || windowed[0].price;

    return {
      ticker: e.ticker,
      name: e.sbRow?.name || e.ticker,
      position: e.position,
      qty: realQty,
      direction,
      costBasis: cost,
      windowed,
      isActive,
      hasRealQty: realQty != null,
    };
  }).filter(Boolean);

  if (positionSeries.length === 0) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--ink-faint)" font-family="var(--mono)" font-size="11">No price history available for any positions in this range</text>`;
    if (legend) legend.innerHTML = `<span style="color:var(--ink-faint)">Make sure your sheet's price history columns are populated</span>`;
    return;
  }

  // Build master date timeline (union of all positions' dates)
  const masterDates = new Set();
  positionSeries.forEach(s => s.windowed.forEach(p => masterDates.add(p.date)));
  const sortedDates = Array.from(masterDates).sort();
  if (sortedDates.length < 2) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--ink-faint)" font-family="var(--mono)" font-size="11">Not enough price history in this range</text>`;
    if (legend) legend.innerHTML = '';
    return;
  }

  // Index each position's history by date for fast lookup, then forward-fill
  positionSeries.forEach(s => {
    s.priceByDate = new Map();
    s.windowed.forEach(p => s.priceByDate.set(p.date, p.price));
    // Forward fill: walk sortedDates and carry forward last price
    let lastPrice = s.windowed[0].price;
    s.filledByDate = new Map();
    for (const d of sortedDates) {
      // Only start filling from this position's first available date
      if (d < s.windowed[0].date) continue;
      if (s.priceByDate.has(d)) lastPrice = s.priceByDate.get(d);
      s.filledByDate.set(d, lastPrice);
    }
  });

  // Are there any positions with real quantity? If yes, plot dollar portfolio value.
  // If not, plot synthetic "1 share each" value (useful for pure watch lists).
  const hasAnyRealQty = positionSeries.some(s => s.hasRealQty);

  // Build the aggregate portfolio value series.
  // value(t) = sum over positions of: qty * (cost + direction * (price(t) - cost))
  //                                  = qty * cost + direction * qty * (price(t) - cost)
  // For active positions with real qty: use real qty.
  // For watching/tracking: contribute 1 share at current price (so they show as price evolution).
  const dataPoints = [];
  for (const date of sortedDates) {
    let totalValue = 0;
    let contributors = 0;
    for (const s of positionSeries) {
      const price = s.filledByDate.get(date);
      if (price == null) continue;
      const qty = s.hasRealQty ? s.qty : (hasAnyRealQty ? 0 : 1); // skip watching when active mix
      if (qty === 0) continue;
      // Position value = qty * cost + direction * qty * (price - cost)
      const positionValue = qty * s.costBasis + s.direction * qty * (price - s.costBasis);
      totalValue += positionValue;
      contributors++;
    }
    if (contributors > 0) {
      dataPoints.push({ date, value: totalValue });
    }
  }

  if (dataPoints.length < 2) {
    svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--ink-faint)" font-family="var(--mono)" font-size="11">No data points to plot. ${hasAnyRealQty ? 'Set Qty + Entry Price on active positions.' : 'Add price history to plot.'}</text>`;
    if (legend) legend.innerHTML = '';
    return;
  }

  // ── Render ──
  // Use viewBox so SVG scales to container width. Container width comes from CSS.
  const W = 1100, H = 320;
  const margin = { top: 32, right: 20, bottom: 36, left: 78 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  // Y range — show full dynamic range with padding
  let yMin = Infinity, yMax = -Infinity;
  dataPoints.forEach(p => {
    if (p.value < yMin) yMin = p.value;
    if (p.value > yMax) yMax = p.value;
  });
  const yPad = Math.max((yMax - yMin) * 0.08, yMax * 0.005);
  yMin -= yPad;
  yMax += yPad;

  const xScale = i => margin.left + (i / Math.max(1, dataPoints.length - 1)) * innerW;
  const yScale = v => margin.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Find high + low points
  let hiIdx = 0, loIdx = 0;
  dataPoints.forEach((p, i) => {
    if (p.value > dataPoints[hiIdx].value) hiIdx = i;
    if (p.value < dataPoints[loIdx].value) loIdx = i;
  });
  const hiPoint = dataPoints[hiIdx];
  const loPoint = dataPoints[loIdx];

  // Start + end values
  const startVal = dataPoints[0].value;
  const endVal = dataPoints[dataPoints.length - 1].value;
  const periodChange = endVal - startVal;
  const periodPct = startVal > 0 ? periodChange / startVal : 0;
  const isUp = periodChange >= 0;
  const lineColor = isUp ? '#5b8a72' : '#a5645a';
  const fillColor = isUp ? 'rgba(91, 138, 114, 0.12)' : 'rgba(165, 100, 90, 0.12)';

  // Build the price-line path (stepped or smooth — using straight segments for ticker feel)
  let linePath = '';
  let areaPath = '';
  dataPoints.forEach((p, i) => {
    const x = xScale(i);
    const y = yScale(p.value);
    if (i === 0) {
      linePath = `M ${x.toFixed(2)} ${y.toFixed(2)}`;
      areaPath = `M ${x.toFixed(2)} ${(margin.top + innerH).toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`;
    } else {
      linePath += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
      areaPath += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
  });
  // Close area path
  areaPath += ` L ${xScale(dataPoints.length - 1).toFixed(2)} ${(margin.top + innerH).toFixed(2)} Z`;

  // ── Y grid + labels ──
  const yTicks = [];
  const yRange = yMax - yMin;
  // Smart step size based on range magnitude
  let yStep;
  if (yRange > 1e6) yStep = Math.pow(10, Math.floor(Math.log10(yRange / 5)));
  else if (yRange > 1e3) yStep = Math.pow(10, Math.floor(Math.log10(yRange / 5)));
  else if (yRange > 50) yStep = 10;
  else if (yRange > 10) yStep = 2;
  else if (yRange > 1) yStep = 0.5;
  else yStep = 0.1;
  const yStart = Math.ceil(yMin / yStep) * yStep;
  for (let v = yStart; v <= yMax; v += yStep) yTicks.push(v);

  let s = '';

  // Header: aggregate stats
  const fmt$ = v => {
    const abs = Math.abs(v);
    if (abs >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(2);
  };
  const fmt$L = v => {
    // Long-form for tooltips / Y-axis
    return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  s += `<text x="${margin.left}" y="18" font-family="var(--mono)" font-size="11" fill="var(--ink-dim)">Portfolio Value</text>`;
  s += `<text x="${margin.left + 110}" y="18" font-family="var(--mono)" font-size="15" fill="var(--ink)" font-weight="700">${fmt$L(endVal)}</text>`;
  const changeColor = isUp ? '#5b8a72' : '#a5645a';
  s += `<text x="${margin.left + 110}" y="34" font-family="var(--mono)" font-size="11" fill="${changeColor}" font-weight="600">${isUp ? '+' : ''}${fmt$L(periodChange)} (${(periodPct * 100).toFixed(2)}%)</text>`;

  // High/Low badges on right side
  s += `<g font-family="var(--mono)" font-size="10" text-anchor="end">`;
  s += `<text x="${margin.left + innerW}" y="14" fill="#5b8a72">High: ${fmt$(hiPoint.value)} <tspan fill="var(--ink-faint)">· ${hiPoint.date}</tspan></text>`;
  s += `<text x="${margin.left + innerW}" y="28" fill="#a5645a">Low: ${fmt$(loPoint.value)} <tspan fill="var(--ink-faint)">· ${loPoint.date}</tspan></text>`;
  s += `</g>`;

  // Y grid
  s += `<g stroke="var(--rule)" stroke-width="0.5" stroke-dasharray="2 3" opacity="0.6">`;
  yTicks.forEach(v => {
    const y = yScale(v);
    s += `<line x1="${margin.left}" y1="${y}" x2="${margin.left + innerW}" y2="${y}"/>`;
  });
  s += `</g>`;

  // Y-axis labels (right-aligned to chart's left edge)
  s += `<g font-family="var(--mono)" font-size="10" fill="var(--ink-dim)">`;
  yTicks.forEach(v => {
    const y = yScale(v);
    s += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end">${fmt$(v)}</text>`;
  });
  s += `</g>`;

  // Fill area under line
  s += `<path d="${areaPath}" fill="${fillColor}" stroke="none"/>`;

  // Main price line
  s += `<path d="${linePath}" stroke="${lineColor}" stroke-width="1.8" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Mark high and low with small triangles
  const hiX = xScale(hiIdx), hiY = yScale(hiPoint.value);
  s += `<path d="M ${hiX} ${hiY - 8} l -4 -6 l 8 0 z" fill="#5b8a72" stroke="#0a0908" stroke-width="0.5"/>`;
  const loX = xScale(loIdx), loY = yScale(loPoint.value);
  s += `<path d="M ${loX} ${loY + 8} l -4 6 l 8 0 z" fill="#a5645a" stroke="#0a0908" stroke-width="0.5"/>`;

  // X-axis date labels
  const numXTicks = Math.min(7, dataPoints.length);
  s += `<g font-family="var(--mono)" font-size="10" fill="var(--ink-faint)">`;
  for (let i = 0; i < numXTicks; i++) {
    const idx = Math.floor(i * (dataPoints.length - 1) / (numXTicks - 1));
    const d = dataPoints[idx].date;
    const [y, m, day] = d.split('-');
    const short = `${m}/${day}/${y.slice(2)}`;
    s += `<text x="${xScale(idx)}" y="${margin.top + innerH + 22}" text-anchor="middle">${short}</text>`;
  }
  s += `</g>`;

  // ── HOVER LAYER ──
  // Invisible rect spanning the chart area captures mouse moves
  s += `<rect id="pc-hover-rect" x="${margin.left}" y="${margin.top}" width="${innerW}" height="${innerH}" fill="transparent" style="cursor:crosshair"/>`;
  // Hover overlay (hidden by default)
  s += `<g id="pc-tooltip" style="display:none;pointer-events:none">
    <line id="pc-vline" x1="0" y1="${margin.top}" x2="0" y2="${margin.top + innerH}" stroke="var(--amber)" stroke-width="0.8" stroke-dasharray="3 3"/>
    <circle id="pc-dot" r="5" fill="var(--amber)" stroke="#0a0908" stroke-width="1.5"/>
    <rect id="pc-tip-bg" rx="3" ry="3" fill="#0a0908" stroke="var(--amber)" stroke-width="1" fill-opacity="0.96"/>
    <g id="pc-tip-text"></g>
  </g>`;

  svg.innerHTML = s;

  // Stash context for hover handler
  svg._pcCtx = {
    dataPoints, margin, innerW, innerH,
    xScale, yScale,
    lineColor,
  };

  // Wire mouse handlers (use addEventListener on the rect, not inline)
  const hoverRect = svg.querySelector('#pc-hover-rect');
  if (hoverRect) {
    hoverRect.addEventListener('mousemove', e => {
      const rect = svg.getBoundingClientRect();
      // Translate page-x to SVG viewBox-x
      const vbX = (e.clientX - rect.left) / rect.width * W;
      // Map to data index
      const ratio = (vbX - margin.left) / innerW;
      const idx = Math.max(0, Math.min(dataPoints.length - 1, Math.round(ratio * (dataPoints.length - 1))));
      showPCTooltip(idx);
    });
    hoverRect.addEventListener('mouseleave', () => {
      const tip = document.getElementById('pc-tooltip');
      if (tip) tip.style.display = 'none';
    });
  }

  // ── Legend ──
  if (legend) {
    const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    const legendItems = positionSeries.map(ser => {
      const last = ser.windowed[ser.windowed.length - 1];
      const lastPrice = last?.price ?? ser.costBasis;
      const positionPct = ser.direction * (lastPrice - ser.costBasis) / ser.costBasis;
      const isWatchTrack = ser.position === 'Watching' || ser.position === 'Tracking';
      return `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap">
        <span style="color:var(--amber);font-weight:700">${ser.ticker}</span>
        <span style="color:var(--ink-faint);font-size:9px">${ser.position}${ser.hasRealQty ? ` · ${ser.qty}sh` : ''}</span>
        <span style="color:${positionPct >= 0 ? '#5b8a72' : '#a5645a'};font-weight:600">${fmtPct(positionPct * 100)}</span>
      </span>`;
    }).join('');
    if (!hasAnyRealQty) {
      legend.innerHTML = `<span style="color:var(--ink-faint);font-style:italic">Watch-list mode: 1 share per position</span>` + legendItems;
    } else {
      legend.innerHTML = legendItems;
    }
  }
}

// Portfolio chart hover handler
function showPCTooltip(idx) {
  const svg = document.getElementById('portfolio-chart-svg');
  if (!svg?._pcCtx) return;
  const ctx = svg._pcCtx;
  const pt = ctx.dataPoints[idx];
  if (!pt) return;
  const tip = document.getElementById('pc-tooltip');
  const vline = document.getElementById('pc-vline');
  const dot = document.getElementById('pc-dot');
  const tipBg = document.getElementById('pc-tip-bg');
  const tipText = document.getElementById('pc-tip-text');
  if (!tip) return;

  const cx = ctx.xScale(idx);
  const cy = ctx.yScale(pt.value);
  vline.setAttribute('x1', cx);
  vline.setAttribute('x2', cx);
  dot.setAttribute('cx', cx);
  dot.setAttribute('cy', cy);

  // Compute change from start of visible window for context
  const startVal = ctx.dataPoints[0].value;
  const change = pt.value - startVal;
  const pct = startVal > 0 ? change / startVal : 0;
  const changeColor = change >= 0 ? '#5b8a72' : '#a5645a';

  const fmt$L = v => '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Format date as e.g. "May 4, 2026"
  let prettyDate = pt.date;
  try {
    const d = new Date(pt.date + 'T12:00:00Z');
    prettyDate = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {}

  const lines = [
    { t: prettyDate, color: 'var(--amber)', weight: '700', size: 12 },
    { t: fmt$L(pt.value), color: 'var(--ink)', weight: '700', size: 14 },
    { t: `${change >= 0 ? '+' : ''}${fmt$L(change)} (${(pct * 100).toFixed(2)}%)`, color: changeColor, size: 11 },
  ];

  tipText.innerHTML = '';
  const tipW = 200, lineH = 18;
  const tipH = lines.length * lineH + 10;
  const W = 1100;
  const flipped = (cx + tipW + 16) > (ctx.margin.left + ctx.innerW);
  const bgX = flipped ? cx - tipW - 12 : cx + 12;
  const bgY = Math.max(ctx.margin.top + 4, Math.min(cy - tipH / 2, ctx.margin.top + ctx.innerH - tipH - 4));

  lines.forEach((line, i) => {
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', bgX + 10);
    txt.setAttribute('y', bgY + 16 + i * lineH);
    txt.setAttribute('fill', line.color);
    txt.setAttribute('font-family', 'var(--mono)');
    txt.setAttribute('font-size', line.size || 11);
    if (line.weight) txt.setAttribute('font-weight', line.weight);
    txt.textContent = line.t;
    tipText.appendChild(txt);
  });
  tipBg.setAttribute('x', bgX);
  tipBg.setAttribute('y', bgY);
  tipBg.setAttribute('width', tipW);
  tipBg.setAttribute('height', tipH);
  tip.style.display = '';
}

function wirePortfolioToolbar() {
  document.getElementById('portfolio-add-btn')?.addEventListener('click', () => {
    openAddPositionModal();
  });
  document.getElementById('portfolio-import-watch')?.addEventListener('click', () => {
    const sbRows = state.stockbook?.rows || [];
    // Map sheet status values to portfolio positions
    const statusMap = {
      'trading': 'Trading',
      'long': 'Long',
      'short': 'Short',
      'watching': 'Watching',
      'tracking': 'Tracking',
      'avoid': 'Avoid',
      'sold': 'Sold',
    };
    let added = 0;
    sbRows.forEach(r => {
      const status = (r.status || '').toLowerCase().trim();
      if (statusMap[status]) {
        const existing = loadPortfolio().find(e => e.ticker === r.ticker);
        if (!existing) {
          addToPortfolio({ ticker: r.ticker, position: statusMap[status], notes: [] });
          added++;
        }
      }
    });
    flashStatus(`Imported ${added} positions from sheet status`, 'success');
    renderStockBook();
  });
  document.getElementById('portfolio-export')?.addEventListener('click', () => {
    const data = loadPortfolio();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portfolio-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function wirePortfolioRowEvents() {
  // Position dropdown
  document.querySelectorAll('.portfolio-position').forEach(sel => {
    sel.addEventListener('change', () => {
      const arr = loadPortfolio();
      const e = arr.find(x => x.ticker === sel.dataset.tic);
      if (e) {
        e.position = sel.value;
        // Clear qty if moving to non-active state (qty meaningless for watching/tracking)
        if (!ACTIVE_POSITIONS.includes(sel.value)) e.qty = null;
        savePortfolio(arr);
        renderStockBook(); // re-render so qty disables + P/L re-computes
      }
    });
  });
  // Qty input
  document.querySelectorAll('.portfolio-qty').forEach(inp => {
    inp.addEventListener('change', () => {
      const arr = loadPortfolio();
      const e = arr.find(x => x.ticker === inp.dataset.tic);
      if (e) {
        const v = parseFloat(inp.value);
        e.qty = isFinite(v) ? v : null;
        savePortfolio(arr);
        renderStockBook();
      }
    });
  });
  // Cost basis
  document.querySelectorAll('.portfolio-cost').forEach(inp => {
    inp.addEventListener('change', () => {
      const arr = loadPortfolio();
      const e = arr.find(x => x.ticker === inp.dataset.tic);
      if (e) {
        const v = parseFloat(inp.value);
        e.costBasis = isFinite(v) ? v : null;
        savePortfolio(arr);
        renderStockBook();
      }
    });
  });
  // Notes button → open notes modal
  document.querySelectorAll('.portfolio-notes-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openNotesModal(btn.dataset.tic);
    });
  });
  // Actions
  document.querySelectorAll('[data-portfolio-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tic = btn.dataset.tic;
      const act = btn.dataset.portfolioAct;
      if (act === 'value') {
        switchTab('valuation');
        document.getElementById('ticker').value = tic;
        loadValuation();
      } else if (act === 'remove') {
        if (confirm(`Remove ${tic} from portfolio?`)) {
          removeFromPortfolio(tic);
          renderStockBook();
        }
      }
    });
  });
}

function openAddPositionModal() {
  const sbRows = state.stockbook?.rows || [];
  const datalistOptions = sbRows.map(r =>
    `<option value="${r.ticker}">${r.ticker} — ${escapeHtml(r.name || '')}</option>`
  ).join('');

  const today = new Date().toISOString().slice(0, 10);

  const html = `
    <div class="modal-backdrop" id="portfolio-add-modal" style="display:flex">
      <div class="modal-box" style="max-width:480px">
        <div class="modal-head">
          <div class="modal-title">Add to Portfolio</div>
          <button class="modal-close" onclick="document.getElementById('portfolio-add-modal').remove()">×</button>
        </div>
        <div class="modal-section">
          <div class="modal-label">Ticker</div>
          <input type="text" class="modal-input" id="port-add-tic" list="port-add-tic-list" placeholder="AAPL" autocomplete="off" style="text-transform:uppercase">
          <datalist id="port-add-tic-list">${datalistOptions}</datalist>
        </div>
        <div class="modal-section">
          <div class="modal-label">Position</div>
          <select class="modal-input" id="port-add-pos">
            ${PORTFOLIO_POSITIONS.map(p => `<option value="${p}" ${p === 'Trading' ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
          <div style="font-family:var(--mono);font-size:10px;color:var(--ink-faint);margin-top:6px">
            Trading / Long / Short → P/L calculated · Watching / Tracking → price tracking only
          </div>
        </div>
        <div class="modal-section">
          <div class="modal-label">Entry Date</div>
          <input type="date" class="modal-input" id="port-add-date" value="${today}" max="${today}">
          <div style="font-family:var(--mono);font-size:10px;color:var(--ink-faint);margin-top:6px">
            Defaults to today · set a past date to track since-entry performance
          </div>
        </div>
        <div class="modal-section">
          <div class="modal-label">Entry Price <small style="color:var(--ink-faint);text-transform:none;letter-spacing:0">(auto-fills from price history)</small></div>
          <input type="number" class="modal-input" id="port-add-cost" step="0.01" placeholder="150.50">
        </div>
        <div class="modal-section" id="port-add-qty-section">
          <div class="modal-label">Quantity <small style="color:var(--ink-faint);text-transform:none;letter-spacing:0">(only for active positions)</small></div>
          <input type="number" class="modal-input" id="port-add-qty" step="any" placeholder="100">
        </div>
        <div class="modal-section">
          <div class="modal-label">Notes (optional)</div>
          <input type="text" class="modal-input" id="port-add-notes" placeholder="thesis, entry reason, target…">
        </div>
        <div class="modal-section" style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--rule);padding-top:14px">
          <button class="btn btn-ghost" onclick="document.getElementById('portfolio-add-modal').remove()">Cancel</button>
          <button class="btn" id="port-add-save">Add</button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('port-add-tic').focus();

  // Auto-fill entry price from sheet history when ticker + date change
  const autoFillCost = () => {
    const tic = document.getElementById('port-add-tic').value.trim().toUpperCase();
    const dateStr = document.getElementById('port-add-date').value;
    const costInput = document.getElementById('port-add-cost');
    if (!tic || !dateStr) return;
    if (costInput.value && costInput.dataset.userEdited === '1') return; // don't clobber user input
    const hist = getHistoryForTicker(tic);
    if (!hist || hist.length === 0) return;
    // Find the bar at or before the entry date (binary search)
    let lo = 0, hi = hist.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hist[mid].date <= dateStr) { best = hist[mid]; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best) {
      costInput.value = best.price.toFixed(2);
      costInput.placeholder = `${best.price.toFixed(2)} (from ${best.date})`;
    }
  };
  document.getElementById('port-add-tic').addEventListener('change', autoFillCost);
  document.getElementById('port-add-tic').addEventListener('blur', autoFillCost);
  document.getElementById('port-add-date').addEventListener('change', autoFillCost);
  // Track if user manually edited the cost so we don't overwrite it
  document.getElementById('port-add-cost').addEventListener('input', e => {
    e.target.dataset.userEdited = '1';
  });

  // Disable qty for non-active positions
  const togglePositionFields = () => {
    const pos = document.getElementById('port-add-pos').value;
    const isActive = ACTIVE_POSITIONS.includes(pos);
    const qtyInput = document.getElementById('port-add-qty');
    const qtySection = document.getElementById('port-add-qty-section');
    qtyInput.disabled = !isActive;
    qtySection.style.opacity = isActive ? '1' : '0.4';
    if (!isActive) qtyInput.value = '';
  };
  document.getElementById('port-add-pos').addEventListener('change', togglePositionFields);
  togglePositionFields();

  document.getElementById('port-add-save').addEventListener('click', () => {
    const tic = document.getElementById('port-add-tic').value.trim().toUpperCase();
    if (!tic) { alert('Ticker required'); return; }
    const pos = document.getElementById('port-add-pos').value;
    const dateStr = document.getElementById('port-add-date').value;
    // Convert YYYY-MM-DD → noon UTC ISO so timezone doesn't shift the date
    const addedAt = dateStr ? new Date(dateStr + 'T12:00:00Z').toISOString() : new Date().toISOString();
    const qty = ACTIVE_POSITIONS.includes(pos)
      ? (parseFloat(document.getElementById('port-add-qty').value) || null)
      : null;
    const cost = parseFloat(document.getElementById('port-add-cost').value) || null;
    const notesText = document.getElementById('port-add-notes').value.trim();
    const notes = notesText
      ? [{ ts: new Date().toISOString(), text: notesText, priceAtNote: cost }]
      : [];
    addToPortfolio({ ticker: tic, position: pos, qty, costBasis: cost, notes, addedAt });
    document.getElementById('portfolio-add-modal').remove();
    flashStatus(`${tic} added to portfolio`, 'success');
    renderStockBook();
  });
}

// ============================================================
//   BONDS & TREASURIES TAB
//   Data sources:
//   - U.S. Treasury Fiscal Data API (no key, official, CORS open)
//   - FRED (already integrated for macro)
//   - Sheet (for any bond ETFs the user tracks)
// ============================================================

const BONDS_CACHE_KEY = 'valuatio.bonds.v1';
const BONDS_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

state.bonds = { data: null, loaded: false };

function loadBondsCache() {
  try {
    const raw = localStorage.getItem(BONDS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.fetchedAt > BONDS_CACHE_TTL_MS) return null;
    return parsed;
  } catch { return null; }
}
function saveBondsCache(data) {
  try {
    localStorage.setItem(BONDS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), ...data }));
  } catch {}
}

// Fetch Daily Treasury Yield Curve Rates from Treasury Fiscal Data
// Returns: array of {date, "1mo", "2mo", "3mo", "6mo", "1yr", "2yr", "3yr", "5yr", "7yr", "10yr", "20yr", "30yr"}
// Proxy-aware fetcher for endpoints that may block CORS.
// Tries direct first (some browsers/networks allow it), then falls back through
// the same proxy chain we use for FRED. Returns parsed JSON or null.
async function fetchJsonWithProxies(targetUrl) {
  const proxies = [
    u => u, // direct (works in some envs)
    u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    u => `https://thingproxy.freeboard.io/fetch/${u}`,
    u => `https://proxy.cors.sh/${u}`,
    u => `https://api.cors.lol/?url=${encodeURIComponent(u)}`,
    u => `https://yacdn.org/serve/${u}`,
  ];
  const errors = [];
  for (let i = 0; i < proxies.length; i++) {
    const url = proxies[i](targetUrl);
    const wrapped = i === 5;
    try {
      const r = await fetch(url, {
        headers: { 'Accept': 'application/json,*/*', 'x-cors-api-key': 'temp_anything' },
      });
      if (!r.ok) {
        errors.push(`proxy ${i}: HTTP ${r.status}`);
        continue;
      }
      let json;
      if (wrapped) {
        const wrap = await r.json().catch(() => null);
        if (!wrap?.contents) { errors.push(`proxy ${i}: empty wrapped`); continue; }
        try { json = JSON.parse(wrap.contents); } catch { errors.push(`proxy ${i}: bad JSON in wrapper`); continue; }
      } else {
        json = await r.json();
      }
      if (json) {
        if (i > 0) console.log(`✓ Reached ${targetUrl.slice(0, 80)}… via proxy ${i}`);
        return json;
      }
    } catch (e) {
      errors.push(`proxy ${i}: ${e.message}`);
    }
  }
  console.error(`All proxies failed for ${targetUrl}:`, errors.join(' · '));
  return null;
}

// FRED FALLBACK for the yield curve — assembles tenors from FRED CSV endpoints
// since FRED is more proxy-friendly than fiscaldata.treasury.gov.
const FRED_YIELD_SERIES = {
  '1mo':  'DGS1MO',  '2mo':  'DGS2MO',  '3mo':  'DGS3MO',  '6mo':  'DGS6MO',
  '1yr':  'DGS1',    '2yr':  'DGS2',    '3yr':  'DGS3',    '5yr':  'DGS5',
  '7yr':  'DGS7',    '10yr': 'DGS10',   '20yr': 'DGS20',   '30yr': 'DGS30',
};

async function fetchFredYieldCurve() {
  const tenors = Object.keys(FRED_YIELD_SERIES);
  const results = await Promise.all(
    tenors.map(t => fetchFredSeries(FRED_YIELD_SERIES[t]).catch(() => null))
  );
  const byDate = {};
  tenors.forEach((tenor, i) => {
    const series = results[i];
    if (!series) return;
    const recent = series.slice(-120);
    recent.forEach(pt => {
      if (!byDate[pt.date]) byDate[pt.date] = { date: pt.date };
      byDate[pt.date][tenor] = pt.value;
    });
  });
  const arr = Object.values(byDate)
    .filter(row => Object.keys(row).length > 1)
    .sort((a, b) => a.date.localeCompare(b.date));
  return arr.length > 0 ? arr : null;
}

// STOOQ FALLBACK — last resort. Stooq publishes daily CSV for treasury yields:
//   ^IRX = 13-week (≈3mo), ^FVX = 5yr, ^TNX = 10yr, ^TYX = 30yr
// Doesn't cover all tenors but enough for a usable curve.
const STOOQ_YIELD_SERIES = {
  '3mo':  '^irx',
  '5yr':  '^fvx',
  '10yr': '^tnx',
  '30yr': '^tyx',
};

async function fetchStooqYieldCurve() {
  const tenors = Object.keys(STOOQ_YIELD_SERIES);
  const results = await Promise.all(tenors.map(async tenor => {
    const symbol = STOOQ_YIELD_SERIES[tenor];
    try {
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
      const r = await fetch(url);
      if (!r.ok) return null;
      const text = await r.text();
      // CSV: Date,Open,High,Low,Close,Volume
      const lines = text.trim().split('\n');
      if (lines.length < 2) return null;
      // Take last 90 days
      const recent = lines.slice(-90);
      return recent.map(line => {
        const cells = line.split(',');
        if (cells.length < 5) return null;
        const date = cells[0];
        const close = parseFloat(cells[4]);
        if (!date.match(/^\d{4}-\d{2}-\d{2}$/) || !isFinite(close)) return null;
        // Stooq returns ^TNX as actual percentage value (4.50 = 4.50%)
        return { date, value: close };
      }).filter(Boolean);
    } catch { return null; }
  }));

  const byDate = {};
  tenors.forEach((tenor, i) => {
    const series = results[i];
    if (!series) return;
    series.forEach(pt => {
      if (!byDate[pt.date]) byDate[pt.date] = { date: pt.date };
      byDate[pt.date][tenor] = pt.value;
    });
  });
  const arr = Object.values(byDate)
    .filter(row => Object.keys(row).length > 1)
    .sort((a, b) => a.date.localeCompare(b.date));
  return arr.length > 0 ? arr : null;
}

async function fetchTreasuryYieldCurve() {
  const endpoint = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/daily_treasury_yield_curve_rates';
  const params = new URLSearchParams({
    sort: '-record_date',
    'page[size]': '90',
  });
  const j = await fetchJsonWithProxies(`${endpoint}?${params}`);
  if (j?.data && Array.isArray(j.data)) {
    return j.data.map(row => ({
      date: row.record_date,
      '1mo':  parseFloat(row.bc_1month) || null,
      '2mo':  parseFloat(row.bc_2month) || null,
      '3mo':  parseFloat(row.bc_3month) || null,
      '6mo':  parseFloat(row.bc_6month) || null,
      '1yr':  parseFloat(row.bc_1year)  || null,
      '2yr':  parseFloat(row.bc_2year)  || null,
      '3yr':  parseFloat(row.bc_3year)  || null,
      '5yr':  parseFloat(row.bc_5year)  || null,
      '7yr':  parseFloat(row.bc_7year)  || null,
      '10yr': parseFloat(row.bc_10year) || null,
      '20yr': parseFloat(row.bc_20year) || null,
      '30yr': parseFloat(row.bc_30year) || null,
    })).reverse();
  }

  // Treasury blocked — fall back to FRED
  console.log('Treasury yield curve unreachable, falling back to FRED…');
  const fred = await fetchFredYieldCurve();
  if (fred && fred.length > 0) return fred;

  // FRED also blocked — last resort: Stooq (4 tenors only)
  console.log('FRED unreachable, falling back to Stooq…');
  const stooq = await fetchStooqYieldCurve();
  if (stooq && stooq.length > 0) {
    console.log(`✓ Stooq returned ${stooq.length} days of yields (3M / 5Y / 10Y / 30Y only)`);
    return stooq;
  }

  return null;
}

async function fetchTreasuryAvgRates() {
  const endpoint = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates';
  const params = new URLSearchParams({
    sort: '-record_date',
    'page[size]': '180',
  });
  const j = await fetchJsonWithProxies(`${endpoint}?${params}`);
  return Array.isArray(j?.data) ? j.data : null;
}

async function fetchPublicDebt() {
  const endpoint = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny';
  const params = new URLSearchParams({
    sort: '-record_date',
    'page[size]': '30',
  });
  const j = await fetchJsonWithProxies(`${endpoint}?${params}`);
  if (j?.data && Array.isArray(j.data) && j.data.length > 0) {
    const mapped = j.data.map(row => ({
      date: row.record_date,
      total: parseFloat(row.tot_pub_debt_out_amt),
      held_by_public: parseFloat(row.debt_held_public_amt),
      intragov: parseFloat(row.intragov_hold_amt),
    })).filter(r => isFinite(r.total) && r.total > 0);
    if (mapped.length > 0) return mapped;
  }

  // Treasury blocked — fall back to FRED series GFDEBTN (Total Federal Debt)
  // FRED has it quarterly. Returns billions, we convert to dollars.
  console.log('Public debt unreachable via Treasury, falling back to FRED GFDEBTN…');
  try {
    const fredData = await fetchFredSeries('GFDEBTN');
    if (fredData && fredData.length > 0) {
      // GFDEBTN is in millions — convert to actual dollars
      const recent = fredData.slice(-30);
      return recent.reverse().map(pt => ({
        date: pt.date,
        total: pt.value * 1e6, // millions → dollars
        held_by_public: null,
        intragov: null,
      }));
    }
  } catch (e) {
    console.error('FRED fallback for debt also failed:', e);
  }
  return null;
}

// Bond ETFs to track (list with their general categories)
const BOND_ETFS = [
  { ticker: 'TLT',  name: 'iShares 20+ Year Treasury Bond ETF',     category: 'Long Treasury' },
  { ticker: 'IEF',  name: 'iShares 7-10 Year Treasury Bond ETF',    category: 'Mid Treasury' },
  { ticker: 'SHY',  name: 'iShares 1-3 Year Treasury Bond ETF',     category: 'Short Treasury' },
  { ticker: 'BIL',  name: 'SPDR Bloomberg 1-3 Month T-Bill ETF',    category: 'T-Bills' },
  { ticker: 'GOVT', name: 'iShares U.S. Treasury Bond ETF',         category: 'Broad Treasury' },
  { ticker: 'TIP',  name: 'iShares TIPS Bond ETF',                  category: 'TIPS' },
  { ticker: 'SCHP', name: 'Schwab U.S. TIPS ETF',                   category: 'TIPS' },
  { ticker: 'AGG',  name: 'iShares Core U.S. Aggregate Bond ETF',   category: 'Aggregate' },
  { ticker: 'BND',  name: 'Vanguard Total Bond Market ETF',         category: 'Aggregate' },
  { ticker: 'LQD',  name: 'iShares iBoxx Investment Grade Corp',    category: 'IG Corporate' },
  { ticker: 'HYG',  name: 'iShares iBoxx High Yield Corporate',     category: 'High Yield' },
  { ticker: 'JNK',  name: 'SPDR Bloomberg High Yield Bond ETF',     category: 'High Yield' },
  { ticker: 'MBB',  name: 'iShares MBS ETF',                        category: 'Mortgage-Backed' },
  { ticker: 'EMB',  name: 'iShares JPM USD EM Bond ETF',            category: 'EM Bonds' },
  { ticker: 'BNDX', name: 'Vanguard Total International Bond ETF',  category: 'Intl Bonds' },
  { ticker: 'VCSH', name: 'Vanguard Short-Term Corporate Bond',     category: 'Short Corporate' },
];

// ============================================================
//   RENDER YIELD CURVE SVG
// ============================================================
const YC_TENORS = [
  { key: '1mo',  months: 1 },
  { key: '2mo',  months: 2 },
  { key: '3mo',  months: 3 },
  { key: '6mo',  months: 6 },
  { key: '1yr',  months: 12 },
  { key: '2yr',  months: 24 },
  { key: '3yr',  months: 36 },
  { key: '5yr',  months: 60 },
  { key: '7yr',  months: 84 },
  { key: '10yr', months: 120 },
  { key: '20yr', months: 240 },
  { key: '30yr', months: 360 },
];

function renderYieldCurveSvg(yieldCurveData) {
  const svg = document.getElementById('yield-curve-svg');
  if (!svg || !yieldCurveData || yieldCurveData.length === 0) return;

  const W = 900, H = 360;
  const margin = { top: 50, right: 60, bottom: 50, left: 60 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;

  const today = yieldCurveData[yieldCurveData.length - 1];
  // Find ~1 month ago and ~1 year ago for comparison
  const findByDaysAgo = (days) => {
    const targetDate = new Date(today.date);
    targetDate.setDate(targetDate.getDate() - days);
    const targetIso = targetDate.toISOString().slice(0, 10);
    let best = null;
    for (let i = yieldCurveData.length - 1; i >= 0; i--) {
      if (yieldCurveData[i].date <= targetIso) { best = yieldCurveData[i]; break; }
    }
    return best;
  };
  const month1 = findByDaysAgo(30);
  const year1  = yieldCurveData[0]; // ~90 days back is the oldest we fetched

  // X axis: log scale on months for readability
  const minM = 1, maxM = 360;
  const logMin = Math.log(minM), logMax = Math.log(maxM);
  const xScale = m => margin.left + ((Math.log(m) - logMin) / (logMax - logMin)) * innerW;

  // Y axis: yields from 0 to max+0.5
  const allYields = YC_TENORS.flatMap(t => [today[t.key], month1?.[t.key], year1?.[t.key]]).filter(v => v != null);
  const yMax = Math.ceil((Math.max(...allYields, 5) + 0.5) * 2) / 2;
  const yMin = 0;
  const yScale = y => margin.top + innerH - ((y - yMin) / (yMax - yMin)) * innerH;

  function curvePath(rec) {
    if (!rec) return '';
    let d = '';
    let started = false;
    for (const t of YC_TENORS) {
      const v = rec[t.key];
      if (v == null) continue;
      const x = xScale(t.months);
      const y = yScale(v);
      d += (started ? ' L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1);
      started = true;
    }
    return d;
  }

  let s = '';
  // Title
  s += `<text class="yc-title" x="${margin.left}" y="28">Yield Curve · ${today.date}</text>`;

  // Grid
  s += `<g class="yc-grid">`;
  for (let y = 0; y <= yMax; y += 1) {
    const yp = yScale(y);
    s += `<line x1="${margin.left}" y1="${yp}" x2="${margin.left + innerW}" y2="${yp}"/>`;
  }
  s += `</g>`;

  // Axes
  s += `<g class="yc-axis">`;
  s += `<line x1="${margin.left}" y1="${margin.top + innerH}" x2="${margin.left + innerW}" y2="${margin.top + innerH}"/>`;
  s += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerH}"/>`;
  // X tick labels
  YC_TENORS.forEach(t => {
    const x = xScale(t.months);
    s += `<line x1="${x}" y1="${margin.top + innerH}" x2="${x}" y2="${margin.top + innerH + 4}"/>`;
    s += `<text x="${x}" y="${margin.top + innerH + 18}" text-anchor="middle">${t.key}</text>`;
  });
  // Y tick labels
  for (let y = 0; y <= yMax; y += 1) {
    const yp = yScale(y);
    s += `<text x="${margin.left - 8}" y="${yp + 4}" text-anchor="end">${y.toFixed(1)}%</text>`;
  }
  s += `</g>`;

  // Curves: 1-year ago, 1-month ago, today
  if (year1)  s += `<path class="yc-curve-1y" d="${curvePath(year1)}"/>`;
  if (month1) s += `<path class="yc-curve-1m" d="${curvePath(month1)}"/>`;
  s += `<path class="yc-curve-current" d="${curvePath(today)}"/>`;

  // Today's points + values
  YC_TENORS.forEach(t => {
    const v = today[t.key];
    if (v == null) return;
    const x = xScale(t.months);
    const y = yScale(v);
    s += `<circle class="yc-point" cx="${x}" cy="${y}" r="3.5"/>`;
    if (['3mo', '2yr', '10yr', '30yr'].includes(t.key)) {
      s += `<text class="yc-label" x="${x}" y="${y - 10}" text-anchor="middle">${v.toFixed(2)}%</text>`;
    }
  });

  // Legend
  const lx = margin.left + 14;
  const ly = margin.top + 14;
  s += `<line x1="${lx}" y1="${ly}" x2="${lx + 22}" y2="${ly}" stroke="var(--amber)" stroke-width="2.5"/>`;
  s += `<text class="yc-label" x="${lx + 28}" y="${ly + 4}" fill="var(--ink)">Today</text>`;
  if (month1) {
    s += `<line x1="${lx}" y1="${ly + 14}" x2="${lx + 22}" y2="${ly + 14}" stroke="#6b8aac" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    s += `<text class="yc-label" x="${lx + 28}" y="${ly + 18}" fill="#6b8aac">${month1.date.slice(0, 10)} (1m ago)</text>`;
  }
  if (year1) {
    s += `<line x1="${lx}" y1="${ly + 28}" x2="${lx + 22}" y2="${ly + 28}" stroke="#a85a3a" stroke-width="1.5" stroke-dasharray="6 4"/>`;
    s += `<text class="yc-label" x="${lx + 28}" y="${ly + 32}" fill="#a85a3a">${year1.date.slice(0, 10)} (oldest)</text>`;
  }

  // ── HOVER LAYER ──
  // Per-tenor invisible hit zones for hover tooltips
  s += `<g id="yc-hover-layer">`;
  YC_TENORS.forEach((t, idx) => {
    const x = xScale(t.months);
    const halfL = idx > 0 ? (xScale(t.months) - xScale(YC_TENORS[idx - 1].months)) / 2 : 18;
    const halfR = idx < YC_TENORS.length - 1 ? (xScale(YC_TENORS[idx + 1].months) - xScale(t.months)) / 2 : 18;
    s += `<rect x="${x - halfL}" y="${margin.top}" width="${halfL + halfR}" height="${innerH}"
                fill="transparent" style="cursor:crosshair"
                onmouseover="showYCTooltip('${t.key}', ${x})"
                onmouseout="hideYCTooltip()"/>`;
  });
  s += `</g>`;

  // Crosshair line + tooltip — hidden by default
  s += `<g id="yc-tooltip-group" style="display:none;pointer-events:none">
    <line id="yc-vline" x1="0" y1="${margin.top}" x2="0" y2="${margin.top + innerH}" stroke="var(--amber)" stroke-width="0.8" stroke-dasharray="3 3"/>
    <g id="yc-dots"></g>
    <rect id="yc-tip-bg" rx="3" ry="3" fill="#0a0908" stroke="var(--amber)" stroke-width="1" fill-opacity="0.96"/>
    <g id="yc-tip-text"></g>
  </g>`;

  svg.innerHTML = s;

  // Stash data for hover handler
  svg._ycCtx = {
    today, month1, year1,
    margin, innerW, innerH,
    xScale, yScale,
  };
}

// Yield curve hover handlers
window.showYCTooltip = function(tenorKey, cx) {
  const svg = document.getElementById('yield-curve-svg');
  if (!svg?._ycCtx) return;
  const ctx = svg._ycCtx;
  const grp = document.getElementById('yc-tooltip-group');
  const vline = document.getElementById('yc-vline');
  const dotsG = document.getElementById('yc-dots');
  const tipBg = document.getElementById('yc-tip-bg');
  const tipTextG = document.getElementById('yc-tip-text');
  if (!grp) return;

  vline.setAttribute('x1', cx);
  vline.setAttribute('x2', cx);

  dotsG.innerHTML = '';
  tipTextG.innerHTML = '';

  const lines = [{ t: `${tenorKey.toUpperCase()} Tenor`, color: 'var(--amber)', weight: '700', size: '12' }];
  const tenorLabel = YC_TENORS.find(x => x.key === tenorKey)?.key.toUpperCase() || tenorKey;

  // Today
  if (ctx.today?.[tenorKey] != null) {
    const v = ctx.today[tenorKey];
    const y = ctx.yScale(v);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', y);
    dot.setAttribute('r', '5');
    dot.setAttribute('fill', 'var(--amber)');
    dot.setAttribute('stroke', '#0a0908');
    dot.setAttribute('stroke-width', '1.5');
    dotsG.appendChild(dot);
    lines.push({ t: `Today: ${v.toFixed(3)}%`, color: 'var(--amber)', weight: '700' });
    lines.push({ t: ctx.today.date, color: 'var(--ink-faint)', size: '10' });
  }
  // 1m ago
  if (ctx.month1?.[tenorKey] != null) {
    const v = ctx.month1[tenorKey];
    const y = ctx.yScale(v);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', y);
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', '#6b8aac');
    dot.setAttribute('stroke', '#0a0908');
    dot.setAttribute('stroke-width', '1.5');
    dotsG.appendChild(dot);
    const todayVal = ctx.today?.[tenorKey];
    const delta = todayVal != null ? (todayVal - v) * 100 : null;
    lines.push({
      t: `1m ago: ${v.toFixed(3)}%${delta != null ? `  (${delta >= 0 ? '+' : ''}${delta.toFixed(0)} bp)` : ''}`,
      color: '#6b8aac',
    });
  }
  // Year ago / oldest
  if (ctx.year1?.[tenorKey] != null) {
    const v = ctx.year1[tenorKey];
    const y = ctx.yScale(v);
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', y);
    dot.setAttribute('r', '4');
    dot.setAttribute('fill', '#a85a3a');
    dot.setAttribute('stroke', '#0a0908');
    dot.setAttribute('stroke-width', '1.5');
    dotsG.appendChild(dot);
    const todayVal = ctx.today?.[tenorKey];
    const delta = todayVal != null ? (todayVal - v) * 100 : null;
    lines.push({
      t: `${ctx.year1.date.slice(0, 10)}: ${v.toFixed(3)}%${delta != null ? `  (${delta >= 0 ? '+' : ''}${delta.toFixed(0)} bp)` : ''}`,
      color: '#a85a3a',
    });
  }

  // Render text
  const lineH = 14;
  const tipH = lines.length * lineH + 14;
  const tipW = 220;
  const flipped = (cx + tipW + 14) > (ctx.margin.left + ctx.innerW);
  const bgX = flipped ? cx - tipW - 8 : cx + 10;
  const tipY = ctx.margin.top + 10;

  lines.forEach((line, i) => {
    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', bgX + 10);
    txt.setAttribute('y', tipY + 14 + i * lineH);
    txt.setAttribute('fill', line.color);
    txt.setAttribute('font-family', 'var(--mono)');
    txt.setAttribute('font-size', line.size || '11');
    if (line.weight) txt.setAttribute('font-weight', line.weight);
    txt.textContent = line.t;
    tipTextG.appendChild(txt);
  });

  tipBg.setAttribute('x', bgX);
  tipBg.setAttribute('y', tipY);
  tipBg.setAttribute('width', tipW);
  tipBg.setAttribute('height', tipH);
  grp.style.display = '';
};

window.hideYCTooltip = function() {
  const grp = document.getElementById('yc-tooltip-group');
  if (grp) grp.style.display = 'none';
};

// Render the yield curve table + key spreads (2s10s, 3m10y, etc.)
function renderYieldCurveTable(yieldCurveData) {
  const wrap = document.getElementById('yc-table-wrap');
  if (!wrap || !yieldCurveData || yieldCurveData.length === 0) return;
  const today = yieldCurveData[yieldCurveData.length - 1];

  const findByDaysAgo = (days) => {
    const targetDate = new Date(today.date);
    targetDate.setDate(targetDate.getDate() - days);
    const targetIso = targetDate.toISOString().slice(0, 10);
    for (let i = yieldCurveData.length - 1; i >= 0; i--) {
      if (yieldCurveData[i].date <= targetIso) return yieldCurveData[i];
    }
    return null;
  };
  const yesterday = yieldCurveData.length >= 2 ? yieldCurveData[yieldCurveData.length - 2] : null;
  const week1 = findByDaysAgo(7);
  const month1 = findByDaysAgo(30);
  const month3 = findByDaysAgo(90);

  // Spreads: 10y-2y, 10y-3m, 30y-5y, 5y-2y
  const spread = (a, b, rec) => (rec?.[a] != null && rec?.[b] != null) ? rec[a] - rec[b] : null;
  const spreads = [
    { label: '10Y - 2Y',  value: spread('10yr', '2yr',  today), ref: '< 0 = inverted (recession signal)' },
    { label: '10Y - 3M',  value: spread('10yr', '3mo',  today), ref: '< 0 = NY Fed recession indicator' },
    { label: '30Y - 5Y',  value: spread('30yr', '5yr',  today), ref: 'Long-end steepness' },
    { label: '5Y - 2Y',   value: spread('5yr',  '2yr',  today), ref: 'Belly steepness' },
  ];

  const fmtRow = (label, key) => {
    const t = today[key];
    const y = yesterday?.[key];
    const w = week1?.[key];
    const m = month1?.[key];
    const m3 = month3?.[key];
    const dDay = (t != null && y != null) ? (t - y) * 100 : null; // bps
    const dWeek = (t != null && w != null) ? (t - w) * 100 : null;
    const dMonth = (t != null && m != null) ? (t - m) * 100 : null;
    const d3M = (t != null && m3 != null) ? (t - m3) * 100 : null;
    const fmtBp = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(0) + ' bp';
    const cls = v => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';
    return `
      <tr>
        <td>${label}</td>
        <td>${t != null ? t.toFixed(2) + '%' : '—'}</td>
        <td class="${cls(dDay)}">${fmtBp(dDay)}</td>
        <td class="${cls(dWeek)}">${fmtBp(dWeek)}</td>
        <td class="${cls(dMonth)}">${fmtBp(dMonth)}</td>
        <td class="${cls(d3M)}">${fmtBp(d3M)}</td>
      </tr>
    `;
  };

  wrap.innerHTML = `
    <div class="yc-spreads">
      ${spreads.map(s => {
        const cls = s.value == null ? '' : s.value < 0 ? 'inverted' : 'normal';
        return `
          <div class="yc-spread-tile">
            <div class="yc-spread-label">${s.label}</div>
            <div class="yc-spread-value ${cls}">${s.value == null ? '—' : (s.value >= 0 ? '+' : '') + (s.value * 100).toFixed(0) + ' bp'}</div>
            <div class="yc-spread-sub">${s.ref}</div>
          </div>
        `;
      }).join('')}
    </div>
    <table class="bonds-table" style="margin-top:12px">
      <thead>
        <tr>
          <th>Tenor</th>
          <th>Yield</th>
          <th>Δ 1D</th>
          <th>Δ 1W</th>
          <th>Δ 1M</th>
          <th>Δ 3M</th>
        </tr>
      </thead>
      <tbody>
        ${YC_TENORS.map(t => fmtRow(t.key.toUpperCase(), t.key)).join('')}
      </tbody>
    </table>
  `;
}

// Render bond ETF table — pulls from sheet first, falls back to external if available
async function renderBondEtfTable() {
  const wrap = document.getElementById('bond-etf-table-wrap');
  if (!wrap) return;

  // Make sure stockbook is loaded so we can look up sheet prices
  if ((state.stockbook?.rows?.length ?? 0) === 0) {
    try { await loadStockBook(false); } catch {}
  }

  // Helper: parse changepct cell (always /100)
  function parsePctCell(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.toUpperCase().startsWith('#')) return null;
    const isNeg = /^\(/.test(s) || /^-/.test(s);
    const n = parseFloat(s.replace(/[%$,\s()+]/g, '').replace(/^-/, ''));
    if (!isFinite(n)) return null;
    return (isNeg ? -n : n) / 100;
  }

  // Pull sheet history for fallback
  let sheetHistory = null;
  try {
    const cached = JSON.parse(localStorage.getItem(SHEET_CACHE_KEY) || 'null');
    if (cached?.data?.priceHistory) sheetHistory = cached.data.priceHistory;
  } catch {}

  const rows = BOND_ETFS.map(etf => {
    const sbRow = state.stockbook?.rows?.find(r => r.ticker === etf.ticker);
    const sheetSeries = sheetHistory?.[etf.ticker];
    let price = null, r1d = null, r1m = null, r3m = null, r1y = null;

    if (sbRow?.price != null) price = sbRow.price;
    else if (sheetSeries?.length) price = sheetSeries[sheetSeries.length - 1].price;

    if (sbRow?.rawRow) r1d = parsePctCell(sbRow.rawRow['changepct']);
    if (r1d == null && sheetSeries?.length >= 2) r1d = priceChangeOverDays(sheetSeries, 1);
    if (sheetSeries?.length >= 2) {
      r1m = priceChangeOverDays(sheetSeries, 30);
      r3m = priceChangeOverDays(sheetSeries, 91);
      r1y = priceChangeOverDays(sheetSeries, 365);
    }

    return { ...etf, price, r1d, r1m, r3m, r1y, inSheet: !!sbRow };
  });

  // Group by category
  const byCategory = {};
  rows.forEach(r => {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  });

  const fmtPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const fmtPrice = v => v == null ? '—' : '$' + v.toFixed(2);
  const cls = v => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';

  const inSheetCount = rows.filter(r => r.inSheet).length;
  const note = inSheetCount === 0 ? `
    <p style="color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.6;margin-bottom:14px;padding:12px;border-left:2px solid var(--amber);background:rgba(212,162,76,0.05)">
      None of these bond ETFs found in your sheet. Add them to your published Google Sheet to track prices and returns here.
      Recommended: TLT, IEF, SHY, AGG, LQD, HYG, TIP — covers most bond exposures.
    </p>
  ` : `
    <p style="color:var(--ink-faint);font-family:var(--mono);font-size:10px;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:10px">
      ${inSheetCount} of ${rows.length} found in your sheet
    </p>
  `;

  wrap.innerHTML = note + `
    <div class="bonds-table-wrap">
      <table class="bonds-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Name</th>
            <th>Category</th>
            <th>Price</th>
            <th>1D</th>
            <th>1M</th>
            <th>3M</th>
            <th>1Y</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr style="cursor:${r.inSheet ? 'pointer' : 'default'};opacity:${r.inSheet ? 1 : 0.5}"
                ${r.inSheet ? `onclick="executeCommand('${r.ticker}')"` : ''}>
              <td style="color:var(--amber);font-weight:700">${r.ticker}</td>
              <td>${r.name}</td>
              <td style="color:var(--ink-dim)">${r.category}</td>
              <td>${fmtPrice(r.price)}</td>
              <td class="${cls(r.r1d)}">${fmtPct(r.r1d)}</td>
              <td class="${cls(r.r1m)}">${fmtPct(r.r1m)}</td>
              <td class="${cls(r.r3m)}">${fmtPct(r.r3m)}</td>
              <td class="${cls(r.r1y)}">${fmtPct(r.r1y)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderAvgRates(avgRatesData) {
  const wrap = document.getElementById('avg-rates-wrap');
  if (!wrap) return;
  if (!avgRatesData || avgRatesData.length === 0) {
    wrap.innerHTML = `<div class="empty" style="padding:30px;text-align:center;color:var(--ink-dim);font-family:var(--mono);font-size:12px">No avg rates data returned from Treasury</div>`;
    return;
  }

  // Group by security_type_desc; pull most recent + 12 months ago for each
  const byType = {};
  avgRatesData.forEach(r => {
    const type = r.security_desc || r.security_type_desc;
    if (!type) return;
    if (!byType[type]) byType[type] = [];
    byType[type].push({ date: r.record_date, rate: parseFloat(r.avg_interest_rate_amt) });
  });

  // For each type, compute current, 1m ago, 3m ago, 12m ago
  const summary = Object.entries(byType).map(([type, entries]) => {
    entries.sort((a, b) => a.date.localeCompare(b.date));
    const cur = entries[entries.length - 1];
    const findClosestDaysBack = (days) => {
      const target = new Date(cur.date);
      target.setDate(target.getDate() - days);
      const tIso = target.toISOString().slice(0, 10);
      let best = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].date <= tIso) { best = entries[i]; break; }
      }
      return best;
    };
    const m1 = findClosestDaysBack(30);
    const m3 = findClosestDaysBack(90);
    const m12 = findClosestDaysBack(365);
    return {
      type,
      current: cur,
      delta1m:  m1  ? cur.rate - m1.rate  : null,
      delta3m:  m3  ? cur.rate - m3.rate  : null,
      delta12m: m12 ? cur.rate - m12.rate : null,
    };
  }).filter(r => r.current && isFinite(r.current.rate));

  // Sort by current rate desc
  summary.sort((a, b) => b.current.rate - a.current.rate);

  const fmtBp = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + ' bp';
  const cls = v => v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';

  wrap.innerHTML = `
    <div class="bonds-table-wrap">
      <table class="bonds-table">
        <thead>
          <tr>
            <th>Treasury Type</th>
            <th>Avg Rate</th>
            <th>As Of</th>
            <th>Δ 1M</th>
            <th>Δ 3M</th>
            <th>Δ 1Y</th>
          </tr>
        </thead>
        <tbody>
          ${summary.map(s => `
            <tr>
              <td>${s.type}</td>
              <td>${s.current.rate.toFixed(3)}%</td>
              <td style="color:var(--ink-faint);font-size:10px">${s.current.date}</td>
              <td class="${cls(s.delta1m)}">${fmtBp(s.delta1m)}</td>
              <td class="${cls(s.delta3m)}">${fmtBp(s.delta3m)}</td>
              <td class="${cls(s.delta12m)}">${fmtBp(s.delta12m)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderPublicDebt(debtData) {
  const wrap = document.getElementById('public-debt-wrap');
  if (!wrap) return;
  if (!debtData || debtData.length === 0) {
    wrap.innerHTML = `
      <div class="empty" style="padding:30px;text-align:center;color:var(--ink-dim);font-family:var(--mono);font-size:11px;line-height:1.7">
        Public debt data unreachable. Treasury Fiscal Data and FRED both blocked.<br>
        <span style="color:var(--ink-faint)">Open DevTools (F12) → Console for details</span>
      </div>
    `;
    return;
  }
  const latest = debtData[0]; // sorted desc
  const monthAgoIdx = Math.min(20, debtData.length - 1);
  const monthAgo = debtData[monthAgoIdx];
  const fmt$T = v => v == null || !isFinite(v) ? '—' : '$' + (v / 1e12).toFixed(2) + 'T';
  const dailyChange = debtData.length >= 2 ? latest.total - debtData[1].total : null;
  const hasBreakdown = latest.held_by_public != null && latest.intragov != null;

  wrap.innerHTML = `
    <div class="debt-card">
      <div>
        <div class="debt-stat-label">Total Public Debt</div>
        <div class="debt-stat-value">${fmt$T(latest.total)}</div>
        <div class="debt-stat-sub">as of ${latest.date}</div>
      </div>
      ${hasBreakdown ? `
      <div>
        <div class="debt-stat-label">Held by Public</div>
        <div class="debt-stat-value">${fmt$T(latest.held_by_public)}</div>
        <div class="debt-stat-sub">${(latest.held_by_public / latest.total * 100).toFixed(1)}% of total</div>
      </div>
      <div>
        <div class="debt-stat-label">Intragovernmental</div>
        <div class="debt-stat-value">${fmt$T(latest.intragov)}</div>
        <div class="debt-stat-sub">${(latest.intragov / latest.total * 100).toFixed(1)}% of total</div>
      </div>
      ` : ''}
      ${dailyChange != null && isFinite(dailyChange) ? `
      <div>
        <div class="debt-stat-label">${hasBreakdown ? 'Daily Change' : 'Quarterly Change'}</div>
        <div class="debt-stat-value" style="color:${dailyChange > 0 ? '#a5645a' : '#5b8a72'}">
          ${dailyChange > 0 ? '+' : ''}${(dailyChange / 1e9).toFixed(2)}B
        </div>
        <div class="debt-stat-sub">vs prior period</div>
      </div>
      ` : ''}
      ${monthAgo && monthAgo.total !== latest.total ? `
      <div>
        <div class="debt-stat-label">${hasBreakdown ? '~30 Day Change' : 'YoY Change'}</div>
        <div class="debt-stat-value" style="color:${(latest.total - monthAgo.total) > 0 ? '#a5645a' : '#5b8a72'}">
          ${(latest.total - monthAgo.total) > 0 ? '+' : ''}${((latest.total - monthAgo.total) / 1e9).toFixed(1)}B
        </div>
        <div class="debt-stat-sub">vs ${monthAgo.date}</div>
      </div>
      ` : ''}
    </div>
    <p style="font-family:var(--mono);font-size:10px;color:var(--ink-faint);margin-top:14px;line-height:1.6">
      Source: ${hasBreakdown ? 'U.S. Treasury Fiscal Data · Debt to the Penny · Updated daily' : 'FRED · GFDEBTN (Total Federal Debt) · Quarterly'}
    </p>
  `;
}

// ============================================================
//   MAIN BONDS LOADER
// ============================================================
async function loadBondsTab(forceRefresh = false) {
  const ycStatus = document.getElementById('yc-status');
  const ratesStatus = document.getElementById('avg-rates-status');
  const debtStatus = document.getElementById('debt-status');

  // Try cache first
  if (!forceRefresh) {
    const cached = loadBondsCache();
    if (cached) {
      state.bonds.data = cached;
      if (cached.yieldCurve) {
        renderYieldCurveSvg(cached.yieldCurve);
        renderYieldCurveTable(cached.yieldCurve);
        if (ycStatus) ycStatus.textContent = `As of ${cached.yieldCurve[cached.yieldCurve.length - 1].date} · cached`;
      }
      if (cached.avgRates) {
        renderAvgRates(cached.avgRates);
        if (ratesStatus) ratesStatus.textContent = 'Cached · click any row';
      }
      if (cached.publicDebt) {
        renderPublicDebt(cached.publicDebt);
        if (debtStatus) debtStatus.textContent = 'Cached';
      }
    }
  }

  // Always render bond ETFs from sheet (fast)
  await renderBondEtfTable();

  // Fetch fresh data in parallel
  if (ycStatus) ycStatus.textContent = 'Fetching live yield curve…';
  const [yieldCurve, avgRates, publicDebt] = await Promise.all([
    fetchTreasuryYieldCurve(),
    fetchTreasuryAvgRates(),
    fetchPublicDebt(),
  ]);

  if (yieldCurve) {
    renderYieldCurveSvg(yieldCurve);
    renderYieldCurveTable(yieldCurve);
    const tenorsFound = Object.keys(yieldCurve[0]).filter(k => k !== 'date').length;
    const sourceLabel = tenorsFound >= 12 ? 'Treasury' : tenorsFound >= 8 ? 'FRED' : 'Stooq';
    if (ycStatus) ycStatus.textContent = `As of ${yieldCurve[yieldCurve.length - 1].date} · ${sourceLabel} · ${tenorsFound} tenors`;
  } else {
    if (ycStatus) ycStatus.innerHTML = '<span style="color:#a5645a">All sources unreachable · check console (F12) for details</span>';
  }
  if (avgRates) {
    renderAvgRates(avgRates);
    if (ratesStatus) ratesStatus.textContent = 'Live · sortable';
  }
  if (publicDebt) {
    renderPublicDebt(publicDebt);
    if (debtStatus) debtStatus.textContent = `Latest: ${publicDebt[0].date}`;
  }

  saveBondsCache({ yieldCurve, avgRates, publicDebt });
  state.bonds.loaded = true;
}

// Add BONDS mnemonic to terminal
if (typeof TERMINAL_FUNCTIONS !== 'undefined') {
  TERMINAL_FUNCTIONS.BONDS = {
    name: 'Bonds & Treasuries',
    desc: 'Yield curve · interest rates · public debt',
    scope: 'global',
    handler: () => switchTab('bonds'),
  };
  TERMINAL_FUNCTIONS.YC = {
    name: 'Yield Curve',
    desc: 'Open the Bonds tab',
    scope: 'global',
    handler: () => switchTab('bonds'),
  };
}

// ============================================================
//   PORTFOLIO NOTES MODAL — timestamped notes per ticker
// ============================================================
function openNotesModal(ticker) {
  const arr = loadPortfolio();
  const entry = arr.find(e => e.ticker === ticker);
  if (!entry) return;
  if (!Array.isArray(entry.notes)) entry.notes = [];

  // Remove any prior modal
  document.getElementById('notes-modal')?.remove();

  const fmtTs = ts => {
    try {
      const d = new Date(ts);
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch { return ts; }
  };

  const sbRow = state.stockbook?.rows?.find(r => r.ticker === ticker);
  const company = sbRow?.name || ticker;

  const renderNotesList = () => {
    const list = document.getElementById('notes-list');
    if (!list) return;
    if (entry.notes.length === 0) {
      list.innerHTML = `<div style="color:var(--ink-faint);font-style:italic;text-align:center;padding:24px">No notes yet</div>`;
      return;
    }
    // Newest first
    const sorted = [...entry.notes].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    list.innerHTML = sorted.map((n, i) => {
      const realIdx = entry.notes.indexOf(n);
      return `
        <div class="note-entry">
          <div class="note-meta">
            <span class="note-ts">${fmtTs(n.ts)}</span>
            ${n.priceAtNote != null ? `<span class="note-price">@ $${n.priceAtNote.toFixed(2)}</span>` : ''}
            <button class="note-delete" data-note-idx="${realIdx}" title="Delete this note">×</button>
          </div>
          <div class="note-text">${escapeHtml(n.text)}</div>
        </div>
      `;
    }).join('');
    // Wire delete buttons
    list.querySelectorAll('.note-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Delete this note?')) return;
        const idx = parseInt(btn.dataset.noteIdx);
        entry.notes.splice(idx, 1);
        savePortfolio(arr);
        renderNotesList();
        renderStockBook();
      });
    });
  };

  const html = `
    <div class="modal-backdrop" id="notes-modal" style="display:flex;z-index:9999">
      <div class="modal-box" style="max-width:680px;max-height:85vh;display:flex;flex-direction:column">
        <div class="modal-head">
          <div class="modal-title">${ticker} — Notes <span style="color:var(--ink-faint);font-weight:400">· ${escapeHtml(company)}</span></div>
          <button class="modal-close" onclick="document.getElementById('notes-modal').remove()">×</button>
        </div>
        <div class="modal-section" style="flex-shrink:0">
          <div class="modal-label">New Note</div>
          <textarea id="note-input" class="modal-input" rows="3" style="resize:vertical;min-height:70px" placeholder="Thesis, entry reason, target, news, sentiment shift, stop loss…"></textarea>
          <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
            <label style="font-family:var(--mono);font-size:11px;color:var(--ink-dim);display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="checkbox" id="note-include-price" checked> Stamp current price
            </label>
            <span style="flex:1"></span>
            <button class="btn btn-ghost" onclick="document.getElementById('notes-modal').remove()">Close</button>
            <button class="btn" id="note-save-btn">+ Add Note</button>
          </div>
        </div>
        <div class="modal-section" style="flex:1;overflow-y:auto;border-top:1px solid var(--rule)">
          <div class="modal-label">All Notes <span style="color:var(--ink-faint);font-weight:400;text-transform:none;letter-spacing:0">(newest first)</span></div>
          <div id="notes-list"></div>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  renderNotesList();

  // Auto-focus the input
  setTimeout(() => document.getElementById('note-input')?.focus(), 50);

  document.getElementById('note-save-btn').addEventListener('click', () => {
    const input = document.getElementById('note-input');
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    const includePrice = document.getElementById('note-include-price').checked;
    const livePrice = sbRow?.price ?? sbRow?.fmpPrice ?? null;
    entry.notes.push({
      ts: new Date().toISOString(),
      text,
      priceAtNote: includePrice && livePrice != null ? livePrice : null,
    });
    savePortfolio(arr);
    input.value = '';
    renderNotesList();
    renderStockBook();
  });

  // Ctrl/Cmd + Enter to save
  document.getElementById('note-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('note-save-btn').click();
    }
  });
}
