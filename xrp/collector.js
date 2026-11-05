// ─────────────────────────────────────────────────────────────────────────────
// XRP wallet collector — JavaScript port of the Opus-approved prototype (xrp_monitor.py, 36 tests).
//
// The accounting is a line-for-line port, kept deliberately close to the Python (same structure,
// same names, same result keys) so a reviewer can diff the two. Only the language changed — the
// backend runs on Node and has no Python at runtime. Drops are BigInt, so sums and the ledger
// reconciliation are exact. test/xrp-parity.test.js feeds real, recorded ledger responses through
// this port and requires the same figures the Python prototype produced.
//
// Method (unchanged):
//  • Pin ONE validated ledger L1; page account_tx (ledger_index_max = L1) newest-first; dedupe by hash.
//  • Complete window (cutoff reached / history exhausted): the oldest covered ledger L0 is fully
//    collected, so it is INCLUDED and the opening balance is read at L0-1.
//  • Incomplete window: the oldest collected ledger may be partly collected, so it is EXCLUDED and the
//    opening balance is read at that ledger; the covered span is reported.
//  • Reconcile in/out/fees against account_info balances at the same pinned ledger L1.
//  • A wallet is VERIFIED only if its window is complete AND the residual is exactly zero.
//    Aggregate totals exist only if EVERY wallet is verified (`totals_verified`).
//  • Counterparty ownership is never inferred; flow_class is 'confirmed_internal' or 'unclassified'.
//
// ADDED for the backend (does not touch the accounting): a historical-coverage proof. A window only
// counts as complete if the server's reported `complete_ledgers` range reaches back to the ledger that
// proves the window start (or to the start of mainnet history when completeness came from exhausting
// the account's history) — otherwise it is marked incomplete and totals are withheld.
// ─────────────────────────────────────────────────────────────────────────────
import { Unavailable } from './xrpl-client.js';

export const EPOCH = 946684800;
export const EXPLORER = 'https://livenet.xrpl.org/transactions/';
export const OWNERSHIP = ['confirmed', 'third_party', 'unknown'];
export const FULL_HISTORY_START = 32570;           // first ledger every XRPL mainnet full-history server holds
const TF_PARTIAL_PAYMENT = 0x00020000;

const txOf = (t) => t.tx_json || t.tx || {};
const hashOf = (t) => t.hash || txOf(t).hash;
const ledgerOf = (t) => t.ledger_index || txOf(t).ledger_index;
const xrp = (drops) => Number(drops) / 1e6;
const isoOf = (sec) => new Date(sec * 1000).toISOString();

/** Contiguous complete-ledger segment containing `ledger`, from server_info.complete_ledgers ("a-b,c-d"). */
export function parseCompleteLedgers(str, ledger) {
  if (typeof str !== 'string') return null;
  for (const part of str.split(',')) {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (m && Number(m[1]) <= ledger && ledger <= Number(m[2])) return { start: Number(m[1]), end: Number(m[2]) };
  }
  return null;
}

export async function balance(rpc, addr, ledger) {
  const r = await rpc('account_info', { account: addr, ledger_index: ledger });
  return r.account_data ? BigInt(r.account_data.Balance) : null;
}

/** Collects one wallet's transactions for the window. Dedupes by hash. Never throws Unavailable (records it). */
export async function collectWallet(rpc, w, L1, cutoff, maxPages) {
  let marker = null; let pages = 0; const seen = new Set(); const txs = [];
  let complete = false; let reason = null; let dup = 0; let via = null; let proofLedger = null; let rangeMin = null; let rangeMetaBad = false;
  try {
    for (;;) {
      if (pages >= maxPages) { reason = `page budget (${maxPages}) exhausted before reaching window start`; break; }
      const p = { account: w.address, ledger_index_min: -1, ledger_index_max: L1, limit: 50, forward: false };
      if (marker) p.marker = marker;
      const r = await rpc('account_tx', p); pages += 1;
      if (!r.transactions) throw new Unavailable(r.error_message || r.error || 'bad response');
      if (!('validated' in r ? r.validated : true)) throw new Unavailable('response not from validated ledger data');
      // Load-balanced servers may differ in history depth page to page: keep the MOST restrictive
      // (largest) lower bound seen on any page; missing/invalid metadata on any page is unproven.
      if (Number.isSafeInteger(r.ledger_index_min) && r.ledger_index_min >= 0) rangeMin = rangeMin === null ? r.ledger_index_min : Math.max(rangeMin, r.ledger_index_min);
      else rangeMetaBad = true;
      let reached = false;
      for (const t of r.transactions) {
        if (!('validated' in t ? t.validated : true)) continue;
        const h = hashOf(t);
        if (seen.has(h)) { dup += 1; continue; }
        const d = txOf(t).date;
        if (d === undefined || d === null) continue;
        if (d + EPOCH < cutoff) { reached = true; proofLedger = ledgerOf(t) ?? null; break; }
        seen.add(h); txs.push(t);
      }
      marker = r.marker;
      if (reached) { complete = true; via = 'cutoff'; break; }
      if (!marker) { complete = true; via = 'exhausted'; reason = 'full account history exhausted'; break; }
    }
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    reason = `endpoint unavailable: ${e.message}`;
  }
  const leds = txs.map(ledgerOf);
  const L0 = leds.length ? Math.min(...leds) : null;
  return { txs, pages, complete, reason, L0, duplicates_dropped: dup, via, proofLedger, rangeMin, rangeMetaBad };
}

