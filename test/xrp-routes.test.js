import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { createXrpRouter } from '../xrp/routes.js';
import { createXrpService } from '../xrp/service.js';
import { loadXrpConfig } from '../xrp/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
async function withServer(service, fn) {
  const app = express(); app.use('/api/xrp', createXrpRouter(service));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('GET /api/xrp/wallets: JSON, cacheable for 60 s, served from the service; default build is "disabled" and makes no upstream call', async () => {
  let fetched = 0;
  const service = createXrpService({ cfg: loadXrpConfig({}), clientFactory: () => ({ rpc: async () => { fetched += 1; }, stats: {}, setDeadline() {} }), log: { log() {}, warn() {} } });
  service.start();
  await withServer(service, async (base) => {
    const r = await fetch(`${base}/api/xrp/wallets`); const body = await r.json();
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /application\/json/); assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(body.state, 'disabled'); assert.equal(body.totals.verified, false); assert.equal(body.readOnly, true);
  });
  assert.equal(fetched, 0);
});

test('read-only surface: no write or refresh endpoints (POST/PUT/DELETE and other paths 404)', async () => {
  const service = { getResponse: () => ({ state: 'disabled' }) };
  await withServer(service, async (base) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await fetch(`${base}/api/xrp/wallets`, { method })).status, 404, method);
    for (const path of ['/api/xrp/refresh', '/api/xrp', '/api/xrp/wallets/refresh']) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  });
});

test('server.js wires the XRP router and scheduler without touching the ETF routes', () => {
  const src = readFileSync(join(root, 'server.js'), 'utf-8');
  assert.match(src, /app\.use\('\/api\/xrp', createXrpRouter\(xrpService\)\)/); assert.match(src, /xrpService\.start\(\)/);
  assert.match(src, /buildEtfResponse\(etfState/);                       // ETF integrity guard still in place
});
