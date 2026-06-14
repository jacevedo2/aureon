#!/usr/bin/env python3
"""
Fetch Bitcoin / Ethereum / XRP spot ETF AUM and daily flow data.
Writes to latest-etf-data.json in the repo root.
Uses Yahoo Finance (yfinance) — no API key required.

Flow computation:
  flow = AUM_today - AUM_stored × (price_today / price_stored)

This removes the price-return component from the AUM delta so only
net fund creations/redemptions remain. Flow is 0 on the bootstrap day
(when stored data is more than 4 calendar days old).
"""
import json
import os
import sys
from datetime import date, timedelta

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed. Run: pip install yfinance", file=sys.stderr)
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(ROOT, "latest-etf-data.json")

BTC_TICKERS = ["IBIT", "FBTC", "GBTC", "ARKB", "BITB", "HODL", "BTCO", "BRRR", "EZBC", "DEFI", "BTCW"]
ETH_TICKERS = ["ETHA", "FETH", "ETHW", "CETH", "QETH", "ETHV", "ETHU", "EZET"]
XRP_TICKERS = ["XRPI", "XRPC", "XRP", "XRPZ", "GXRP", "TOXR", "XRPR"]

BTC_BENCHMARK = "IBIT"
ETH_BENCHMARK = "ETHA"
XRP_BENCHMARK = "XRPI"

# Tickers that must return AUM > 0 for the XRP basket to be considered valid.
# XRPR is intentionally excluded — Yahoo Finance does not publish totalAssets for it.
REQUIRED_XRP_TICKERS = {"XRPI", "XRPC", "XRP", "XRPZ", "GXRP", "TOXR"}

# Abort if new xrpAUM is below this fraction of the price-adjusted prior snapshot.
# Catches partial-coverage runs that don't hit zero but still under-count significantly.
XRP_AUM_MIN_RATIO = 0.80


def get_total_aum(tickers: list[str], required: set[str] | None = None) -> int:
    total = 0
    resolved: set[str] = set()
    for sym in tickers:
        try:
            info = yf.Ticker(sym).info
            aum = info.get("totalAssets", 0) or 0
            if aum > 0:
                print(f"  {sym}: ${aum / 1e9:.3f}B")
                total += aum
                resolved.add(sym)
            else:
                print(f"  {sym}: $0 (no AUM returned)", file=sys.stderr)
        except Exception as e:
            print(f"  {sym}: skipped ({e})", file=sys.stderr)
    if required:
        missing = required - resolved
        if missing:
            missing_str = ", ".join(sorted(missing))
            print(
                f"\nABORT: Required XRP tickers returned no AUM: {missing_str}\n"
                f"  Not writing latest-etf-data.json — prior snapshot preserved.",
                file=sys.stderr,
            )
            sys.exit(1)
    return int(total)


def get_price_return(ticker: str) -> float:
    """Return price_today / price_prev_close for the given ticker.
    Falls back to 1.0 (no-change) on any error so flow computation stays safe.
    """
    try:
        hist = yf.Ticker(ticker).history(period="5d")
        closes = hist["Close"].dropna()
        if len(closes) >= 2:
            p_today = float(closes.iloc[-1])
            p_prev = float(closes.iloc[-2])
            if p_prev > 0:
                ret = p_today / p_prev
                print(f"  {ticker} price return: {ret:.4f} ({p_prev:.2f} → {p_today:.2f})")
                return ret
    except Exception as e:
        print(f"  {ticker} price return error: {e}", file=sys.stderr)
    return 1.0


def compute_flow(aum_today: int, aum_stored: int, price_return: float) -> int:
    """flow = AUM_today - AUM_stored × price_return"""
    if aum_stored <= 0:
        return 0
    return int(aum_today - aum_stored * price_return)


def shift_append(arr: list, value: int, maxlen: int = 7) -> list:
    result = list(arr or [])
    result.append(value)
    return result[-maxlen:]


def load_existing() -> dict:
    if os.path.exists(OUTPUT):
        try:
            with open(OUTPUT) as f:
                return json.load(f)
        except Exception as e:
            print(f"Warning: could not read {OUTPUT}: {e}", file=sys.stderr)
    return {}


