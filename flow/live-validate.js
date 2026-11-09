// Strict validation of a live-monitoring snapshot. The publisher is trusted with a secret, but its payload is still treated as untrusted:
// a forged, corrupted or replayed snapshot must not become something a user reads as a market observation. Unknown fields are REJECTED
// (so a raw-trade array or any other payload cannot ride along), and the verdict must agree with the fields that justify it.
// This file has NO dependency on the monitor/detector code (only the tiny asset registry), so the server can ship it (with the router) on its own.
import { flowAsset } from './live-assets.js';
export const LIVE_SCHEMA_VERSION = 1;
export const LIVE_MODE = 'live-monitoring';

export const LIVE_LIMITS = Object.freeze({
  maxBodyBytes: 16 * 1024,        // the real snapshot is ~2 KB
  maxAgeSeconds: 300,             // a snapshot built more than 5 minutes ago is refused on publish and withheld on read
  maxFutureSkewSeconds: 60,
  minEventRatio: 3,               // detector minRatio: an "event" below it cannot be genuine
});
const STATES = ['verified', 'withheld', 'unavailable'];
const VERDICTS = ['normal', 'elevated', 'event', 'withheld', 'unavailable'];
const ASSESSMENTS = ['typical', 'elevated-no-new-event', 'unusual-activity', 'not-assessed'];
const REASON = /^[a-z0-9-]{1,40}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, { min = 0, max = 1e15, int = false } = {}) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v));
const str = (v, max = 500) => typeof v === 'string' && v.length <= max;
const isoMs = (v) => (typeof v === 'string' && v.length <= 40 && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? Date.parse(v) : NaN);
const exact = (o, keys) => isObj(o) && Object.keys(o).every((k) => keys.includes(k));

