// Private delivery of the live BTC snapshot: Mac (publisher script) -> this router -> authenticated iPhone.
//   POST /api/flow/live/publish   needs `Authorization: Bearer <FLOW_PUBLISH_SECRET>`. Disabled (503) unless that env var is set (>= 32 chars).
//   GET  /api/flow/live           needs the app's normal user token (requireAuth, injected). Read-only.
// The snapshot is held IN MEMORY only (Render free tier restarts and sleeps). That is represented, not hidden: after a restart the read
// endpoint says `no-snapshot` with reason `backend-restarted`, never an old or empty "normal". Nothing here writes to disk or calls a provider.
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { validateLiveSnapshot, LIVE_LIMITS } from './live-validate.js';

const sha = (s) => createHash('sha256').update(String(s)).digest();
export const LIVE_RESPONSE_VERSION = 1;

export function createFlowLiveRouter({ requireAuth, publishSecret = process.env.FLOW_PUBLISH_SECRET, nowMs = () => Date.now(), limits = LIVE_LIMITS, minPublishGapMs = 5000 } = {}) {
  if (typeof requireAuth !== 'function') throw new TypeError('flow live router: requireAuth must be injected');
  const secretOk = typeof publishSecret === 'string' && publishSecret.length >= 32;
  const secretHash = secretOk ? sha(publishSecret) : null;
  const bootedAt = nowMs();
  let held = null;                       // { snapshot, receivedAt, capturedAt }
  let lastPublishAt = 0;
  const router = Router();

  router.post('/live/publish', (req, res, next) => {                                // auth first: an unauthenticated caller learns nothing and parses nothing
    res.set('Cache-Control', 'no-store');
    if (!secretOk) return res.status(503).json({ error: 'publishing-disabled' });
    const m = /^Bearer (.{1,256})$/.exec(req.headers.authorization ?? '');
    if (!m || !timingSafeEqual(sha(m[1]), secretHash)) return res.status(401).json({ error: 'unauthorized' });
    return next();
  }, express.json({ limit: limits.maxBodyBytes, strict: true }), (req, res) => {
    const now = nowMs();
    if (now - lastPublishAt < minPublishGapMs) return res.status(429).json({ error: 'too-frequent' });
    const v = validateLiveSnapshot(req.body, { nowSec: now / 1000, limits });
    if (!v.ok) return res.status(422).json({ error: 'invalid-snapshot', reason: v.reason });
    const capturedAt = Date.parse(v.snapshot.observation.capturedAt);
    if (held && capturedAt <= held.capturedAt) return res.status(409).json({ error: 'not-newer-than-held' });   // blocks replay of an older capture
    held = { snapshot: v.snapshot, receivedAt: now, capturedAt }; lastPublishAt = now;
    return res.status(200).json({ accepted: true, capturedAt: v.snapshot.observation.capturedAt });
  });

  router.get('/live', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const now = nowMs();
    const env = { schemaVersion: LIVE_RESPONSE_VERSION, serverTime: new Date(now).toISOString(), serverStartedAt: new Date(bootedAt).toISOString() };
    if (!held) return res.json({ ...env, state: 'no-snapshot', reason: 'backend-restarted' });      // nothing received since this process started
    const ageSeconds = Math.max(0, Math.round((now - held.capturedAt) / 1000));
    // Re-validate on every read: the age rule is time-dependent, and a held object can never be served unvalidated.
    const v = validateLiveSnapshot(held.snapshot, { nowSec: now / 1000, limits });
    if (!v.ok) return res.json({ ...env, state: 'stale', reason: v.reason === 'stale-snapshot' ? 'publisher-silent' : 'invalid-held-snapshot', snapshotAgeSeconds: ageSeconds });
    return res.json({ ...env, state: 'ok', snapshotAgeSeconds: ageSeconds, snapshot: v.snapshot });
  });
  router.use((err, req, res, next) => { res.set('Cache-Control', 'no-store'); res.status(err?.status === 413 ? 413 : 400).json({ error: err?.status === 413 ? 'too-large' : 'bad-request' }); });   // no parser detail leaks
  return router;
}
