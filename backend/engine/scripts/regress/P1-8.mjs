// BUGS.md P1-8: a WS "live" that arrives before the HTTP ACK (the norm on this
// venue) runs refreshReconciliationRisk while our own order is still
// SUBMITTING. core.ts:348-351 then treats that in-flight order as a restored
// one and halts the WHOLE account with "restored orders require
// reconciliation". Nothing clears it on ACK or fill, so every other market's
// orders are rejected until a recovery pass happens to succeed.
//
// Real TradingPlatform/Core/Store/Strategy, only the gateway faked.
// Run after `npm run build`:  node scripts/regress/P1-8.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { PlatformStore } from "../../dist/platform/store.js";

const START = 1_800_000_000;
const UP = "11".repeat(38), DOWN = "22".repeat(38), EUP = "33".repeat(38), EDOWN = "44".repeat(38);
const HASH = "0x" + "cd".repeat(32);
const btc = { id: "0xbtc", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xbtc", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xbtc", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const eth = { id: "0xeth", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: EUP, marketId: "0xeth", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: EDOWN, marketId: "0xeth", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = (cash) => ({ accountId: "t", at: START - 60, cashAt: START - 60, cashUsd: cash, positions: [], openOrders: [], complete: true });
const limits = { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null };
const settle = () => new Promise(r => setTimeout(r, 80));

// While the POST for the first order is in flight, the venue's WS already says
// "live" for it. The gateway fires that event from inside submit(), after the
// order is SUBMITTING and its orderId (the signed hash) is known, but before
// the ACK returns.
function harness({ restoredFrom, liveBeforeAck = true } = {}) {
  const dir = restoredFrom ?? mkdtempSync(join(tmpdir(), "p1-8-")); const path = join(dir, "state.json");
  const store = new PlatformStore(path); const restored = store.load(); let platform; let submits = 0;
  const gateway = { mode: "live", durableIdentity: true,
    async submit(request, instrument, prepared) {
      submits += 1;
      const hash = submits === 1 ? HASH : "0x" + String(submits).repeat(64).slice(0, 64);
      prepared({ orderHash: hash, signedPayload: { sig: "s" }, preparedAt: START + 1 });
      if (submits === 1 && liveBeforeAck) platform.core.observeVenueStatus(hash, "live", { source: "user_ws", observedAt: START + 1.1 });
      return { status: "accepted", orderId: hash, venueStatus: "LIVE" };
    },
    async cancel() { return true; } };
  platform = new TradingPlatform({ account: account(100), instruments: [...btc.instruments, ...eth.instruments], limits, restored, now: () => START + 2,
    adapters: { gateway, estimateFee: () => 0.05, persist: (s, c) => store.save(s, c), deferPersistence: () => store.defer(),
      persistPreparedOrder: o => store.savePreparedOrder(o) } });
  platform.ingest({ kind: "market", market: btc }); platform.ingest({ kind: "market", market: eth });
  return { dir, store, platform };
}
const order = (clientOrderId, tokenId) => ({ clientOrderId, strategyId: "s", tokenId, direction: "BUY", price: 0.70, shares: 5, timeInForce: "GTC", postOnly: false });

// --- bug case: live-before-ACK must not halt the account ---
{
  const h = harness();
  await h.platform.core.submit(order("btc:1", UP)); await settle();
  const risk = h.platform.core.risk();
  assert.notEqual(risk.reason, "restored orders require reconciliation",
    "an in-flight order of THIS process must not be treated as a restored order");
  assert.equal(risk.halted, false, "live-before-ACK must not halt the whole account");
  // And another market's order must be accepted.
  const other = await h.platform.core.submit(order("eth:1", EUP)); await settle();
  assert.notEqual(other.status, "REJECTED", "another market's order must not be rejected by a stale global halt");
  h.store.close(); rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS bug: live-before-ACK does not halt the account; other market still trades");
}

// --- control: the guard must only spare THIS process's in-flight order. An
// order genuinely restored from disk as in-flight must still halt until
// reconciled (that is what the halt exists for). Restore a state that holds a
// SUBMITTING order whose clientOrderId is NOT in this process's submissions
// map: the constructor converts it to UNKNOWN and sets "restored orders
// require reconciliation" (:104-123), and refreshReconciliationRisk must keep
// the account halted because that order is not in `submissions`. ---
{
  const dir = mkdtempSync(join(tmpdir(), "p1-8c-"));
  // Build a normal snapshot first (one resting OPEN order persists state.json),
  // then hand-restore with an extra in-flight order that this process never
  // submitted, exactly as a crash mid-POST in a previous process would leave.
  const h = harness({ liveBeforeAck: false });
  const resting = await h.platform.core.submit(order("btc:1", UP)); await settle();
  assert.equal(resting.status, "OPEN");
  h.store.close();
  const s2 = new PlatformStore(join(h.dir, "state.json")); const restored = s2.load();
  restored.orders.push({ clientOrderId: "eth:stale", orderId: "0x" + "ab".repeat(32), strategyId: "s",
    tokenId: EUP, direction: "BUY", price: 0.70, shares: 5, filledShares: 0, status: "SUBMITTING",
    reservedUsd: 3.55, reservedShares: 0, createdAt: START, updatedAt: START, timeInForce: "GTC",
    postOnly: false, identityProtocol: "signed-before-post", prepared: { orderHash: "0x" + "ab".repeat(32), signedPayload: { sig: "s" } } });
  const gateway = { mode: "live", durableIdentity: true, async submit() { throw new Error("no submit in control restore"); }, async cancel() { return true; } };
  const p3 = new TradingPlatform({ account: account(100), instruments: [...btc.instruments, ...eth.instruments], limits, restored, now: () => START + 3,
    adapters: { gateway, estimateFee: () => 0.05, persist: (s, c) => s2.save(s, c), deferPersistence: () => s2.defer(), persistPreparedOrder: o => s2.savePreparedOrder(o) } });
  const stale = p3.core.orders().find(o => o.clientOrderId === "eth:stale");
  assert.ok(stale, "control: the restored in-flight order is present");
  assert.equal(stale.status, "UNKNOWN", "control: a restored in-flight order is recovered as UNKNOWN, not SUBMITTING");
  const r3 = p3.core.risk();
  assert.equal(r3.reconciliationRequired, true, "control: a restored in-flight order still requires reconciliation");
  // Its market stays blocked until reconciled — that is the protection the halt
  // provides; a mapped UNKNOWN order is market-scoped, not a global halt.
  assert.ok((r3.blockedMarketIds ?? []).includes("0xeth"), "control: the restored order's market stays blocked until reconciled");
  s2.close(); rmSync(h.dir, { recursive: true, force: true });
  console.log("PASS control: a restored in-flight order still requires reconciliation and blocks its market");
}
console.log("P1-8 OK");
