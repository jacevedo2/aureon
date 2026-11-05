# XRP parity fixtures
Real, recorded XRP Ledger responses (validated ledger 108,110,074; 24 h window) used to prove the JS collector reproduces the
Opus-approved Python prototype. Public ledger data only (addresses, hashes, amounts).

* `recorded-ledger-w2-w3.json` — `account_tx` pages, `account_info` balances (opening ledger L0-1 and closing ledger L1) and `tx`
  re-verification responses for wallets W2 and W3. Trimmed to the fields the collector reads; values are verbatim.
  `complete_ledgers` (`32570-<pin>`) and the pinned ledger are supplied by the test (the original `server_info` response was never saved);
  every recorded `account_tx` page carries `ledger_index_min: 32570`, which the collector also checks.
* `golden-python-w2-w3.json` — output of the approved Python prototype (`xrp_monitor.py`, corrected + final-safeguard version) run on the
  FULL raw responses for the same two wallets.
