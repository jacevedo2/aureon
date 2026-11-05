import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createXrpService } from '../xrp/service.js';
import { loadXrpConfig } from '../xrp/config.js';
import { Unavailable } from '../xrp/xrpl-client.js';
import { basicLedger, cfg as analysisCfg, NOW } from './helpers/xrp-fake-ledger.js';

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function setup({ enabled = true, hints = {}, led = basicLedger() } = {}) {
  const clock = { ms: NOW * 1000 }; const state = { down: false };
  const cfg = { enabled, rpcUrl: 'https://example.invalid/', refreshSeconds: 900, staleAfterSeconds: 2700, maxServeAgeSeconds: 7200, scanDeadlineSeconds: 480, hints, analysis: analysisCfg() };
  const timers = [];
  const rpc = async (m, p) => { if (state.down) throw new Unavailable('upstream down'); return led.rpc(m, p); };
  const svc = createXrpService({ cfg, clientFactory: () => ({ rpc, stats: { requests: 0 }, setDeadline() {} }), nowMs: () => clock.ms,
    log: { log() {}, warn() {} }, setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimeoutFn() {} });
  return { svc, led, clock, state, timers, cfg };
}

test('disabled by default: no upstream calls, explicit disabled state, no totals', async () => {
  const { svc, led } = setup({ enabled: false });
  assert.equal(await svc.refresh(), null); svc.start(); await flush();
  assert.equal(led.calls.length, 0);
  const r = svc.getResponse(); assert.equal(r.state, 'disabled'); assert.equal(r.totals.verified, false); assert.deepEqual(r.wallets, []);
  assert.equal(r.unsupported.exchangeNetFlow.available, false);
});

test('before the first scan: warming, no data; a request never starts a scan', async () => {
  const { svc, led } = setup();
  for (let i = 0; i < 10; i += 1) assert.equal(svc.getResponse().state, 'warming');
  assert.equal(led.calls.length, 0);
});

