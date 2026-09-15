# Real Authenticated Maker Probe

The Dublin account completed two bounded real CLOB lifecycle probes on 2026-09-15. The second order used 5 shares at `0.01` for `$0.05` notional. The exchange returned a live order ACK, the targeted cancel returned a confirmed cancel ACK, the authenticated user feed became ready from a target-market event, the feed delivered the cancellation event, no fill was observed, the final open-order query was empty, and the collateral balance delta was zero.

This proves the authenticated user-channel evidence path used by the live orchestrator. It does not unlock the full engine. The engine remains stopped in paper mode with `live_unlocked=false` until the stop/recovery reconciliation is completed and the candidate strategy passes its loss diagnosis.

Raw server outputs: `live-auth-maker-probe-20260915.log` and `live-auth-maker-probe-20260915-r2.log`.
