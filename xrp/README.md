# XRP wallet monitor (read-only)

`GET /api/xrp/wallets` serves cached, ledger-verified activity for the three XRP Ledger addresses in `wallets.json`.
Nothing here signs, holds keys, or writes to any ledger/service.

* **Source:** validated XRP Ledger transactions via public JSON-RPC (`XRPL_RPC_URL`, default `https://xrplcluster.com/`, a full-history cluster).
* **Accounting:** `collector.js` is a line-for-line port of the Opus-approved Python prototype (`xrp_monitor.py`, 36 tests). `test/xrp-parity.test.js` reproduces its output on recorded real data.
* **Verified totals only:** aggregates are returned only if every wallet has a complete 24 h window **and** reconciles with an exactly-zero residual against `account_info` balances at the same pinned ledger. Otherwise `totals.verified=false`, totals are `null`, and per-wallet reasons are returned.
* **History is proven, not assumed:** a window counts as complete only if the server's `complete_ledgers` range reaches the ledger that proves the window start (or mainnet's first ledger, 32570, when completeness came from exhausting the account history).
* **Ownership:** every wallet is reported as `unconfirmed_third_party`. No exchange inflow/outflow is classified. Exchange net flow and whale activity are `available:false`.
* **Cache:** requests read memory only. One scan at a time; first scan at boot, then every `XRP_REFRESH_SECONDS` (default 900). See the header of `service.js`.
* **Off by default:** set `XRP_WALLETS_ENABLED=true` to enable; until then the endpoint returns `state:"disabled"` and the server makes no XRPL calls.

States: `disabled` · `warming` (first scan running) · `unavailable` (no successful scan) · `fresh` · `stale` (older than 3 intervals; totals withheld after max(2 h, 8 intervals)).
