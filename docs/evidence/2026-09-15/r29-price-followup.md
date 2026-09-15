# R29 Price Mode Follow-up

The 12-market replay compared the observed-price mode with the `force_order` upper-bound mode under the same order size, pair cap, queue factor, inventory limit, fee rate, and 15-second quote delay.

| Mode | Candidate fills | Official settlement PnL | Worst-case PnL |
|---|---:|---:|---:|
| observed | 0 | `$0.00` | `$0.00` |
| force_order | 19 | `+$2.86` | `+$2.86` |

The strict-pair strategy had 7 fills and `-$11.58` in the force-order run; the calibrated strategy had 31 fills and `+$1.95`. The positive result is an upper bound because `force_order` supplies an order direction that the observed public activity does not establish. It is not a production result or a reason to loosen live gates. The evidence points to the availability and interpretation of working sell-side orders as the next research target.

Raw result: `data/research/r33/r29-price-followup-20260915.json`.
