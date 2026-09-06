# Tiny Live Fill-Rate Test — close the realistic gap to the target wallet

**Why:** the backtest can't measure the real maker fill rate (queue priority + liquidity rewards aren't
in top-of-book contingent fills). The target's logged profile is **33.6 fills/mkt, 56% maker / 44%
taker, 82% win, +$5.42/mkt, pair 0.969**. Our realistic backtest caps at ~12–14 fills / ~50% win on
the sparse recorded book. The only ground truth is a live test. This runbook measures it and A/Bs the
**verified queue-priority / rewards lever** (`--requote-min-rest-sec 3.5`).

> Run during the **active-hours overlap (13:30–16:00 UTC)** — that's when the target gets its ~33
> fills/mkt. Calm hours have thin books and few fills (the known ~5% problem).

## 0. Build
```bash
cargo build --release --bin btc-5m-live
```

## 1. PAPER A/B — does the lever lift fill rate? ($0 risk)
Run both legs of the A/B during the overlap (the paper queue model approximates fill timing):
```bash
# Baseline (lever OFF):
REST=0   WINDOWS=12 ./pm2-clone-fillrate.sh        # -> results/live/fillrate-paper-rest0.jsonl
# Lever ON (queue priority + rewards eligibility):
REST=3.5 WINDOWS=12 ./pm2-clone-fillrate.sh        # -> results/live/fillrate-paper-rest3.5.jsonl
```
Then compare:
```bash
./target/release/btc-5m-live replay-clob results/live/fillrate-paper-rest0.jsonl
./target/release/btc-5m-live replay-clob results/live/fillrate-paper-rest3.5.jsonl
# (replay-clob reports the REAL fill rate, fill-dwell, hedge-completion, and realized P&L)
```
**Capture per run:** fills/market, maker %, taker %, re-quotes, fill-dwell, win %, PnL.
**Expected:** REST=3.5 holds orders in the queue longer → fewer re-quotes, **higher maker fill rate**.

## 2. TINY LIVE — measure the REAL fill rate (≤ $10 at risk)
Needs `.env` (POLYMARKET_PRIVATE_KEY, POLY_SIGNATURE_TYPE=3, POLY_FUNDER). Bust-capped at $10 / $8.
```bash
# Pre-flight (read-only): balances + CTF allowance
./target/release/btc-5m-live preflight
# Tiny live, lever ON, during the overlap:
PAPER=0 REST=3.5 USD=2 CAP=10 LOSS=8 WINDOWS=12 ./pm2-clone-fillrate.sh
```
Monitor in another shell:
```bash
./target/release/btc-5m-live monitor results/live/fillrate-LIVE-rest3.5.jsonl
```
After it finishes, analyze + reconcile actual on-chain fills:
```bash
./target/release/btc-5m-live analyze     results/live/fillrate-LIVE-rest3.5.jsonl
./target/release/btc-5m-live replay-clob  results/live/fillrate-LIVE-rest3.5.jsonl
```

## 3. Metrics to record (the gap, every aspect)
| Metric | Target | Our paper | Our LIVE | Gap |
|---|---|---|---|---|
| Fills / market | 33.6 | | | |
| Maker % / Taker % | 56 / 44 | | | |
| Avg pair cost | 0.969 | | | |
| Win rate | 82% | | | |
| PnL / market ($) | +5.42 | | | |
| **+ Liquidity rebate / day** | (extra) | n/a | from on-chain PUSD at 00:00 UTC | |

> **Rebate accrual** is *separate* from the binary PnL above — check the wallet's daily PUSD/USDC
> liquidity-reward payout (midnight UTC, $1 min). Per the docs it can dwarf the thin binary edge and is
> likely a large part of the target's real take. Resting tight, two-sided, ≥3.5s near mid maximizes it.

## 4. GO / NO-GO to scale `--max-total-usd` toward the target's ~$300/mkt
- **GO** if LIVE: maker fill rate ≥ ~40% AND fills/mkt ≥ ~20 AND PnL/mkt ≥ 0 (binary) AND pair < 1.0
  AND a non-trivial daily rebate accrues. Raise CAP in steps (10 → 30 → 100 → 300), re-measuring each.
- **NO-GO / re-tune** if fills stay < ~15 or PnL < 0: the queue isn't filling us — try a longer
  `--requote-min-rest-sec` (5–7), a tighter `--requote-move-ticks`, or accept it's a thin-hours regime
  and only run the overlap. Do **not** scale a losing fill rate (scaling multiplies the loss).

## 5. Dense full-window CLOB recording (offline, $0) — unblocks the realistic backtest
The old recording covered only ~53% of each window and stopped ~40s early. `record-feeds` now streams
the book to each window's **true end** + logs **top-of-book sizes**. Record during the overlap, then
convert + backtest the *actual clone* on the full book:
```bash
SECONDS_RUN=9000 ./pm2-recorder-dense.sh         # 2.5h, $0, read-only -> results/track/dense-feeds.jsonl
#   (or: pm2 start pm2-recorder-dense.sh --name btc-recorder-dense)
python3 ../btc-5m-target-trader/build_clone_md_from_feeds.py results/track/dense-feeds.jsonl
./target/release/btc-5m-backtest --mode realistic-trader --target-clone-active \
  --fill-model bid --maker-life-sec 20 \
  --market-data ../btc-5m-target-trader/clone_md_feeds.json --trader-json ../btc-5m-target-trader/clone_md_feeds.json
```
With full-window coverage the realistic fills/win/PnL become trustworthy (the current ~12 fills / 54%
is capped by the sparse sample, not the strategy).

## 6. Value the LIQUIDITY REWARDS (the likely hidden edge)
The realistic-trader backtest now reports a **reward score** (resting-maker score `((v−s)/v)²·size`,
quadratic in closeness to mid). Add `--reward-rate` to turn it into an estimated $ rebate so you see
**binary PnL + rebate** together:
```bash
./target/release/btc-5m-backtest --mode realistic-trader --target-clone-active --fill-model bid \
  --reward-max-spread 0.035 --reward-rate 0.01 --market-data ... --trader-json ...
# -> "Reward score: N | Est. rebate: $X | Binary+rebate: $Y"
```
The pool/competition split is market-specific (fetch `max_incentive_spread` from the CLOB API per
market); `--reward-rate` is your $/score·min assumption. This is how you test whether the target's edge
(and near-mid quoting) is really rewards-driven — and the live test's true rebate is the wallet's daily
PUSD payout at 00:00 UTC.

## Notes
- All orders are **postOnly (maker)**; forced crosses only to complete a pair near resolution.
- The locked production preset (`btc-live-a`) is **unchanged**; this is a separate, capped test.
- This test is the real-world counterpart to the faithful clone (`target_clone_active`) validated offline.
