// BUGS.md P2-20: partial fills are summed as floats (97.85 + 4.1 =
// 101.94999999999999) and then compared to the venue's size_matched (101.95)
// with strict !==. While the order is still open every reconcile() therefore
// throws "apply missing fills before reconciliation" and the market stays
// blocked. Real TradingPlatform/Core/Store, only the gateway faked.
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
const limits = { capitalUsd: 1000, maxOrderUsd: 500, maxOpenOrders: 10, dailyLossUsd: null };
const settle = () => new Promise(r => setTimeout(r, 80));

function build() {
  const dir = mkdtempSync(join(tmpdir(), "p2-20-")); const s = new PlatformStore(join(dir, "state.json"));
  const gw = { mode: "live", durableIdentity: true,
    async submit(_r, _i, prep) { prep({ orderHash: HASH, signedPayload: { sig: "s" }, preparedAt: START + 1 }); return { status: "accepted", orderId: HASH, venueStatus: "LIVE" }; },
    async cancel() { return true; } };
  const p = new TradingPlatform({ account: { accountId: "t", at: START - 60, cashAt: START - 60, cashUsd: 1000, positions: [], openOrders: [], complete: true },
    instruments: btc.instruments, limits, now: () => START + 10,
    adapters: { gateway: gw, estimateFee: () => 0.05, persist: (st, c) => s.save(st, c), deferPersistence: () => s.defer(), persistPreparedOrder: o => s.savePreparedOrder(o) } });
  p.ingest({ kind: "market", market: btc });
  return { p, s, dir };
}
const fill = (tradeId, shares, ts) => ({ kind: "fill", marketId: btc.id, roundId: btc.roundId, fill: { tradeId, orderId: HASH, marketId: btc.id, roundId: btc.roundId,
  tokenId: UP, direction: "BUY", price: 0.70, shares, feeUsd: 0, status: "CONFIRMED", feeSource: "reported", ts, isMaker: false } });
// Venue snapshot: the same order still open with size_matched as the venue reports it.
const venueOpen = (matched, cash) => ({ accountId: "t", at: START + 9, cashAt: START + 9, cashUsd: cash, complete: true,
  positions: [{ tokenId: UP, shares: matched, costUsd: matched * 0.70, realizedPnlUsd: 0 }],
  openOrders: [{ clientOrderId: "btc:1", orderId: HASH, strategyId: "s", tokenId: UP, direction: "BUY", price: 0.70, shares: 120,
    filledShares: matched, timeInForce: "GTC", postOnly: false, status: "PARTIAL",
    reservedUsd: (120 - matched) * 0.70, reservedShares: 0, createdAt: START + 1, updatedAt: START + 9 }] });

// --- bug case: two partial fills whose float sum != the venue's decimal ---
{
  const { p, s, dir } = build();
  await p.core.submit({ clientOrderId: "btc:1", strategyId: "s", tokenId: UP, direction: "BUY", price: 0.70, shares: 120, timeInForce: "GTC", postOnly: false });
  await settle();
  p.ingest(fill("t1", 97.85, START + 3)); p.ingest(fill("t2", 4.1, START + 4)); await settle();
  const local = p.core.orders()[0].filledShares;
  assert.notEqual(local, 101.95, "precondition: float sum is not exactly 101.95");
  const matched = Number("101.95");
  await p.core.reconcile(venueOpen(matched, 1000 - matched * 0.70));   // must not throw
  assert.ok(Math.abs(p.core.orders()[0].filledShares - matched) < 1e-8, "filledShares agrees with the venue within EPS");
  s.close(); rmSync(dir, { recursive: true, force: true });
  console.log(`PASS bug: float-summed ${local} reconciles against venue ${matched}`);
}
// --- control: a genuinely missing fill (a real difference) must still be caught ---
{
  const { p, s, dir } = build();
  await p.core.submit({ clientOrderId: "btc:1", strategyId: "s", tokenId: UP, direction: "BUY", price: 0.70, shares: 120, timeInForce: "GTC", postOnly: false });
  await settle();
  p.ingest(fill("t1", 97.85, START + 3)); await settle();              // local 97.85
  // reconcile is synchronous, so a real 4.1-share gap throws synchronously.
  assert.throws(() => p.core.reconcile(venueOpen(101.95, 1000 - 101.95 * 0.70)),
    /apply missing fills before reconciliation/, "control: a real 4.1-share gap must still be refused");
  s.close(); rmSync(dir, { recursive: true, force: true });
  console.log("PASS control: a real missing fill is still refused");
}
console.log("P2-20 OK");
