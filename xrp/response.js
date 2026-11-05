// ─────────────────────────────────────────────────────────────────────────────
// GET /api/xrp/wallets — response builder (pure function; no I/O, no environment access).
//
// Rules enforced here:
//  • Aggregate totals are present ONLY when the analysis says totals_verified (every wallet complete and
//    reconciled with exactly zero residual) AND the snapshot is not too old. Otherwise they are null and
//    the reason per wallet is returned.
//  • Wallet ownership is always reported as an UNCONFIRMED third-party attribution.
//  • No exchange inflow/outflow classification is ever produced: every transfer is "unclassified"
//    (or "confirmed_internal" between two confirmed wallets of one entity — none exist today).
//  • Exchange net flow and whale activity are explicitly unavailable.
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
export const MAX_LARGE_TRANSFERS = 25;

export const OWNERSHIP_NOTE = 'Third-party attribution. Ownership is NOT confirmed by the exchange.';
export const UNSUPPORTED = {
  exchangeNetFlow: { available: false, reason: 'Exchange wallet ownership is not confirmed by any owner-published source, so exchange inflow/outflow is not computed.' },
  whaleActivity: { available: false, reason: 'Large transfers are ledger facts only; they are not evidence of whale buying or selling.' },
};
export const DISCLAIMERS = [
  'Coverage is partial: only the listed addresses are monitored; exchanges operate many other wallets.',
  'Wallet movements are not exchange inflows or outflows: counterparty ownership is unknown.',
  'A large transfer is a ledger fact, not evidence of buying or selling.',
];

const isoOrNull = (sec) => (sec === null || sec === undefined ? null : new Date(sec * 1000).toISOString());

function walletView(w, tooOld, hostedHints) {
  const base = {
    id: w.id,
    address: w.address,
    label: `Monitored wallet ${w.id}`,
    ...(hostedHints[w.id] ? { entityHint: hostedHints[w.id] } : {}),
    ownership: { status: 'unconfirmed_third_party', note: OWNERSHIP_NOTE },
    status: w.status,
  };
  if (w.status === 'unavailable') return { ...base, verified: false, verificationFailure: w.verification_failure, figures: null };
  const cv = w.coverage || {};
  return {
    ...base,
    verified: Boolean(w.verified) && !tooOld,
    verificationFailure: tooOld ? 'snapshot too old' : w.verification_failure,
    coverage: {
      complete: Boolean(w.window_complete), openingLedgerExclusive: cv.opening_ledger_exclusive ?? null, closingLedger: cv.closing_ledger ?? null,
      coveredFrom: cv.covered_from_utc ?? null, coveredHours: cv.covered_hours ?? null, requestedHours: cv.requested_hours ?? null, basis: cv.basis ?? null,
      historyProven: w.history_coverage?.proven ?? null,
    },
    reconciliation: w.reconciliation
      ? (w.reconciliation.residual_drops !== undefined
        ? { ran: true, covers: w.reconciliation.covers, residualXrp: w.reconciliation.residual_xrp, residualDrops: w.reconciliation.residual_drops,
            ledgerBalanceChangeXrp: w.reconciliation.ledger_delta_xrp, computedXrp: w.reconciliation.computed_xrp }
        : { ran: false, reason: w.reconciliation.unavailable_reason || w.reconciliation.error || 'unavailable' })
      : { ran: false, reason: w.counts && w.counts.payments_in + w.counts.payments_out === 0 ? 'no activity in window' : 'unavailable' },
    figuresVerified: Boolean(w.verified) && !tooOld,
    figures: {
      receivedXrp: w.inflow_xrp, sentXrp: w.outflow_xrp, feesPaidXrp: w.fees_paid_xrp,
      paymentsReceived: w.counts.payments_in, paymentsSent: w.counts.payments_out,
      failedTransactions: w.counts.failed_tec, nonXrpPaymentsSkipped: w.counts.non_xrp_or_unavailable,
    },
    pagesFetched: w.pages, duplicatesDropped: w.duplicates_dropped,
  };
}

/**
 * @param {object} p
 * @param {boolean} p.enabled
 * @param {object|null} p.served       {analysis, verification, completedAt(ms), durationMs, requests}
 * @param {object|null} p.lastAttempt  {at(ms), ok, error?}
 * @param {boolean} p.refreshing
 * @param {object} p.cfg               loadXrpConfig() result
 * @param {number} p.nowMs
 */
