// The ONLY place that names the assets Flow Intelligence can monitor. Self-contained (no imports) so the server can ship it with the live router.
// Adding an asset here is not enough to monitor it: a monitor must also be started for it, with its OWN database (see monitor.js).
export const FLOW_ASSETS = Object.freeze({
  BTC: Object.freeze({ asset: 'BTC', pair: 'BTC/USD', krakenPair: 'XBTUSD', streamId: 'kraken:spot:btc/usd:kraken public rest', liveId: 'live-btc-usd' }),
  XRP: Object.freeze({ asset: 'XRP', pair: 'XRP/USD', krakenPair: 'XRPUSD', streamId: 'kraken:spot:xrp/usd:kraken public rest', liveId: 'live-xrp-usd' }),
});
export const DEFAULT_FLOW_ASSET = 'BTC';
/** @returns the registry entry for a supported asset code, else null. Only own, exact, upper-case keys match (no prototype keys, no case folding). */
export const flowAsset = (code) => (typeof code === 'string' && Object.hasOwn(FLOW_ASSETS, code) ? FLOW_ASSETS[code] : null);
