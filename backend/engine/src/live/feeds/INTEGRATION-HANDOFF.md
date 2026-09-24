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

The implementation is committed on `codex/market-data`. The latest cleanup
commit audited for this handoff is `f778943`; use `git rev-parse HEAD` on the
branch being integrated instead of copying a stale hash from this document.

As of this handoff, `codex/trading-runtime` has already added the identity-aware
feed start, bounded `FeedQueue` consumer, and snapshot execution gate. Its
latest local branch commit is `bcb78cd`. The branches are still separate, so a
production deployment must combine the latest market-data and trading-runtime
commits through `codex/integration`.

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
the requested asset. The returned discovery `Market` contains `conditionId`,
`roundId`, `upToken`, `downToken`, `start`, and `end`; it does not contain a
field literally named `marketId`. The trading-runtime adapter maps
`conditionId -> MarketInfo.id` and `start -> MarketInfo.startsAt`, then passes
that identity into the feed. The feed itself remains token-based and can
consume any valid binary market returned by discovery.

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

The canonical mapping is `upToken -> YES` and `downToken -> NO`. The pair has
two asset identities (`YES.assetId` and `NO.assetId`); there is no separate
top-level `assetId` for a bilateral snapshot. Control-plane and frontend DTOs
should expose the same pair as `yesToken`/`noToken` or nested `YES`/`NO`, without
inventing a third quote source. `best_bid_ask` events may update best prices
before matching L2 depth arrives, so five-level arrays are optional on a
snapshot even though the live venue normally supplies them.

The actual field sources and ownership boundaries are:

| Field | Produced from | Boundary and validation |
| --- | --- | --- |
| `marketId` | Gamma/collector `conditionId`, or an explicit feed identity | The runtime must pass `MarketInfo.id`; late WS inference is a compatibility fallback only. |
| `roundId` | Slug Unix start boundary (`{asset}-updown-5m-{roundStart}`) | A decimal string divisible by 300; runtime requires it to equal `String(startsAt)`. |
| `YES.assetId` / `NO.assetId` | Discovery `upToken` / `downToken` | Token ids must match the active market instruments; they are not interchangeable with another round. |
| `sequence` | Local counter for accepted paired snapshots in one feed | Strictly increases within a feed; the queue and runtime gate reject duplicates and regressions. A full feed restart starts a new counter and must use a new market key or a fresh runtime generation. |
| `sourceAt` | Newest accepted venue timestamp across YES and NO | Per-side `sourceAt` values are retained; regressions are rejected. `expiresAt` uses the older side, so a newer `sourceAt` does not make the pair fresher than its older quote. |
| `expiresAt` | `min(feed deadline, older sourceAt + 2 seconds)` | The runtime requires `expiresAt > now`; round end is also enforced from `roundId`/`MarketInfo.endsAt`. |

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
`{ marketId: market.id, roundId: String(market.startsAt) }`. In this example
`market` is the platform adapter's internal `MarketInfo`, whose `id` and
`startsAt` fields are derived from discovery's `conditionId` and `start`; it is
not the `Market` object returned directly by `findFiveMinuteMarket`. It must preserve
the `YES`/`NO` asset ids and never rebuild a second quote object from the
legacy `up*`/`down*` compatibility fields. A `bookStatus` event is scoped by
its market and token pair; it must not be applied to every active market.

The feed identity argument is optional for backward compatibility, but the
production runtime must always provide it. If it is omitted, `roundId` may be
inferred from the deadline and `marketId` may remain undefined until a venue
frame carries a market id; that path is not sufficient for an execution gate.

`tsUnix` and local receive time do not make an expired source quote fresh.
`sourceAt`, `expiresAt`, and the two per-asset source timestamps are the
freshness fields.

## Ownership

| Workstream | Owns | Required action |
| --- | --- | --- |
| `codex/market-data` | WebSocket, discovery, order book, quote freshness, multi-market queue semantics | Complete on this branch. Do not add strategy or API logic here. |
| `codex/trading-runtime` | Strategy input, execution gate, order lifecycle | Identity-aware feed start, bounded queue consumption, snapshot freshness gate, and order idempotency/recovery are implemented on its current branch; recheck them after merge. |
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