/** @returns {{ok:true, snapshot:object}|{ok:false, reason:string}}  reasons are fixed strings (never payload content). */
export function validateLiveSnapshot(input, { nowSec = Date.now() / 1000, limits = LIVE_LIMITS } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  if (!isObj(input)) return bad('not-an-object');
  const s = input;
  if (!exact(s, ['schemaVersion', 'id', 'mode', 'asset', 'pair', 'source', 'window', 'observation', 'activity', 'series', 'comparison', 'assessment', 'event', 'baseline', 'monitoring', 'verdict', 'quality'])) return bad('unknown-field');
  if (s.schemaVersion !== LIVE_SCHEMA_VERSION) return bad('unsupported-version');
  if (s.mode !== LIVE_MODE) return bad('wrong-mode');                                  // demo / recorded snapshots can never be served as live
  const A = flowAsset(s.asset);                                                       // a supported asset, and its pair/id must belong to THAT asset
  if (!A || s.pair !== A.pair || s.id !== A.liveId) return bad('wrong-asset');
  if (!exact(s.source, ['venue', 'market', 'provider', 'scope']) || s.source.venue !== 'Kraken' || s.source.market !== 'spot' || !str(s.source.provider, 80) || !str(s.source.scope, 120)) return bad('bad-source');

  const o = s.observation;
  if (!exact(o, ['tradeCount', 'malformedCount', 'firstTradeAt', 'lastTradeAt', 'lastProviderReceiptAt', 'capturedAt'])
    || !num(o.tradeCount, { int: true, max: 1e8 }) || !num(o.malformedCount, { int: true, max: 1e8 })) return bad('bad-observation');
  const captured = isoMs(o.capturedAt) / 1000;
  if (!Number.isFinite(captured)) return bad('bad-timestamp');
  if (captured > nowSec + limits.maxFutureSkewSeconds) return bad('future-timestamp');
  if (nowSec - captured > limits.maxAgeSeconds) return bad('stale-snapshot');
  for (const k of ['firstTradeAt', 'lastTradeAt', 'lastProviderReceiptAt']) {
    if (o[k] !== null && !(Number.isFinite(isoMs(o[k])) && isoMs(o[k]) / 1000 <= captured + limits.maxFutureSkewSeconds)) return bad('bad-timestamp');
  }

  if (!VERDICTS.includes(s.verdict) || !ASSESSMENTS.includes(s.assessment)) return bad('bad-classification');
  const q = s.quality;
  if (!exact(q, ['state', 'coverageVerified', 'completeBuckets', 'totalBuckets', 'reasons', 'detail']) || !STATES.includes(q.state) || typeof q.coverageVerified !== 'boolean'
    || !num(q.completeBuckets, { int: true, max: 10 }) || !num(q.totalBuckets, { int: true, max: 10 }) || q.completeBuckets > q.totalBuckets || !str(q.detail, 600)
    || !Array.isArray(q.reasons) || q.reasons.length > 4 || !q.reasons.every((r) => typeof r === 'string' && REASON.test(r))) return bad('bad-quality');
  if (q.coverageVerified !== (q.totalBuckets > 0 && q.completeBuckets === q.totalBuckets)) return bad('inconsistent-quality');

  if (s.window !== null) {
    const w = s.window; const a = isoMs(w?.from); const b = isoMs(w?.to);
    if (!exact(w, ['from', 'to', 'seconds']) || !Number.isFinite(a) || !Number.isFinite(b) || b <= a || b / 1000 > captured + limits.maxFutureSkewSeconds || w.seconds !== (b - a) / 1000 || w.seconds > 3600) return bad('bad-window');
  }
  if (s.activity !== null) {
    const a = s.activity;
    if (!exact(a, ['tradeCount', 'notionalUsd', 'baseVolume', 'largestTradeShare']) || !num(a.tradeCount, { int: true, max: 1e8 }) || !num(a.notionalUsd)
      || (a.baseVolume !== null && !num(a.baseVolume)) || (a.largestTradeShare !== null && !num(a.largestTradeShare, { max: 1 }))) return bad('bad-activity');
  }
  if (!Array.isArray(s.series) || s.series.length > 6 || !s.series.every((p) => exact(p, ['start', 'notionalUsd', 'tradeCount']) && Number.isFinite(isoMs(p.start)) && num(p.notionalUsd) && num(p.tradeCount, { int: true, max: 1e8 }))) return bad('bad-series');
  if (s.comparison !== null && (!exact(s.comparison, ['typicalNotionalUsd', 'ratio']) || !num(s.comparison.typicalNotionalUsd) || !num(s.comparison.ratio, { max: 1e6 }))) return bad('bad-comparison');
  if (s.baseline !== null && (!exact(s.baseline, ['eligible', 'baselineCoverage', 'windowsInBaseline', 'windowsExpected', 'requiredCoverage']) || typeof s.baseline.eligible !== 'boolean'
    || !num(s.baseline.baselineCoverage, { max: 1 }) || !num(s.baseline.windowsInBaseline, { int: true, max: 1e6 }) || !num(s.baseline.windowsExpected, { int: true, max: 1e6 }) || !num(s.baseline.requiredCoverage, { max: 1 }))) return bad('bad-baseline');
  const m = s.monitoring;
  if (m !== null && (!exact(m, ['coveredThrough', 'collectionAgeSeconds', 'gapCount', 'halted']) || (m.coveredThrough !== null && !Number.isFinite(isoMs(m.coveredThrough)))
    || (m.collectionAgeSeconds !== null && !num(m.collectionAgeSeconds, { max: 1e9 })) || !num(m.gapCount, { int: true, max: 1e6 }) || typeof m.halted !== 'boolean')) return bad('bad-monitoring');

  // The verdict must be justified by the fields beside it. Anything else is a forged or corrupted payload.
  const hasEvent = s.event !== null;
  if (hasEvent !== (s.assessment === 'unusual-activity')) return bad('inconsistent-event');
  switch (s.verdict) {
    case 'unavailable':
      if (q.state !== 'unavailable' || hasEvent || s.activity !== null || s.assessment !== 'not-assessed') return bad('inconsistent-verdict'); break;
    case 'withheld':
      if (q.state !== 'withheld' || hasEvent || q.reasons.length === 0 || s.assessment !== 'not-assessed') return bad('inconsistent-verdict'); break;
    case 'normal': case 'elevated': case 'event': {
      const expectedAssessment = { normal: 'typical', elevated: 'elevated-no-new-event', event: 'unusual-activity' }[s.verdict];
      if (q.state !== 'verified' || !q.coverageVerified || q.reasons.length || s.assessment !== expectedAssessment || !s.window || !s.activity || s.series.length !== 6 || !s.baseline?.eligible || !s.monitoring || s.monitoring.halted) return bad('inconsistent-verdict');
      if (o.tradeCount !== s.activity.tradeCount) return bad('inconsistent-verdict');
      break;
    }
    default: return bad('bad-classification');
  }
  if (q.state === 'unavailable' && s.verdict !== 'unavailable') return bad('inconsistent-verdict');

  if (hasEvent) {
    const e = s.event;
    if (!exact(e, ['id', 'windowStart', 'windowEnd', 'notionalUsd', 'tradeCount', 'ratioToTypical', 'typicalNotionalUsd', 'explanation', 'scope']) || !str(e.id, 60) || !str(e.explanation, 700) || !str(e.scope, 120)
      || !num(e.notionalUsd) || !num(e.tradeCount, { int: true, max: 1e8 }) || !num(e.ratioToTypical, { max: 1e6 }) || !num(e.typicalNotionalUsd)) return bad('bad-event');
    if (e.ratioToTypical < limits.minEventRatio) return bad('event-below-threshold');
    if (e.windowStart !== s.window.from || e.windowEnd !== s.window.to || e.tradeCount !== s.activity.tradeCount || Math.abs(e.notionalUsd - s.activity.notionalUsd) > 0.01) return bad('event-window-mismatch');
  }
  return { ok: true, snapshot: s };
}
