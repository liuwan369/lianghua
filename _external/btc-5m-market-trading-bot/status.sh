#!/usr/bin/env bash
# One-shot live-trading status snapshot. Usage: ./status.sh
export PATH="$PATH:/usr/local/bin:/usr/bin"
cd /root/projects/btc-5m-market-trading-bot
LIVE=/var/log/btc-live-a.pm2.log
FUNDER=0xb5badc3f990E8457C79766f0E2398489e5E998Ac

echo "════════ PM2 PROCESSES ════════"
pm2 list 2>/dev/null | grep -E "name|btc-"

echo; echo "════════ LIVE TRADER — current state ════════"
grep '\[dbg\]' $LIVE | tail -1 | grep -oE 'left=[0-9]+|spent=[0-9./]+|pair=[0-9.]+|inv U[0-9]+/D[0-9]+|btc=[0-9]+|fairUp=[0-9.-]+' | tr '\n' '  '; echo
echo "deployed/cap (on-chain reconcile):"; grep 'reconcile:' $LIVE | tail -1 | sed 's/^[0-9T:-]*://'

echo; echo "════════ RECENT REAL EVENTS (quotes / fills / window closes) ════════"
grep -E "QUOTE|✓ fill|window inventory|REALIZED" $LIVE | tail -6 | sed 's/^\([0-9T:-]*\):/\1 /'

echo; echo "════════ TODAY'S COUNTS ════════"
echo "  real QUOTEs: $(grep -c '• QUOTE' $LIVE)   real fills: $(grep -cE '✓ fill (Up|Down)' $LIVE)   errors: $(grep -ciE 'error|panic|reject|FAILED|not allowed' $LIVE)"

echo; echo "════════ ON-CHAIN (authoritative PnL) ════════"
curl -s --max-time 12 "https://data-api.polymarket.com/activity?user=$FUNDER&limit=6" 2>/dev/null \
 | python3 -c "import sys,json;
try: d=json.load(sys.stdin)
except: print('  (no response)'); sys.exit()
print('  (no activity)') if not d else [print(f\"  {a.get('type'):<6} {a.get('side',''):<4} {a.get('size','')} @ {a.get('price','')}  {a.get('title','')[:34]}\") for a in d[:6]]"

echo; echo "════════ DATASET (recorder) ════════"
echo "  markets recorded: $(grep -h '\"ev\":\"meta\"' results/track/clob-*.jsonl 2>/dev/null | wc -l) / 288 target"
echo; echo "(live stream: pm2 logs btc-live-a   |   dashboard: pm2 monit   |   stop: pm2 stop btc-live-a)"