export function buildXrpWalletsResponse({ enabled, served, newerUnverified = null, lastAttempt, refreshing, cfg, nowMs }) {
  const head = {
    service: 'xrp-wallet-monitor', schemaVersion: SCHEMA_VERSION, readOnly: true,
    source: { name: 'XRP Ledger validated transactions (public JSON-RPC)', fullHistoryRequired: true },
    unsupported: UNSUPPORTED, disclaimers: DISCLAIMERS,
    refresh: {
      intervalSeconds: cfg.refreshSeconds,
      lastAttemptAt: lastAttempt ? new Date(lastAttempt.at).toISOString() : null,
      lastAttemptOk: lastAttempt ? lastAttempt.ok : null,
      lastAttemptError: lastAttempt && !lastAttempt.ok ? String(lastAttempt.error || 'failed').slice(0, 200) : null,
      refreshing: Boolean(refreshing),
      newerScanNotVerified: newerUnverified ? { completedAt: new Date(newerUnverified.completedAt).toISOString(), withheldReasons: newerUnverified.analysis.set.withheld_reasons } : null,
    },
  };
  if (!enabled) {
    const notConfigured = Boolean(cfg.configError);
    return { ...head, state: 'disabled', reason: notConfigured ? `XRP wallet monitoring is not configured on this server (${cfg.configError}); no ledger requests are made.` : 'XRP wallet monitoring is not enabled on this server.', totals: { verified: false, withheldReason: notConfigured ? 'monitoring not configured' : 'monitoring disabled' }, wallets: [], largeTransfers: { available: false, items: [] } };
  }
  if (!served) {
    const state = (refreshing || !lastAttempt) ? 'warming' : 'unavailable';
    return { ...head, state, reason: state === 'warming' ? 'First ledger scan in progress; no data yet.' : 'No successful ledger scan is available.',
      totals: { verified: false, withheldReason: state === 'warming' ? 'no scan completed yet' : 'no successful scan' }, wallets: [], largeTransfers: { available: false, items: [] } };
  }

  const a = served.analysis;
  const ageSeconds = Math.max(0, Math.round((nowMs - served.completedAt) / 1000));
  const stale = ageSeconds > cfg.staleAfterSeconds;
  const tooOld = ageSeconds > cfg.maxServeAgeSeconds;
  const s = a.set;
  const totalsVerified = Boolean(s.totals_verified) && !tooOld;
  const verification = new Map((served.verification || []).map((v) => [v.hash, v.match]));
  const generated = Date.parse(a.generated_utc);
  const reasons = tooOld ? { snapshot: `snapshot is ${ageSeconds}s old (limit ${cfg.maxServeAgeSeconds}s)` } : s.withheld_reasons;

  return {
    ...head,
    state: stale ? 'stale' : 'fresh',
    generatedAt: new Date(served.completedAt).toISOString(),
    ageSeconds,
    scan: { durationSeconds: Math.round((served.durationMs || 0) / 1000), requests: served.requests ?? null },
    observation: {
      windowHours: a.window_hours,
      windowEnd: a.generated_utc,
      windowStart: new Date(generated - a.window_hours * 3600 * 1000).toISOString(),
      pinnedLedger: a.pinned_ledger,
      serverHistorySegment: a.server_history?.complete_ledgers_segment ?? null,
      note: 'All wallets are read at the same pinned validated ledger. Boundaries per wallet are under wallets[].coverage.',
    },
    totals: totalsVerified
      ? { verified: true, receivedXrp: s.inbound_xrp, sentXrp: s.outbound_xrp, netXrp: s.net_xrp, betweenMonitoredXrp: s.between_monitored_xrp,
          paymentsReceived: s.n_inbound, paymentsSent: s.n_outbound, paymentsBetweenMonitored: s.n_between, scope: s.coverage }
      : { verified: false, receivedXrp: null, sentXrp: null, netXrp: null, betweenMonitoredXrp: null, paymentsReceived: null, paymentsSent: null,
          withheldReasons: reasons, scope: s.coverage },
    wallets: a.wallets.map((w) => walletView(w, tooOld, cfg.hints || {})),
    largeTransfers: {
      available: true,
      thresholdXrp: a.threshold_xrp,
      complete: Boolean(a.transfers_complete) && !tooOld,
      note: a.transfers_complete ? null : 'Collection was incomplete for at least one wallet; transfers may be missing.',
      items: a.transfers.slice(0, MAX_LARGE_TRANSFERS).map((t) => ({
        hash: t.hash, amountXrp: t.amount_xrp, direction: t.direction === 'in' ? 'received' : 'sent', walletId: t.monitored_id,
        counterparty: { address: t.direction === 'in' ? t.source : t.destination, monitored: t.counterparty_monitored,
          ownership: t.counterparty_ownership === 'unknown' ? 'unknown' : `unconfirmed_${t.counterparty_ownership}` },
        timestamp: isoOrNull(t.ts), ledger: t.ledger, flowClass: t.flow_class, verifyUrl: t.verify_url,
        reverified: verification.has(t.hash) ? verification.get(t.hash) : null,
      })),
    },
  };
}
