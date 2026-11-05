// Synthetic XRPL for scenario tests. account_tx is served newest-first in pages of `page` (default 2) with markers;
// account_info from a (account, ledger) table (null = actNotFound). Failure injection mirrors the prototype's tests.
import { Unavailable } from '../../xrp/xrpl-client.js';
export const EPOCH = 946684800;
export const NOW = 1_800_000_000;

export function tx(hash, ledger, src, dst, xrp, ageS = 100, o = {}) {
  const amount = o.amt !== undefined ? o.amt : String(Math.round(xrp * 1e6));
  return { hash, ledger_index: ledger, validated: true,
    tx_json: { TransactionType: o.type || 'Payment', Account: src, Destination: dst, Amount: amount, Fee: String(o.fee ?? 10), date: NOW - EPOCH - ageS, Flags: o.flags || 0 },
    meta: { TransactionResult: o.res || 'tesSUCCESS', delivered_amount: amount } };
}

export class FakeLedger {
  constructor(txsByAddr, balances, o = {}) {
    Object.assign(this, { t: txsByAddr, bal: balances, fail: null, dup: false, page: 2, failAfterTx: null, failAddr: null,
      pin: 1000, completeLedgers: '1-1000', rangeMin: 1, nTx: 0, calls: [] }, o);
    this.rpc = this.rpc.bind(this);
  }
  async rpc(method, params) {
    this.calls.push(method);
    if (method === 'server_info') return { info: { validated_ledger: { seq: this.pin }, ...(this.completeLedgers === undefined ? {} : { complete_ledgers: this.completeLedgers }), server_state: 'full' } };
    if (this.fail === method) throw new Unavailable('down');
    if (method === 'account_tx') {
      this.nTx += 1;
      if (this.failAfterTx !== null && this.nTx > this.failAfterTx) throw new Unavailable('down mid-collection');
      if (this.failAddr === params.account) throw new Unavailable('down for this wallet');
      const lst = [...this.t[params.account]].sort((a, b) => b.ledger_index - a.ledger_index);
      const start = params.marker ? Number(params.marker) : 0;
      let chunk = lst.slice(start, start + this.page);
      if (this.dup && start > 0) chunk = [lst[start - 1], ...chunk];     // boundary tx re-delivered
      const r = { transactions: chunk, validated: true, ledger_index_min: this.rangeMinByPage ? this.rangeMinByPage[this.nTx - 1] : this.rangeMin, ledger_index_max: params.ledger_index_max };
      if (start + this.page < lst.length) r.marker = String(start + this.page);
      return r;
    }
    if (method === 'account_info') {
      const b = this.bal[`${params.account}|${params.ledger_index}`];
      if (b === undefined) throw new Error(`fixture: no balance for ${params.account}@${params.ledger_index}`);
      return b === null ? { error: 'actNotFound' } : { account_data: { Account: params.account, Balance: typeof b === 'bigint' ? b.toString() : String(Math.round(b * 1e6)) } };
    }
    if (method === 'tx') {   // re-verification lookup: flat tx fields + meta, like the real `tx` response
      for (const list of Object.values(this.t)) for (const t of list) if (t.hash === params.transaction) return { hash: t.hash, validated: true, ledger_index: t.ledger_index, ...t.tx_json, meta: t.meta };
      return { error: 'txnNotFound' };
    }
    throw new Error(`fake ledger: unexpected ${method}`);
  }
}
export const A = 'rAAAA'; export const B = 'rBBBB'; export const X = 'rXXXX';
export const cfg = (o = {}) => ({ full_history_start: 1, window_hours: 24, large_transfer_threshold_xrp: 1000, max_pages_per_wallet: 40,
  wallets: [{ id: 'A', address: A, ownership: 'third_party', provenance: 'p', evidence_url: null }], ...o });
export const twoWallets = () => cfg({ wallets: [{ id: 'A', address: A, ownership: 'third_party', provenance: 'p' }, { id: 'B', address: B, ownership: 'third_party', provenance: 'p' }] });
// Complete window; oldest ledger 960 (H4 +50) is INCLUDED, opening balance at 959.
export function basicLedger(o = {}) {
  const txs = [tx('H1', 990, X, A, 5000, 400), tx('H2', 980, A, X, 2000, 500), tx('H3', 970, X, A, 300, 600), tx('H4', 960, X, A, 50, 700)];
  const bal = { [`${A}|959`]: 100, [`${A}|980`]: 100 + 50 + 300 - 2000 - 10 / 1e6, [`${A}|1000`]: 100 + 5350 - 2000 - 10 / 1e6 };
  return new FakeLedger({ [A]: txs }, bal, o);
}
