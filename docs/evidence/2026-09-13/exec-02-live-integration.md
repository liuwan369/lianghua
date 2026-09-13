# EXEC-02 Live Integration Evidence

Date: 2026-09-13

The live path now creates an account/mode isolated `AccountStateStore`, attaches an `AccountExecutionGate` to `Engine`, refreshes from the authenticated account reader before the first market and before each rollover, and attaches the same gate as the executor reservation coordinator. Fresh state is deliberately fail-closed until an authoritative Beijing-day opening baseline has been persisted.

Reservation IDs are retained through exchange ACKs and linked to exchange order IDs. A partial fill advances `partially_filled`, a complete fill advances `settlement_pending`, and final account reconciliation closes all remaining order reservations. A cancellation ACK deliberately leaves its reservation active because a fill may race with cancellation; only authoritative reconciliation may close it. Unknown ACKs remain active and pause submissions until reconciliation, including unknown responses with no order ID.

The account adapter accepts only complete, available collateral and positions Sections from the same wallet with `pagination_atomic=true`. Every position must carry an explicit `valuation: "liquidation_bid"`; an unmarked `curPrice` estimate and the current non-atomic reader output are rejected.

Validation performed:

- `npm test -- --run src/live/account-control.test.ts src/live/account-equity-adapter.test.ts src/live/account-state-store.test.ts src/live/account-reservation.test.ts src/live/executor.test.ts src/live/orchestrator.test.ts` (54 tests passed)
- `npm run typecheck` (passed)

The currently deployed read-only account reader still reports `pagination_atomic=false` and provides no verified liquidation-bid/as-of evidence. Therefore it is intentionally rejected by the adapter; a fresh live run has no supported bootstrap path and remains fail-closed until an atomic account source and a persisted Beijing-day opening baseline are supplied. No live connection or real-money submission was started. The runtime continues to require explicit `live=true`, an owner signer, a persisted authoritative day baseline, and the existing 50 USD capital / 30 USD daily-loss limits.

Follow-up hardening added an explicit `AuthoritativeOpeningReader` contract for a provider-owned opening/current cut. Both cuts must carry their own `checked_at`; the reconciliation packet must include a validated cash-flow window and position-release evidence. Ordinary account reads without that evidence are rejected instead of treating transfers as an empty window. The opening cut is allowed to be historical within the current Beijing risk day, while the current cut remains subject to freshness checks. Live startup now creates an empty fail-closed state when needed and reports the missing opening baseline explicitly; only an injected authoritative bootstrap reader can initialize it.

The async reconciliation path checks that the latest persisted equity cut is unchanged before writing and merges the latest reservation envelope, preventing a delayed account response from overwriting a reservation or a concurrent reconciliation. A delayed-reader regression confirms a reservation created during reconciliation survives the account write. Validation: 52 related Vitest tests and `npm run typecheck`/`npm run build` passed.

The ordinary `connectAccountReader` remains explicitly non-atomic. A separate opt-in `connectAtomicAccountReader` / `connectAuthoritativeOpeningReader` now validates a provider-owned bootstrap packet: wallet binding, immutable per-cut tokens, section token consistency, complete collateral and positions, liquidation-bid valuation, and a complete cash-flow window. It is used by live startup only when `PM_ATOMIC_ACCOUNT_URL` is configured; otherwise startup continues to fail closed. The provider endpoint is not deployed or configured in the current environment, so this code change does not unlock live trading. The new adapter and existing account/equity suites pass 37 tests with typecheck passing.
