# EXEC-02: Offline Account Equity Contract

Date: 2026-09-13, Asia/Shanghai.
Status: deterministic accounting core implemented; independent review completed with coercion and historical rehydration fixes applied.
Execution integration: absent. Every view has `execution_ready=false`.

## Owned Files

- `_external/btc-5m-market-trading-bot/src/live/account-equity.ts`
- `_external/btc-5m-market-trading-bot/src/live/account-equity.test.ts`
- This evidence document.

The batch does not change `account-finance`, `orchestrator`, `risk-store`, the
frontend, deployment, credentials, or order submission. It adds no filesystem
or network access and creates no actual orders.

## API

```ts
createAccountEquityState(account, mode): AccountEquityState
reduceAccountEquity(state, event, nowMs, maxAgeMs): {
  state: AccountEquityState;
  view: AccountEquityView;
  applied: boolean;
}
accountEquityView(state, nowMs, maxAgeMs): AccountEquityView
serializeAccountEquityState(state): string
parseAccountEquityState(parsedJson, expectedAccount, expectedMode): AccountEquityState
```

The JSON state binds an account and paper/live mode, schema version, Beijing
risk day, fixed 50,000,000 microdollar capital allocation and 30,000,000
microdollar daily loss limit. Wallet equity can exceed USD 50; this does not
increase the allocation. No order-budget sufficiency decision is exposed.

Events are explicit:

| Event | Required evidence | State transition |
| --- | --- | --- |
| `initialize` | Historical midnight opening snapshot and a fresh current reconciliation in that same Beijing day | Establishes the opening equity, includes pre-existing positions, evaluates current daily PnL |
| `reconcile` | New snapshot linked to the previous snapshot ID, cumulative confirmed external cash-flow coverage, position-release evidence | Updates current equity and PnL without changing the opening baseline |
| `rollover` | Next midnight boundary reconciliation and a fresh current reconciliation for the following day | Closes and retains the prior day, carries the exact boundary positions and cash into the new opening, retains any sticky loss stop |

`maxAgeMs` is an explicit caller policy. Both snapshot age and per-position
valuation age are checked. Historical opening/boundary records are deliberately
historical evidence; their marks must have been current at their own timestamp.
They are never presented as a fresh current account observation.

## Financial Semantics

All amounts are safe integer microdollars. Share quantities use integer
microshares and prices use microdollars per share. Multiplication and summation
use internal `bigint`; each position value is floored to one microdollar rather
than rounding equity upward. Persisted documents contain only JSON values.

```text
equity = collateral cash + sum(quantity * current unit valuation)
daily PnL = current equity - opening equity - deposits + withdrawals
```

Every position in the reconciled account scope is included, including holdings
from earlier markets or days. Allowed valuations are `liquidation_bid` and
`confirmed_payout`; the latter is exactly zero or one dollar per share. Cost
prices are not accepted as valuation methods. Zero quantity contributes zero;
unknown positive quantity or unknown positive-position valuation is rejected.

External flows are only confirmed `deposit` or `withdrawal` records. Trading
cash receipts and verified paid rewards remain part of equity changes and are
not capital-flow adjustments. A flow interval is `(opening.atMs, snapshot.atMs]`.
Thus a transfer exactly at the midnight closing timestamp is reconciled in the
old day, already included in the next opening, and not counted again next day.

The complete current-day flow window must retain every previously accepted flow
in that interval. Identical repeated IDs are idempotent; conflicting payloads
for an existing ID are rejected. A newly discovered flow dated at or before the
last complete reconciliation is rejected instead of silently restating a prior
loss. Such a correction requires a separately designed audited restatement path.

For every position quantity reduction or disappearance, the packet must supply
the exact previous/new quantities and an evidence ID. This prevents an empty
position response from silently removing old holdings during a daily rollover.
The future adapter is responsible for verifying those referenced receipts.

## Failure and Persistence Semantics

- Missing baseline, unknown cash/positions, incomplete coverage, stale marks,
  stale/future snapshots, duplicate IDs, out-of-order sequence/time/link, invalid
  amounts and unrepresentable totals reject the update.
- Rejected events preserve the last reconciled day, holdings, PnL, cash-flow IDs
  and any halt. A persisted reconciliation issue pauses accounting; current
  equity/PnL in the view become `null`, not zero. A later valid new packet may
  clear this transient issue.
- Daily PnL at or below minus USD 30 sets a sticky loss flag. A later mark gain,
  deposit, restart or rollover cannot remove it. No reset/resume method is added
  in this batch; future recovery must be explicit and audited.
- Rollover is atomic within the reducer: if either the boundary or current
  packet fails, no closing day, new baseline or cash-flow mutation is retained.
- The prior day's closing record, exact carried snapshot and loss flags remain
  serializable. Deserialization checks account/mode/schema/limits, day continuity,
  recomputed equity/PnL, cash-flow bounds and loss-stop consistency.
- Strict parsing validates structure and arithmetic, not document authenticity.
  Locking, durable writes, tamper evidence and trusted source verification are
  deliberately outside this deterministic module.

## Validation

| Command, from the engine directory | Result |
| --- | --- |
| `npm test -- --run src/live/account-equity.test.ts src/risk-store.test.ts src/live/account-finance.test.ts` | 3 files; 53 tests passed, including 23 new equity tests |
| `npm run typecheck` | Passed, exit 0 |

Coverage includes pre-existing holdings, USD 50 allocation independent from
wallet equity, deposits/withdrawals, rewards as equity changes, duplicate and
conflicting cash-flow IDs, incomplete and late cash-flow records, evidence-backed
position removal, zero payout, exact loss threshold, monetary precision,
unavailable/stale/future data, sequencing, strict persistence, transient pause
recovery, explicit Beijing rollover and sticky stops across serialization.

## Remaining EXEC-02 Work

Independent review found and the implementation corrected three issues before
integration: JSON array values were previously coerced into the deposit/
withdrawal and valuation enums; historical opening/boundary marks were not
checked at their own cut; and rollover continuity depended on JSON property
ordering. Strict runtime type checks, cut-time mark validation and canonical
snapshot comparison now cover these cases. A multi-day downtime catch-up path
remains outside this reducer and must be designed before resuming after missing
Beijing day boundaries.

This does not complete EXEC-02. The next integration requires an authoritative
cash/position/receipt adapter for a common reconciliation point, independently
verified valuation and settlement semantics, durable account state, and an
atomic reservation manager covering open orders, unknown submission ACKs,
pending fills, fees and cancels. A serialized pre-submission gate must combine
that reservation state with the fixed USD 50 allocation and verified daily loss
state. Display snapshots and cost-based occupancy estimates cannot satisfy that
contract. No live readiness, deployment, three-end synchronization or profit
claim is made by this evidence.
