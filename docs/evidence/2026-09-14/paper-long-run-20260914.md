# Paper run status: 2026-09-14

## Current run

- Node: Dublin `34.242.206.196`
- Run ID: `20260914-065212-1b45f5670a9c`
- Started: `2026-09-14T06:52:12Z`
- Mode: `paper`
- Live unlock: `false`
- Parameters: `$2` per order, `$50` paper notional cap, 200 order cap, 180 minute duration
- Process: running; first post-start check showed 1 quote and 1 simulated maker fill (`2026-09-14T06:52:xxZ`)

The previous run reached its `$10` cumulative submission limit (`spent $9.94`) and then repeatedly refused quotes. Its process uptime and market count were not valid continuous paper evidence. It was stopped and replaced with this bounded run. The `$50` cap is a paper-engine limit and does not authorize additional live capital.

## Observation rule

The minimum observation is measured from the current run start: at least two hours plus either ten market windows or twenty valid simulated fills/submissions. A running process without new valid quote/fill events does not satisfy the gate. Latency samples are reported separately from real order ACK latency.

## Historical run distinction

The `2026-09-13` paper-long-run document describes an earlier run that was later stopped. Its elapsed time and results must not be counted as elapsed time for this current run.
