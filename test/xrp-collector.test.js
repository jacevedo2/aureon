// Scenario tests for the JS XRP collector (port of the prototype's regression suite + backend additions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyze, parseCompleteLedgers, FULL_HISTORY_START } from '../xrp/collector.js';
test('mainnet full-history start constant is 32570', () => assert.equal(FULL_HISTORY_START, 32570));
import { FakeLedger, basicLedger, tx, cfg, twoWallets, A, B, X, NOW } from './helpers/xrp-fake-ledger.js';

const run = (led, c = cfg()) => analyze(led.rpc, c, NOW);
const withheld = (out, id = 'A') => {
  const s = out.set;
  assert.equal(s.totals_verified, false); assert.equal(s.totals_withheld, true); assert.ok(id in s.withheld_reasons);
  for (const k of ['inbound_xrp', 'outbound_xrp', 'net_xrp', 'between_monitored_xrp', 'n_inbound', 'n_outbound', 'n_between']) assert.equal(s[k], null, k);
};

// ── Correction 1: first ledger of the window ────────────────────────────────
test('complete window includes its oldest ledger and reconciles at L0-1 with zero residual', async () => {
  const out = await run(basicLedger()); const w = out.wallets[0];
  assert.equal(w.window_complete, true); assert.equal(w.inflow_xrp, 5350); assert.equal(w.outflow_xrp, 2000);
  assert.equal(w.boundary_ledger_excluded, null); assert.equal(w.reconciliation.opening_ledger, 959);
  assert.equal(w.reconciliation.residual_drops, '0'); assert.equal(w.verified, true);
  assert.deepEqual([out.set.inbound_xrp, out.set.outbound_xrp, out.set.net_xrp, out.set.totals_verified], [5350, 2000, 3350, true]);
});

test('first-ledger regression: two payments in ledger L0 (one 36.361105 XRP) counted once; older-than-window payment excluded', async () => {
  const txs = [tx('H1', 990, X, A, 5000, 400), tx('H2', 980, A, X, 2000, 500), tx('H3', 970, X, A, 300, 600), tx('H4', 960, X, A, 50, 700),
    tx('H5', 960, X, A, 0, 700, { amt: '36361105' }), tx('OLD', 950, X, A, 777, 90000)];
  for (const dup of [false, true]) {
    const bal = { [`${A}|959`]: 877, [`${A}|1000`]: 877 + 5350 + 36.361105 - 2000 - 10 / 1e6 };
    const out = await run(new FakeLedger({ [A]: txs }, bal, { dup }), cfg({ large_transfer_threshold_xrp: 1e-6 }));
    const w = out.wallets[0];
    assert.equal(w.counts.payments_in, 4); assert.equal(w.inflow_xrp, 5386.361105);
    assert.equal(w.reconciliation.residual_drops, '0'); assert.equal(w.verified, true);
    const hs = out.transfers.map((t) => t.hash); assert.equal(hs.length, new Set(hs).size); assert.deepEqual([...hs].sort(), ['H1', 'H2', 'H3', 'H4', 'H5']);
  }
});

// ── Correction 2/4: incomplete and failed collection ───────────────────────
test('page budget exhausted: partial, actual covered span, oldest collected ledger excluded, totals withheld', async () => {
  const out = await run(basicLedger(), cfg({ max_pages_per_wallet: 1 })); const w = out.wallets[0];
  assert.equal(w.status, 'partial'); assert.equal(w.coverage.complete, false); assert.equal(w.coverage.opening_ledger_exclusive, 980);
  assert.equal(w.boundary_ledger_excluded, 980); assert.equal(w.reconciliation.covers, 'ledgers (980, 1000]');
  assert.equal(w.reconciliation.residual_drops, '0'); assert.equal(w.inflow_xrp, 5000); assert.match(w.coverage_note, /page budget/);
  withheld(out); assert.equal(out.transfers_complete, false);
});

test('mid-collection failure: page 1 succeeds, page 2 fails -> incomplete, never presented as complete', async () => {
  const led = basicLedger({ failAfterTx: 1 }); const out = await run(led); const w = out.wallets[0];
  assert.equal(led.nTx, 2); assert.equal(w.pages, 1); assert.equal(w.status, 'partial'); assert.equal(w.window_complete, false);
  assert.match(w.coverage_note, /endpoint unavailable/); assert.equal(w.inflow_xrp, 5000);          // not the 5,350 of a complete window
  assert.equal(w.verified, false); withheld(out); assert.equal(out.transfers_complete, false);
});

