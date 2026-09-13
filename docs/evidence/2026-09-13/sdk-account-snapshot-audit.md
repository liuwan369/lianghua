# Official SDK Account Snapshot Audit

Date: 2026-09-13

## Sources checked

- Official TypeScript SDK: `https://github.com/Polymarket/ts-sdk`
- Account actions: `packages/client/src/actions/account.ts`
- Positions action: `packages/client/src/actions/positions.ts`
- Official CLOB user WebSocket manager: `packages/client/src/websockets/clob/user.ts`

## Finding

The official SDK exposes separate authenticated calls for `/data/orders`,
`/data/trades`, `/balance-allowance`, positions, activity and related pages.
Pagination uses cursors, but the account responses do not expose a shared
cross-resource snapshot token or transaction sequence. The user WebSocket
provides authenticated order/trade events and reconnect handling, but it does
not turn balance, positions and open orders into one atomic cut.

Therefore the official SDK is useful for transport, validation, pagination and
user-event capture, but it cannot by itself satisfy this project's atomic
opening/current account contract. Replacing the current client with the
official SDK would improve API maintenance, not solve the consistency problem.

## Adopted design

1. Keep the ordinary reader explicitly non-atomic.
2. Use the official SDK/user channel where compatible for authenticated order
   and trade lifecycle evidence.
3. Require a provider-owned snapshot endpoint (or an equivalent authoritative
   service) to issue the immutable snapshot token used by the live gate.
4. Fail closed when that source or its cash-flow and liquidation evidence is
   unavailable.

The production adapter is opt-in through `PM_ATOMIC_ACCOUNT_URL`. No live
unlock or real-money action follows from this audit.
