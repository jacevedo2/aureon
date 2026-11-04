// Regression tests for the ETF data-integrity guard (etf-response.js).
// Run with:  npm test   (node:test — no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildEtfResponse, FLOWS_UNAVAILABLE_REASON, VERIFIED_FLOW_SOURCES } from '../etf-response.js';
import { etfData as fallbackData } from '../etf-data.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fileData = JSON.parse(readFileSync(join(root, 'latest-etf-data.json'), 'utf-8'));
const NOW = Date.parse('2026-11-04T12:00:00Z');

// A payload shaped exactly like the real one (the estimated, unverified values).
const estimated = () => structuredClone(fileData);
const state = (source, payload = estimated()) => ({ source, payload: { ...payload, etfTodayVolume: { IBIT: 123456789 } } });

const FLOW_KEYS = ['btcFlow', 'ethFlow', 'xrpFlow', 'btcAUM', 'ethAUM', 'xrpAUM'];
const SERIES_KEYS = ['btcRecentFlows', 'ethRecentFlows', 'xrpRecentFlows'];

function assertUnavailable(body) {
  assert.equal(body.lastUpdated, null, 'lastUpdated must be null');
  for (const k of FLOW_KEYS) assert.ok(!(k in body), `${k} must be omitted`);
  for (const k of SERIES_KEYS) assert.deepEqual(body[k], [], `${k} must be an empty array`);
  assert.deepEqual(body.etfTodayVolume, {});
  assert.equal(body.flowsVerified, false);
  assert.equal(body.flowsUnavailableReason, FLOWS_UNAVAILABLE_REASON);
  assert.equal(body._meta.flowsVerified, false);
  assert.equal(body._meta.isStale, true);
  assert.equal(body._meta.ageDays, null);
}

// Every number in a value tree, so we can prove no figure leaks anywhere.
function numbersIn(v, out = []) {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => numbersIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => numbersIn(x, out));
  return out;
}

test('no source is verified today (allowlist is empty)', () => {
  assert.equal(VERIFIED_FLOW_SOURCES.length, 0);
});

for (const source of ['latest-file', 'fallback', 'remote-url', 'coinglass-live', 'something-new', undefined]) {
  test(`unverified source "${source}" returns the unavailable response`, () => {
    assertUnavailable(buildEtfResponse(state(source), {}, { nowMs: NOW }));
  });
}

test('the unavailable response contains no numeric values at all (never a placeholder zero)', () => {
  const body = buildEtfResponse(state('latest-file'), {}, { nowMs: NOW });
  assert.deepEqual(numbersIn(body), []);
});

test('none of the stored estimate numbers appear anywhere in the response', () => {
  const body = buildEtfResponse(state('latest-file'), { refreshResult: 'updated', prevLastUpdated: fileData.lastUpdated, dataChanged: true }, { nowMs: NOW });
  const text = JSON.stringify(body);
  const stored = [...numbersIn(fileData), ...numbersIn(fallbackData)].filter(n => Math.abs(n) >= 1000);
  assert.ok(stored.length > 20, 'sanity: collected the stored figures');
  for (const n of stored) assert.ok(!text.includes(String(n)), `leaked stored figure ${n}`);
  assert.ok(!text.includes(fileData.lastUpdated), 'leaked the stored file date');
});

test('response is built from an allowlist: unknown payload fields never pass through', () => {
  const payload = { ...estimated(), btcFlowEstimate: 999999, _note: 'secret', extraSeries: [1, 2, 3] };
  const text = JSON.stringify(buildEtfResponse(state('latest-file', payload), {}, { nowMs: NOW }));
  for (const needle of ['btcFlowEstimate', '999999', 'secret', 'extraSeries']) assert.ok(!text.includes(needle), needle);
});

test('route metadata: only refreshResult / retryAfterSeconds are echoed', () => {
  const body = buildEtfResponse(state('latest-file'), { refreshResult: 'unchanged', retryAfterSeconds: 42, prevLastUpdated: '2026-11-03', dataChanged: false, anything: 'x' }, { nowMs: NOW });
  assert.equal(body._meta.refreshResult, 'unchanged');
  assert.equal(body._meta.retryAfterSeconds, 42);
  for (const k of ['prevLastUpdated', 'dataChanged', 'anything']) assert.ok(!(k in body._meta), `${k} must not be echoed`);
});

