#!/usr/bin/env bash
# Live-trading launcher for Strategy A under PM2 (TypeScript).
set -eu
cd /root/projects/btc-5m-market-trading-bot
set -a; . ./.env; set +a
mkdir -p results/live
npm run build --silent
exec node dist/cli/live.js run --live \
  --order-usd 2 --max-orders 50 --max-total-usd 10 \
  --log-file results/live/live-session.jsonl
