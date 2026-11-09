// Production-side tests for XRP alongside BTC on the live snapshot routes. XRP fixtures are SYNTHETIC relabels of the BTC ones (rules, not market data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { validateLiveSnapshot } from '../flow/live-validate.js';
import { createFlowLiveRouter } from '../flow/live-routes.js';
import { FLOW_ASSETS, flowAsset } from '../flow/live-assets.js';
import { verifyToken, createToken } from '../auth/jwt.js';

const fx = (n) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/flow/${n}.synthetic.json`, import.meta.url)), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const toXrp = (s) => JSON.parse(JSON.stringify(s).replaceAll('live-btc-usd', 'live-xrp-usd').replaceAll('BTC/USD', 'XRP/USD').replace('"asset":"BTC"', '"asset":"XRP"'));
const BTC = fx('live-snapshot-normal'); const XRP = toXrp(BTC); const XRP_EVENT = toXrp(fx('live-snapshot-event')); const BTC_EVENT = fx('live-snapshot-event');
const cap = (s) => Date.parse(s.observation.capturedAt) / 1000;
const SECRET = 'x'.repeat(40);

test('registry: BTC and XRP only; exact keys; the fixtures relabel cleanly', () => {
  assert.deepEqual(Object.keys(FLOW_ASSETS), ['BTC', 'XRP']);
  for (const bad of ['xrp', 'ETH', '', 'constructor', '__proto__', null, undefined, ['XRP']]) assert.equal(flowAsset(bad), null);
  assert.equal(XRP.asset, 'XRP'); assert.equal(XRP.pair, 'XRP/USD'); assert.equal(XRP.id, 'live-xrp-usd'); assert.doesNotMatch(JSON.stringify(XRP), /BTC/);
  assert.equal(BTC.asset, 'BTC'); assert.equal(BTC.id, 'live-btc-usd');
});

test('validator: XRP and BTC validate; identity cannot be mixed; other assets and event/baseline rules still apply', () => {
  for (const s of [BTC, XRP, XRP_EVENT, BTC_EVENT]) assert.equal(validateLiveSnapshot(s, { nowSec: cap(s) + 30 }).ok, true);
  const now = cap(XRP) + 30;
  const reason = (mut) => { const s = clone(XRP); mut(s); const r = validateLiveSnapshot(s, { nowSec: now }); return r.ok ? 'ok' : r.reason; };
  assert.equal(reason((s) => { s.pair = 'BTC/USD'; }), 'wrong-asset');
  assert.equal(reason((s) => { s.id = 'live-btc-usd'; }), 'wrong-asset');
  assert.equal(reason((s) => { s.asset = 'BTC'; }), 'wrong-asset');
  assert.equal(reason((s) => { s.asset = 'xrp'; }), 'wrong-asset');
  assert.equal(reason((s) => { s.asset = 'ETH'; s.pair = 'ETH/USD'; s.id = 'live-eth-usd'; }), 'wrong-asset');
  assert.equal(reason((s) => { s.asset = '__proto__'; }), 'wrong-asset');
  assert.equal(reason((s) => { s.baseline.eligible = false; }), 'inconsistent-verdict');          // "normal" still needs an eligible baseline
  assert.equal(reason((s) => { s.trades = [{ price: 1 }]; }), 'unknown-field');
  const e = cap(XRP_EVENT) + 30; const ev = clone(XRP_EVENT); ev.event.ratioToTypical = 1.2;
  assert.equal(validateLiveSnapshot(ev, { nowSec: e }).reason, 'event-below-threshold');
  const nb = clone(XRP_EVENT); nb.baseline.eligible = false;
  assert.equal(validateLiveSnapshot(nb, { nowSec: e }).reason, 'inconsistent-verdict');             // no event without an eligible baseline
});

const fakeAuth = (req, res, next) => (verifyToken((req.headers.authorization ?? '').replace(/^Bearer /, '')) ? next() : res.status(401).json({ error: 'Unauthorized' }));
async function serve(opts = {}) {
  const clk = { t: cap(BTC) * 1000 + 30_000 };
  const app = express(); app.use('/api/flow', createFlowLiveRouter({ requireAuth: fakeAuth, publishSecret: SECRET, nowMs: () => clk.t, minPublishGapMs: 0, ...opts }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/flow/live`; const user = { authorization: `Bearer ${createToken(7, 'u@example.com')}` };
  return { clk, user, pub: (body, headers = { authorization: `Bearer ${SECRET}` }) => fetch(`${base}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    get: (q = '', headers = user) => fetch(base + q, { headers }), close: () => new Promise((r) => server.close(r)) };
}

test('BTC is the default: no query behaves exactly as before and equals ?asset=BTC', async () => {
  const s = await serve();
  try {
    const empty = await (await s.get()).json(); assert.equal(empty.state, 'no-snapshot'); assert.equal(empty.reason, 'backend-restarted');
    assert.deepEqual(Object.keys(empty).sort(), ['reason', 'schemaVersion', 'serverStartedAt', 'serverTime', 'state']);        // envelope shape unchanged
    assert.equal((await s.pub(BTC)).status, 200);
    const a = await (await s.get()).json(); assert.equal(a.state, 'ok'); assert.equal(a.snapshot.asset, 'BTC'); assert.deepEqual(a, await (await s.get('?asset=BTC')).json());
    assert.deepEqual(Object.keys(a).sort(), ['schemaVersion', 'serverStartedAt', 'serverTime', 'snapshot', 'snapshotAgeSeconds', 'state']);
    assert.equal((await s.get()).headers.get('cache-control'), 'no-store');
  } finally { await s.close(); }
});

test('BTC and XRP are accepted, held and served independently; unknown assets are refused; auth applies to both', async () => {
  const s = await serve();
  try {
    assert.equal((await (await s.get('?asset=XRP')).json()).state, 'no-snapshot');
    assert.equal((await s.pub(BTC)).status, 200);
    assert.equal((await (await s.get('?asset=XRP')).json()).state, 'no-snapshot');                      // a BTC publish never answers an XRP read
    assert.equal((await s.pub(XRP)).status, 200);
    const x = await (await s.get('?asset=XRP')).json(); assert.equal(x.state, 'ok'); assert.equal(x.snapshot.asset, 'XRP'); assert.equal(x.snapshot.id, 'live-xrp-usd');
    assert.equal((await (await s.get()).json()).snapshot.asset, 'BTC');                                  // XRP did not overwrite BTC
    for (const q of ['?asset=DOGE', '?asset=xrp', '?asset=', '?asset[]=XRP', '?asset=XRP&asset=BTC', '?asset=__proto__', '?asset=constructor']) assert.equal((await s.get(q)).status, 400, q);
    assert.deepEqual(await (await s.get('?asset=DOGE')).json(), { error: 'unsupported-asset' });
    assert.equal((await s.get('?asset=XRP', {})).status, 401); assert.equal((await s.get('?asset=XRP', { authorization: `Bearer ${SECRET}` })).status, 401);
    assert.equal((await s.pub(XRP, {})).status, 401); assert.equal((await s.pub(XRP, { authorization: 'Bearer wrong' })).status, 401);
    const mixed = clone(XRP); mixed.pair = 'BTC/USD'; const r = await s.pub(mixed); assert.equal(r.status, 422); assert.equal((await r.json()).reason, 'wrong-asset');
    const eth = clone(XRP); eth.asset = 'ETH'; assert.equal((await s.pub(eth)).status, 422);
    assert.equal((await (await s.get('?asset=XRP')).json()).snapshot.pair, 'XRP/USD');                   // the refused payloads changed nothing
  } finally { await s.close(); }
});

test('freshness, replay protection and rate limits are per asset', async () => {
  const s = await serve({ minPublishGapMs: 5000 });
  try {
    assert.equal((await s.pub(BTC)).status, 200);
    assert.equal((await s.pub(XRP)).status, 200);                                                        // not blocked by BTC's rate-limit slot
    assert.equal((await s.pub(XRP)).status, 429); assert.equal((await s.pub(BTC)).status, 429);
    s.clk.t += 6000; assert.equal((await s.pub(XRP)).status, 409); assert.equal((await s.pub(BTC)).status, 409);   // an identical/older capture is refused
    const older = clone(XRP); older.observation.capturedAt = new Date(Date.parse(XRP.observation.capturedAt) - 1000).toISOString();
    assert.equal((await s.pub(older)).status, 409);
    s.clk.t += 400_000;                                                                                   // > 5 minutes with no publisher
    for (const q of ['', '?asset=XRP']) { const b = await (await s.get(q)).json(); assert.equal(b.state, 'stale'); assert.equal(b.reason, 'publisher-silent'); assert.equal(b.snapshot, undefined); }
    assert.equal((await s.pub(XRP)).status, 422);                                                         // the old capture is too old to publish again
  } finally { await s.close(); }
});

test('production source stays self-contained: the asset registry has no imports and nothing else was added', () => {
  const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(read('../flow/live-assets.js'), /import |require\(|fetch\(|process\.env/);
  assert.doesNotMatch(['../flow/live-routes.js', '../flow/live-validate.js', '../flow/live-assets.js'].map(read).join('\n'), /from '\.\/(monitor|store|detector|buckets|kraken|collector|live-snapshot)|better-sqlite3|node:fs|node:child_process|fetch\(|https?:\/\//);
});
