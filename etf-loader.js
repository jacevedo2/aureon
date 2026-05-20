// ─────────────────────────────────────────────────────────────────────────────
// ETF Data Loader
//
// Exports:
//   etfState          — live object { payload, source } — always current
//   refreshEtfData()  — async fn; call to reload data and stamp lastUpdated
//
// Priority order on each refresh:
//   1. COINGLASS_API_KEY env var — live CoinGlass V3 API (BTC + ETH; XRP falls through)
//   2. ETF_DATA_URL env var      — optional remote JSON (full payload including XRP)
//   3. latest-etf-data.json      ← edit this file + git push to update
//   4. etf-data.js               ← permanent hardcoded fallback
//
// If COINGLASS_API_KEY is set, BTC and ETH flows are always live.
// XRP flow is sourced from ETF_DATA_URL or the committed JSON files.
//
// To update without a live key: edit latest-etf-data.json and git push.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { etfData as fallbackData } from './etf-data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUIRED_FIELDS = [
  'lastUpdated',
  'btcFlow', 'ethFlow', 'xrpFlow',
  'btcAUM',  'ethAUM',  'xrpAUM',
  'btcRecentFlows', 'ethRecentFlows', 'xrpRecentFlows',
];

const COINGLASS_BASE = 'https://open-api.coinglass.com/public/v3/etf';
const FETCH_TIMEOUT_MS = 8000;

function validate(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const missing = REQUIRED_FIELDS.filter(f => !(f in obj));
  if (missing.length) {
    console.warn('[ETF loader] missing fields:', missing.join(', '));
    return false;
  }
  return true;
}

function tryFile() {
  const filePath = join(__dirname, 'latest-etf-data.json');
  try {
    const raw    = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const { _note, ...data } = parsed;
    if (!validate(data)) return null;
    return data;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[ETF loader] latest-etf-data.json parse error:', err.message);
    }
    return null;
  }
}

async function tryUrl(url) {
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!validate(data)) return null;
    return data;
  } catch (err) {
    console.warn('[ETF loader] ETF_DATA_URL fetch failed:', err.message);
    return null;
  }
}

// ── CoinGlass V3 integration ───────────────────────────────────────────────────
// Fetches BTC and ETH ETF flow history. XRP is sourced separately (file/fallback).
// Returns a partial payload with btcFlow, ethFlow, btcAUM, ethAUM,
// btcRecentFlows, ethRecentFlows, lastUpdated — caller merges XRP from fallback.

