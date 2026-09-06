#!/usr/bin/env bash
# Runs when the recorder reaches 288 markets: re-optimizes BOTH strategies with the walk-forward
# (train/test) validator and writes a GO/NO-GO report. SAFE — offline, $0 risk, NO live trading.
# The real-money redeploy stays MANUAL (gated on a GO verdict + human confirm) — see report footer.
export PATH="$PATH:/usr/local/bin:/usr/bin"
cd /root/projects/btc-5m-market-trading-bot || exit 1
FLAG=results/track/.optimized288.done
REPORT=results/track/OPTIMIZATION_REPORT.md
TARGET=288

N=$(grep -h '"ev":"meta"' results/track/clob-*.jsonl 2>/dev/null | wc -l)
[ -f "$FLAG" ] && exit 0                 # already optimized once
[ "$N" -lt "$TARGET" ] && exit 0         # not enough data yet

{
  echo "# BTC-5m Auto-Optimization Report"
  echo "_Generated at $N markets recorded._"
  echo
  echo '## Walk-forward validation (optimize on TRAIN, validate on unseen TEST) — THE decision'
  echo '```'
  python3 results/track/backtest.py walkforward
  echo '```'
  echo '## Full-sample optimize (reference only — can overfit)'
  echo '```'
  python3 results/track/backtest.py optimize
  echo '```'
  echo '## A vs B comparison'
  echo '```'
  python3 results/track/backtest.py compare
  echo '```'
  echo
  echo '## REDEPLOY GATE (real money — manual confirm required)'
  echo 'Redeploy live ONLY for a strategy whose walk-forward verdict is ✅ GO (positive + 100% maker'
  echo '+ within cap OUT-OF-SAMPLE). If GO for Strategy A, the live command is (edit pm2-live-a.sh args'
  echo 'to the validated params, then `pm2 restart btc-live-a`). If NO-GO, do NOT trade live.'
} > "$REPORT" 2>&1
touch "$FLAG"
echo "optimization report written to $REPORT at $N markets"
