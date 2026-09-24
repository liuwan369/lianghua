import { strict as assert } from "node:assert";
import { isSnapshotFreshAfter, validateMarketSnapshot, type SnapshotGateIdentity, type SnapshotGateResult } from "./snapshot-gate.js";
import type { MarketBookSnapshot } from "./contracts.js";

const identity: SnapshotGateIdentity = {
  assetId: "btc", marketId: "market-1", roundId: "1000", endsAt: 1300,
  yesAssetId: "yes-1", noAssetId: "no-1",
};

function snapshot(overrides: Partial<MarketBookSnapshot> = {}): MarketBookSnapshot {
  return {
    marketId: "market-1", roundId: "1000", sequence: 1, sourceAt: 1001, expiresAt: 1100, tsUnix: 1001,
    YES: { assetId: "yes-1", bid: 0.4, ask: 0.5, sourceAt: 1001, expiresAt: 1100, sequence: 1 },
    NO: { assetId: "no-1", bid: 0.4, ask: 0.5, sourceAt: 1001, expiresAt: 1100, sequence: 1 },
    ...overrides,
  };
}

function rejectReason(result: SnapshotGateResult): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected snapshot rejection");
  return result.reason;
}

const first = validateMarketSnapshot(snapshot(), identity, undefined, 1002, true);
assert.equal(first.ok, true, "a complete healthy paired snapshot is accepted");
assert.equal(snapshot().assetId, undefined, "the actual feed shape has no underlying asset symbol");
assert.equal(rejectReason(validateMarketSnapshot(snapshot({ assetId: "eth" }), identity, undefined, 1002, true)),
  "asset_id_mismatch", "an explicit conflicting symbol cannot be rebound to BTC");
if (!first.ok) throw new Error("baseline snapshot rejected");

assert.equal(rejectReason(validateMarketSnapshot(snapshot({ marketId: "other-market" }), identity, undefined, 1002, true)),
  "market_id_mismatch");
assert.equal(rejectReason(validateMarketSnapshot(snapshot({ roundId: "1300" }), identity, undefined, 1002, true)),
  "round_id_mismatch");
assert.equal(rejectReason(validateMarketSnapshot(snapshot(), identity, first.watermark, 1002, true)),
  "sequence_regression");
assert.equal(rejectReason(validateMarketSnapshot(snapshot({ sequence: 2, sourceAt: 1000,
  YES: { assetId: "yes-1", bid: 0.4, ask: 0.5, sourceAt: 1000, expiresAt: 1100, sequence: 2 },
  NO: { assetId: "no-1", bid: 0.4, ask: 0.5, sourceAt: 1001, expiresAt: 1100, sequence: 2 },
}), identity, first.watermark, 1002, true)), "source_at_regression");
assert.equal(rejectReason(validateMarketSnapshot(snapshot({ expiresAt: 1002,
  YES: { assetId: "yes-1", bid: 0.4, ask: 0.5, sourceAt: 1001, expiresAt: 1002, sequence: 1 },
  NO: { assetId: "no-1", bid: 0.4, ask: 0.5, sourceAt: 1001, expiresAt: 1002, sequence: 1 },
}), identity, undefined, 1002, true)), "expired_snapshot");
assert.equal(rejectReason(validateMarketSnapshot(snapshot({ YES: {
  assetId: "yes-1", bid: 0.4, ask: 0.5, sourceAt: 1001, expiresAt: 1100, sequence: 1,
  depthSourceAt: 1000, depthExpiresAt: 1001, bids: [[0.4, 1]], asks: [[0.5, 1]],
} }), identity, undefined, 1002, true)), "invalid_yes_quote", "expired L2 depth cannot be consumed");
assert.equal(rejectReason(validateMarketSnapshot(snapshot({ expiresAt: 1001, receivedAtUnix: 1002 }),
  identity, undefined, 1002, true)), "expired_snapshot", "local receive time cannot refresh an expired venue book");
assert.equal(rejectReason(validateMarketSnapshot(snapshot({ YES: { assetId: "yes-1", bid: 0.8, ask: 0.7,
  sourceAt: 1001, expiresAt: 1100, sequence: 1 } }), identity, undefined, 1002, true)),
  "invalid_yes_quote");
assert.equal(rejectReason(validateMarketSnapshot(snapshot(), identity, undefined, 1002, false)), "book_unhealthy");
assert.equal(isSnapshotFreshAfter(snapshot({ receivedAtUnix: 999 }), 1000), false,
  "a frame received before disconnect cannot resume execution");
assert.equal(isSnapshotFreshAfter(snapshot({ receivedAtUnix: 1000 }), 1000), true,
  "a frame received after disconnect status can rebuild the pair");
assert.equal(isSnapshotFreshAfter(snapshot(), 1000), false,
  "a reconnect frame without receive evidence is not trusted");
assert.equal(validateMarketSnapshot(snapshot({ roundId: "1300" }),
  { ...identity, roundId: "1300", endsAt: 1600 }, undefined, 1002, true).ok, true,
  "the next round has an independent identity and watermark");
assert.equal(validateMarketSnapshot({ ...snapshot({ marketId: "market-2", YES: {
  assetId: "yes-2", bid: 0.4, ask: 0.5, sourceAt: 1001, expiresAt: 1100, sequence: 1,
}, NO: { assetId: "no-2", bid: 0.4, ask: 0.5, sourceAt: 1001, expiresAt: 1100, sequence: 1 } }),
}, { ...identity, marketId: "market-2", yesAssetId: "yes-2", noAssetId: "no-2" }, undefined, 1002, true).ok, true,
  "a second market has an independent sequence watermark");

console.log("snapshot-gate.test: PASS");
