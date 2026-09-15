# R29 Quote Start Delay Follow-up

Command:

```text
python scripts/pm-r29-safe-sweep.py --sqlite data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 --history-dir data/research/r33 --out data/research/r33/r29-quote-delay-followup-20260915.json --max-markets 12 --max-combinations 4 --experiment quote_start_delay --resolution-labels data/research/r33/report.json
```

The four isolated runs used `quote_start_delay_ms` values `0`, `5000`, `15000`, and `30000`. Each saw 12 markets, 11 complete markets, and 1,406,579 replayed CLOB events. All four produced zero simulated fills and zero simulated settlement PnL.

The rejection profile was identical across delays: `trade_not_eligible:no_working_sell_order=15503`, `trade_skipped:no_working_order=14698`, `trade_skipped:taker_side_not_sell=805`, `trade_rejected:not_eligible=42`, and `quote_cancelled:pair_cost_gate=4`. The delay parameter is therefore not identified by this sample and is not a production tuning lever. The next experiment must address why eligible working sell orders are absent and separately measure one-sided exposure before selecting defaults.

Raw result: `data/research/r33/r29-quote-delay-followup-20260915.json`.
