// End-to-end check of the decide -> persist -> sign -> POST path with the real
// TradingPlatform, TradingCore, BtcReversalStrategy and PlatformStore. Only the
// venue gateway is faked. Run after `npm run build`:
//   node scripts/check-order-path.mjs
// Covers the persistence changes made to cut copies on the order path:
//   - the state written to disk is a snapshot, not a live alias of core state
//   - the strategy stage and the signed intent are durable before the POST
//   - a crash between signing and POST restores the order as UNKNOWN and
//     blocks its market until reconciliation, without re-signing
//   - a normal ACK leaves one accepted order and no leftover intent
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingPlatform } from "../dist/platform/platform.js";
import { PlatformStore } from "../dist/platform/store.js";
import { BtcReversalStrategy } from "../dist/strategies/btc-reversal.js";

const START = 1_800_000_000;           // round start, a multiple of 300
const UP = "11".repeat(38), DOWN = "22".repeat(38);
const market = { id: "0xmarket", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`,
  startsAt: START, endsAt: START + 300,
  instruments: [
    { tokenId: UP, marketId: "0xmarket", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
    { tokenId: DOWN, marketId: "0xmarket", outcome: "Down", tickSize: 0.01, minOrderSize: 5 },
  ] };
const account = (cash) => ({ accountId: "t", at: START - 60, cashAt: START - 60, cashUsd: cash,
  positions: [], openOrders: [], complete: true });
const limits = { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null };

// A paired snapshot whose UP/DOWN asks are given; clocks advance with `now`.
const snap = (now, upAsk, downAsk) => {
  const side = (tokenId, ask) => ({ assetId: tokenId, bid: ask - 0.01, ask, bidSize: 100, askSize: 100,
    sourceAt: now, expiresAt: now + 2 });
  return { assetId: "btc", marketId: market.id, roundId: market.roundId, sourceAt: now, expiresAt: now + 2,
    tsUnix: now, receivedAtUnix: now, receivedAtMonoMs: performance.now(), marketAgeMs: 50,
    YES: side(UP, upAsk), NO: side(DOWN, downAsk) };
};

function harness({ onSubmit, restoredFrom } = {}) {
  const dir = restoredFrom ?? mkdtempSync(join(tmpdir(), "order-path-"));
  const path = join(dir, "state.json");
  const store = new PlatformStore(path);
  const restored = store.load();
  let now = START - 5;
  const events = [];
  let platform;
  const gateway = {
    mode: "live", durableIdentity: true,
    async submit(request, instrument, prepared) {
      return onSubmit({ request, prepared, path, store, platform });
    },
    async cancel() { return true; },
  };
  const strategy = new BtcReversalStrategy(
    { stageShares: [5], maxStages: 1, triggerPrice: 0.67, maxBuyPrice: 0.7, confirmationPrice: 0.7,
      roundBudgetUsd: 10, maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 },
    // Same guard as cli/platform.ts: a restored strategy saves from its
    // constructor, before the platform exists.
    { persist: state => platform?.core.setStrategyState("btc-reversal", state),
      restoredState: restored?.strategyStates?.["btc-reversal"] });
  platform = new TradingPlatform({ account: account(100), instruments: market.instruments, limits,
    restored, now: () => now,
    adapters: { gateway, estimateFee: () => 0.05,
      persist: (state, critical) => store.save(state, critical),
      deferPersistence: () => store.defer(),
      persistPreparedOrder: order => store.savePreparedOrder(order) } });
  platform.subscribe(event => events.push(event));
  platform.ingest({ kind: "market", market });
  platform.attach(strategy);
  const tick = (secondsFromStart, upAsk, downAsk) => {
    now = START + secondsFromStart;
    platform.ingest({ kind: "book", snapshot: snap(now, upAsk, downAsk), marketId: market.id, roundId: market.roundId });
  };
  // The strategy only admits a round it sees before it starts (now <= startsAt),
  // exactly as live; a restored run must not re-admit one it already holds.
  if (!restoredFrom) tick(-5, 0.60, 0.40);
  return { dir, path, store, platform, strategy, events, tick, setNow: t => { now = t; } };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60));
const readJson = p => JSON.parse(readFileSync(p, "utf8"));

// --- 1. Normal order: stage durable before POST, snapshot is not an alias ---
{
  const seenBeforePost = {};
  const h = harness({ onSubmit: async ({ request, prepared, path, store }) => {
    // What a crash right before this POST would leave on disk.
    prepared({ orderHash: "0x" + "cd".repeat(32), signedPayload: { sig: "s" }, preparedAt: START + 1 });
    seenBeforePost.intent = readJson(`${path}.intent`).order;
    return { status: "accepted", orderId: "0x" + "cd".repeat(32), venueStatus: "LIVE" };
  } });
  h.tick(1, 0.60, 0.40);          // baseline below trigger
  h.tick(2, 0.68, 0.32);          // UP crosses 0.67 -> one BUY stage
  await settle();

  assert.equal(seenBeforePost.intent.status, "SUBMITTING", "signed intent written before POST");
  assert.equal(seenBeforePost.intent.orderId, "0x" + "cd".repeat(32));
  const orders = h.platform.core.orders();
  assert.equal(orders.length, 1, "exactly one order");
  assert.equal(orders[0].status, "OPEN");
  assert.equal(orders[0].tokenId, UP);

  // Flush and check the file reflects the ACKed order, with its stage.
  h.store.close();
  const disk = readJson(h.path);
  assert.equal(disk.orders.length, 1);
  assert.equal(disk.orders[0].status, "OPEN", "ACK state durable");
  const stage = disk.strategyStates["btc-reversal"].rounds.find(r => r.roundId === market.roundId).stages[0];
  assert.equal(stage.clientOrderId, orders[0].clientOrderId, "strategy stage durable with the order");
  assert.equal(existsSync(`${h.path}.intent`), false, "intent removed once the snapshot covers it");

  // The store no longer clones what it is handed, so the core must hand it a
  // private snapshot. Capture a pending (not yet flushed) snapshot, change the
  // live core state, then flush: disk must hold the value at capture time.
  const h2 = harness({ onSubmit: async () => ({ status: "rejected", error: "x" }) });
  h2.store.defer();                                    // hold the write pending, as mid-submit
  h2.platform.core.setStrategyState("alias", { v: "captured" }); // persist() -> store.save(...)
  const pending = h2.store["pending"];
  // Mutate live core state WITHOUT persisting. If the store were holding the
  // live object instead of a snapshot, this would leak into what gets written.
  h2.platform.core["state"].cashUsd = -12345;
  h2.platform.core["state"].strategyStates.alias.v = "later";
  assert.equal(pending.cashUsd, 100, "pending snapshot must not alias live core state (cash)");
  assert.equal(pending.strategyStates.alias.v, "captured", "pending snapshot must not alias live core state (strategy)");
  h2.platform.core["state"].cashUsd = 100;
  h2.store.close(); rmSync(h2.dir, { recursive: true, force: true });
  rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS 1 normal order: intent before POST, stage + ACK durable, no alias");
}

// --- 2. Crash after signing, before the POST returns ---
{
  let crashDir;
  const h = harness({ onSubmit: async ({ prepared }) => {
    prepared({ orderHash: "0x" + "ef".repeat(32), signedPayload: { sig: "s" }, preparedAt: START + 1 });
    return new Promise(() => {});                    // POST never answers: process dies here
  } });
  crashDir = h.dir;
  h.tick(1, 0.60, 0.40);
  h.tick(2, 0.32, 0.68);                             // DOWN crosses
  await settle();
  // Simulate the process dying: drop the lock file without a clean close/flush.
  rmSync(`${h.path}.lock`, { force: true });

  const r = harness({ restoredFrom: crashDir, onSubmit: async () => { throw new Error("must not resubmit"); } });
  const orders = r.platform.core.orders();
  assert.equal(orders.length, 1, "the signed order survives the crash");
  assert.equal(orders[0].status, "UNKNOWN", "an uncertain POST restores as UNKNOWN, never re-signed");
  assert.equal(orders[0].tokenId, DOWN);
  // By design an unresolved order blocks only its own market, so one stuck
  // round cannot suppress the next (core.ts refreshReconciliationRisk).
  const risk = r.platform.core.risk();
  assert.equal(risk.reconciliationRequired, true, "reconciliation required");
  assert.deepEqual(risk.blockedMarketIds, [market.id], "the order's market is blocked");
  r.store.close(); rmSync(crashDir, { recursive: true, force: true });
  // And the blocked market really refuses a new order.
  r.tick(4, 0.69, 0.31);
  await settle();
  assert.equal(r.platform.core.orders().length, 1, "no new order while the market is blocked");
  console.log("PASS 2 crash between sign and POST: restored UNKNOWN, market blocked, no resubmit");
}

// --- 3. Rejected ACK releases the reservation and frees the stage ---
{
  const h = harness({ onSubmit: async ({ prepared }) => {
    prepared({ orderHash: "0x" + "aa".repeat(32), signedPayload: { sig: "s" }, preparedAt: START + 1 });
    return { status: "rejected", error: "venue said no" };
  } });
  h.tick(1, 0.60, 0.40);
  h.tick(2, 0.68, 0.32);
  await settle();
  const [order] = h.platform.core.orders();
  assert.equal(order.status, "REJECTED");
  assert.equal(order.reservedUsd, 0, "rejected order holds no cash");
  assert.equal(h.platform.core.risk().availableUsd, 100, "all cash available again");
  h.store.close(); rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS 3 rejected ACK: reservation released");
}

// --- 4. Strategy state held by core is not the strategy's live object ---
// setStrategyState no longer copies, which is safe only because the strategy
// hands over exportState(), a fresh clone. Prove the strategy's own later
// mutations never reach the state core holds and persists.
{
  const h = harness({ onSubmit: async () => ({ status: "rejected", error: "x" }) });
  h.tick(1, 0.60, 0.40);                             // baseline -> strategy saves
  const held = h.platform.core["state"].strategyStates["btc-reversal"];
  const before = JSON.stringify(held);
  const live = h.strategy["state"];
  assert.notEqual(held, live, "core must not hold the strategy's live state object");
  live.rounds[0].reason = "mutated-in-strategy";     // mutate without a save()
  assert.equal(JSON.stringify(held), before, "strategy mutation must not reach core's copy");
  h.store.close(); rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS 4 strategy state held by core is independent of the live strategy");
}

console.log("ALL PASS");