/** Proves the server's history reaches the window start. {ok, reason}. */
export function checkHistoryCoverage(history, c, fullHistoryStart = FULL_HISTORY_START) {
  if (!history) return { ok: false, reason: 'server did not report a complete_ledgers range containing the validated ledger' };
  const required = c.via === 'exhausted' ? fullHistoryStart : c.proofLedger;
  if (required === null || required === undefined) return { ok: false, reason: 'no ledger evidence of the window start' };
  if (history.start > required) return { ok: false, reason: `server history starts at ledger ${history.start}, after the ledger needed (${required})` };
  if (c.rangeMetaBad || (c.pages > 0 && c.rangeMin === null)) return { ok: false, reason: 'account_tx page(s) did not report a valid ledger_index_min, so history coverage cannot be proven' };
  if (c.rangeMin !== null && c.rangeMin > required) return { ok: false, reason: `account_tx searched only from ledger ${c.rangeMin}, after the ledger needed (${required})` };
  return { ok: true, required };
}

function classifyCounterparty(addr, registry) {
  const e = registry.get(addr);
  return e ? e.ownership : 'unknown';
}

export async function analyze(rpc, cfg, now = Date.now() / 1000) {
  const cutoff = now - cfg.window_hours * 3600;
  const registry = new Map(cfg.wallets.map((w) => [w.address, w]));
  for (const w of cfg.wallets) {
    if (!OWNERSHIP.includes(w.ownership)) throw new Error(`${w.id}: invalid ownership`);
    if (w.ownership === 'confirmed' && !w.evidence_url) throw new Error(`${w.id}: 'confirmed' ownership requires evidence_url`);
  }
  const si = (await rpc('server_info', {})).info;
  const L1 = si?.validated_ledger?.seq;
  if (!Number.isInteger(L1)) throw new Unavailable('server_info did not report a validated ledger');
  const history = parseCompleteLedgers(si.complete_ledgers, L1);
  const thr = cfg.large_transfer_threshold_xrp * 1_000_000;
  const out = {
    generated_utc: isoOf(now), pinned_ledger: L1, window_hours: cfg.window_hours, threshold_xrp: cfg.large_transfer_threshold_xrp,
    server_history: history ? { complete_ledgers_segment: [history.start, history.end], server_state: si.server_state ?? null } : null,
    wallets: [], set: {}, transfers: [],
  };
  const seenSet = new Set(); let setIn = 0n; let setOut = 0n; let between = 0n; let nSetIn = 0; let nSetOut = 0; let nBetween = 0;

  for (const w of cfg.wallets) {
    const res = { id: w.id, address: w.address, entity_hint: w.entity_hint ?? null, ownership: w.ownership, provenance: w.provenance, evidence_url: w.evidence_url ?? null };
    let c;
    try {
      c = await collectWallet(rpc, w, L1, cutoff, cfg.max_pages_per_wallet);
    } catch (e) {
      if (!(e instanceof Unavailable)) throw e;
      Object.assign(res, { status: 'unavailable', reason: e.message, verified: false, verification_failure: `collection unavailable: ${e.message}` });
      out.wallets.push(res); continue;
    }
    if (c.pages === 0 || (c.txs.length === 0 && !c.complete && (c.reason || '').startsWith('endpoint unavailable'))) {
      Object.assign(res, { status: 'unavailable', reason: c.reason || 'no data collected', verified: false, verification_failure: `collection unavailable: ${c.reason || 'no data collected'}` });
      out.wallets.push(res); continue;
    }
    // Backend addition: a window is only complete if the server's history provably reaches its start.
    let proof = null;
    if (c.complete) {
      proof = checkHistoryCoverage(history, c, cfg.full_history_start ?? FULL_HISTORY_START);
      if (!proof.ok) { c.complete = false; c.reason = `historical coverage not proven: ${proof.reason}`; }
    }
    const txs = c.txs; const Lmin = c.L0;
    const skipLedger = c.complete ? null : Lmin;
    const openingLedger = Lmin === null ? null : (c.complete ? Lmin - 1 : Lmin);
    let coveredFrom;
    if (c.complete) coveredFrom = cutoff;
    else { const ds = txs.filter((t) => ledgerOf(t) === Lmin).map((t) => txOf(t).date + EPOCH); coveredFrom = ds.length ? ds[0] : null; }
    const coverage = {
      complete: c.complete, requested_hours: cfg.window_hours, opening_ledger_exclusive: openingLedger, closing_ledger: L1,
      covered_from_utc: coveredFrom === null ? null : isoOf(coveredFrom),
      covered_hours: coveredFrom === null ? null : Math.round(((now - coveredFrom) / 3600) * 100) / 100,
      basis: c.complete ? 'full requested window' : `PARTIAL: oldest collected ledger excluded; ${c.reason || 'incomplete'}`,
    };
    let inflow = 0n; let outflow = 0n; let fees = 0n;
    let nIn = 0; let nOut = 0; let nFail = 0; let nNonxrp = 0; let nPartial = 0; let nOther = 0;
    for (const t of txs) {
      const tj = txOf(t); const meta = t.meta; const led = ledgerOf(t);
      if (led === skipLedger) continue;
      if (tj.Account === w.address) fees += BigInt(tj.Fee);
      if (meta.TransactionResult !== 'tesSUCCESS') { nFail += 1; continue; }
      if (tj.TransactionType !== 'Payment') { nOther += 1; continue; }
      const da = meta.delivered_amount !== undefined ? meta.delivered_amount : tj.Amount;
      if (typeof da !== 'string') { nNonxrp += 1; continue; }
      if ((tj.Flags || 0) & TF_PARTIAL_PAYMENT) nPartial += 1;
      const drops = BigInt(da); const h = hashOf(t); const ts = tj.date + EPOCH;
      const src = tj.Account; const dst = tj.Destination;
      if (src === dst) continue;
      let direction; let peer;
      if (dst === w.address) { direction = 'in'; peer = src; inflow += drops; nIn += 1; }
      else if (src === w.address) { direction = 'out'; peer = dst; outflow += drops; nOut += 1; }
      else continue;
      const peerOwn = classifyCounterparty(peer, registry);
      const bothMonitored = registry.has(peer);
      // 'confirmed_internal' only when BOTH ends are monitored, confirmed and the same (named) entity; else 'unclassified'.
      const fclass = (bothMonitored && registry.get(peer).ownership === 'confirmed' && w.ownership === 'confirmed'
        && w.entity_hint && registry.get(peer).entity_hint === w.entity_hint) ? 'confirmed_internal' : 'unclassified';
      out.transfers.push({ hash: h, ts, amount_xrp: xrp(drops), direction, monitored: w.address, monitored_id: w.id, source: src, destination: dst,
        counterparty_ownership: peerOwn, counterparty_monitored: bothMonitored, ledger: led, flow_class: fclass, verify_url: EXPLORER + h });
      if (seenSet.has(h)) continue;                       // set-level counting: each hash once
      seenSet.add(h);
      if (bothMonitored) { between += drops; nBetween += 1; }
      else if (direction === 'in') { setIn += drops; nSetIn += 1; }
      else { setOut += drops; nSetOut += 1; }
    }
    let status = 'ok'; let recon = null;
    if (openingLedger !== null) {
      try {
        const b0 = await balance(rpc, w.address, openingLedger); const b1 = await balance(rpc, w.address, L1);
        if (b0 === null || b1 === null) {
          status = 'ok-reconcile-unavailable';
          recon = { unavailable_reason: (b0 === null && b1 !== null && c.complete)
            ? `account created inside the observation window (no balance at ledger ${openingLedger})`
            : `account balance unavailable at ledger ${b0 === null ? openingLedger : L1}` };
        } else {
          const residual = (b1 - b0) - (inflow - outflow - fees);
          recon = { ledger_delta_xrp: xrp(b1 - b0), computed_xrp: xrp(inflow - outflow - fees), residual_xrp: xrp(residual), residual_drops: residual.toString(),
            opening_ledger: openingLedger, closing_ledger: L1, covers: `ledgers (${openingLedger}, ${L1}]`, window_complete: c.complete,
            covered_from_utc: coverage.covered_from_utc, covered_hours: coverage.covered_hours };
        }
      } catch (e) {
        if (!(e instanceof Unavailable)) throw e;
        status = 'ok-reconcile-unavailable'; recon = { error: e.message };
      }
    }
    if (!c.complete) status = 'partial';                  // never 'ok': figures cover only the stated span
    // A wallet is VERIFIED only if its window is complete AND it reconciled with exactly zero residual
    // (or had no activity at all, so there is nothing to reconcile).
    let vf = null;
    if (!c.complete) vf = `partial collection: ${c.reason || 'incomplete'}`;
    else if (status === 'ok-reconcile-unavailable') vf = `reconciliation could not run: ${recon.unavailable_reason || recon.error || 'unknown'}`;
    else if (recon && recon.residual_drops !== '0') vf = `non-zero reconciliation residual ${recon.residual_xrp >= 0 ? '+' : ''}${recon.residual_xrp.toFixed(6)} XRP`;
    else if (txs.length && !recon) vf = 'reconciliation missing';
    Object.assign(res, {
      verified: vf === null, verification_failure: vf, status, window_complete: c.complete, coverage_note: c.reason, pages: c.pages, coverage,
      history_coverage: { server_segment: history ? [history.start, history.end] : null, completeness_basis: c.via, proof_ledger: proof?.required ?? null, proven: proof ? proof.ok : null },
      duplicates_dropped: c.duplicates_dropped, boundary_ledger_excluded: skipLedger,
      counts: { payments_in: nIn, payments_out: nOut, failed_tec: nFail, non_payment: nOther, non_xrp_or_unavailable: nNonxrp, partial_payment_flag: nPartial },
      inflow_xrp: xrp(inflow), outflow_xrp: xrp(outflow), fees_paid_xrp: xrp(fees), reconciliation: recon,
    });
    out.wallets.push(res);
  }
  out.transfers.sort((a, b) => b.amount_xrp - a.amount_xrp);
  out.transfers = out.transfers.filter((r) => r.amount_xrp * 1e6 >= thr);
  // Aggregate totals exist only if EVERY wallet is verified. `totals_withheld` is the inverse.
  const bad = {};
  for (const w of out.wallets) if (!w.verified) bad[w.id] = w.verification_failure;
  const coverageNote = 'partial: only explicitly configured addresses are monitored; counterparties are unknown unless configured';
  if (Object.keys(bad).length) {
    out.set = { totals_verified: false, totals_withheld: true, withheld_reasons: bad, inbound_xrp: null, outbound_xrp: null, net_xrp: null, between_monitored_xrp: null,
      n_inbound: null, n_outbound: null, n_between: null, coverage: coverageNote };
  } else {
    out.set = { totals_verified: true, totals_withheld: false, withheld_reasons: {}, inbound_xrp: xrp(setIn), outbound_xrp: xrp(setOut), net_xrp: xrp(setIn - setOut),
      between_monitored_xrp: xrp(between), n_inbound: nSetIn, n_outbound: nSetOut, n_between: nBetween, coverage: coverageNote };
  }
  out.transfers_complete = !out.wallets.some((w) => w.status === 'partial' || w.status === 'unavailable');
  return out;
}

/** Re-fetch each large transfer via `tx` and compare hash/amount/time/accounts to the collected record. */
export async function verifyTransfers(rpc, transfers, limit = 10) {
  const results = [];
  for (const r of transfers.slice(0, limit)) {
    try {
      const x = await rpc('tx', { transaction: r.hash }, { cacheable: true });
      const tj = x.tx_json || x;
      const da = (x.meta || {}).delivered_amount !== undefined ? x.meta.delivered_amount : tj.Amount;
      const ok = x.validated === true && x.meta.TransactionResult === 'tesSUCCESS' && xrp(BigInt(da)) === r.amount_xrp
        && tj.Account === r.source && tj.Destination === r.destination && tj.date + EPOCH === r.ts;
      results.push({ hash: r.hash, match: Boolean(ok) });
    } catch (e) {
      results.push({ hash: r.hash, match: null, error: String(e.message || e) });
    }
  }
  return results;
}
