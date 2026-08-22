// ─────────────────────────────────────────────────────────────────────────────
// ETF Data Loader
//
// Exports:
//   etfState          — live object { payload, source, volumeByTicker } — always current
//   refreshEtfData()  — async fn; call to reload data and stamp lastUpdated
//
// Priority order on each refresh (aggregate flow/AUM chain):
//   1. COINGLASS_API_KEY env var — live CoinGlass V3 API (BTC + ETH; XRP falls through)
//   2. ETF_DATA_URL env var      — optional remote JSON (full payload including XRP)
//   3. latest-etf-data.json      ← edit this file + git push to update
//   4. etf-data.js               ← permanent hardcoded fallback
//
// If COINGLASS_API_KEY is set, BTC and ETH flows are always live.
// XRP flow is sourced from ETF_DATA_URL or the committed JSON files.
//
// To update without a live key: edit latest-etf-data.json and git push.
//
// Per-fund volume (separate, additive-only chain — see COINGLASS_V4_BASE
// section below): populated only when COINGLASS_API_KEY is set, only for
// BTC/ETH tickers (no CoinGlass XRP list endpoint exists), exposed in the
// response as payload.etfTodayVolume = { [ticker]: volumeUSD }. Never
// blocks or fails the main payload; absent/failed volume simply means that
// ticker is missing from the map, never a fabricated 0.
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

// ── Per-fund volume (CoinGlass V4 "ETF List" endpoints) ────────────────────────
// Separate API family from the V3 fund-flow-history endpoints above (different
// base URL, different auth header, different response shape). Confirmed via
// CoinGlass's published API docs (docs.coinglass.com/reference/bitcoin-etfs,
// .../ethereum-etf-list) on 2026-08-21:
//   GET https://open-api-v4.coinglass.com/api/etf/{bitcoin|ethereum}/list
//   header: CG-API-KEY: <key>   (available on every plan tier, including free)
// Each row includes `ticker` (matches Aureon's existing per-issuer tickers,
// e.g. IBIT/GBTC/FBTC/ETHA/ETHE exactly) and `volume_usd`.
//
// IMPORTANT — no XRP equivalent exists. CoinGlass currently only publishes
// this per-fund "list" endpoint (with volume) for bitcoin and ethereum;
// there is no /api/etf/xrp/list. XRP only has /api/etf/xrp/flow-history,
// which is aggregate (no per-ticker breakdown, no volume) — already the
// endpoint used by fetchCoinGlassProduct above. So per-fund volume can only
// be populated for the BTC/ETH breakdown tickers; XRP tickers (XRPC, XRP,
// XRPZ, GXRP, TOXR, XRPR, XXRP, XRPD) will not appear in the returned map
// until CoinGlass (or another vendor) exposes a comparable XRP endpoint.
//
// Semantics: CoinGlass's docs label volume_usd only as "Volume in USD" with
// no explicit rolling-vs-session qualifier. Since these are conventional
// exchange-listed ETF shares (Nasdaq/NYSE/Cboe), traded during a single
// daily session — not a continuously-rolling market like crypto spot — and
// the same response row carries `last_trade_time`/`market_status`, this is
// treated as the current trading session's (calendar-day) volume and
// exposed to iOS as `etfTodayVolume`, per Aureon's "don't mislabel rolling
// data as today's" rule. If CoinGlass later documents this explicitly as a
// rolling 24h figure, rename to etfVolume24h on both ends.
const COINGLASS_V4_BASE = 'https://open-api-v4.coinglass.com';
const VOLUME_PRODUCTS = ['bitcoin', 'ethereum']; // no 'xrp' — no such CoinGlass endpoint yet

async function fetchCoinGlassVolumeList(apiKey, product) {
  const url = `${COINGLASS_V4_BASE}/api/etf/${product}/list`;
  try {
    const res = await fetch(url, {
      headers: { 'CG-API-KEY': apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.json();

    if (!res.ok) {
      console.warn(`[ETF volume] ${product} HTTP ${res.status} — msg: ${body?.msg ?? JSON.stringify(body).slice(0, 120)}`);
      return null;
    }

    const code = String(body?.code ?? body?.status ?? '');
    if (code !== '0' && code !== '200') {
      console.warn(`[ETF volume] ${product} non-zero code: ${code} msg: ${body?.msg}`);
      return null;
    }

    const list = Array.isArray(body.data) ? body.data : Array.isArray(body.data?.list) ? body.data.list : null;
    if (!list) {
      console.warn(`[ETF volume] ${product} unexpected shape — keys: ${Object.keys(body).join(', ')}`);
      return null;
    }

    const entries = {};
    let matched = 0, missingVolume = 0;
    for (const row of list) {
      const ticker = row?.ticker;
      if (!ticker) continue;
      const vol = row?.volume_usd ?? row?.volumeUsd ?? null;
      if (vol === null || vol === undefined) { missingVolume++; continue; }
      entries[ticker] = vol;
      matched++;
    }
    console.log(`[ETF volume] ${product} ✅ funds matched=${matched} missingVolume=${missingVolume} totalRows=${list.length}`);
    return entries;

  } catch (err) {
    console.warn(`[ETF volume] ${product} fetch threw: ${err.message}`);
    return null;
  }
}

/// Fetches per-fund volume for every supported product and merges into one
/// ticker-keyed map. Best-effort and additive only — a failure here never
/// affects the main flow/AUM payload. Returns null (not {}) on total
/// failure so the caller can choose to keep the previous cached map instead
/// of wiping it.
async function fetchETFVolumeMap(apiKey) {
  console.log(`[ETF volume] ▶︎ requesting per-fund volume — products: ${VOLUME_PRODUCTS.join(', ')}`);
  const results = await Promise.all(VOLUME_PRODUCTS.map(p => fetchCoinGlassVolumeList(apiKey, p)));
  if (results.every(r => r === null)) {
    console.warn('[ETF volume] ❌ all products failed — keeping previous volume map');
    return null;
  }
  const merged = {};
  for (const r of results) if (r) Object.assign(merged, r);
  console.log(`[ETF volume] ✅ merged map — ${Object.keys(merged).length} tickers total`);
  return merged;
}

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
// volumeByTicker persists across refreshes independently of `payload`/`source`
// (which describe only the flow/AUM chain) — a failed volume fetch keeps the
// last-known map rather than clearing it, same "don't wipe good data on a
// transient failure" convention as the missing-field handling in applyResponse.
export const etfState = { payload: null, source: null, volumeByTicker: {} };

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

  // ── Per-fund volume (independent of the flow/AUM chain above) ─────────────
  // Only attempted when a CoinGlass key is present — same credential gate as
  // the live flow fetch, no new env var. Additive-only: never blocks or
  // fails the main payload, and a failed/skipped fetch simply carries the
  // previous map forward (see etfState.volumeByTicker init comment).
  if (cgKey) {
    const volumeMap = await fetchETFVolumeMap(cgKey);
    if (volumeMap) etfState.volumeByTicker = volumeMap;
  } else {
    console.warn('[ETF volume] skipped — COINGLASS_API_KEY not set (per-fund volume will be absent, not zero)');
  }

  etfState.payload = { ...raw, etfTodayVolume: etfState.volumeByTicker };
  etfState.source  = src;
  console.log(`[ETF loader] ✅ refreshed — source: ${src}, lastUpdated: ${raw.lastUpdated}, ageDays: ${ageDays ?? 'unknown'}, volumeTickers: ${Object.keys(etfState.volumeByTicker).length}`);
}

// Initial load at module startup
await refreshEtfData();