test('unavailable wallet contributes nothing and withholds the set totals', async () => {
  const base = basicLedger();
  const out = await run(new FakeLedger({ [A]: base.t[A], [B]: [] }, base.bal, { failAddr: B }), twoWallets());
  const b = out.wallets.find((w) => w.id === 'B');
  assert.equal(b.status, 'unavailable'); assert.ok(!('inflow_xrp' in b)); withheld(out, 'B');
});

// ── Final safeguard: totals_verified ───────────────────────────────────────
test('reconciliation unavailable (endpoint error / no balance at L1) withholds totals but keeps wallet evidence', async () => {
  for (const mode of ['endpoint', 'missing-L1']) {
    const led = mode === 'endpoint' ? basicLedger({ fail: 'account_info' }) : basicLedger();
    if (mode !== 'endpoint') led.bal[`${A}|1000`] = null;
    const out = await run(led); const w = out.wallets[0];
    assert.equal(w.status, 'ok-reconcile-unavailable'); assert.equal(w.verified, false); assert.match(w.verification_failure, /reconciliation could not run/);
    assert.equal(w.inflow_xrp, 5350); assert.equal(w.window_complete, true); withheld(out);
  }
});

test('non-zero residual (even 0.5 XRP) withholds totals; transfer evidence is kept', async () => {
  for (const off of [1, -0.5]) {
    const led = basicLedger(); led.bal[`${A}|1000`] += off;
    const out = await run(led); const w = out.wallets[0];
    assert.equal(w.status, 'ok'); assert.equal(w.verified, false); assert.match(w.verification_failure, /non-zero reconciliation residual/);
    assert.equal(w.reconciliation.residual_xrp, off); assert.equal(out.transfers.length, 2); withheld(out);
  }
});

test('account created inside the observation window is reported as such and withholds totals', async () => {
  const led = basicLedger(); led.bal[`${A}|959`] = null;
  const out = await run(led); const w = out.wallets[0];
  assert.equal(w.verified, false); assert.match(w.verification_failure, /account created inside the observation window/); withheld(out);
});

test('a quiet complete wallet (no activity) does not block verified totals', async () => {
  const base = basicLedger();
  const out = await run(new FakeLedger({ [A]: base.t[A], [B]: [] }, base.bal), twoWallets());
  assert.equal(out.wallets.find((w) => w.id === 'B').verified, true); assert.equal(out.set.totals_verified, true); assert.equal(out.set.inbound_xrp, 5350);
});

test('one unverified wallet withholds ALL totals but only that wallet is blamed', async () => {
  const base = basicLedger(); const led = new FakeLedger({ [A]: base.t[A], [B]: [] }, { ...base.bal }); led.bal[`${A}|1000`] += 1;
  const out = await run(led, twoWallets());
  withheld(out, 'A'); assert.ok(!('B' in out.set.withheld_reasons)); assert.equal(out.transfers_complete, true);
});

// ── Correction 3: no exchange-flow classification ──────────────────────────
test('flow classification: unknown counterparties stay unclassified, even for a confirmed monitored wallet', async () => {
  const c = cfg({ large_transfer_threshold_xrp: 1e-6, wallets: [{ id: 'A', address: A, ownership: 'confirmed', provenance: 'p', evidence_url: 'https://e.example/x', entity_hint: 'E' }] });
  const out = await run(basicLedger(), c);
  assert.deepEqual(new Set(out.transfers.map((t) => t.direction)), new Set(['in', 'out']));
  for (const t of out.transfers) { assert.equal(t.flow_class, 'unclassified'); assert.equal(t.counterparty_ownership, 'unknown'); }
  assert.equal(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'xrp', 'collector.js'), 'utf-8').includes('confirmed_external'), false);
});

