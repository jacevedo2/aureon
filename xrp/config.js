// Configuration for the XRP wallet monitor. Everything is opt-in: with no environment variables the
// feature is DISABLED — GET /api/xrp/wallets answers with an explicit "disabled" state and the server
// makes no outbound XRPL calls.
//
//   XRP_WALLETS_ENABLED   "true" to start the background refresh                (default: off)
//   XRPL_RPC_URL          XRPL JSON-RPC endpoint (https://…); must be a FULL-HISTORY server. REQUIRED when enabled:
//                         there is deliberately NO default — public clusters are not for commercial use. If it is
//                         missing or invalid the monitor FAILS CLOSED: no scans, no XRPL requests at all.
//   XRP_REFRESH_SECONDS   refresh interval, clamped to 300..3600                 (default: 900)
//   XRP_ENTITY_HINTS      optional JSON {"W1":"Name"} display hints — NOT stored in the repo
import { readFileSync } from 'node:fs';

const WALLETS_FILE = new URL('./wallets.json', import.meta.url);

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function parseHints(raw) {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    const out = {};
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 40);
    return out;
  } catch { return {}; }
}

/** Validates the configured endpoint WITHOUT ever echoing it (it carries a credential). */
function parseEndpoint(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { url: null, error: 'XRPL_RPC_URL is not set' };
  let u;
  try { u = new URL(s); } catch { return { url: null, error: 'XRPL_RPC_URL is not a valid URL' }; }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return { url: null, error: 'XRPL_RPC_URL must be an https:// URL' };
  return { url: s, error: null };
}

export function loadXrpConfig(env = process.env, walletsFile = WALLETS_FILE) {
  const file = JSON.parse(readFileSync(walletsFile, 'utf-8'));
  const refreshSeconds = clampInt(env.XRP_REFRESH_SECONDS, 300, 3600, 900);
  const hints = parseHints(env.XRP_ENTITY_HINTS);
  const requested = env.XRP_WALLETS_ENABLED === 'true';
  const endpoint = requested ? parseEndpoint(env.XRPL_RPC_URL) : { url: null, error: null };
  return {
    requested,
    // Fail closed: enabled only when explicitly requested AND a valid endpoint is configured.
    enabled: requested && endpoint.url !== null,
    configError: requested ? endpoint.error : null,   // fixed strings only; never contains the URL
    rpcUrl: endpoint.url,
    refreshSeconds,
    staleAfterSeconds: refreshSeconds * 3,          // served as "stale" after this age
    maxServeAgeSeconds: Math.max(7200, refreshSeconds * 8), // totals are withheld after this age
    scanDeadlineSeconds: 480,                       // a scan that runs longer is abandoned (windows end up incomplete)
    analysis: {
      window_hours: file.window_hours,
      large_transfer_threshold_xrp: file.large_transfer_threshold_xrp,
      max_pages_per_wallet: file.max_pages_per_wallet,
      wallets: file.wallets.map((w) => ({ ...w, ...(hints[w.id] ? { entity_hint: hints[w.id] } : {}) })),
    },
    hints,
  };
}
