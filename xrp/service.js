// ─────────────────────────────────────────────────────────────────────────────
// XRP wallet service: runs the collector in the background and serves the last result from memory.
//
// CACHE / REFRESH BEHAVIOUR
//  • A request NEVER triggers an XRPL scan. GET /api/xrp/wallets only reads memory, so app traffic can
//    not multiply upstream load or re-scan full transaction histories.
//  • One scan at a time (single-flight). The first scan starts at boot, then every `refreshSeconds`
//    (default 15 min). After a failed scan the delay doubles (max 1 h).
//  • The result of every completed scan is kept in memory ("latest"); the newest scan whose totals were
//    verified is kept as "lastGood". While lastGood is younger than `staleAfterSeconds` it is served even
//    if a newer scan could not be verified (the newer outcome is disclosed in `refresh.newerScanNotVerified`),
//    so a transient upstream hiccup does not flap the app between figures and "withheld". Beyond that, the
//    newest scan is served as-is, and anything older than `maxServeAgeSeconds` has its totals withheld.
//  • A failed scan (exception) never replaces cached data; it is recorded in `refresh.lastAttempt*`.
//  • The RPC client additionally caches immutable `tx` look-ups (bounded), saving re-verification calls
//    for large transfers that stay inside the 24 h window across refreshes.
// ─────────────────────────────────────────────────────────────────────────────
import { analyze, verifyTransfers } from './collector.js';
import { createXrplClient } from './xrpl-client.js';
import { buildXrpWalletsResponse } from './response.js';

export function createXrpService({
  cfg,
  clientFactory = (c) => createXrplClient({ url: c.rpcUrl }),
  nowMs = () => Date.now(),
  log = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const client = clientFactory(cfg);
  let latest = null; let lastGood = null; let lastAttempt = null; let inflight = null; let failures = 0; let timer = null; let stopped = true;

  async function refresh() {
    if (!cfg.enabled) return null;
    if (inflight) return inflight;                       // single-flight
    inflight = (async () => {
      const started = nowMs();
      try {
        client.setDeadline(started + cfg.scanDeadlineSeconds * 1000);
        const analysis = await analyze(client.rpc, cfg.analysis, started / 1000);
        const verification = await verifyTransfers(client.rpc, analysis.transfers);
        const rec = { analysis, verification, completedAt: nowMs(), durationMs: nowMs() - started, requests: client.stats.requests };
        latest = rec;
        if (analysis.set.totals_verified) lastGood = rec;
        lastAttempt = { at: rec.completedAt, ok: true };
        failures = 0;
        log.log(`[xrp] scan ok — ledger ${analysis.pinned_ledger}, totals_verified=${analysis.set.totals_verified}, ${Math.round(rec.durationMs / 1000)}s`);
        return rec;
      } catch (e) {
        failures += 1;
        lastAttempt = { at: nowMs(), ok: false, error: e?.message || String(e) };
        log.warn(`[xrp] scan failed (#${failures}): ${lastAttempt.error}`);
        return null;
      } finally {
        client.setDeadline(null);
        inflight = null;
      }
    })();
    return inflight;
  }

  function selectServed() {
    const now = nowMs();
    if (lastGood && (now - lastGood.completedAt) / 1000 <= cfg.staleAfterSeconds) return lastGood;
    return latest ?? lastGood;
  }

  function getResponse() {
    const served = selectServed();
    return buildXrpWalletsResponse({
      enabled: cfg.enabled, served, newerUnverified: served && latest && latest !== served ? latest : null,
      lastAttempt, refreshing: Boolean(inflight), cfg, nowMs: nowMs(),
    });
  }

  function start() {
    if (!cfg.enabled || !stopped) return;
    stopped = false;
    const loop = async () => {
      await refresh();
      if (stopped) return;
      const delaySec = failures ? Math.min(cfg.refreshSeconds * 2 ** Math.min(failures, 3), 3600) : cfg.refreshSeconds;
      timer = setTimeoutFn(loop, delaySec * 1000);
      timer?.unref?.();
    };
    loop();                                              // not awaited: server startup is never blocked
  }

  function stop() { stopped = true; if (timer) clearTimeoutFn(timer); timer = null; }

  return { refresh, getResponse, start, stop, client, get state() { return { latest, lastGood, lastAttempt, failures, refreshing: Boolean(inflight) }; } };
}
