# Long paper run started: 2026-09-13

## Runtime

- Node: Dublin `34.242.206.196`
- First attempt: `20260913-145826-5db77ca89e57` (failed before engine start because it reused an unreconciled wallet-keyed paper ledger)
- Active run: `20260913-150541-624a3c0c16f2`
- Mode: `paper`
- Config revision: `2`
- Started: `2026-09-13T15:05:41Z` (server API timestamp)
- Duration: `0` (manual stop; no automatic time limit)
- `order_usd`: `1.00`
- `max_total_usd`: `10.00` (paper-only submitted notional cap)
- `max_orders`: `20`
- `maker_life_sec`: `15`
- `pair_cost_max`: `0.99`
- `defensive_cancel_bps`: `20`
- `decision_interval_ms`: `0`
- Live unlock: `false`

## Why this run exists

The run is a controlled paper/shadow observation window for collecting real
market-feed behavior and order lifecycle fields (`order_submit`, `order_ack`,
`cancel_requested`, `cancel_ack`, `trade_at_exchange_unix`, and
`matched_price`). It is not a real-money test and does not establish wallet
profit, real queue position, reward eligibility, or settlement correctness.

## What historical data can already prove

- Replay and regression behavior, parser correctness, strategy determinism,
  risk limits, persistence, and failure recovery.
- Official outcome labeling and cost-accounting transformations where the
  source and version are recorded.
- Candidate ranking under explicitly stated conservative, neutral, and stress
  fill assumptions.

## What still requires live/provider evidence

- A provider-owned (or independently authoritative) account cut with one
  immutable token covering opening/current collateral, positions, cash-flow
  completeness, and liquidation valuation. The official SDK endpoints are
  separate resources and do not provide this token.
- Real authenticated maker order lifecycle evidence on a third independent
  date, including exchange timestamps and matched prices. Paper events do not
  prove exchange queue placement or fills.
- A persisted Beijing-day opening equity baseline and a reconciled current cut;
  without both, the live gate remains fail-closed.

## Stop/advance rules

The paper run may be stopped after the lifecycle sample is sufficient for the
pre-registered report, or earlier for a reproducible fault. A fixed number of
calendar days is not itself a gate. The next phase advances only when the
evidence above is present and independently reviewed; otherwise the run is
continued or the missing source is integrated. No paper result is converted
into a production default or live unlock by itself.

The first attempt was retained as a failure artifact. The engine was corrected
to key paper risk state to `default-paper`, independently of the configured
wallet; the active run started successfully after that change and remained
`running=true` at the first 20-second check.
