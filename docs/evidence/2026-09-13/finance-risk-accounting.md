# Finance Risk Accounting: Read-Only Contract

Date: 2026-09-13, Asia/Shanghai.
Scope: account-finance/account-data producer and their tests. No strategy,
frontend, order submission, account credentials, deployment, or live trading was changed.

## Delivered

- Preserved `occupancy.complete=false` and `spendable_balance=null`. CLOB
  collateral, open orders and Data API positions are non-atomic observations.
- Added `occupancy.observed` with valid collateral balance, unmatched BUY count,
  position cost/count, combined capital occupancy estimate, capital headroom
  estimate, cash shortfall estimate, source check times and source skew.
- Position cost is the Data API `size * avgPrice` of every positive position
  across all returned markets. Redeemable holdings remain included until a
  separate cash reconciliation confirms their release. Position market value,
  liquidation value, realized profit and future rewards are not substituted for
  cost. Zero-size positions contribute zero without requiring an average price.
- Combined estimated occupation is unmatched open BUY notional plus observed
  position cost. `capital_headroom_estimate_usd = 50 - combined estimate`; a
  negative result remains visible. It is not an executable budget.
- Incomplete/missing positions, duplicate position identities or orders,
  invalid prices/sizes, negative balances and unrepresentable currency amounts
  produce `null` in affected observations. Missing cash is not zero cash;
  known empty positions can still be reported independently of unknown cash.
- Collateral integer base units must be safely representable before conversion
  to USD. The reader refuses malformed, negative or imprecise amounts.
- Added an explicitly read-only `risk_contract` with USD 50 capital, USD 30
  daily loss, `Asia/Shanghai`, `execution_ready=false` and required integration
  prerequisites. It does not assert that an account equity execution gate exists.

## Semantics and Remaining Integration

`estimate_inputs_complete` only means the observed numeric inputs and source
timestamps were valid and their pagination reported complete. It does not mean
the cross-source state is atomic, fresh enough for execution, reconciled to the
execution journal, or safe to submit against. `source_skew_ms` is the difference
between the section completion timestamps, not a guarantee of data indexer age
or first-page observation time.

The following remain explicitly unaccounted: unknown submission acknowledgements,
MATCHED trades awaiting chain confirmation, fills occurring between snapshots,
fees and allowance reservations. These observations must not release a local
in-flight reservation simply because an order disappears from the open-order
endpoint. Available cash remains unknown until those paths are reconciled.

The existing engine realized-PnL daily stop is outside this change. A complete
USD 30 daily account-equity loss contract still needs the risk-day opening
equity, external deposits/withdrawals, pending settlement, verified paid fees
and rewards, and conservative current positions at an agreed timestamp. A
submission gate must combine those with serialized local reservations and must
recheck before any new financial risk. No live enforcement claim is made here.

## Validation

All checks used local source, mocks, or existing unit tests. No network account
read or live action was required.

| Command / check | Result |
| --- | --- |
| Engine: `npm test -- --run src/live/account-finance.test.ts src/live/account-data.test.ts src/live/account-data-reader.test.ts` | 3 files, 27 tests passed |
| Engine: `npm run typecheck` | Passed, exit 0 |
| Root: `python -m pytest tests/test_account_data.py -q` | 5 tests passed |
| Web: `npm test -- --run src/account-data.test.ts` | 16 tests passed |
| Direct producer-to-consumer smoke: generated `balanceOccupancy`/`accountRiskContract` mock payload passed `web/src/api/client.ts::validate('account-data', payload)` using `node --import tsx` | Passed |
| `git diff --check` | Passed; existing LF/CRLF notices only |

The current Python bridge preserves additive producer fields and the frontend
validator accepts them while retaining the original occupancy field shapes.
No frontend control or layout was changed. Consumer schema expansion and a
typed execution-side finance integration remain separate work.

Independent code review approved the read-only scope: 27 engine tests, 23
frontend/account API tests and 44 Python account tests (1 skipped) passed in
the reviewer's checks. Integrated verification also passed; see TESTING.md.
Release synchronization is recorded separately in DEPLOYMENT.md. Live account
equity reconciliation and profitability verification are not completed by this
evidence.

## Deployed Observation

Release `aff7d5378b56` was published on 2026-09-13 and the public account-data
endpoint returned `available=true`, `stale=false`, `read_only=true`, the new
50/30 risk contract and observed occupancy. At source timestamps around
2026-09-12 20:00:41 UTC, reported collateral was USD 120.699416, unmatched BUY
count 0 and 10 position records had combined cost approximately USD 19.99583237.
These are a timestamped account observation, not an atomic balance or realized
PnL. Existing positions must be reconciled when constructing EXEC-02's initial
equity. The larger wallet balance does not increase the user's USD 50 mandate.
`spendable_balance` remains null and `execution_ready` remains false.
