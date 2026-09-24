import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClobMarketProjection, publishSnapshot } from "../../dist/dashboard/market-projection.js";
import { parseMarketSnapshotOptions, runMarketSnapshot } from "../../dist/cli/market-snapshot.js";

const OLD_ROUND = 1_800_000_000;

test("asset list rejects empty entries", () => {
  assert.throws(() => parseMarketSnapshotOptions(["--assets", ","]), /comma-separated assets/);
  assert.throws(() => parseMarketSnapshotOptions(["--assets", "btc,,eth"]), /comma-separated assets/);
});

test("slow asset discovery does not delay a resolved asset feed", async t => {
  const dir = mkdtempSync(join(tmpdir(), "market-discovery-isolation-"));
  const controller = new AbortController();
  const started = [];
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const running = runMarketSnapshot({ assets: ["btc", "eth"], output: join(dir, "snapshot.json"),
    durationSec: 0, staleAfterMs: 250, publishMs: 5, discoveryMs: 1000 }, {
    now: () => OLD_ROUND + 100,
    discover: async (_at, _direct, _signal, asset) => {
      if (asset === "eth") await slow;
      return { asset, slug: `${asset}-updown-5m-${OLD_ROUND}`, conditionId: `${asset}-market`,
        roundId: String(OLD_ROUND), upToken: `${asset}-yes`, downToken: `${asset}-no`, start: OLD_ROUND, end: OLD_ROUND + 300 };
    },
    feed: (_sink, _yes, _no, _deadline, identity) => { started.push(identity.marketId); return { stop() {} }; },
    publish: () => {},
  }, controller.signal);
  t.after(async () => { controller.abort(); releaseSlow(); await running; rmSync(dir, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 100 && !started.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(started, ["btc-market"]);
});

test("collector publishes independent assets and retains only the disconnected asset as stale", async t => {
  const now = OLD_ROUND + 100;
  const sinks = new Map();
  const rows = new Map();
  let latest;
  const controller = new AbortController();
  const dir = mkdtempSync(join(tmpdir(), "market-multi-asset-"));
  const running = runMarketSnapshot({ assets: ["btc", "eth", "sol"], output: join(dir, "snapshot.json"),
    durationSec: 0, staleAfterMs: 250, publishMs: 5, discoveryMs: 1000 }, {
    now: () => now,
    discover: async (_at, _direct, _signal, asset) => ({ asset, slug: `${asset}-updown-5m-${OLD_ROUND}`,
      conditionId: `${asset}-market`, roundId: String(OLD_ROUND), upToken: `${asset}-yes`, downToken: `${asset}-no`,
      start: OLD_ROUND, end: OLD_ROUND + 300 }),
    feed: (sink, yes, no, _deadline, identity) => {
      sinks.set(identity.marketId, sink);
      rows.set(identity.marketId, pairedBook({ marketId: identity.marketId, roundId: identity.roundId,
        yesAssetId: yes, noAssetId: no, sequence: 1, now }));
      return { stop() {} };
    },
    publish: (_path, value) => { latest = structuredClone(value); },
  }, controller.signal);
  t.after(async () => { controller.abort(); await running; rmSync(dir, { recursive: true, force: true }); });
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate());
  };
  await waitFor(() => sinks.size === 3);
  for (const [id, sink] of sinks) sink(rows.get(id));
  await waitFor(() => latest.current_markets.length === 3);
  assert.deepEqual(latest.current_markets.map(row => row.assetId).sort(), ["btc", "eth", "sol"]);
  sinks.get("eth-market")({ kind: "bookStatus", healthy: false, connected: false, reason: "transport_disconnected" });
  await waitFor(() => latest.current_markets.find(row => row.assetId === "eth")?.healthy === false);
  assert.equal(latest.collector_online, true);
  assert.equal(latest.current_markets.find(row => row.assetId === "btc").healthy, true);
  assert.equal(latest.current_markets.find(row => row.assetId === "sol").healthy, true);
  assert.equal(latest.current_markets.find(row => row.assetId === "eth").snapshot.sequence, 1);
});

function pairedBook({ marketId, roundId, yesAssetId, noAssetId, sequence, now, sourceAge = 0.02 }) {
  const sourceAt = now - sourceAge;
  const expiresAt = now + 1;
  const side = (assetId, bid, ask) => ({ assetId, bid, ask, bidSize: 10, askSize: 11,
    bids: Array.from({ length: 5 }, (_, index) => [bid - index * 0.001, 10 + index]),
    asks: Array.from({ length: 5 }, (_, index) => [ask + index * 0.001, 11 + index]),
    sourceAt, expiresAt, sequence });
  return { kind: "book", snapshot: {
    source: "polymarket-ws", marketId, roundId, sequence, sourceAt, expiresAt, tsUnix: now,
    YES: side(yesAssetId, 0.41, 0.42), NO: side(noAssetId, 0.57, 0.58),
  } };
}

test("cold restart keeps the previous round stale until a validated new-round pair arrives", async t => {
  const dir = mkdtempSync(join(tmpdir(), "market-snapshot-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "market-snapshot.json");
  const old = new ClobMarketProjection({ upToken: "old-yes", downToken: "old-no",
    conditionId: "old-market", start: OLD_ROUND, end: OLD_ROUND + 300 });
  const oldFrame = pairedBook({ marketId: "old-market", roundId: String(OLD_ROUND),
    yesAssetId: "old-yes", noAssetId: "old-no", sequence: 17, now: OLD_ROUND + 299 });
  assert.equal(old.applySnapshot(oldFrame.snapshot, oldFrame.snapshot.tsUnix), true);
  const oldOutput = old.snapshot(oldFrame.snapshot.tsUnix);
  const oldCanonical = structuredClone(oldOutput.current_markets[0].snapshot);
  publishSnapshot(output, oldOutput);

  const roundId = String(OLD_ROUND + 300);
  const now = OLD_ROUND + 301;
  const market = { asset: "btc", slug: `btc-updown-5m-${roundId}`, conditionId: "new-market",
    roundId, upToken: "new-yes", downToken: "new-no", start: Number(roundId), end: Number(roundId) + 300 };
  const published = [];
  const controller = new AbortController();
  let feedSink;
  let feedIdentity;
  const running = runMarketSnapshot({ output, durationSec: 0, staleAfterMs: 250,
    publishMs: 5, discoveryMs: 1_000 }, {
    now: () => now,
    discover: async () => market,
    feed: (sink, _yes, _no, _deadline, identity) => {
      feedSink = sink;
      feedIdentity = identity;
      return { stop() {} };
    },
    publish: (path, value) => {
      published.push(structuredClone(value));
      publishSnapshot(path, value);
    },
  }, controller.signal);
  t.after(async () => { controller.abort(); await running; });

  const waitUntil = async predicate => {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && !predicate()) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), "collector did not reach expected state");
  };
  await waitUntil(() => feedSink && published.some(value => value.current_markets[0]?.snapshot.marketId === "old-market"));
  const stale = published.find(value => value.current_markets[0]?.snapshot.marketId === "old-market");
  assert.equal(stale.collector_online, false);
  assert.equal(stale.current_markets[0].healthy, false);
  assert.equal(stale.current_markets[0].strategyEligible, false);
  assert.deepEqual(stale.current_markets[0].snapshot, oldCanonical);
  assert.equal(feedIdentity.marketId, market.conditionId);
  assert.equal(feedIdentity.roundId, market.roundId);
  assert.equal(feedIdentity.yesAssetId, market.upToken);
  assert.equal(feedIdentity.noAssetId, market.downToken);

  const wrongRound = pairedBook({ marketId: market.conditionId, roundId: String(OLD_ROUND),
    yesAssetId: market.upToken, noAssetId: market.downToken, sequence: 1, now });
  feedSink(wrongRound);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(published.some(value => value.current_markets[0]?.snapshot.marketId === "old-market"
    && value.current_markets[0].healthy === false));
  assert.equal(published.some(value => value.current_markets[0]?.snapshot.marketId === "new-market"), false);

  feedSink(pairedBook({ marketId: market.conditionId, roundId: market.roundId,
    yesAssetId: market.upToken, noAssetId: market.downToken, sequence: 1, now, sourceAge: 0.5 }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(published.some(value => value.current_markets[0]?.snapshot.marketId === "old-market"
    && value.current_markets[0].healthy === false));
  assert.equal(published.some(value => value.current_markets[0]?.snapshot.marketId === "new-market"), false);

  feedSink(pairedBook({ marketId: market.conditionId, roundId: market.roundId,
    yesAssetId: market.upToken, noAssetId: market.downToken, sequence: 1, now }));
  await waitUntil(() => published.some(value => value.collector_online
    && value.current_markets[0]?.snapshot.marketId === "new-market"));
  const recovered = published.find(value => value.collector_online
    && value.current_markets[0]?.snapshot.marketId === "new-market");
  assert.equal(recovered.current_markets[0].healthy, true);
  assert.equal(recovered.current_markets[0].strategyEligible, false);

  controller.abort();
  await running;
});

test("same-round cold restart continues the cached snapshot sequence", async t => {
  const dir = mkdtempSync(join(tmpdir(), "market-snapshot-sequence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "market-snapshot.json");
  const roundId = String(OLD_ROUND + 300);
  const now = OLD_ROUND + 301;
  const market = { asset: "btc", slug: `btc-updown-5m-${roundId}`, conditionId: "same-market",
    roundId, upToken: "same-yes", downToken: "same-no", start: Number(roundId), end: Number(roundId) + 300 };
  const previous = new ClobMarketProjection({ upToken: market.upToken, downToken: market.downToken,
    conditionId: market.conditionId, start: market.start, end: market.end });
  const oldFrame = pairedBook({ marketId: market.conditionId, roundId,
    yesAssetId: market.upToken, noAssetId: market.downToken, sequence: 17, now });
  assert.equal(previous.applySnapshot(oldFrame.snapshot, now), true);
  publishSnapshot(output, previous.snapshot(now));

  let feedSink;
  let feedIdentity;
  const controller = new AbortController();
  const published = [];
  const running = runMarketSnapshot({ output, durationSec: 0, staleAfterMs: 250,
    publishMs: 5, discoveryMs: 1_000 }, {
    now: () => now,
    discover: async () => market,
    feed: (sink, _yes, _no, _deadline, identity) => {
      feedSink = sink;
      feedIdentity = identity;
      return { stop() {} };
    },
    publish: (_path, value) => published.push(structuredClone(value)),
  }, controller.signal);
  t.after(async () => { controller.abort(); await running; });

  const waitUntil = async predicate => {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && !predicate()) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), "collector did not reach expected state");
  };
  await waitUntil(() => feedSink && feedIdentity);
  assert.equal(feedIdentity.sequenceBase, 17);
  feedSink(pairedBook({ marketId: market.conditionId, roundId,
    yesAssetId: market.upToken, noAssetId: market.downToken, sequence: feedIdentity.sequenceBase + 1, now }));
  await waitUntil(() => published.some(value => value.collector_online
    && value.current_markets[0]?.snapshot.sequence === 18));

  controller.abort();
  await running;
});