test('between two monitored wallets: counted once; internal only if both confirmed AND same named entity', async () => {
  const mk = (oa, ob, ea, eb) => cfg({ wallets: [
    { id: 'A', address: A, ownership: oa, provenance: 'p', evidence_url: oa === 'confirmed' ? 'https://e.example/a' : null, entity_hint: ea },
    { id: 'B', address: B, ownership: ob, provenance: 'p', evidence_url: ob === 'confirmed' ? 'https://e.example/b' : null, entity_hint: eb }] });
  const ta = [tx('S1', 990, A, B, 5000, 100), tx('S0', 970, X, A, 1, 300)]; const tb = [tx('S1', 990, A, B, 5000, 100), tx('B0', 970, X, B, 1, 300)];
  const bal = { [`${A}|969`]: 10, [`${A}|1000`]: 10 + 1 - 5000 - 10 / 1e6, [`${B}|969`]: 10, [`${B}|1000`]: 10 + 5001 };
  const classes = async (c) => (await run(new FakeLedger({ [A]: ta, [B]: tb }, bal), c)).transfers.filter((t) => t.hash === 'S1').map((t) => t.flow_class);
  assert.deepEqual(await classes(mk('confirmed', 'confirmed', 'E', 'E')), ['confirmed_internal', 'confirmed_internal']);
  assert.deepEqual(await classes(mk('confirmed', 'confirmed', 'E1', 'E2')), ['unclassified', 'unclassified']);
  assert.deepEqual(await classes(mk('third_party', 'third_party', undefined, undefined)), ['unclassified', 'unclassified']);
  assert.deepEqual(await classes(mk('confirmed', 'confirmed', undefined, undefined)), ['unclassified', 'unclassified']);   // no entity name -> never "internal"
  const out = await run(new FakeLedger({ [A]: ta, [B]: tb }, bal), mk('third_party', 'third_party'));
  assert.equal(out.set.between_monitored_xrp, 5000); assert.equal(out.set.n_between, 1); assert.equal(out.set.inbound_xrp, 2);
});

test("'confirmed' ownership without evidence is rejected", async () => {
  await assert.rejects(run(basicLedger(), cfg({ wallets: [{ id: 'A', address: A, ownership: 'confirmed', provenance: 'p' }] })), /requires evidence_url/);
});

// ── Accounting details ─────────────────────────────────────────────────────
test('failed (tec) payment moves nothing but pays its fee; IOU payments are skipped', async () => {
  const txs = [tx('F1', 990, A, X, 9999, 100, { res: 'tecUNFUNDED_PAYMENT', fee: 12 }), tx('P1', 980, X, A, 10, 200), tx('P0', 970, X, A, 1, 300)];
  const out = await run(new FakeLedger({ [A]: txs }, { [`${A}|969`]: 50, [`${A}|1000`]: 50 + 11 - 12 / 1e6 })); const w = out.wallets[0];
  assert.equal(w.outflow_xrp, 0); assert.equal(w.inflow_xrp, 11); assert.equal(w.counts.failed_tec, 1); assert.equal(w.reconciliation.residual_drops, '0');
  const iou = { currency: 'USD', value: '5', issuer: X }; const t1 = tx('I1', 990, X, A, 0, 100); t1.tx_json.Amount = iou; t1.meta.delivered_amount = iou;
  const o2 = await run(new FakeLedger({ [A]: [t1, tx('I2', 980, X, A, 7, 200), tx('I0', 970, X, A, 1, 300)] }, { [`${A}|969`]: 1, [`${A}|1000`]: 9 }));
  assert.equal(o2.wallets[0].counts.non_xrp_or_unavailable, 1); assert.equal(o2.wallets[0].inflow_xrp, 8);
});

test('drops are exact beyond 2^53 (BigInt): a 99,999,999,999.999999 XRP payment reconciles to residual 0', async () => {
  const big = '99999999999999999';   // drops (> Number.MAX_SAFE_INTEGER)
  const txs = [tx('G1', 990, X, A, 0, 100, { amt: big, fee: 10 }), tx('G0', 970, X, A, 0, 300, { amt: '1' })];
  const bal = { [`${A}|969`]: 5n, [`${A}|1000`]: 5n + BigInt(big) + 1n };
  const out = await run(new FakeLedger({ [A]: txs }, bal));
  assert.equal(out.wallets[0].reconciliation.residual_drops, '0'); assert.equal(out.wallets[0].verified, true);
});

// ── Backend addition: historical coverage must be proven ───────────────────
test('parseCompleteLedgers picks the contiguous segment containing the validated ledger', () => {
  assert.deepEqual(parseCompleteLedgers('1-1000', 1000), { start: 1, end: 1000 });
  assert.deepEqual(parseCompleteLedgers('32570-500,900-1000', 1000), { start: 900, end: 1000 });
  assert.equal(parseCompleteLedgers('32570-500', 1000), null); assert.equal(parseCompleteLedgers('empty', 1000), null); assert.equal(parseCompleteLedgers(undefined, 1000), null);
});

test('history coverage: full-history server proves the window; wallet is marked as proven', async () => {
  const out = await run(basicLedger({ completeLedgers: '1-1000' }));
  assert.equal(out.wallets[0].history_coverage.proven, true); assert.equal(out.wallets[0].verified, true);
});

