// Private delivery of the live BTC snapshot: Mac (publisher script) -> this router -> authenticated iPhone.
//   POST /api/flow/live/publish   needs `Authorization: Bearer <FLOW_PUBLISH_SECRET>`. Disabled (503) unless that env var is set (>= 32 chars).
//   GET  /api/flow/live           needs the app's normal user token (requireAuth, injected). Read-only. `?asset=XRP` selects another asset; with no
//                                 parameter it serves BTC exactly as before. An unsupported asset is a 400, never a guess.
// Each asset is held, rate-limited and replay-checked INDEPENDENTLY, so one asset's publisher can never overwrite or age another's.
// The snapshot is held IN MEMORY only (Render free tier restarts and sleeps). That is represented, not hidden: after a restart the read
// endpoint says `no-snapshot` with reason `backend-restarted`, never an old or empty "normal". Nothing here writes to disk or calls a provider.
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { validateLiveSnapshot, LIVE_LIMITS } from './live-validate.js';
import { DEFAULT_FLOW_ASSET, flowAsset } from './live-assets.js';

const sha = (s) => createHash('sha256').update(String(s)).digest();
export const LIVE_RESPONSE_VERSION = 1;

export function createFlowLiveRouter({ requireAuth, publishSecret = process.env.FLOW_PUBLISH_SECRET, nowMs = () => Date.now(), limits = LIVE_LIMITS, minPublishGapMs = 5000 } = {}) {
  if (typeof requireAuth !== 'function') throw new TypeError('flow live router: requireAuth must be injected');
  const secretOk = typeof publishSecret === 'string' && publishSecret.length >= 32;
  const secretHash = secretOk ? sha(publishSecret) : null;
  const bootedAt = nowMs();
  const held = new Map();                // asset -> { snapshot, receivedAt, capturedAt }
  const lastPublishAt = new Map();       // asset -> ms
  const router = Router();

  router.post('/live/publish', (req, res, next) => {                                // auth first: an unauthenticated caller learns nothing and parses nothing
    res.set('Cache-Control', 'no-store');
    if (!secretOk) return res.status(503).json({ error: 'publishing-disabled' });
    const m = /^Bearer (.{1,256})$/.exec(req.headers.authorization ?? '');
    if (!m || !timingSafeEqual(sha(m[1]), secretHash)) return res.status(401).json({ error: 'unauthorized' });
    return next();
  }, express.json({ limit: limits.maxBodyBytes, strict: true }), (req, res) => {
    const now = nowMs();
    const slot = flowAsset(req.body?.asset) ? req.body.asset : DEFAULT_FLOW_ASSET;   // picks the rate-limit slot only; the validator decides acceptance
    if (now - (lastPublishAt.get(slot) ?? 0) < minPublishGapMs) return res.status(429).json({ error: 'too-frequent' });
    const v = validateLiveSnapshot(req.body, { nowSec: now / 1000, limits });
    if (!v.ok) return res.status(422).json({ error: 'invalid-snapshot', reason: v.reason });
    const key = v.snapshot.asset;
    const capturedAt = Date.parse(v.snapshot.observation.capturedAt);
    if (held.has(key) && capturedAt <= held.get(key).capturedAt) return res.status(409).json({ error: 'not-newer-than-held' });   // blocks replay of an older capture
    held.set(key, { snapshot: v.snapshot, receivedAt: now, capturedAt }); lastPublishAt.set(key, now);
    return res.status(200).json({ accepted: true, capturedAt: v.snapshot.observation.capturedAt });
  });

  router.get('/live', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const requested = req.query.asset === undefined ? DEFAULT_FLOW_ASSET : req.query.asset;
    if (!flowAsset(requested)) return res.status(400).json({ error: 'unsupported-asset' });
    const now = nowMs();
    const env = { schemaVersion: LIVE_RESPONSE_VERSION, serverTime: new Date(now).toISOString(), serverStartedAt: new Date(bootedAt).toISOString() };
    const h = held.get(requested);
    if (!h) return res.json({ ...env, state: 'no-snapshot', reason: 'backend-restarted' });      // nothing received since this process started
    const ageSeconds = Math.max(0, Math.round((now - h.capturedAt) / 1000));
    // Re-validate on every read: the age rule is time-dependent, and a held object can never be served unvalidated.
    const v = validateLiveSnapshot(h.snapshot, { nowSec: now / 1000, limits });
    if (!v.ok) return res.json({ ...env, state: 'stale', reason: v.reason === 'stale-snapshot' ? 'publisher-silent' : 'invalid-held-snapshot', snapshotAgeSeconds: ageSeconds });
    return res.json({ ...env, state: 'ok', snapshotAgeSeconds: ageSeconds, snapshot: v.snapshot });
  });
  router.use((err, req, res, next) => { res.set('Cache-Control', 'no-store'); res.status(err?.status === 413 ? 413 : 400).json({ error: err?.status === 413 ? 'too-large' : 'bad-request' }); });   // no parser detail leaks
  return router;
}