test('after a scan: fresh, verified totals, ledger boundaries, transfer hashes + verification, unconfirmed ownership', async () => {
  const { svc } = setup(); await svc.refresh(); const r = svc.getResponse();
  assert.equal(r.state, 'fresh'); assert.equal(r.readOnly, true); assert.equal(r.schemaVersion, 1);
  assert.deepEqual([r.totals.verified, r.totals.receivedXrp, r.totals.sentXrp, r.totals.netXrp], [true, 5350, 2000, 3350]);
  assert.equal(r.observation.pinnedLedger, 1000); assert.equal(r.observation.windowHours, 24);
  assert.ok(r.observation.windowStart < r.observation.windowEnd);
  const w = r.wallets[0];
  assert.equal(w.ownership.status, 'unconfirmed_third_party'); assert.match(w.ownership.note, /NOT confirmed/);
  assert.deepEqual([w.coverage.openingLedgerExclusive, w.coverage.closingLedger, w.coverage.complete, w.coverage.historyProven], [959, 1000, true, true]);
  assert.equal(w.reconciliation.ran, true); assert.equal(w.reconciliation.residualDrops, '0'); assert.equal(w.verified, true);
  assert.deepEqual(r.largeTransfers.items.map((t) => t.hash), ['H1', 'H2']);
  for (const t of r.largeTransfers.items) { assert.equal(t.flowClass, 'unclassified'); assert.equal(t.reverified, true); assert.match(t.verifyUrl, /^https:\/\/livenet\.xrpl\.org\/transactions\//); assert.equal(t.counterparty.ownership, 'unknown'); }
  assert.equal(r.unsupported.exchangeNetFlow.available, false); assert.equal(r.unsupported.whaleActivity.available, false);
});

test('serialized response never claims confirmed ownership, exchange flow classes, or names a label source', async () => {
  const { svc } = setup(); await svc.refresh(); const txt = JSON.stringify(svc.getResponse());
  for (const bad of ['confirmed_external', 'confirmed_internal', 'xrpscan', 'exchange_inflow', 'exchange_outflow', '"confirmed"']) assert.equal(txt.toLowerCase().includes(bad), false, bad);
  assert.equal(txt.includes('entityHint'), false);
});

test('entity hints appear only when configured through the environment', async () => {
  const { svc } = setup({ hints: { A: 'Example Exchange' } }); await svc.refresh();
  const w = svc.getResponse().wallets[0]; assert.equal(w.entityHint, 'Example Exchange'); assert.equal(w.ownership.status, 'unconfirmed_third_party');
});

test('single-flight: concurrent refreshes share one scan', async () => {
  const { svc, led } = setup(); const [a, b] = await Promise.all([svc.refresh(), svc.refresh()]);
  assert.equal(a, b); assert.equal(led.calls.filter((m) => m === 'server_info').length, 1);
});

test('cache: requests are served from memory with no upstream traffic', async () => {
  const { svc, led } = setup(); await svc.refresh(); const n = led.calls.length;
  for (let i = 0; i < 25; i += 1) svc.getResponse();
  assert.equal(led.calls.length, n);
});

test('freshness: stale after 3 intervals; totals withheld once the snapshot is too old', async () => {
  const { svc, clock } = setup(); await svc.refresh();
  clock.ms += 2000 * 1000; assert.equal(svc.getResponse().state, 'fresh');
  clock.ms += 1000 * 1000; let r = svc.getResponse(); assert.equal(r.state, 'stale'); assert.equal(r.totals.verified, true);      // 3000 s old
  clock.ms += 4400 * 1000; r = svc.getResponse(); assert.equal(r.state, 'stale'); assert.equal(r.totals.verified, false);          // 7400 s old
  assert.equal(r.totals.receivedXrp, null); assert.match(r.totals.withheldReasons.snapshot, /snapshot is 7400s old/);
  assert.equal(r.wallets[0].figuresVerified, false); assert.equal(r.largeTransfers.complete, false);
});

test('a failed scan never replaces cached data and is reported', async () => {
  const { svc, state } = setup(); await svc.refresh(); state.down = true;
  assert.equal(await svc.refresh(), null); const r = svc.getResponse();
  assert.equal(r.state, 'fresh'); assert.equal(r.totals.verified, true); assert.equal(r.refresh.lastAttemptOk, false); assert.match(r.refresh.lastAttemptError, /upstream down|validated ledger/);
});

test('no data and a failed first scan: explicit unavailable state', async () => {
  const { svc, state } = setup(); state.down = true; await svc.refresh();
  const r = svc.getResponse(); assert.equal(r.state, 'unavailable'); assert.equal(r.totals.verified, false); assert.deepEqual(r.wallets, []);
});

test('a newer UNVERIFIED scan does not replace a fresh verified one, but is disclosed; once stale it is what gets served', async () => {
  const { svc, led, clock } = setup(); await svc.refresh();
  led.bal['rAAAA|1000'] += 1;                                          // next scan: ledger balance disagrees -> unverified
  clock.ms += 900 * 1000; await svc.refresh();
  let r = svc.getResponse();
  assert.equal(r.state, 'fresh'); assert.equal(r.totals.verified, true); assert.ok(r.refresh.newerScanNotVerified); assert.ok('A' in r.refresh.newerScanNotVerified.withheldReasons);
  clock.ms += 2000 * 1000; r = svc.getResponse();                      // verified snapshot is now > 2700 s old
  assert.equal(r.totals.verified, false); assert.equal(r.totals.receivedXrp, null); assert.match(r.totals.withheldReasons.A, /non-zero reconciliation residual/);
  assert.equal(r.wallets[0].figuresVerified, false);
});

test('scheduler: first scan at start, then every interval; a failure doubles the delay (max 1 h) and success resets it', async () => {
  const { svc, state, timers } = setup(); svc.start(); await flush();
  assert.equal(svc.getResponse().state, 'fresh'); assert.equal(timers.at(-1).ms, 900_000);
  state.down = true; await timers.at(-1).fn(); await flush(); assert.equal(timers.at(-1).ms, 1_800_000);
  await timers.at(-1).fn(); await flush(); assert.equal(timers.at(-1).ms, 3_600_000);
  await timers.at(-1).fn(); await flush(); assert.equal(timers.at(-1).ms, 3_600_000);            // capped
  state.down = false; await timers.at(-1).fn(); await flush(); assert.equal(timers.at(-1).ms, 900_000);
  svc.stop();
});

// ── config ────────────────────────────────────────────────────────────────
test('config: disabled unless XRP_WALLETS_ENABLED === "true"; defaults; clamps; hints parsing', () => {
  assert.equal(loadXrpConfig({}).enabled, false); assert.equal(loadXrpConfig({ XRP_WALLETS_ENABLED: '1' }).enabled, false);
  const c = loadXrpConfig({ XRP_WALLETS_ENABLED: 'true', XRPL_RPC_URL: 'https://xrpl.example.invalid/abc' });
  assert.equal(c.enabled, true); assert.equal(c.rpcUrl, 'https://xrpl.example.invalid/abc'); assert.equal(c.refreshSeconds, 900);
  assert.equal(loadXrpConfig({ XRP_REFRESH_SECONDS: '10' }).refreshSeconds, 300); assert.equal(loadXrpConfig({ XRP_REFRESH_SECONDS: '999999' }).refreshSeconds, 3600);
  assert.equal(loadXrpConfig({ XRP_REFRESH_SECONDS: 'abc' }).refreshSeconds, 900);
  assert.deepEqual(loadXrpConfig({ XRP_ENTITY_HINTS: 'not json' }).hints, {}); assert.deepEqual(loadXrpConfig({ XRP_ENTITY_HINTS: '{"W1":"X","W2":5}' }).hints, { W1: 'X' });
  assert.equal(c.analysis.wallets.length, 3); assert.ok(c.analysis.wallets.every((w) => w.ownership === 'third_party' && w.entity_hint === undefined));
});

test('wallets.json: addresses only — no exchange names, no confirmed ownership, no label-source names', () => {
  const txt = readFileSync(join(root, 'xrp', 'wallets.json'), 'utf-8');
  for (const word of ['kraken', 'binance', 'bitstamp', 'coinbase', 'xrpscan', '"confirmed"']) assert.equal(txt.toLowerCase().includes(word), false, word);
  for (const w of JSON.parse(txt).wallets) assert.match(w.address, /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/);
});

test('xrp code has no signing/key material and reads env only in config.js', () => {
  for (const f of ['collector.js', 'xrpl-client.js', 'service.js', 'response.js', 'routes.js']) {
    const src = readFileSync(join(root, 'xrp', f), 'utf-8');
    assert.equal(/process\.env/.test(src), false, `${f} must not read process.env`);
    assert.equal(/\b(seed|secret|private[_ ]?key|sign\()/i.test(src.replace(/\/\/.*$/gm, '')), false, `${f}: no key material or signing`);
    assert.equal(/"method":\s*"(submit|sign|wallet_propose)"|'(submit|sign|wallet_propose)'/.test(src), false, `${f}: read-only RPC methods only`);
  }
});
