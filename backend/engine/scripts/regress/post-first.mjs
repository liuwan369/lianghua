// The order's broadcasts run after the POST has been issued (2026-10-29: ~2 ms
// of journal/strategy/user-feed work before every order on the server).
// - the reservation and the signed identity are durable BEFORE the POST;
// - no order event reaches observers before the POST is issued;
// - after it: one SUBMITTING broadcast carrying the signed identity, then the ack's;
// - a gateway that fails before the POST still gets its SUBMITTING broadcast, then UNKNOWN;
// - a gateway that never calls onPostSent (accepted) still broadcasts before the ack state.
// Real TradingPlatform/core, scripted gateways. Run after `npm run build`.
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38);
const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
function harness(gateway) {
  const log = [];
  const platform = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, now: () => START + 21,
    adapters: { gateway, estimateFee: () => 0.05, deferPersistence: () => log.push("defer"),
      persist: (_state, critical) => log.push(critical ? "persist!" : "persist"),
      persistPreparedOrder: order => log.push(`intent:${order.orderId}`) } });
  platform.ingest({ kind: "market", market });
  platform.subscribe(event => { if (event.kind === "order") log.push(`order:${event.order.status}:${event.order.orderId ?? "-"}`); });
  return { platform, log };
}
const request = { clientOrderId: "binance-lead:0xm:1", strategyId: "binance-lead", tokenId: UP, direction: "BUY", price: 0.42, shares: 5, timeInForce: "FAK", postOnly: false };

// --- the real order path: sign, durable identity, POST, then broadcasts ---
{
  let h;
  const gateway = { mode: "live", durableIdentity: true, async submit(_r, _i, prepared, timing) {
    prepared({ orderHash: "0xhash", signedPayload: { s: 1 }, preparedAt: START + 21 });
    h.log.push("POST");
    timing.onPostSent();
    timing.onPostSent();                                  // a second call does nothing
    h.log.push("awaiting venue");
    await new Promise(r => setTimeout(r, 5));
    return { status: "rejected", orderId: "0xhash", error: "no orders found to match with FAK order" };
  }, async cancel() { return true; } };
  h = harness(gateway);
  const order = await h.platform.core.submit(request);
  assert.equal(order.status, "REJECTED");
  const at = (entry) => h.log.indexOf(entry);
  assert.ok(at("intent:0xhash") >= 0 && at("intent:0xhash") < at("POST"), "the signed identity is durable before the POST");
  assert.ok(at("defer") < at("POST"), "the reservation is held for the intent commit before the POST");
  assert.equal(h.log.slice(0, at("POST")).filter(e => e.startsWith("order:")).length, 0, "no order broadcast before the POST");
  const after = h.log.slice(at("POST")).filter(e => e.startsWith("order:"));
  assert.deepEqual(after, ["order:SUBMITTING:0xhash", "order:REJECTED:0xhash"], "one SUBMITTING with the identity, then the ack");
  assert.ok(at("order:SUBMITTING:0xhash") < at("awaiting venue"), "it runs while the venue holds the order, not after the reply");
}
// --- a gateway that throws before the POST: observers still see SUBMITTING, then UNKNOWN ---
{
  const gateway = { mode: "live", durableIdentity: true, async submit(_r, _i, prepared) {
    prepared({ orderHash: "0xhash2", signedPayload: { s: 1 }, preparedAt: START + 21 });
    throw new Error("socket closed before the request");
  }, async cancel() { return true; } };
  const h = harness(gateway);
  const order = await h.platform.core.submit(request);
  assert.equal(order.status, "UNKNOWN");
  assert.deepEqual(h.log.filter(e => e.startsWith("order:")), ["order:SUBMITTING:0xhash2", "order:UNKNOWN:0xhash2"]);
}
// --- a gateway that never calls onPostSent (a test or older adapter) ---
{
  const gateway = { mode: "live", durableIdentity: true, async submit(_r, _i, prepared) {
    prepared({ orderHash: "0xhash3", signedPayload: { s: 1 }, preparedAt: START + 21 });
    return { status: "accepted", orderId: "0xhash3", venueStatus: "live" };
  }, async cancel() { return true; } };
  const h = harness(gateway);
  const order = await h.platform.core.submit(request);
  assert.equal(order.status, "OPEN");
  assert.deepEqual(h.log.filter(e => e.startsWith("order:")), ["order:SUBMITTING:0xhash3", "order:OPEN:0xhash3"]);
}
// --- a gateway without durable identity (paper/test) keeps its old persist ---
{
  const gateway = { mode: "live", durableIdentity: false, async submit() { return { status: "accepted", orderId: "0xv" }; }, async cancel() { return true; } };
  const h = harness(gateway);
  await h.platform.core.submit(request);
  assert.ok(h.log.includes("persist!"), "the reservation is persisted before submit");
  assert.deepEqual(h.log.filter(e => e.startsWith("order:")), ["order:SUBMITTING:-", "order:OPEN:0xv"]);
}
console.log("post-first OK");
