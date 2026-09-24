import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClobMarketProjection, publishSnapshot, readPublishedSnapshot, stalePublishedSnapshot }
  from "../../dist/dashboard/market-projection.js";

const ROUND = 1_800_000_000;
const NOW = ROUND + 100;
const levels = (base, size) => Array.from({ length: 5 }, (_, index) => [base + index * 0.001, size + index]);

function quote(sequence = 1, sourceAt = NOW - 0.05) {
  const expiresAt = NOW + 2;
  return {
    source: "polymarket-ws",
    marketId: "condition-btc-5m",
    roundId: String(ROUND),
    sequence,
    sourceAt,
    expiresAt,
    tsUnix: NOW,
    receivedAtUnix: NOW,
    YES: { assetId: "yes-token", bid: 0.41, ask: 0.42, bidSize: 12, askSize: 13,
      bids: levels(0.41, 12), asks: levels(0.42, 13), sourceAt, expiresAt, sequence },
    NO: { assetId: "no-token", bid: 0.57, ask: 0.58, bidSize: 14, askSize: 15,
      bids: levels(0.57, 14), asks: levels(0.58, 15), sourceAt, expiresAt, sequence },
    // Intentionally disagree with YES/NO: compatibility output must derive from canonical fields.
    upBid: 0.9, upAsk: 0.91, downBid: 0.08, downAsk: 0.09,
  };
}

function projection() {
  return new ClobMarketProjection({ upToken: "yes-token", downToken: "no-token",
    conditionId: "condition-btc-5m", start: ROUND, end: ROUND + 300, staleAfterMs: 1_000 });
}

test("collector JSON preserves the canonical paired snapshot and disables strategy eligibility", t => {
  const value = projection();
  const accepted = quote();
  assert.equal(value.applySnapshot(accepted, NOW), true);
  const output = value.snapshot(NOW);
  assert.equal(output.collector_online, true);
  assert.equal(output.strategyEligible, false);
  assert.equal(output.current_markets[0].healthy, true);
  assert.equal(output.current_markets[0].strategyEligible, false);
  assert.deepEqual(output.current_markets[0].snapshot, {
    marketId: accepted.marketId,
    roundId: accepted.roundId,
    sequence: accepted.sequence,
    sourceAt: accepted.sourceAt,
    expiresAt: accepted.expiresAt,
    YES: accepted.YES,
    NO: accepted.NO,
  });
  assert.equal(output.current_markets[0].up_bid, accepted.YES.bid);
  assert.equal(output.current_markets[0].down_bid, accepted.NO.bid);
  assert.equal(output.current_markets[0].book_depth_ready, true);

  const dir = mkdtempSync(join(tmpdir(), "market-projection-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "market-snapshot.json");
  publishSnapshot(path, output);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(persisted.current_markets[0].snapshot, output.current_markets[0].snapshot);
  assert.equal(persisted.current_markets[0].healthy, true);
  assert.equal(persisted.current_markets[0].strategyEligible, false);

  const restored = readPublishedSnapshot(path);
  assert.ok(restored);
  const stale = stalePublishedSnapshot(restored, NOW + 10, "Collector restarted");
  assert.equal(stale.collector_online, false);
  assert.equal(stale.collector_connected, false);
  assert.equal(stale.current_markets[0].healthy, false);
  assert.equal(stale.current_markets[0].quote_fresh, false);
  assert.deepEqual(stale.current_markets[0].snapshot, output.current_markets[0].snapshot);
});

test("expiry and disconnect retain the accepted snapshot unchanged but mark it unhealthy", () => {
  const value = projection();
  const accepted = quote();
  assert.equal(value.applySnapshot(accepted, NOW), true);

  const expired = value.snapshot(accepted.expiresAt + 1);
  assert.equal(expired.collector_online, false);
  assert.equal(expired.current_markets[0].healthy, false);
  assert.deepEqual(expired.current_markets[0].snapshot, {
    marketId: accepted.marketId,
    roundId: accepted.roundId,
    sequence: accepted.sequence,
    sourceAt: accepted.sourceAt,
    expiresAt: accepted.expiresAt,
    YES: accepted.YES,
    NO: accepted.NO,
  });

  value.disconnect();
  const disconnected = value.snapshot(NOW + 0.1);
  assert.equal(disconnected.collector_online, false);
  assert.equal(disconnected.collector_connected, false);
  assert.equal(disconnected.current_markets[0].healthy, false);
  assert.equal(disconnected.current_markets[0].snapshot.sourceAt, accepted.sourceAt);
  assert.equal(disconnected.current_markets[0].snapshot.expiresAt, accepted.expiresAt);
});

test("reconnect stays unhealthy until a newer complete pair arrives and rejects old sequence", () => {
  const value = projection();
  const accepted = quote(7);
  assert.equal(value.applySnapshot(accepted, NOW), true);
  value.disconnect();
  value.markConnected(true);
  assert.equal(value.snapshot(NOW + 0.1).current_markets[0].healthy, false);
  assert.equal(value.applySnapshot(quote(6, NOW + 0.01), NOW + 0.02), false);
  assert.equal(value.snapshot(NOW + 0.1).current_markets[0].snapshot.sequence, 7);
  assert.equal(value.applySnapshot(quote(8, NOW + 0.02), NOW + 0.03), true);
  const recovered = value.snapshot(NOW + 0.03);
  assert.equal(recovered.collector_online, true);
  assert.equal(recovered.current_markets[0].healthy, true);
  assert.equal(recovered.current_markets[0].snapshot.sequence, 8);
});

test("rejects outcome token mismatch and requires five levels on all four sides", () => {
  const value = projection();
  const wrongTokens = quote();
  wrongTokens.YES.assetId = "different-yes-token";
  assert.equal(value.applySnapshot(wrongTokens, NOW), false);
  assert.equal(value.snapshot(NOW).current_markets.length, 0);

  const fourLevels = quote();
  fourLevels.YES.bids = fourLevels.YES.bids.slice(0, 4);
  assert.equal(value.applySnapshot(fourLevels, NOW), true);
  assert.equal(value.snapshot(NOW).current_markets[0].book_depth_ready, false);
});

test("incomplete paired frames are rejected without throwing", () => {
  const value = projection();
  assert.equal(value.applySnapshot({ ...quote(), NO: undefined }, NOW), false);
  assert.equal(value.applySnapshot({ ...quote(), YES: undefined }, NOW), false);
  assert.equal(value.snapshot(NOW).current_markets.length, 0);
});
