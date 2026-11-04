// ─────────────────────────────────────────────────────────────────────────────
// /api/etf response builder — ETF data-integrity guard
//
// WHY THIS EXISTS
// The values held in etfState (latest-etf-data.json, etf-data.js, ETF_DATA_URL, and the
// CoinGlass loader path) have NOT been verified as real ETF fund flows:
//   • latest-etf-data.json is written by scripts/fetch-etf-data.py, whose "flow" is
//     AUM_today − AUM_stored × (benchmark price return). The stored AUM has been frozen for
//     weeks, so that value is just −AUM × (price move) — a price artifact, not a flow.
//   • The per-day arrays carry no dates, and a value covers the gap between two script runs
//     (sometimes off by a day), not a reporting date.
//   • The CoinGlass path has not had its data contract (dates, units, plan) verified.
// Until a source is verified, NO flow, AUM, history or volume figure may leave this server.
//
// HOW IT FAILS
// Closed. Every source is treated as unverified unless it appears in VERIFIED_FLOW_SOURCES,
// and any unexpected error also returns the unavailable response.
//
// WHAT CLIENTS SEE (compatible with TestFlight Build 5)
//   lastUpdated: null, empty *RecentFlows arrays, no scalar flow/AUM fields, empty
//   etfTodayVolume, plus explicit `flowsVerified:false` and a human-readable reason.
//   Build 5 skips absent/null fields, accepts empty arrays, and treats a null lastUpdated as
//   "no data" — so it renders its unavailable state. Missing data is never zero.
//
// RE-ENABLING (deliberately not possible through configuration)
// This module reads no environment variables. The only way to publish figures is to add a
// source to VERIFIED_FLOW_SOURCES in code, after its data contract has been verified, and to
// ship that change through review. test/etf-response.test.js fails if this file ever reads
// process.env.
// ─────────────────────────────────────────────────────────────────────────────

export const FLOWS_UNAVAILABLE_REASON =
  'ETF fund-flow figures are unavailable: no verified source is connected. Earlier estimates were derived from stale AUM and price movement and are not shown.';

// Sources whose flow/AUM figures have been verified against the provider's published contract
// (reporting dates, chronological order, units). INTENTIONALLY EMPTY.
export const VERIFIED_FLOW_SOURCES = Object.freeze([]);

// Keys from the route's `extra` argument that may be echoed to clients. Anything else
// (e.g. prevLastUpdated, dataChanged — which would expose the unverified file date) is dropped.
const ALLOWED_EXTRA_KEYS = ['refreshResult', 'retryAfterSeconds'];

const SCALAR_KEYS = ['btcFlow', 'ethFlow', 'xrpFlow', 'btcAUM', 'ethAUM', 'xrpAUM'];
const SERIES_KEYS = ['btcRecentFlows', 'ethRecentFlows', 'xrpRecentFlows'];

function cleanExtra(extra) {
  const out = {};
  if (extra && typeof extra === 'object') {
    for (const k of ALLOWED_EXTRA_KEYS) if (k in extra) out[k] = extra[k];
  }
  return out;
}

function unavailableBody(source, extra, nowMs) {
  return {
    lastUpdated: null,
    btcRecentFlows: [],
    ethRecentFlows: [],
    xrpRecentFlows: [],
    etfTodayVolume: {},
    flowsVerified: false,
    flowsUnavailableReason: FLOWS_UNAVAILABLE_REASON,
    _meta: {
      source: typeof source === 'string' ? source : 'unknown',
      isStale: true,
      ageDays: null,
      staleReason: FLOWS_UNAVAILABLE_REASON,
      flowsVerified: false,
      servedAt: new Date(nowMs).toISOString(),
      ...cleanExtra(extra),
    },
  };
}

const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {{payload?: object|null, source?: string}} state  etfState from etf-loader.js
 * @param {object} [extra]  route metadata (only refreshResult / retryAfterSeconds are echoed)
 * @param {{nowMs?: number, verifiedSources?: readonly string[]}} [opts]  test seams only —
 *        server.js never passes `verifiedSources`.
 */
export function buildEtfResponse(state, extra = {}, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const verifiedSources = opts.verifiedSources ?? VERIFIED_FLOW_SOURCES;
  try {
    const source = state?.source;
    const payload = state?.payload;
    if (!payload || typeof payload !== 'object' || !verifiedSources.includes(source)) {
      return unavailableBody(source, extra, nowMs);
    }

    // Verified-source branch (dormant while VERIFIED_FLOW_SOURCES is empty): copy only fields
    // that are present and valid. An invalid or missing field is OMITTED, never coerced to 0.
    const body = {
      lastUpdated: typeof payload.lastUpdated === 'string' ? payload.lastUpdated : null,
      etfTodayVolume: {},
      flowsVerified: true,
    };
    for (const k of SCALAR_KEYS) if (isFiniteNumber(payload[k])) body[k] = payload[k];
    for (const k of SERIES_KEYS) {
      body[k] = Array.isArray(payload[k]) && payload[k].every(isFiniteNumber) ? payload[k].slice(-7) : [];
    }
    const ageMs = body.lastUpdated ? nowMs - new Date(body.lastUpdated).getTime() : null;
    const ageDays = ageMs != null && Number.isFinite(ageMs) ? Math.floor(ageMs / 86_400_000) : null;
    body._meta = {
      source,
      isStale: ageDays == null || ageDays > 3,
      ageDays,
      staleReason: null,
      flowsVerified: true,
      servedAt: new Date(nowMs).toISOString(),
      ...cleanExtra(extra),
    };
    return body;
  } catch {
    // Do not touch `state` again here — it may be what threw.
    return unavailableBody(undefined, extra, nowMs);
  }
}
