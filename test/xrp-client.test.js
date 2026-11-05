import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createXrplClient, Unavailable } from '../xrp/xrpl-client.js';

function harness(script, opts = {}) {
  let t = 0; const sleeps = []; const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), method: init.method });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  const client = createXrplClient({ url: 'https://xrpl.example.invalid/', fetchImpl, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, paceMs: 1600, maxAttempts: 4, ...opts });
  return { client, sleeps, calls, clock: () => t };
}
const ok = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });

test('client: read-only JSON-RPC POST with the method and params wrapped as XRPL expects; no credentials sent', async () => {
  const h = harness([ok({ status: 'success', x: 1 })]);
  const r = await h.client.rpc('server_info', {});
  assert.equal(r.x, 1); assert.deepEqual(h.calls[0].body, { method: 'server_info', params: [{}] }); assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.calls[0].url, 'https://xrpl.example.invalid/');
});

test('client: consecutive requests are paced (>= paceMs apart)', async () => {
  const h = harness([ok({ a: 1 })]);
  await h.client.rpc('a', {}); await h.client.rpc('b', {}); await h.client.rpc('c', {});
  assert.deepEqual(h.sleeps, [1600, 1600, 1600]);
});

test('client: tooBusy waits the server-suggested time (+2 s) and retries, then succeeds', async () => {
  const h = harness([ok({ error: 'tooBusy', error_message: 'units quota (10000 per 60s) exhausted, retry in ~1500ms' }), ok({ fine: true })]);
  const r = await h.client.rpc('account_tx', {});
  assert.equal(r.fine, true); assert.equal(h.client.stats.rateLimitWaits, 1); assert.ok(h.sleeps.includes(3500)); assert.equal(h.calls.length, 2);
});

test('client: network errors and HTTP 5xx are retried with a growing delay', async () => {
  const h = harness([new Error('ECONNRESET'), { ok: false, status: 503, json: async () => ({}) }, ok({ fine: 1 })]);
  const r = await h.client.rpc('x', {});
  assert.equal(r.fine, 1); assert.equal(h.client.stats.failedAttempts, 2); assert.ok(h.sleeps.includes(3000) && h.sleeps.includes(6000));
});

test('client: gives up as Unavailable after maxAttempts (never returns made-up data)', async () => {
  const h = harness([new Error('down')]);
  await assert.rejects(h.client.rpc('x', {}), (e) => e instanceof Unavailable && /down/.test(e.message));
  assert.equal(h.calls.length, 4);
});

test('client: persistent rate limiting also ends as Unavailable', async () => {
  const h = harness([ok({ error: 'tooBusy', error_message: 'retry in ~100ms' })]);
  await assert.rejects(h.client.rpc('x', {}), (e) => e instanceof Unavailable && /rate limited/.test(e.message));
});

test('client: malformed responses are retried, not trusted', async () => {
  const h = harness([{ ok: true, status: 200, json: async () => ({ nope: 1 }) }, ok({ fine: 1 })]);
  assert.equal((await h.client.rpc('x', {})).fine, 1);
});

test('client: scan deadline stops further requests', async () => {
  const h = harness([ok({ a: 1 })]);
  h.client.setDeadline(h.clock() + 1000);
  await h.client.rpc('a', {});                 // pacing sleep pushes the clock past the deadline
  await assert.rejects(h.client.rpc('b', {}), (e) => e instanceof Unavailable && /deadline/.test(e.message));
  h.client.setDeadline(null); assert.equal((await h.client.rpc('c', {})).a, 1);
});

test('client: only calls marked cacheable are cached; errors are never cached; cache is bounded', async () => {
  const h = harness([ok({ v: 1 })], { cacheMax: 2 });
  await h.client.rpc('tx', { transaction: 'A' }, { cacheable: true }); await h.client.rpc('tx', { transaction: 'A' }, { cacheable: true });
  assert.equal(h.calls.length, 1); assert.equal(h.client.stats.cacheHits, 1);
  await h.client.rpc('tx', { transaction: 'A' }); assert.equal(h.calls.length, 2);                       // not marked cacheable -> always fetched
  await h.client.rpc('tx', { transaction: 'B' }, { cacheable: true }); await h.client.rpc('tx', { transaction: 'C' }, { cacheable: true });
  assert.equal(h.client.cacheSize, 2);                                                                    // FIFO bound
  const e = harness([ok({ error: 'txnNotFound', status: 'error' })]);
  await e.client.rpc('tx', { transaction: 'Z' }, { cacheable: true }); await e.client.rpc('tx', { transaction: 'Z' }, { cacheable: true });
  assert.equal(e.calls.length, 2);
});
