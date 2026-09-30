// BUGS.md P2-22: a venue "canceled" that arrives (via User WS) while the order
// is still SUBMITTING only records venueStatus; the order stays SUBMITTING. The
// HTTP ACK then promotes it to OPEN (core.ts:957) without checking venueStatus,
// leaving OPEN + venueStatus=canceled with the reservation still held. Found
// while fixing P1-8, which used to mask it via a recovery loop.
//
// Real TradingPlatform/Core/Store, only the gateway faked.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { PlatformStore } from "../../dist/platform/store.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), HASH = "0x" + "cd".repeat(32);
const btc = { id: "0xbtc", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xbtc", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xbtc", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = (c) => ({ accountId: "t", at: START + 5, cashAt: START + 5, cashUsd: c, positions: [], openOrders: [], complete: true });
const limits = { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null };
const settle = () => new Promise(r => setTimeout(r, 80));
const order = { clientOrderId: "btc:1", strategyId: "s", tokenId: UP, direction: "BUY", price: 0.70, shares: 5, timeInForce: "GTC", postOnly: false };

function run(cancelBeforeAck) {
  const dir = mkdtempSync(join(tmpdir(), "p2-22-")); const s = new PlatformStore(join(dir, "state.json")); let p;
  const gw = { mode: "live", durableIdentity: true,
    async submit(_r, _i, prep) { prep({ orderHash: HASH, signedPayload: { sig: "s" }, preparedAt: START + 1 });
      if (cancelBeforeAck) p.core.observeVenueStatus(HASH, "canceled", { source: "user_ws", observedAt: START + 1.1 });
      return { status: "accepted", orderId: HASH, venueStatus: "LIVE" }; },
    async cancel() { return true; } };
  p = new TradingPlatform({ account: account(100), instruments: btc.instruments, limits, now: () => START + 2,
    adapters: { gateway: gw, estimateFee: () => 0.05, persist: (st, c) => s.save(st, c), deferPersistence: () => s.defer(), persistPreparedOrder: o => s.savePreparedOrder(o) } });
  p.ingest({ kind: "market", market: btc });
  return { p, s, dir };
}

// --- bug case: canceled before ACK ---
{
  const { p, s, dir } = run(true);
  await p.core.submit(order); await settle();
  const o = p.core.orders()[0];
  assert.notEqual(o.status, "OPEN", "a venue-cancelled order must not be promoted to OPEN by the ACK");
  assert.equal(o.status, "CANCELLED", "it should settle as CANCELLED");
  // Reservation is kept pending until reconciliation proves no fill raced (P0-2 invariant).
  assert.equal(o.reconciliationPending, o.reservedUsd > 1e-8 || o.reservedShares > 1e-8,
    "pending must track whether a reservation is still held");
  await p.core.reconcile(account(100));   // must not throw
  s.close(); rmSync(dir, { recursive: true, force: true });
  console.log("PASS bug: venue cancel before ACK is not promoted to OPEN");
}
// --- control: no venue cancel — ACK must still open the order ---
{
  const { p, s, dir } = run(false);
  await p.core.submit(order); await settle();
  assert.equal(p.core.orders()[0].status, "OPEN", "control: a normal ACK still opens the order");
  s.close(); rmSync(dir, { recursive: true, force: true });
  console.log("PASS control: a normal ACK still opens the order");
}
console.log("P2-22 OK");