test('GET and POST /api/etf/refresh build identical bodies (apart from route metadata and time)', () => {
  const get = buildEtfResponse(state('latest-file'), {}, { nowMs: NOW });
  const post = buildEtfResponse(state('latest-file'), { refreshResult: 'updated' }, { nowMs: NOW });
  const strip = ({ _meta: { refreshResult, ...m }, ...rest }) => ({ ...rest, _meta: m });
  assert.deepEqual(strip(post), strip({ ...get, _meta: { ...get._meta } }));
});

test('fails closed on missing / malformed state', () => {
  for (const bad of [undefined, null, {}, { source: 'latest-file' }, { source: 'latest-file', payload: null }, { source: 'latest-file', payload: 'x' }]) {
    assertUnavailable(buildEtfResponse(bad, {}, { nowMs: NOW }));
  }
});

test('fails closed if building throws', () => {
  const hostile = { get source() { throw new Error('boom'); }, payload: estimated() };
  assertUnavailable(buildEtfResponse(hostile, {}, { nowMs: NOW }));
});

test('response is valid JSON and Build 5 compatible: arrays are [], null date, no scalar flow/AUM keys', () => {
  const round = JSON.parse(JSON.stringify(buildEtfResponse(state('latest-file'), {}, { nowMs: NOW })));
  assert.equal(round.lastUpdated, null);
  assert.ok(Array.isArray(round.btcRecentFlows) && round.btcRecentFlows.length === 0);
  assert.ok(!('btcFlow' in round) && !('xrpAUM' in round));
});

// ── Dormant verified branch: exercised only via the test seam; server.js never passes it. ──
test('verified branch (test seam): omits invalid fields instead of coercing to zero', () => {
  const payload = { lastUpdated: '2026-11-03', btcFlow: 5, ethFlow: null, xrpFlow: 'x', btcAUM: NaN,
    btcRecentFlows: [1, 2, 3], ethRecentFlows: [1, null, 3], xrpRecentFlows: 'nope' };
  const body = buildEtfResponse({ source: 'test-verified', payload }, {}, { nowMs: NOW, verifiedSources: ['test-verified'] });
  assert.equal(body.flowsVerified, true);
  assert.equal(body.btcFlow, 5);
  for (const k of ['ethFlow', 'xrpFlow', 'btcAUM', 'ethAUM', 'xrpAUM']) assert.ok(!(k in body), `${k} must be omitted`);
  assert.deepEqual(body.btcRecentFlows, [1, 2, 3]);
  assert.deepEqual(body.ethRecentFlows, [], 'series with a non-number is dropped whole');
  assert.deepEqual(body.xrpRecentFlows, []);
  assert.ok(!numbersIn(body).includes(0), 'no zero was invented');
});

test('verified branch (test seam): stale or undated data is marked stale', () => {
  const old = buildEtfResponse({ source: 'test-verified', payload: { lastUpdated: '2026-10-01' } }, {}, { nowMs: NOW, verifiedSources: ['test-verified'] });
  assert.equal(old._meta.isStale, true);
  const undated = buildEtfResponse({ source: 'test-verified', payload: {} }, {}, { nowMs: NOW, verifiedSources: ['test-verified'] });
  assert.equal(undated.lastUpdated, null);
  assert.equal(undated._meta.isStale, true);
});

// ── Guard against re-enabling through configuration ──
test('etf-response.js never reads environment variables (no flag can re-enable estimates)', () => {
  // Scan code only — the explanatory comments legitimately mention process.env.
  const code = readFileSync(join(root, 'etf-response.js'), 'utf-8').replace(/\/\/.*$/gm, '');
  assert.ok(!/process\.env/.test(code), 'etf-response.js must not reference process.env');
  assert.ok(!/import\.meta\.env/.test(code));
  assert.ok(!/\bimport\b[^;]*['"]dotenv['"]/.test(code), 'must not load dotenv');
});

test('server.js routes both ETF endpoints through buildEtfResponse and never spreads etfState.payload', () => {
  const src = readFileSync(join(root, 'server.js'), 'utf-8');
  assert.match(src, /import \{ buildEtfResponse \} from '\.\/etf-response\.js'/);
  assert.equal((src.match(/buildEtfResponse\(etfState/g) || []).length, 3, 'GET + POST + POST rate-limited');
  assert.ok(!/res\.json\(\s*(etfState|\.\.\.)/.test(src));
  assert.ok(!/\.\.\.\s*etfState\.payload/.test(src), 'etfState.payload must never be spread into a response');
  assert.ok(!/payload\s*,\s*source\s*\}\s*=\s*etfState/.test(src), 'inline builder must not return');
});