test('history coverage NOT proven -> window incomplete, wallet unverified, totals withheld', async () => {
  const history = [['server history starts after the ledger needed', { completeLedgers: '995-1000' }, /server history starts at ledger 995/],
    ['complete_ledgers missing', { completeLedgers: undefined }, /did not report/],
    ['validated ledger outside every reported segment', { completeLedgers: '32570-900' }, /did not report/],
    ['account_tx searched from too late a ledger', { rangeMin: 975 }, /account_tx searched only from ledger 975/]];
  for (const [name, o, re] of history) {
    // window ends at the cutoff: add a pre-window payment at ledger 950 so completeness comes from reaching the cutoff
    const base = basicLedger(o); base.t[A].push(tx('OLD', 950, X, A, 777, 90000)); base.bal[`${A}|959`] = 877; base.bal[`${A}|960`] = 877 + 50; base.bal[`${A}|1000`] += 777;
    const out = await run(base); const w = out.wallets[0];
    assert.equal(w.window_complete, false, name); assert.equal(w.status, 'partial', name); assert.match(w.coverage_note, /historical coverage not proven/, name);
    assert.match(w.coverage_note, re, name); assert.equal(w.history_coverage.proven, false, name); withheld(out);
  }
});

test('history coverage when completeness comes from exhausting the account history requires true full history', async () => {
  const ok = await run(basicLedger()); assert.equal(ok.wallets[0].history_coverage.completeness_basis, 'exhausted'); assert.equal(ok.set.totals_verified, true);
  const pl = basicLedger({ completeLedgers: '996-1000' }); pl.bal[`${A}|960`] = 150;   // incomplete accounting opens at the oldest collected ledger
  const partial = await run(pl);            // node only holds recent ledgers: "exhausted" proves nothing
  assert.equal(partial.wallets[0].window_complete, false); assert.match(partial.wallets[0].coverage_note, /server history starts at ledger 996/); withheld(partial);
});

test('server_info without a validated ledger fails the scan (nothing is guessed)', async () => {
  await assert.rejects(analyze(async () => ({ info: {} }), cfg(), NOW), /validated ledger/);
});

// Regression (Opus review 001): load-balanced servers can differ in history depth between pages.
// Every page's ledger_index_min must count; the most restrictive one decides.
function pagedLedger(o) {
  const base = basicLedger({ page: 2, ...o });       // 4 in-window txs -> 2 pages (+ third page when OLD is added)
  base.bal[`${A}|960`] = 150;          // an unproven window falls back to incomplete accounting opening at the oldest collected ledger
  return base;
}
test('REGRESSION page 1 full-history, page 2 partial-history server that reports history exhausted -> NOT complete/verified', async () => {
  const base = pagedLedger({ rangeMinByPage: [1, 995] });   // page 2 server only has ledgers >= 995
  const out = await run(base); const w = out.wallets[0];
  assert.equal(w.history_coverage.completeness_basis, 'exhausted');     // second server reported no marker
  assert.equal(w.history_coverage.proven, false); assert.equal(w.verified, false); assert.equal(w.window_complete, false);
  assert.match(w.coverage_note, /account_tx searched only from ledger 995/); withheld(out);
});
test('REGRESSION same mix, window ending at the cutoff: later partial page still makes history unproven', async () => {
  const base = pagedLedger({ rangeMinByPage: [1, 1, 975] });
  base.t[A].push(tx('OLD', 950, X, A, 777, 90000)); base.bal[`${A}|959`] = 877; base.bal[`${A}|960`] = 877 + 50; base.bal[`${A}|1000`] += 777;
  const out = await run(base); const w = out.wallets[0];
  assert.equal(w.history_coverage.proven, false); assert.equal(w.verified, false); withheld(out);
});
test('history coverage: missing / invalid ledger_index_min on ANY page is unproven (conservative)', async () => {
  for (const [name, by] of [['missing on page 2', [1, undefined]], ['null on page 1', [null, 1]], ['string', [1, '1']], ['negative', [1, -1]], ['NaN', [1, NaN]]]) {
    const out = await run(pagedLedger({ rangeMinByPage: by })); const w = out.wallets[0];
    assert.equal(w.history_coverage.proven, false, name); assert.equal(w.verified, false, name);
    assert.match(w.coverage_note, /did not report a valid ledger_index_min/, name); withheld(out);
  }
});
test('history coverage: consistent full-history pages (all ledger_index_min equal) stay verified; accounting unchanged', async () => {
  const out = await run(pagedLedger({ rangeMinByPage: [1, 1] })); const ref = await run(basicLedger({ page: 2 }));
  assert.equal(out.wallets[0].verified, true); assert.equal(out.set.totals_verified, true);
  assert.deepEqual(out.set.totals, ref.set.totals); assert.equal(out.wallets[0].residual_drops, ref.wallets[0].residual_drops);
});
