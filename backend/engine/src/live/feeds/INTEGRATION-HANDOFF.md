# Market Data Integration Handoff

This document records the handoff from `codex/market-data` to the integration,
trading-runtime, ledger-api, and frontend workstreams. It describes the
contract and checks required to consume a live five-minute feed. It is not a
replacement for the shared API contract.

## Delivered By Market Data

- Polymarket public market WebSocket for the YES and NO assets on one socket.
- Parameterized `{asset}-updown-5m-{roundStart}` discovery and `roundId` handling; BTC remains the backward-compatible default.
- L2 book replication with best bid/ask and top-five bids/asks.
- `book`, `bookStatus`, `tickSize`, and public trade feed events.
- Connection Promise reuse, reconnect backoff with jitter, watchdogs, and stop cancellation.
- Source timestamp watermarks across reconnects and same-frame wire ordering.
- Invalid-frame rejection, empty quote tombstones, source freshness, and expiry handling.
- Multi-market decision queue isolation by `roundId` and YES/NO token pair. Queue
  watermarks reject sequence/source-time regressions, and expired snapshots are
  discarded before a consumer can receive them.
- `bookStatus` carries `marketId`, `roundId`, `yesAssetId`, and `noAssetId`, so
  a disconnected feed cannot invalidate another market's health state.

The implementation is committed on `codex/market-data`. Use `git rev-parse
HEAD` on the branch being integrated; do not copy a stale commit hash from an
older handoff.

## Asset Parameter

`findMarket(now, allowCollectorFallback, directOnly, signal, asset)` keeps the
existing BTC call shape and accepts an optional lowercase platform symbol as
the fifth argument. New integrations may use the clearer equivalent:

```ts
findFiveMinuteMarket("eth", {
  now,
  allowCollectorFallback: false,
  directOnly: true,
  signal,
});
```

The discovery layer validates symbols to letters and digits, accepts only
five-minute Unix boundaries, and filters Gamma and collector results against
the requested asset. It returns `Market.asset` alongside `marketId`,
`roundId`, and the two outcome tokens. The feed itself remains token-based and
can consume any valid binary market returned by discovery.

## Internal Snapshot

The feed emits `FeedEvent` with `kind: "book"` and a `BookSnapshot` containing
these fields:

```text
marketId       venue condition id
roundId        five-minute Unix start boundary as a string
sequence       local monotonic sequence for accepted paired snapshots
sourceAt       newest venue timestamp represented by the pair
expiresAt      earliest of round end and source freshness deadline
YES / NO       normalized asset snapshots
```

Each asset snapshot contains `assetId`, `bid`, `ask`, optional best sizes,
optional sorted five-level `bids` and `asks`, its own `sourceAt`, `expiresAt`,
and the paired `sequence`. Compatibility `up*` and `down*` fields remain in
`BookSnapshot` for the existing platform adapter.

Consumers must use `YES` and `NO` for new code. The frontend adapter may map
them to lowercase `yes` and `no`; it must not create a second quote source.

When multiple markets are active, keep the complete `BookSnapshot` as the one
shared object for strategy and frontend publication. Do not merge by
`event.kind`, token side, or local receive time. The feed queue coalesces only
within the same `roundId` and YES/NO token pair; current and next rounds may be
held concurrently while the runtime decides which round is executable.

## Required Integration Checks

Before a snapshot reaches strategy execution, the integration adapter must:

1. Match `snapshot.marketId` and `snapshot.roundId` with the active market.
2. Require `snapshot.sequence` to be greater than the last accepted sequence for that market and round.
3. Require `snapshot.expiresAt > now` and both YES and NO best prices to be valid.
4. Reject a source timestamp regression on either asset.
5. Treat `bookStatus.healthy === false`, `stale_book`, and `transport_disconnected` as execution gate failures.
6. Publish the accepted snapshot object to both strategy input and the market stream.

The runtime adapter must pass the market identity when starting each feed:
`{ marketId: market.id, roundId: String(market.startsAt) }`. It must preserve
the `YES`/`NO` asset ids and never rebuild a second quote object from the
legacy `up*`/`down*` compatibility fields. A `bookStatus` event is scoped by
its market and token pair; it must not be applied to every active market.

`tsUnix` and local receive time do not make an expired source quote fresh.
`sourceAt`, `expiresAt`, and the two per-asset source timestamps are the
freshness fields.

## Ownership

| Workstream | Owns | Required action |
| --- | --- | --- |
| `codex/market-data` | WebSocket, discovery, order book, quote freshness, multi-market queue semantics | Complete on this branch. Do not add strategy or API logic here. |
| `codex/trading-runtime` | Strategy input, execution gate, order lifecycle | Consume the accepted snapshot, block stale/mismatched rounds, and preserve order idempotency and recovery. |
| `codex/ledger-api` | Shared DTOs, runtime API, ledger projections | Turn the documented DTOs into typed contracts and expose market pool, runtime status, commands, orders, and events. |
| `codex/integration` | Cross-module wiring and deployment | Merge the module branches, add adapters/startup order, and run server end-to-end checks. |
| `codex/frontend-console` | Store and view adapters | Consume market/runtime streams and preserve the last valid snapshot when a source becomes stale. |

