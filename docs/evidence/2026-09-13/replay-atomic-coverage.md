# REPLAY-01: Book Coverage and Message Boundaries

Date: 2026-09-13, Asia/Shanghai.

## Corrected Semantics

- A complete market requires an initial book for each outcome, source and
  receive time coverage at both boundaries (30 second tolerance), and no
  observed per-outcome receive gap above 60 seconds. Trades and deltas without
  an initial book cannot establish usable book coverage.
- Market detail and aggregate PnL eligibility use the same coverage result.
  Excluded market slugs and per-outcome reasons remain in the report.
- Collector compact `price_change` messages may contain several asset IDs and
  have an empty outer token. The replay now routes deltas by their inner asset
  IDs, filters each market window, and preserves the original message boundary.
- All books affected by one message are updated before each affected market
  makes one strategy decision. Independent messages with equal timestamps
  remain independent. This prevents a synthetic taker hedge against an ask
  removed elsewhere in that same message.
- Reports identify `per-token-book-v2` coverage and
  `compact-atomic-message-v2` decoding. Event counts refer to selected source
  messages, not the count after splitting tokens.

## Review and Validation

The first independent coverage review found no blocking regression and
identified the existing dropped multi-token message path. A subsequent review
of the decoder found a HIGH issue: refreshing after only the first token could
execute against the other token's old book. The implementation was revised to
retain whole messages and refresh after all applicable deltas.

Final independent review found no further actionable replay finding. It
identified two issues in the local incremental publisher: a rollback needed to
stop the already-running rejected process before restoring files, and the
combined systemctl check needed to require both units to be active. Both fixes
passed isolated success/rollback tests, including restored process content,
removal of only newly introduced files, and preservation of unrelated risk data.

The regression starts with Down inventory of 10 shares at cost 4. A single
message updates Down and removes the Up ask at 0.50, replacing it with 0.90.
Atomic application produces zero taker hedges and zero Up cost. A control with
the changes in two independent messages permits the hedge after the first
message, even when their timestamps match. This also tests against an incorrect
timestamp-based batch implementation.

Commands executed:

```powershell
python -m pytest -q tests/test_replay_book_coverage.py tests/test_replay_resolution_labels.py tests/test_clob_streaming.py tests/test_best_bid_ask_replay.py
python -m pytest -q
```

Results: 12 focused tests passed; 289 Python tests passed and 1 skipped.
Integrated finance, engine and frontend verification is recorded in TESTING.md.

## Research Status

The original four-configuration 30-market report used the old decoder and
coverage. It is retained as historical evidence in `r29-label-sweep.md`, not as
an input to production parameter promotion. Two intermediate reruns were stopped
when reviews found the decoder and message-boundary issues; incomplete runs are
not reported as strategy results.

The final decoder is being checked with this bounded three-strategy smoke:

```powershell
python scripts/pm-r26-historical-shadow-replay.py --sqlite data/dublin-server/pm-r25-live-days/dublin-evidence-2026-09-10.sqlite3 --history-dir data/research/r33 --out data/research/r33/r26-atomic-12.json --max-markets 12 --order-size 10 --pair-cap 0.97 --queue-factor 0.25 --max-inventory-imbalance 10 --taker-fee-rate 0.07 --resolution-labels data/research/r33/report.json
```

Current decoder checks do not certify production-strategy parity, lossless feed
sequencing, real queue position, account-wide capital reuse or reward income.
The source-time/receive-time boundary checks and gap thresholds describe
observations, not exchange delivery guarantees. Default parameters remain
unpromoted. The next research stage freezes time-grouped datasets and verifies
production decision semantics before expanding the parameter search.

Performance observation: a five-second py-spy sample (149 samples, no errors)
of the corrected local replay concentrated in `quote_prices`/`levels`, which
repeatedly converts and sorts book depth per strategy decision. The bounded
process used roughly 36 MB working set. This is research replay CPU cost, not
measured live order latency; PERF-01 will compare cached/incremental depth views
with identical event decisions before increasing the sweep size.