The current trading-runtime implementation follows this wiring and routes feed
events through `FeedQueue` before calling its snapshot gate. The feed callback
only performs the bounded queue push; strategy, persistence, account reads,
and HTTP work run in the consumer. The ledger/API layer must consume the
accepted runtime `book` event or the identical market-stream snapshot, not
subscribe to the raw Polymarket socket or rebuild a quote from legacy fields.

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
node src/live/feeds/verify.mjs --asset eth --duration-sec 25 --disconnect-after-sec 8
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
node src/live/feeds/verify.mjs --asset btc --duration-sec 25 --disconnect-after-sec 8
node src/live/feeds/verify.mjs --asset eth --duration-sec 25 --disconnect-after-sec 8
```

Record `DISCOVERY` and `PROBE` for each asset. Acceptance requires a live
`marketId`/`roundId`, paired YES/NO best bid/ask, five-level depth when the venue
provides it, strictly increasing local `sequence`, non-decreasing `sourceAt`,
`expiresAt` at or before the round end, a `recoveryMs` value after the forced
disconnect, and no sequence/source regressions. A missing market or no quotes
is a failed read-only check, not a reason to start trading.

The server process is foreground-only for this check:

```bash
node src/live/feeds/verify.mjs --asset btc --duration-sec 25 --disconnect-after-sec 8
```

Stop with `Ctrl-C` or `SIGTERM`; do not use `killall node` or stop nginx. Before
starting, record `git status`, the active branch, and existing project PIDs.
Afterward confirm no probe process remains. Do not put credentials in the
command line, output, or repository.

Latest post-cleanup read-only server result (34.242.206.196, 2026-09-24, no
strategy or order process):

| Asset | Snapshots | Five levels | Recovery | Processing P50 / P99 | Regressions |
| --- | ---: | --- | ---: | ---: | --- |
| BTC | 495 | YES + NO | 74 ms | 0.0125 / 0.2432 ms | sequence 0, source 0 |

Previous ETH parameterization check (2026-09-23) remains valid: 205 paired
snapshots, YES + NO five-level depth, 261 ms recovery, 0.042 / 0.411 ms
processing P50/P99, and zero sequence/source regressions.

The raw-frame check also observed `book`, `price_changes`, and
`best_bid_ask` events on the server. A first short BTC run started at a round
boundary and ended before a complete baseline arrived; the repeated run passed.
For deployment verification, run the probe at least 25 seconds and treat a
zero-snapshot result as inconclusive only when the log shows a round boundary;
repeat it and investigate any repeated zero-snapshot result.

## Verification Order

1. Build the merged integration branch and run the existing engine tests.
2. Run the read-only feed probe on the server. Confirm market discovery, WebSocket data, five-level depth when supplied, sequence monotonicity, expiry, and round switching.
3. Run the platform in observation mode with no strategy configuration. Confirm that it consumes the snapshot but submits no order.
4. Verify market stream and runtime stream use the same `marketId`, `roundId`, `sequence`, `sourceAt`, and `expiresAt` values.
5. Only after the previous checks pass, schedule a separately approved real-order validation.

## Remaining Risks

- The current server worktree is not the integrated branch. A server checkout or deployment of `codex/integration` is required before testing runtime APIs or order execution.
- The trading-runtime branch now passes `marketId`/`roundId`, consumes through
  `FeedQueue`, and applies the snapshot gate. This is not yet proof that the
  merged production branch preserves the same wiring; integration must verify
  the combined checkout before enabling execution.
- The accepted runtime snapshot and the control-plane market stream still need
  one end-to-end identity check. The API must forward the exact accepted object
  or a lossless DTO carrying the same marketId, roundId, sequence, sourceAt,
  expiresAt, YES, and NO values.
- The existing shared contract is still partly documentation. Until typed DTO validation exists, a field rename can silently break one consumer.
- The current strategy and `discoverBtcMarket` path are still BTC-specific. Parameterized discovery and an ETH/SOL feed do not authorize trading another asset until its strategy, reference feed, outcome mapping, fee rules, and liquidity checks are explicitly wired.
- Each asset needs an explicit strategy/reference-feed mapping before automatic trading is enabled. Discovering an ETH or SOL market alone is not evidence that its oracle, outcome order, fee rules, or liquidity are compatible.
- A manual feed restart inside one running runtime can reset the feed-local sequence. The runtime should clear or version its snapshot watermark when deliberately restarting the same market; ordinary reconnects preserve watermarks and do not have this issue.
- This work has not placed a real order and does not verify fills, cancellation, reconciliation, settlement, or ledger projection.
- Polymarket event formats, venue clocks, Gamma availability, or server network conditions can change. The read-only probe must remain part of deployment verification.
- Each active market currently owns one feed WebSocket. A shared subscription
  registry can reduce connection count later, but it is not required for the
  current correctness checks and must preserve per-market watermarks.