async function fetchCoinGlassProduct(apiKey, product) {
  const url = `${COINGLASS_BASE}/${product}-etf-fund-flow-history`;
  try {
    const res = await fetch(url, {
      headers: { coinglassSecret: apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const body = await res.json();

    if (!res.ok) {
      console.warn(`[ETF loader] CoinGlass ${product.toUpperCase()} HTTP ${res.status} — msg: ${body?.msg ?? JSON.stringify(body).slice(0, 120)}`);
      return null;
    }

    // CoinGlass V3 wraps data in { code, msg, data }
    // data may be an array or { list: [] } — handle both
    const code = String(body?.code ?? body?.status ?? '');
    if (code !== '0' && code !== '200') {
      console.warn(`[ETF loader] CoinGlass ${product.toUpperCase()} non-zero code: ${code} msg: ${body?.msg}`);
      return null;
    }

    let list = Array.isArray(body.data)
      ? body.data
      : Array.isArray(body.data?.list)
        ? body.data.list
        : null;

    if (!list || list.length === 0) {
      console.warn(`[ETF loader] CoinGlass ${product.toUpperCase()} empty data list. Keys: ${Object.keys(body).join(', ')}`);
      return null;
    }

    // Sort ascending by time so index 0 = oldest, last = most recent
    list = list.slice().sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

    // Most recent entry is the current day's data
    const latest = list[list.length - 1];

    // Accept both camelCase and snake_case field names CoinGlass uses across versions
    const netFlow = latest.netFlow ?? latest.net_flow ?? latest.totalNetFlow ?? 0;
    const aum     = latest.totalNetAssets ?? latest.total_net_assets ?? latest.aum ?? 0;

    // Build last-7-days array (oldest → newest)
    const recent = list.slice(-7).map(d => d.netFlow ?? d.net_flow ?? d.totalNetFlow ?? 0);

    // lastUpdated: prefer explicit date string, otherwise derive from Unix ms timestamp
    let lastUpdated;
    if (latest.date && typeof latest.date === 'string') {
      lastUpdated = latest.date;                                       // 'YYYY-MM-DD'
    } else if (latest.time) {
      lastUpdated = new Date(latest.time).toISOString().slice(0, 10); // Unix ms → 'YYYY-MM-DD'
    } else {
      lastUpdated = new Date().toISOString().slice(0, 10);
    }

    console.log(`[ETF loader] CoinGlass ${product.toUpperCase()} ✅  lastUpdated=${lastUpdated}  flow=${netFlow}  aum=${aum}  recentLen=${recent.length}`);
    return { netFlow, aum, recent, lastUpdated };

  } catch (err) {
    console.warn(`[ETF loader] CoinGlass ${product.toUpperCase()} fetch threw: ${err.message}`);
    return null;
  }
}

async function tryCoinGlass(apiKey) {
  console.log('[ETF loader] attempting CoinGlass live fetch (BTC + ETH + XRP)...');

  const [btc, eth, xrp] = await Promise.all([
    fetchCoinGlassProduct(apiKey, 'btc'),
    fetchCoinGlassProduct(apiKey, 'eth'),
    fetchCoinGlassProduct(apiKey, 'xrp'),
  ]);

  if (!btc || !eth) {
    console.warn(`[ETF loader] CoinGlass fetch incomplete — btc: ${!!btc}, eth: ${!!eth}. Falling through.`);
    return null;
  }

  // Use the most recent of the two dates as the overall lastUpdated
  const lastUpdated = btc.lastUpdated > eth.lastUpdated ? btc.lastUpdated : eth.lastUpdated;

  // XRP: use live if available, otherwise pull from file/fallback
  let xrpFlow, xrpAUM, xrpRecentFlows;
  if (xrp) {
    xrpFlow        = xrp.netFlow;
    xrpAUM         = xrp.aum;
    xrpRecentFlows = xrp.recent;
    console.log('[ETF loader] CoinGlass XRP ✅ using live data');
  } else {
    // Merge XRP from committed file so the full payload remains valid
    const fileData  = tryFile() ?? fallbackData;
    xrpFlow         = fileData.xrpFlow;
    xrpAUM          = fileData.xrpAUM;
    xrpRecentFlows  = fileData.xrpRecentFlows;
    console.log('[ETF loader] CoinGlass XRP unavailable — using file xrpFlow=' + xrpFlow);
  }

  return {
    lastUpdated,
    btcFlow:        btc.netFlow,
    ethFlow:        eth.netFlow,
    xrpFlow,
    btcAUM:         btc.aum,
    ethAUM:         eth.aum,
    xrpAUM,
    btcRecentFlows: btc.recent,
    ethRecentFlows: eth.recent,
    xrpRecentFlows,
  };
}

// Mutable state — the route always reads from this object.
export const etfState = { payload: null, source: null };

export async function refreshEtfData() {
  let raw  = null;
  let src  = null;

  // ── 1. CoinGlass live API ──────────────────────────────────────────────────
  const cgKey = process.env.COINGLASS_API_KEY;
  if (cgKey) {
    raw = await tryCoinGlass(cgKey);
    if (raw) src = 'coinglass-live';
    else console.warn('[ETF loader] CoinGlass fetch failed — falling through to ETF_DATA_URL / file');
  } else {
    console.warn('[ETF loader] ⚠️  COINGLASS_API_KEY not set — ETF data will NOT be live. Set this in Render env vars to enable live institutional flow data.');
  }

  // ── 2. Remote URL ──────────────────────────────────────────────────────────
  if (!raw) {
    const remoteUrl = process.env.ETF_DATA_URL;
    if (remoteUrl) {
      raw = await tryUrl(remoteUrl);
      if (raw) src = 'remote-url';
      else console.warn('[ETF loader] ETF_DATA_URL failed — falling through to file');
    }
  }

  // ── 3. Committed JSON file ─────────────────────────────────────────────────
  if (!raw) {
    raw = tryFile();
    if (raw) src = 'latest-file';
  }

  // ── 4. Hardcoded fallback ──────────────────────────────────────────────────
  if (!raw) {
    raw = fallbackData;
    src = 'fallback';
    console.warn('[ETF loader] ⚠️  using fallback etf-data.js');
  }

  // Compute staleness for logging (does not modify the payload)
  const ageMs   = raw.lastUpdated ? Date.now() - new Date(raw.lastUpdated).getTime() : null;
  const ageDays = ageMs != null ? Math.floor(ageMs / 86_400_000) : null;
  const isStale = ageDays != null && ageDays > 3;
  if (isStale) {
    console.warn(`[ETF loader] ⚠️  data is ${ageDays}d old (lastUpdated: ${raw.lastUpdated}) — status will show as stale in app`);
  }

  etfState.payload = { ...raw };
  etfState.source  = src;
  console.log(`[ETF loader] ✅ refreshed — source: ${src}, lastUpdated: ${raw.lastUpdated}, ageDays: ${ageDays ?? 'unknown'}`);
}

// Initial load at module startup
await refreshEtfData();
