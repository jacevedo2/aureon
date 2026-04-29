// ─────────────────────────────────────────────────────────────────────────────
// ETF Data Loader
//
// Exports:
//   etfState          — live object { payload, source } — always current
//   refreshEtfData()  — async fn; call to reload data and stamp lastUpdated
//
// Priority order on each refresh:
//   1. ETF_DATA_URL env var (optional remote JSON)
//   2. latest-etf-data.json  ← edit this file + git push to update
//   3. etf-data.js           ← permanent hardcoded fallback
//
// server.js calls refreshEtfData() on a schedule (every 4 h) so lastUpdated
// always reflects a recent load time, not a stale startup snapshot.
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
    const res  = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!validate(data)) return null;
    return data;
  } catch (err) {
    console.warn('[ETF loader] ETF_DATA_URL fetch failed:', err.message);
    return null;
  }
}

// Mutable state — the route always reads from this object.
export const etfState = { payload: null, source: null };

export async function refreshEtfData() {
  let raw  = null;
  let src  = null;

  const remoteUrl = process.env.ETF_DATA_URL;
  if (remoteUrl) {
    raw = await tryUrl(remoteUrl);
    if (raw) src = 'remote-url';
    else console.warn('[ETF loader] ETF_DATA_URL failed — falling through to file');
  }

  if (!raw) {
    raw = tryFile();
    if (raw) src = 'latest-file';
  }

  if (!raw) {
    raw = fallbackData;
    src = 'fallback';
    console.warn('[ETF loader] ⚠️  using fallback etf-data.js');
  }

  const ts = new Date().toISOString().split('T')[0];
  etfState.payload = { ...raw, lastUpdated: ts };
  etfState.source  = src;
  console.log(`[ETF loader] ✅ refreshed — source: ${src}, lastUpdated: ${ts}`);
}

// Initial load at module startup
await refreshEtfData();