The shared contract should live under `shared/contracts`. This handoff file is
kept beside the feed so the integration owner can verify the source behavior
without changing the market-data ownership boundary.

## Integration Wiring

The platform connector should pass market identity when starting the feed:

```ts
runPolymarketFeed(
  sink(market),
  up.tokenId,
  down.tokenId,
  Math.min(feedDeadline, market.endsAt),
  { marketId: market.id, roundId: String(market.startsAt) },
);
```

The server-owned market pool selects the current and next five-minute round
for each enabled asset. At a boundary, the old round stops producing strategy
triggers only after its orders are assigned to the old `roundId`; the next
round becomes eligible only after a fresh bilateral snapshot passes the checks
above.

Runtime commands are asynchronous. The command response only acknowledges
receipt and includes `requestId`; the runtime stream is authoritative for
`starting`, `running`, `paused`, `stopping`, `stopped`, and `error`.

The read-only feed probe accepts `--asset` and defaults to BTC:

```bash
node dist/live/feeds/verify.mjs --asset eth --duration-sec 25 --disconnect-after-sec 8
```

This validates discovery and public quotes for the requested asset only. It
does not enable a strategy or place an order.

## Server Read-Only Verification

Run these commands from `/root/pm-system/backend/engine` after the integration
branch has been built. The probe imports only public discovery and market WS
code; it does not import the order gateway or start a strategy:

```bash
npm ci
npm run build
node dist/live/feeds/verify.mjs --asset btc --duration-sec 25 --disconnect-after-sec 8
node dist/live/feeds/verify.mjs --asset eth --duration-sec 25 --disconnect-after-sec 8
```

Record `DISCOVERY` and `PROBE` for each asset. Acceptance requires a live
`marketId`/`roundId`, paired YES/NO best bid/ask, five-level depth when the venue
provides it, strictly increasing local `sequence`, non-decreasing `sourceAt`,
`expiresAt` at or before the round end, a `recoveryMs` value after the forced
disconnect, and no sequence/source regressions. A missing market or no quotes
is a failed read-only check, not a reason to start trading.

The server process is foreground-only for this check:

```bash
node dist/live/feeds/verify.mjs --asset btc --duration-sec 25 --disconnect-after-sec 8
```

Stop with `Ctrl-C` or `SIGTERM`; do not use `killall node` or stop nginx. Before
starting, record `git status`, the active branch, and existing project PIDs.
Afterward confirm no probe process remains. Do not put credentials in the
command line, output, or repository.

## Verification Order

1. Build the merged integration branch and run the existing engine tests.
2. Run the read-only `market-snapshot` process on the server. Confirm market discovery, WebSocket data, five-level depth, sequence monotonicity, expiry, and round switching.
3. Run the platform in observation mode with no strategy configuration. Confirm that it consumes the snapshot but submits no order.
4. Verify market stream and runtime stream use the same `marketId`, `roundId`, `sequence`, `sourceAt`, and `expiresAt` values.
5. Only after the previous checks pass, schedule a separately approved real-order validation.

## Remaining Risks

- The current server worktree is not the integrated branch. A server checkout or deployment of `codex/integration` is required before testing runtime APIs or order execution.
- The market-data branch can be verified independently on the server, but the
  current platform adapter still needs to pass `marketId`/`roundId` and connect
  the snapshot gate before this feed can drive the trading runtime.
- `FeedQueue` has correct multi-market semantics but is not yet the active
  `platform.publish()` dispatch path. Integration must wire it without making
  historical queries, resource sampling, or synchronous record listeners block
  the feed callback.
- The existing shared contract is still partly documentation. Until typed DTO validation exists, a field rename can silently break one consumer.
- `codex/trading-runtime` must still wire the snapshot gate to the selected strategy and gateway. Parameterized discovery does not make the existing BTC strategy valid for every asset.
- Each asset needs an explicit strategy/reference-feed mapping before automatic trading is enabled. Discovering an ETH or SOL market alone is not evidence that its oracle, outcome order, fee rules, or liquidity are compatible.
- This work has not placed a real order and does not verify fills, cancellation, reconciliation, settlement, or ledger projection.
- Polymarket event formats, venue clocks, Gamma availability, or server network conditions can change. The read-only probe must remain part of deployment verification.
- Each active market currently owns one feed WebSocket. A shared subscription
  registry can reduce connection count later, but it is not required for the
  current correctness checks and must preserve per-market watermarks.
