# Dublin Measurement and Replay Parameter Audit

Measurement date: 2026-09-12. No new orders, cancellations, transfers, or account
configuration changes were performed. All network probes ran on Dublin; log
aggregation was read-only. Replay/production parameters were not changed.

## Provenance

- Source checkout: `851f782344ce0ce83bf684483d2942e5cb54adad`.
- Public probe: `_external/btc-5m-market-trading-bot/scripts/latency-probe.mjs`.
- Probe SHA256: `4B1345B8B5AFFEDAB6AD9D1B676D3130F1D3F4E0B2DF20A993F042A43A59490B`.
- Host: `ip-172-26-5-249`, Dublin. No local-PC network timing is presented as Dublin timing.
- `dublin-public-latency.json`: new public API/WS measurements, 90 seconds.
- `dublin-journal-latency.json`: summary of existing server journals, separating
  explicitly tagged live, paper, and unknown records. Tagging is not independent
  proof of transaction execution. The old deployed source revision is not verified.

## Observations

| Metric | Samples | Median ms | P95 ms | P99 ms | Meaning |
|---|---:|---:|---:|---:|---|
| Public CLOB `/time` RTT | 30 | 25.90 | 31.77 | 40.42 | New GET request round trips, not order submission |
| WS event age, steady period | 27,144 | 8 | 16 | 130 | New receive time minus exchange event timestamp |
| Historical book processing, live-tagged | 1,929 | 0.027254 | 0.076222 | 0.171868 | Local handling only |
| Historical strategy computation, live-tagged | 1,988 | 0.089395 | 0.233760 | 2.269484 | Engine call, not network or fill waiting |

Dublin chrony reported synchronized, local-minus-NTP offset approximately
0.00003 ms during the first probe. This does not prove the exchange clock has
the same accuracy. Event age includes publication/batching delay as well as
transport; it is not pure one-way network latency. Thousands of messages in
90 seconds are correlated and do not establish multi-day reliability.

Historical live-tagged samples cover only about 11.19 seconds. Maximum book
processing time was 67.55 ms and maximum engine computation time 121.67 ms.
There are no order sign/ACK/cancel/fill-report/reaction timing records in the
scanned journals. The separate `live-order-cancel-acceptance.json` records one
historical order ACK at 148.536 ms; that is not a latency distribution.

The old `market_age` implementation subtracts the newer of the two token
timestamps. Its values must not be substituted for paired-book freshness.

## Parameter Classification

| Parameter | Source | Classification / replay use |
|---|---|---|
| Public WS event age | New Dublin probe | Measured snapshot; keep separate from processing and REST |
| Book processing / decision compute | Existing Dublin journal | Historical short sample; no current full-path certification |
| Order ACK 148.536 ms | Historical acceptance artifact | Single sample only; order visibility timing unknown |
| Order activation 250 ms | Python shadow default | Assumption, not calibrated by public RTT |
| Queue factors 0.25 / 0.50 | Python sweep | Assumptions; require own-order fill evidence |
| Queue conservatism 1.5 / probability thresholds 0.05 and 0.50 | TS Engine defaults | Model choices, not measured exchange probabilities |
| Maker order lifetime 15 seconds | TS Engine default | Strategy choice, not cancellation transport speed |
| Decision intervals 1 second | TS stable config inheritance | Scheduling choice, not measured compute time |
| Unhedged threshold 30 seconds | TS targetClone inheritance | Strategy choice, not measured hedge completion time |
| Python hedge delay 10 / 15 seconds | Replay presets | Strategy choices distinct from TS and transport |
| Cancel confirmation / fill report / complete hedge duration | No timing samples found | Unmeasured; null, never zero |
| Fees / slippage / fill probability | Needs execution and account records | Cannot derive from public endpoint RTT |

## Replay Treatment

These observations support separate empirical timing scenarios, not a certified
single execution delay. Do not add standalone P95 values and call the sum an
end-to-end P95. Do not infer complete hedge latency from a REST GET or an ACK.
Do not apply public-feed delay again to replay events already timestamped at
collector receipt. Transaction matching, empirical distributions, and active
strategy workload coverage remain necessary before a full execution calibration.

The probe's static `api_region` field is not a fresh verification of platform
trading eligibility and is not used here to authorize trading.
