#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# TINY FILL-RATE TEST — faithful target-wallet clone + the VERIFIED fill-rate levers.
# Goal: measure our REAL maker fill rate vs the target's (33.6 fills/mkt, 56% maker, 82% win),
# and the lift from the NEW queue-priority / liquidity-rewards lever (--requote-min-rest-sec).
#
# Run it like the target: ACTIVE-HOURS overlap (13:30–16:00 UTC) when the book is liquid.
#   PAPER (default, $0):     ./pm2-clone-fillrate.sh
#   TINY LIVE ($10 fund):    PAPER=0 ./pm2-clone-fillrate.sh     # needs .env (key/sig3/funder)
#   A/B baseline (lever off): REST=0 ./pm2-clone-fillrate.sh
# Tune scale with USD/CAP/WINDOWS env vars. Analyse after with:  see LIVE_FILLRATE_TEST.md
# ──────────────────────────────────────────────────────────────────────────────
set -eu
cd /root/projects/btc-5m-market-trading-bot
mkdir -p results/live

PAPER=${PAPER:-1}          # 1 = paper ($0); 0 = REAL tiny-live
REST=${REST:-3.5}          # --requote-min-rest-sec (VERIFIED lever); 0 = baseline for the A/B
USD=${USD:-2}              # per-leg notional (clip ≈ USD/price); start tiny, scale after GO
CAP=${CAP:-10}             # bust cap = max deployed notional (keep BELOW the fund)
LOSS=${LOSS:-8}            # hard stop (below the fund so you can never be fully wiped)
WINDOWS=${WINDOWS:-12}     # 12 ≈ 1 hour of 5-min windows; use 30 for the full overlap
SIG=${SIG:-bid-touch}      # informational only

TAG=$([ "$PAPER" = "1" ] && echo paper || echo LIVE)
LOG="results/live/fillrate-${TAG}-rest${REST}.jsonl"
echo "FILL-RATE TEST: mode=$TAG  requote_min_rest=${REST}s  usd=$USD cap=$CAP loss=$LOSS windows=$WINDOWS"
echo "log -> $LOG"

ARGS=(maker-hedge --continuous --fair-value --fair-sigma 2.88 --ev-side-select \
  --requote-min-rest-sec "$REST" \
  --usd "$USD" --pair-target 0.98 --hard-imbalance 0.12 --target-imbalance 0.06 \
  --requote-move-ticks 2 --reconcile-sec 35 \
  --max-total-usd "$CAP" --max-loss-usd "$LOSS" --windows "$WINDOWS" \
  --log-clob "$LOG")

if [ "$PAPER" = "1" ]; then
  exec ./target/release/btc-5m-live "${ARGS[@]}" --paper
else
  set -a; . ./.env; set +a            # wallet key / sig_type=3 / funder (never printed)
  export HEDGE_DEBUG=1
  echo "⚠️  REAL MONEY — capped at \$$CAP deployed / \$$LOSS loss. Ctrl-C cancels all + exits."
  exec ./target/release/btc-5m-live "${ARGS[@]}"
fi
