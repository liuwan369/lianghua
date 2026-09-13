# Account scan and Beijing baseline - 2026-09-14

## Implemented

- `scanConfirmedTransfers` scans confirmed PUSD and USDC `Transfer` logs from an explicit `PM_FINANCE_SCAN_FROM_BLOCK` through the confirmation head in bounded 5,000-block windows.
- Every log is validated for token, transaction hash, block range, both indexed addresses, block hash, confirmation status and `removed`; transfer identity is `transactionHash:logIndex`.
- Missing scan start, invalid ranges, RPC failures, duplicate logs, malformed logs and an unsafe confirmation depth keep the result incomplete. A short-lived reader cache prevents a full backfill on every account poll.
- `AccountFinanceReader` exposes `transfer_scan` and `transfer_range_complete`, but keeps `historical_complete=false` and `reconciliation.complete=false`. A block-range scan alone is not an opening baseline, complete order/trade ledger, or wallet PnL proof.
- Live startup uses the provider-owned atomic bootstrap source for subsequent current refreshes when `PM_ATOMIC_ACCOUNT_URL` is configured. Ordinary CLOB/Data API reads remain non-atomic and cannot unlock live execution.

## Current gate

The production account is not execution-ready. The remaining evidence is a provider-owned immutable opening/current packet for the actual wallet, with complete cash-flow and position-release sections, followed by a Beijing `00:00` boundary packet and a third-date authenticated maker lifecycle probe. No historical block scan is promoted to that contract.

## Verification

- `npm test -- --run src/live/account-finance.test.ts src/live/account-control.test.ts src/live/orchestrator-risk.test.ts`: 21 tests passed.
- `npm run typecheck`: passed.
- No live order was submitted; the live lock remains closed.
