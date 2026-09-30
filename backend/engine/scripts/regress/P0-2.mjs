// BUGS.md P0-2: a local cancel after the order already had reconciliationPending
// cleared (by a WS "live" status, or by a partial fill) leaves the CANCELLED
// order still holding its reservation, which validateAccount rejects on the
// next reconcile and on every restart.
//
// Built on scripts/check-order-path.mjs's harness: real TradingPlatform,
// TradingCore, PlatformStore and BtcReversalStrategy; only the venue gateway is
// faked. Run after `npm run build`:  node scripts/regress/P0-2.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { PlatformStore } from "../../dist/platform/store.js";
import { BtcReversalStrategy } from "../../dist/strategies/btc-reversal.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38);
const HASH = "0x" + "cd".repeat(32);
const market = { id: "0xmarket", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xmarket", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xmarket", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = (cash) => ({ accountId: "t", at: START - 60, cashAt: START - 60, cashUsd: cash, positions: [], openOrders: [], complete: true });
const limits = { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null };
const snap = (now, upAsk, downAsk) => { const side = (t, a) => ({ assetId: t, bid: a - 0.01, ask: a, bidSize: 100, askSize: 100, sourceAt: now, expiresAt: now + 2 });
  return { assetId: "btc", marketId: market.id, roundId: market.roundId, sourceAt: now, expiresAt: now + 2, tsUnix: now, receivedAtUnix: now,
    receivedAtMonoMs: performance.now(), marketAgeMs: 50, YES: side(UP, upAsk), NO: side(DOWN, downAsk) }; };

// Case C needs venue events to land WHILE the local cancel is awaiting its HTTP
// round-trip, so the gateway runs an optional hook from inside cancel().
let duringCancel = null;
function harness(restoredFrom) {
  const dir = restoredFrom ?? mkdtempSync(join(tmpdir(), "p0-2-")); const path = join(dir, "state.json");
  const store = new PlatformStore(path); const restored = store.load(); let now = START - 5; let platform;
  const gateway = { mode: "live", durableIdentity: true,
    async submit(request, instrument, prepared) { prepared({ orderHash: HASH, signedPayload: { sig: "s" }, preparedAt: START + 1 });
      return { status: "accepted", orderId: HASH, venueStatus: "LIVE" }; },
    async cancel() { if (duringCancel) { const hook = duringCancel; duringCancel = null; hook(); } return true; } };
  const strategy = new BtcReversalStrategy({ stageShares: [5], maxStages: 1, triggerPrice: 0.67, maxBuyPrice: 0.7, confirmationPrice: 0.7,
    roundBudgetUsd: 10, maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 },
    { persist: s => platform?.core.setStrategyState("btc-reversal", s), restoredState: restored?.strategyStates?.["btc-reversal"] });
  platform = new TradingPlatform({ account: account(100), instruments: market.instruments, limits, restored, now: () => now,
    adapters: { gateway, estimateFee: () => 0.05, persist: (s, c) => store.save(s, c), deferPersistence: () => store.defer(),
      persistPreparedOrder: o => store.savePreparedOrder(o) } });
  platform.ingest({ kind: "market", market }); platform.attach(strategy);
  const tick = (sec, u, d) => { now = START + sec; platform.ingest({ kind: "book", snapshot: snap(now, u, d), marketId: market.id, roundId: market.roundId }); };
  if (!restoredFrom) tick(-5, 0.60, 0.40);
  return { dir, path, store, platform, tick, setNow: (s) => { now = START + s; } };
}
const settle = () => new Promise(r => setTimeout(r, 80));
const openOne = async (h) => { h.tick(1, 0.60, 0.40); h.tick(2, 0.68, 0.32); await settle(); const [o] = h.platform.core.orders(); assert.equal(o.status, "OPEN", "order should rest OPEN"); return o; };

// --- bug case A: WS "live" before the local cancel ---
{
  const h = harness();
  const o = await openOne(h);
  h.platform.core.observeVenueStatus(HASH, "live", { source: "user_ws", observedAt: START + 2.5 });
  await h.platform.core.cancel(o.clientOrderId); await settle();
  const [c] = h.platform.core.orders();
  assert.equal(c.status, "CANCELLED");
  assert.equal(c.reconciliationPending, true, "A: cancelled order must stay reconciliationPending after a prior WS live");
  await h.platform.core.reconcile(account(100));               // must not throw
  h.store.close();
  harness(h.dir);                                              // restart must not throw
  rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS A: WS live then local cancel — reconcile + restart clean");
}
// --- bug case B: partial fill before the local cancel ---
{
  const h = harness();
  const o = await openOne(h);
  h.platform.ingest({ kind: "fill", marketId: market.id, roundId: market.roundId, fill: { tradeId: "t1", orderId: HASH, marketId: market.id, roundId: market.roundId,
    tokenId: UP, direction: "BUY", price: 0.70, shares: 2, feeUsd: 0, status: "CONFIRMED", feeSource: "reported", ts: START + 2.6, isMaker: false } }); await settle();
  await h.platform.core.cancel(o.clientOrderId); await settle();
  const [c] = h.platform.core.orders();
  assert.equal(c.status, "CANCELLED");
  assert.equal(c.reconciliationPending, true, "B: cancelled order must stay reconciliationPending after a partial fill");
  await h.platform.core.reconcile(account(100));
  h.store.close();
  harness(h.dir);
  rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS B: partial fill then local cancel — reconcile + restart clean");
}
// --- control: plain cancel (no prior live/fill) must still work ---
{
  const h = harness();
  const o = await openOne(h);
  await h.platform.core.cancel(o.clientOrderId); await settle();
  const [c] = h.platform.core.orders();
  assert.equal(c.status, "CANCELLED");
  await h.platform.core.reconcile(account(100));
  h.store.close(); harness(h.dir); rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS control: plain cancel still clean");
}
// --- case C (found by the independent reviewer): the reservation is already
// released to 0 by the time the local cancel's success branch runs. While the
// cancel HTTP is in flight, the User WS delivers orderCancelled
// (confirmCancelled -> CANCELLED, pending=true, reservation kept) and then a
// stray non-cancel status on the now-terminal order, which core.ts:619 answers
// by zeroing the reservation. A naive `reconciliationPending = true` would then
// leave CANCELLED + pending=true + reserved=0, which validateAccount rejects on
// restart just like the original bug. pending must follow the reservation. ---
{
  const h = harness();
  const o = await openOne(h);
  duringCancel = () => {
    h.platform.core.confirmCancelled(o.clientOrderId, false, "user_ws", START + 2.3);
    h.platform.core.observeVenueStatus(HASH, "live", { source: "user_ws", observedAt: START + 2.5 });
  };
  await h.platform.core.cancel(o.clientOrderId); await settle();
  const [c] = h.platform.core.orders();
  assert.equal(c.status, "CANCELLED");
  assert.ok(c.reservedUsd <= 1e-8, "C precondition: the race must have released the reservation");
  assert.equal(c.reconciliationPending, false, "C: no reservation held, so the order must not be left pending");
  await h.platform.core.reconcile(account(100));               // must not throw
  h.store.close();
  harness(h.dir);                                              // restart must not throw
  rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS C: reservation released mid-cancel — not forced pending, reconcile + restart clean");
}
console.log("P0-2 OK");
