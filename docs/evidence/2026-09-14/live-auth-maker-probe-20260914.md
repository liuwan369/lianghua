# Real Authenticated Maker Probe

The Dublin account completed a bounded real CLOB lifecycle probe on 2026-09-14. The order used 5 shares at `0.01` for `$0.05` notional. The exchange returned a live order ACK, the targeted cancel returned a confirmed cancel ACK, the authenticated user feed delivered the cancellation event, no fill was observed, and the final open-order query was empty.

The probe proves credentialed signing and the submit/cancel path. It does not unlock the full engine: the initial user-feed subscription confirmation was not observed within five seconds, and the provider-owned atomic account source is still absent. The full engine remains paper/stopped with `live_unlocked=false`.
