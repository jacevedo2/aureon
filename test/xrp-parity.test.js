// Parity: the JS collector must reproduce the figures of the Opus-approved Python prototype (xrp_monitor.py)
// on REAL recorded XRP Ledger data. Fixtures: test/fixtures/xrp/README.md.
//   recorded-ledger-w2-w3.json   real account_tx / account_info / tx responses (trimmed to the fields the collector reads)
//   golden-python-w2-w3.json     output of the Python prototype on the FULL raw responses for the same wallets
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyze, verifyTransfers } from '../xrp/collector.js';
import { buildReplayRpc } from './helpers/xrp-replay.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'xrp');
const recorded = JSON.parse(readFileSync(join(dir, 'recorded-ledger-w2-w3.json'), 'utf-8'));
const golden = JSON.parse(readFileSync(join(dir, 'golden-python-w2-w3.json'), 'utf-8'));
const wallets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'xrp', 'wallets.json'), 'utf-8'));
const cfg = { window_hours: 24, large_transfer_threshold_xrp: 500000, max_pages_per_wallet: 40, wallets: wallets.wallets.filter((w) => ['W2', 'W3'].includes(w.id)) };

const WALLET_KEYS = ['status', 'verified', 'verification_failure', 'window_complete', 'pages', 'duplicates_dropped', 'boundary_ledger_excluded', 'counts',
  'inflow_xrp', 'outflow_xrp', 'fees_paid_xrp'];

async function run() {
  const rpc = buildReplayRpc(recorded.responses, { pin: recorded.pinned_ledger, completeLedgers: recorded.complete_ledgers });
  const out = await analyze(rpc, cfg, recorded.now);
  out.transfer_verification = await verifyTransfers(rpc, out.transfers);
  return out;
}

test('parity: JS collector reproduces the Python prototype on real recorded ledger data (W2 + W3)', async () => {
  const js = await run();
  assert.equal(js.pinned_ledger, golden.pinned_ledger);
  assert.equal(js.wallets.length, golden.wallets.length);
  for (const [i, g] of golden.wallets.entries()) {
    const w = js.wallets[i];
    assert.equal(w.id, g.id);
    for (const k of WALLET_KEYS) assert.deepEqual(w[k], g[k], `${g.id}.${k}`);
    const { covered_from_utc: jsFrom, ...jsCov } = w.coverage; const { covered_from_utc: pyFrom, ...pyCov } = g.coverage;
    assert.deepEqual(jsCov, pyCov, `${g.id}.coverage`);
    assert.equal(Date.parse(jsFrom), Date.parse(pyFrom), `${g.id}.coverage.covered_from_utc (same instant; Python prints µs, JS ms)`);
    if (g.reconciliation) {
      for (const k of ['ledger_delta_xrp', 'computed_xrp', 'residual_xrp', 'opening_ledger', 'closing_ledger', 'covers', 'window_complete', 'covered_from_utc', 'covered_hours']) {
        // covered_from_utc: Python prints +00:00 microseconds, JS prints Z milliseconds — compare as instants
        if (k === 'covered_from_utc') assert.equal(Date.parse(w.reconciliation[k]), Date.parse(g.reconciliation[k]), `${g.id}.reconciliation.${k}`);
        else assert.deepEqual(w.reconciliation[k], g.reconciliation[k], `${g.id}.reconciliation.${k}`);
      }
    } else assert.equal(w.reconciliation, null);
  }
  assert.deepEqual(js.transfers.map((t) => ({ ...t })), golden.transfers, 'large transfers (hash, amount, direction, ledger, class…)');
  assert.deepEqual(js.set, golden.set, 'set totals');
  assert.equal(js.transfers_complete, golden.transfers_complete);
  assert.deepEqual(js.transfer_verification, golden.transfer_verification);
});

test('parity: concrete real figures (W2 reconciles to the drop; W3 is quiet)', async () => {
  const js = await run();
  const w2 = js.wallets.find((w) => w.id === 'W2'); const w3 = js.wallets.find((w) => w.id === 'W3');
  assert.equal(w2.inflow_xrp, 2474711.242616); assert.equal(w2.outflow_xrp, 5228373.718685);
  assert.equal(w2.reconciliation.residual_drops, '0'); assert.equal(w2.verified, true);
  assert.equal(w2.counts.payments_in, 58);                                     // includes the first-ledger payment of 415.005988 XRP
  assert.equal(w3.reconciliation, null); assert.equal(w3.verified, true);
  assert.equal(js.set.totals_verified, true);
  assert.equal(js.wallets.every((w) => w.history_coverage.proven === true), true);   // backend addition: history proven from complete_ledgers
});

// Optional full three-wallet parity against ALL original raw responses (not committed: ~2 MB).
// XRP_PARITY_RAW_DIR=<folder with the raw .json responses>  XRP_PARITY_GOLDEN=<snapshot-corrected-replay.json>  XRP_PARITY_NOW_FROM=<original snapshot.json>
const rawDir = process.env.XRP_PARITY_RAW_DIR;
test('parity (optional, full data): all three wallets incl. the busy one match the Python replay snapshot', { skip: !rawDir || !existsSync(rawDir) }, async () => {
  const responses = readdirSync(rawDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(rawDir, f), 'utf-8')));
  const g = JSON.parse(readFileSync(process.env.XRP_PARITY_GOLDEN, 'utf-8'));
  const orig = JSON.parse(readFileSync(process.env.XRP_PARITY_NOW_FROM, 'utf-8'));
  const rpc = buildReplayRpc(responses, { pin: orig.pinned_ledger, completeLedgers: `32570-${orig.pinned_ledger}` });
  const out = await analyze(rpc, { ...cfg, wallets: wallets.wallets }, Date.parse(orig.generated_utc) / 1000);
  out.transfer_verification = await verifyTransfers(rpc, out.transfers);
  // The golden may predate later safeguard fields (verified / totals_verified): compare only the keys it has.
  for (const [i, gw] of g.wallets.entries()) for (const k of ['status', 'verified', 'inflow_xrp', 'outflow_xrp', 'fees_paid_xrp', 'counts', 'pages']) if (k in gw) assert.deepEqual(out.wallets[i][k], gw[k], `${gw.id}.${k}`);
  for (const k of Object.keys(g.set)) assert.deepEqual(out.set[k], g.set[k], `set.${k}`);
  assert.deepEqual(out.transfers.map((t) => t.hash), g.transfers.map((t) => t.hash));
  assert.deepEqual(out.transfer_verification, g.transfer_verification);
});
