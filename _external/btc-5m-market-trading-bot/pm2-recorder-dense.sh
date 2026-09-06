#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# DENSE FULL-WINDOW CLOB RECORDER ($0, read-only — no key, no orders).
# Unlike the trading-loop --log-clob (which stopped ~40s before each window's end → only ~53%
# coverage), `record-feeds` streams the PM book to each window's TRUE end (dl = market end) and now
# also logs top-of-book SIZES (up_bid_sz/up_ask_sz/down_bid_sz/down_ask_sz) for queue modelling.
# Run it during the ACTIVE overlap (13:30–16:00 UTC) so the recorded windows are the liquid ones the
# target trades. Then convert + backtest:  python3 ../btc-5m-target-trader/build_clone_md_from_feeds.py
#
#   ./pm2-recorder-dense.sh                 # default 2.5h (the overlap)
#   SECONDS_RUN=3600 ./pm2-recorder-dense.sh   # 1h
# ──────────────────────────────────────────────────────────────────────────────
set -eu
cd /root/projects/btc-5m-market-trading-bot
mkdir -p results/track
SECONDS_RUN=${SECONDS_RUN:-9000}      # 2.5h overlap by default
OUT=${OUT:-results/track/dense-feeds.jsonl}
echo "DENSE recorder: ${SECONDS_RUN}s -> $OUT  (full-window PM book + sizes + BTC/oracle/flow; \$0, read-only)"
exec ./target/release/btc-5m-live record-feeds --seconds "$SECONDS_RUN" --out "$OUT"