def main():
    today = date.today()
    today_str = today.isoformat()

    print(f"ETF data fetch — {today_str}")
    print("=" * 50)

    existing = load_existing()

    if existing.get("lastUpdated") == today_str:
        print("Data already up to date — nothing to do.")
        return

    # ── AUM ──────────────────────────────────────────────────────────────────────
    print("\nBTC ETF basket:")
    btc_aum = get_total_aum(BTC_TICKERS)
    print(f"  → total: ${btc_aum / 1e9:.2f}B")

    print("\nETH ETF basket:")
    eth_aum = get_total_aum(ETH_TICKERS)
    print(f"  → total: ${eth_aum / 1e9:.2f}B")

    print("\nXRP ETF basket:")
    xrp_aum = get_total_aum(XRP_TICKERS, required=REQUIRED_XRP_TICKERS)
    print(f"  → total: ${xrp_aum / 1e9:.3f}B")

    # ── XRP regression guard ───────────────────────────────────────────────────────
    # Compute xrp_return here so it can be reused for flow computation below.
    prior_xrp_aum = existing.get("xrpAUM", 0)
    xrp_return = 1.0  # default; overwritten when prior data exists
    if prior_xrp_aum > 0:
        xrp_return = get_price_return(XRP_BENCHMARK)
        price_adjusted_prior = prior_xrp_aum * xrp_return
        ratio = xrp_aum / price_adjusted_prior
        if ratio < XRP_AUM_MIN_RATIO:
            print(
                f"\nABORT: xrpAUM ${xrp_aum / 1e6:.0f}M is {ratio:.0%} of price-adjusted prior "
                f"${price_adjusted_prior / 1e6:.0f}M (threshold ≥{XRP_AUM_MIN_RATIO:.0%}).\n"
                f"  Likely cause: missing ticker coverage. Not writing latest-etf-data.json — "
                f"prior ${prior_xrp_aum / 1e6:.0f}M snapshot preserved.",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"  xrpAUM regression check: {ratio:.0%} of prior — OK")

    # ── Flows ─────────────────────────────────────────────────────────────────────
    stored_date_str = existing.get("lastUpdated", "")
    try:
        age_days = (today - date.fromisoformat(stored_date_str)).days
    except Exception:
        age_days = 999

    print(f"\nStored data: {stored_date_str or 'none'} ({age_days}d ago)")

    if 0 < age_days <= 4 and existing.get("btcAUM", 0) > 0:
        print("Computing flows from stored AUM baseline...")
        btc_return = get_price_return(BTC_BENCHMARK)
        eth_return = get_price_return(ETH_BENCHMARK)
        # xrp_return already computed above for the regression guard (or 1.0 on bootstrap)

        btc_flow = compute_flow(btc_aum, existing["btcAUM"], btc_return)
        eth_flow = compute_flow(eth_aum, existing["ethAUM"], eth_return)
        xrp_flow = compute_flow(xrp_aum, existing.get("xrpAUM", 0), xrp_return)
    else:
        print("Bootstrap run — flows set to 0 (no usable baseline).")
        btc_flow = 0
        eth_flow = 0
        xrp_flow = 0

    print(f"\n  btcFlow: ${btc_flow / 1e6:+.1f}M")
    print(f"  ethFlow: ${eth_flow / 1e6:+.1f}M")
    print(f"  xrpFlow: ${xrp_flow / 1e6:+.1f}M")

    # ── Write output ──────────────────────────────────────────────────────────────
    payload = {
        "lastUpdated": today_str,
        "btcFlow": btc_flow,
        "ethFlow": eth_flow,
        "xrpFlow": xrp_flow,
        "btcAUM": btc_aum,
        "ethAUM": eth_aum,
        "xrpAUM": xrp_aum,
        "btcRecentFlows": shift_append(existing.get("btcRecentFlows", []), btc_flow),
        "ethRecentFlows": shift_append(existing.get("ethRecentFlows", []), eth_flow),
        "xrpRecentFlows": shift_append(existing.get("xrpRecentFlows", []), xrp_flow),
    }

    with open(OUTPUT, "w") as f:
        json.dump(payload, f, indent=4)
        f.write("\n")

    print(f"\nWritten to {OUTPUT}")
    print("=" * 50)


if __name__ == "__main__":
    main()
