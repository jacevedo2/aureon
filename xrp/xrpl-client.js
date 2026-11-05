// ─────────────────────────────────────────────────────────────────────────────
// Read-only XRP Ledger JSON-RPC client (public servers, no credentials, no signing).
//
//  • One request at a time, spaced `paceMs` apart (XRPL public clusters meter by "units"; a full 24 h
//    scan of a busy wallet is ~20 account_tx pages).
//  • `tooBusy` (rate limit) is honoured: wait the server-suggested time, then retry — never hammer.
//  • Network errors / HTTP errors retry with a growing delay; after `maxAttempts` the call throws
//    Unavailable so the collector can mark the window incomplete instead of guessing.
//  • An optional scan deadline bounds total wall-clock time.
//  • A small FIFO cache holds only calls the caller marks immutable (validated-ledger data such as
//    `tx` lookups), so repeated refreshes don't re-fetch the same large transfers.
//
// Everything that touches the outside world (fetch, sleep, clock) is injectable for tests.
// ─────────────────────────────────────────────────────────────────────────────

export class Unavailable extends Error {
  constructor(message) { super(message); this.name = 'Unavailable'; }
}

export function createXrplClient({
  url = null,                       // no public fallback: without an endpoint every call fails closed, before any fetch
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  paceMs = 1600,
  maxAttempts = 6,
  timeoutMs = 60_000,
  cacheMax = 500,
} = {}) {
  let lastRequestAt = 0;
  let deadlineAt = null;
  const cache = new Map();
  const stats = { requests: 0, rateLimitWaits: 0, failedAttempts: 0, cacheHits: 0 };

  async function rpc(method, params, { cacheable = false } = {}) {
    if (!url) throw new Unavailable('no XRPL endpoint configured');
    const key = cacheable ? `${method}|${JSON.stringify(params)}` : null;
    if (key && cache.has(key)) { stats.cacheHits += 1; return cache.get(key); }

    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (deadlineAt !== null && now() > deadlineAt) throw new Unavailable('scan deadline exceeded');
      const gap = paceMs - (now() - lastRequestAt);
      if (gap > 0) await sleep(gap);
      try {
        lastRequestAt = now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let resp;
        try {
          resp = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'AureonBackend/1.0 (read-only XRPL monitor)' },
            body: JSON.stringify({ method, params: [params] }),
            signal: ctrl.signal,
          });
        } finally { clearTimeout(timer); }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const res = (await resp.json()).result;
        if (!res || typeof res !== 'object') throw new Error('malformed response');
        stats.requests += 1;
        if (res.error === 'tooBusy') {
          stats.rateLimitWaits += 1;
          const m = /retry in ~(\d+)ms/.exec(res.error_message || '');
          lastError = new Error('rate limited (tooBusy)');
          await sleep((m ? Number(m[1]) / 1000 : 20) * 1000 + 2000);
          continue;
        }
        if (key && res.status !== 'error' && !('error' in res)) {
          if (cache.size >= cacheMax) cache.delete(cache.keys().next().value);
          cache.set(key, res);
        }
        return res;
      } catch (e) {
        stats.failedAttempts += 1;
        lastError = e;
        await sleep(3000 * (attempt + 1));
      }
    }
    throw new Unavailable(String(lastError?.message || lastError || 'request failed'));
  }

  return {
    rpc,
    stats,
    setDeadline(ms) { deadlineAt = ms; },
    get cacheSize() { return cache.size; },
  };
}
