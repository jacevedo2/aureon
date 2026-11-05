// Fail-closed endpoint handling: there is NO public XRPL fallback. Without a valid, explicitly configured
// XRPL_RPC_URL the monitor never starts and never makes an XRPL request — even if XRP_WALLETS_ENABLED=true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadXrpConfig } from '../xrp/config.js';
import { createXrpService } from '../xrp/service.js';
import { createXrplClient, Unavailable } from '../xrp/xrpl-client.js';

const quiet = { log() {}, warn() {} };
const ON = { XRP_WALLETS_ENABLED: 'true' };

test('config: enabled WITHOUT an endpoint fails closed — not enabled, no rpcUrl, no public default', () => {
  for (const env of [ON, { ...ON, XRPL_RPC_URL: '' }, { ...ON, XRPL_RPC_URL: '   ' }]) {
    const c = loadXrpConfig(env);
    assert.equal(c.requested, true); assert.equal(c.enabled, false); assert.equal(c.rpcUrl, null);
    assert.equal(c.configError, 'XRPL_RPC_URL is not set');
    assert.equal(JSON.stringify(c).includes('xrplcluster'), false);
  }
});

test('config: invalid / non-https endpoints fail closed; messages never echo the URL (it carries a credential)', () => {
  const secret = 'SUPERSECRETTOKEN123456';
  const bad = { 'not a url': 'XRPL_RPC_URL is not a valid URL', [`http://example.com/${secret}`]: 'XRPL_RPC_URL must be an https:// URL',
    [`ftp://example.com/${secret}`]: 'XRPL_RPC_URL must be an https:// URL', [`ws://example.com/${secret}`]: 'XRPL_RPC_URL must be an https:// URL' };
  for (const [url, err] of Object.entries(bad)) {
    const c = loadXrpConfig({ ...ON, XRPL_RPC_URL: url });
    assert.equal(c.enabled, false); assert.equal(c.rpcUrl, null); assert.equal(c.configError, err);
    assert.equal(JSON.stringify(c).includes(secret), false, 'config must not retain or echo a rejected URL');
  }
});

test('config: a valid https endpoint enables; loopback http is allowed only for local testing; surrounding whitespace is trimmed', () => {
  const ok = loadXrpConfig({ ...ON, XRPL_RPC_URL: '  https://xrpl.example.invalid/tok  ' });
  assert.equal(ok.enabled, true); assert.equal(ok.rpcUrl, 'https://xrpl.example.invalid/tok'); assert.equal(ok.configError, null);
  assert.equal(loadXrpConfig({ ...ON, XRPL_RPC_URL: 'http://127.0.0.1:8545/x' }).enabled, true);
  assert.equal(loadXrpConfig({ ...ON, XRPL_RPC_URL: 'http://localhost:8545/x' }).enabled, true);
});

test('config: an endpoint alone does NOT enable monitoring (still off unless XRP_WALLETS_ENABLED === "true")', () => {
  const c = loadXrpConfig({ XRPL_RPC_URL: 'https://xrpl.example.invalid/tok' });
  assert.equal(c.enabled, false); assert.equal(c.requested, false); assert.equal(c.configError, null);
  assert.equal(loadXrpConfig({ XRP_WALLETS_ENABLED: '1', XRPL_RPC_URL: 'https://xrpl.example.invalid/tok' }).enabled, false);
});

test('client: with no endpoint every call fails closed as Unavailable BEFORE any fetch', async () => {
  let fetched = 0;
  const client = createXrplClient({ fetchImpl: async () => { fetched += 1; return { ok: true, json: async () => ({ result: {} }) }; }, sleep: async () => {}, maxAttempts: 2 });
  await assert.rejects(() => client.rpc('server_info', {}), (e) => e instanceof Unavailable && /no XRPL endpoint configured/.test(e.message));
  assert.equal(fetched, 0); assert.equal(client.stats.requests, 0);
});

test('service: enabled + no endpoint — start() and refresh() make ZERO network calls (global fetch is trapped)', async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('network call attempted'); };
  try {
    const svc = createXrpService({ cfg: loadXrpConfig(ON), log: quiet });      // DEFAULT client factory, DEFAULT fetch
    svc.start(); assert.equal(await svc.refresh(), null);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 0, 'no XRPL / network request may be made without a configured endpoint');
    assert.equal(svc.client.stats.requests, 0); svc.stop();
  } finally { globalThis.fetch = realFetch; }
});

test('service: enabled + no endpoint — served state is "disabled / not configured", totals withheld, nothing fabricated', () => {
  const svc = createXrpService({ cfg: loadXrpConfig(ON), log: quiet });
  const r = svc.getResponse();
  assert.equal(r.state, 'disabled'); assert.equal(r.totals.verified, false); assert.equal(r.totals.withheldReason, 'monitoring not configured');
  assert.match(r.reason, /not configured on this server \(XRPL_RPC_URL is not set\); no ledger requests are made/);
  assert.deepEqual(r.wallets, []); assert.equal(r.largeTransfers.available, false);
  assert.equal(r.unsupported.exchangeNetFlow.available, false); assert.equal(r.unsupported.whaleActivity.available, false);
});

test('service: the configured endpoint (a credential) never appears in the served response', () => {
  const secret = 'SUPERSECRETTOKEN123456';
  const cfg = loadXrpConfig({ ...ON, XRPL_RPC_URL: `https://xrpl.example.invalid/${secret}` });
  const svc = createXrpService({ cfg, clientFactory: () => ({ rpc: async () => { throw new Error('unused'); }, stats: {}, setDeadline() {} }), log: quiet });
  assert.equal(JSON.stringify(svc.getResponse()).includes(secret), false);
});

test('default (nothing set): plainly disabled — distinct from "not configured" — and still no network', async () => {
  const realFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls += 1; throw new Error('x'); };
  try {
    const svc = createXrpService({ cfg: loadXrpConfig({}), log: quiet }); svc.start(); await svc.refresh();
    const r = svc.getResponse();
    assert.equal(r.state, 'disabled'); assert.equal(r.totals.withheldReason, 'monitoring disabled'); assert.match(r.reason, /not enabled on this server/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = realFetch; }
});
