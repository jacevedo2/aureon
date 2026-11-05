// Replays recorded XRPL responses as an rpc(method, params) function (no network).
// account_tx pages are served newest-first and chained by the marker the previous page returned.
export function buildReplayRpc(responses, { pin, completeLedgers }) {
  const info = new Map(); const txByHash = new Map(); const pagesBy = new Map();
  for (const r of responses) {
    const x = r.result && typeof r.result === 'object' ? r.result : r;     // accept raw HTTP bodies or unwrapped results
    if (x.transactions) { (pagesBy.get(x.account) || pagesBy.set(x.account, []).get(x.account)).push(x); }
    else if (x.account_data) info.set(`${x.account_data.Account}|${x.ledger_index}`, x);
    else if (x.hash) txByHash.set(x.hash, x);
  }
  const maxLedger = (p) => Math.max(...p.transactions.map((t) => t.ledger_index ?? (t.tx || t.tx_json).ledger_index));
  const nextByMarker = new Map(); const first = new Map();
  for (const [acct, pages] of pagesBy) {
    pages.sort((a, b) => maxLedger(b) - maxLedger(a));
    first.set(acct, pages[0]);
    pages.forEach((p, i) => { if (i + 1 < pages.length) nextByMarker.set(`${acct}|${JSON.stringify(p.marker)}`, pages[i + 1]); });
  }
  const calls = [];
  async function rpc(method, params) {
    calls.push(method);
    if (method === 'server_info') return { info: { validated_ledger: { seq: pin }, complete_ledgers: completeLedgers, server_state: 'full' } };
    if (method === 'account_tx') {
      const page = params.marker ? nextByMarker.get(`${params.account}|${JSON.stringify(params.marker)}`) : first.get(params.account);
      if (!page) throw new Error(`replay: no recorded page for ${params.account} marker ${JSON.stringify(params.marker)}`);
      return page;
    }
    if (method === 'account_info') {
      const r = info.get(`${params.account}|${params.ledger_index}`);
      return r || { error: 'actNotFound' };
    }
    if (method === 'tx') {
      const r = txByHash.get(params.transaction);
      if (!r) throw new Error(`replay: no recorded tx ${params.transaction}`);
      return r;
    }
    throw new Error(`replay: unexpected method ${method}`);
  }
  rpc.calls = calls;
  return rpc;
}
