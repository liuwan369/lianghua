# Paper run status: 2026-09-14

## Current run

- Node: Dublin `34.242.206.196`
- Run ID: `20260914-084336-6831da9cc88c`
- Started: `2026-09-14T08:43:36Z`
- Mode: `paper`
- Live unlock: `false`
- Parameters: `$2` per order, `$1000` paper notional cap, 1000 order cap, 180 minute duration
- Process: running; first post-start check showed 1 quote and 2 simulated maker fills

The previous runs reached their `$10` and then `$50` cumulative submission limits and repeatedly refused quotes. Their process uptime and market count were not valid continuous paper evidence. They were stopped and replaced with this bounded run. The `$1000` cap is a paper-engine turnover limit and does not authorize additional live capital.

## Observation rule

The minimum observation is measured from the current run start: at least two hours plus either ten market windows or twenty valid simulated fills/submissions. A running process without new valid quote/fill events does not satisfy the gate. Latency samples are reported separately from real order ACK latency.

Checkpoint at approximately `2026-09-14 16:51 Asia/Shanghai`: the run was still active with `3` markets, `3` quotes, `6` simulated fills, `$26.51` fill notional, engine PnL `-$0.59`, and no reported error. These are simulated engine figures, not wallet profit.

Checkpoint at `2026-09-14 18:46 Asia/Shanghai`: the same run was still active after about 2 hours 2 minutes, with `26` markets, `26` quotes, `46` simulated fills, `$128.70` fill notional, engine PnL `-$9.96`, and no reported error. The P4 time/sample gate is complete; this is not evidence of live profitability. Next validation is authenticated user-feed confirmation plus stop/recovery reconciliation.

## Historical run distinction

The `2026-09-13` paper-long-run document describes an earlier run that was later stopped. Its elapsed time and results must not be counted as elapsed time for this current run.
