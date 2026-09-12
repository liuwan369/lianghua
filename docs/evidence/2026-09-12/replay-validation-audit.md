# Replay Validation Audit

Date: 2026-09-12

Scope: local replay and parameter-selection scripts only. No production engine,
live controls, or account credentials were changed.

## Findings

1. `pm-r26-historical-shadow-replay.py` currently passes `order_size`,
   `pair_cap`, `max_inventory_imbalance`, and `queue_factor` to all three
   engines. Direct construction checks and `local-r29-corrected-20.json`
   confirm that the corrected run changes the calibrated and candidate
   engines as parameters change. The older `local-r29-safe-sweep-40.json`
   was generated before this correction and remains diagnostic-only.

2. `iter_clob()` still expands every matching event from every SQLite file
   into one Python list and sorts it globally. Its comment says the source is
   bounded, but the implementation is not. A full five-day replay can exceed
   local memory. Future runs must use per-market bounded windows with a
   streaming merge or an external sort.

3. The captured Gamma metadata contains market IDs and token/start/end
   fields, but no resolved winning outcome. The replay can calculate
   `settlement_pnl_if_up_usdc`, `settlement_pnl_if_down_usdc`, and a
   worst-case value, but it cannot calculate realized settlement PnL. The
   worst-case number must not be presented as actual historical profit.

4. Before this audit, risk-sweep ranking sorted only by worst-case PnL. A
   parameter set with zero fills therefore produced zero PnL and could outrank
   every active but losing strategy. The ranking now puts active runs first
   and explicitly records `active_trade_run=true/false`; realized settlement
   is marked unavailable until outcome data is added.

## Local evidence

- `local-r29-corrected-20.json`: corrected parameter injection; inactive
  `.97` runs show zero fills and zero PnL, while active `.99` runs show
  fills and losses.
- `local-r29-safe-sweep-40.json`: stale diagnostic artifact; do not use for
  parameter selection.
- `strategy-test-plan.md`: requires nonzero holdout activity and separate
  realized/worst-case outputs.

## Change

Commit `c3f1520` updates `scripts/pm-r28-risk-sweep.py` to prevent inactive
zero-fill runs from winning selection and to label realized settlement as
unavailable. `tests/test_best_bid_ask_replay.py` passes.

