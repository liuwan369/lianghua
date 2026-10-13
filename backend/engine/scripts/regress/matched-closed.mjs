// 2026-10-14 live: a GTC hedge partly filled (9 of 13). At the round's end the
// strategy cancelled the rest; the venue refused (`canceled` empty) because it
// reports the order MATCHED, not live, and it is gone from the open orders.
// The order went UNKNOWN, the strategy re-sent the cancel every second and the
// account recovery ran every 5 s, forever: its reservation stayed held and its
// market stayed blocked. Three orders that day, each with every fill CONFIRMED.
//
// A MATCHED order absent from a complete open-order read, whose matched size
// equals the fills we hold, is finished on the venue: the matched part is
// filled, the rest will never trade. closeMatched() ends it and releases the
// reservation. A different matched size (a fill we have not seen) does not.
//
// Real TradingPlatform/Core/Store, only the gateway faked.
// Run after `npm run build`:  node scripts/regress/matched-closed.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { PlatformStore } from "../../dist/platform/store.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), HASH = "0x" + "cd".repeat(32);
const market = { id: "0xm", assetId: "eth", roundId: String(START), name: `eth-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const limits = { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null };
const settle = () => new Promise(r => setTimeout(r, 50));

async function stuck() {
  const dir = mkdtempSync(join(tmpdir(), "matched-")); const store = new PlatformStore(join(dir, "state.json"));
  let now = START + 120;
  const gateway = { mode: "live", durableIdentity: true,
    async submit(request, instrument, prepared) {
      prepared({ orderHash: HASH, signedPayload: { sig: "s" }, preparedAt: now });
      return { status: "accepted", orderId: HASH, venueStatus: "MATCHED" };
    },
    async cancel() { return false; } };                  // venue: not in `canceled`
  const platform = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits, restored: store.load(), now: () => now,
    adapters: { gateway, estimateFee: () => 0, persist: (s, c) => store.save(s, c), deferPersistence: () => store.defer(),
      persistPreparedOrder: o => store.savePreparedOrder(o) } });
  platform.ingest({ kind: "market", market });
  await platform.core.submit({ clientOrderId: "s:0xm:2", strategyId: "s", tokenId: UP, direction: "BUY", price: 0.70, shares: 13, timeInForce: "GTC", postOnly: false });
  await settle();
  platform.core.applyFill({ tradeId: "t1", orderId: HASH, tokenId: UP, direction: "BUY", price: 0.70, shares: 9, feeUsd: 0, ts: now, status: "CONFIRMED", isMaker: true });
  now = START + 300;
  await platform.core.cancel(HASH).catch(() => undefined);
  await settle();
  return { dir, store, platform };
}

// --- bug: the refused cancel leaves it UNKNOWN with capital held ---
{
  const h = await stuck();
  const order = h.platform.core.order(HASH);
  assert.equal(order.status, "UNKNOWN", "precondition: the refused cancel made it UNKNOWN");
  assert.ok(order.reservedUsd > 2.7, "precondition: the unfilled 4 shares keep 2.80 reserved");
  // --- fix: the venue's MATCHED + matched size 9 = our fills, not in open orders ---
  assert.equal(h.platform.core.closeMatched(HASH, 9), true, "a matched order finished on the venue is closed");
  const done = h.platform.core.order(HASH);
  assert.equal(done.status, "CANCELLED", "the unfilled rest is void");
  assert.equal(done.filledShares, 9, "the 9 filled shares stay");
  assert.equal(done.reservedUsd, 0, "the reservation is released");
  assert.equal(done.reconciliationPending, false, "nothing left to reconcile");
  assert.equal(h.platform.core.risk().reconciliationRequired, false, "the market is no longer blocked");
  assert.equal(h.platform.core.closeMatched(HASH, 9), false, "closing twice is a no-op");
  h.store.close(); rmSync(h.dir, { recursive: true, force: true });
}
// --- a matched size we have not seen (a fill still on its way) is not closed ---
{
  const h = await stuck();
  assert.equal(h.platform.core.closeMatched(HASH, 11), false, "venue matched 11, we hold 9: wait for the fill");
  assert.equal(h.platform.core.order(HASH).status, "UNKNOWN");
  h.store.close(); rmSync(h.dir, { recursive: true, force: true });
}
// --- a fill still settling is not closed either ---
{
  const h = await stuck();
  h.platform.core.applyFill({ tradeId: "t2", orderId: HASH, tokenId: UP, direction: "BUY", price: 0.70, shares: 2, feeUsd: 0, ts: START + 299, status: "MATCHED", isMaker: true });
  assert.equal(h.platform.core.closeMatched(HASH, 11), false, "a MATCHED (unsettled) fill keeps it open");
  h.store.close(); rmSync(h.dir, { recursive: true, force: true });
}
// --- the closed state restores cleanly ---
{
  const h = await stuck();
  h.platform.core.closeMatched(HASH, 9);
  h.store.close();
  const again = new PlatformStore(join(h.dir, "state.json")).load();
  const p2 = new TradingPlatform({ account: { accountId: "t", at: START + 301, cashAt: START + 301, cashUsd: 93.7, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits, restored: again, now: () => START + 310,
    adapters: { gateway: { mode: "live", durableIdentity: true, async submit() {}, async cancel() { return true; } }, estimateFee: () => 0 } });
  assert.equal(p2.core.risk().halted, false, "a restart does not halt on the closed order");
  rmSync(h.dir, { recursive: true, force: true });
}
console.log("matched-closed OK");
