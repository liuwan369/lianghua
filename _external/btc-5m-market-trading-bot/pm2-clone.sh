#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# TARGET-WALLET CLONE — replicates 0xbd050887…'s reverse-engineered strategy at scale.
# Extracted params (from 3000 on-chain trades, results/target/target_activity.json):
#   • ~20-share clips           → --usd 10  (clip_shares = floor(10/0.5) = 20)
#   • pair cost < ~0.98 (avg 0.97, 87% <$1) → --pair-target 0.98
#   • near-delta-neutral ~4% (p90 12%)      → --hard-imbalance 0.12, --target-imbalance 0.06
#   • continuous fair-following re-quote (~26 levels, 97.7% reprice, follows BTC) → --fair-value
#   • all markets, hold to resolution, never sell → --continuous (the maker-hedge loop)
#   • scale ~$288 gross/market  → --max-total-usd (START 100, raise to 300 once fill-rate confirmed)
#
# ⚠️ DEPLOY GUIDANCE (read the memory): our backtest on OVERLAP-CLOSED data shows this LOSES + scaling
#    multiplies the loss — because the target's edge needs ACTIVE-hour liquidity (their ~32 fills/mkt @
#    pair 0.97). RUN THIS DURING THE OVERLAP (13:30–16:00 UTC) and START SMALL ($100) to MEASURE whether
#    OUR fill rate matches the target's 32/mkt; only raise --max-total-usd toward 300 once it does.
# ──────────────────────────────────────────────────────────────────────────────
set -eu
cd /root/projects/btc-5m-market-trading-bot
set -a; . ./.env; set +a            # wallet key / sig_type=3 / funder (never printed)
mkdir -p results/live
export HEDGE_DEBUG=1
exec ./target/release/btc-5m-live maker-hedge --continuous --fair-value \
  --usd 10 --pair-target 0.98 --hard-imbalance 0.12 --target-imbalance 0.06 \
  --max-total-usd 100 --max-loss-usd 100 --reconcile-sec 35 --requote-move-ticks 2 \
  --windows 288 --log-clob results/live/clone-session.jsonl
