// 2026-10-26 live: 7 of 9 FAKs did not fill. Each POST came back
// order_http_post outcome "unknown", the order went UNKNOWN, its detail
// lookup answered 404 for the signed hash, and it held its reservation and
// blocked its market until the 5-minute abandon timer.
//
// The venue kills an unmatched FAK with HTTP 400 and
// {"error": "no orders found to match with FAK order. ...", "orderID": "0x<hash>"}
// (clob-client-v2 issue #54 quotes that body; docs/resources/error-codes lists
// the message as a 400). The client then saw an error AND an order id, and
// the gateway maps any order id without success to "unknown".
//
// A reply that says the FAK did not fill ends it at once: REJECTED, nothing
// reserved, nothing blocked. A reply that does not say (timeout, 5xx, a
// broken connection, `delayed`) keeps waiting for the user feed or recovery.
// Recovery ends a FAK whose detail is 404 with no trade, no position and no
// open order without the 5-minute wait.
//
// Real ClobWrapper + PolymarketGateway (fetch stubbed) and real TradingCore.
// Run after `npm run build`:  node scripts/regress/fak-no-match.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import { ClobWrapper } from "../../dist/live/clob/client.js";
import * as connector from "../../dist/platform/polymarket.js";
import { TradingPlatform } from "../../dist/platform/platform.js";
const { PolymarketGateway } = connector;

const T = "1".repeat(77), DOWN = "2".repeat(77), START = 1_800_000_000;
const NO_MATCH = "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.";

// --- the real client + gateway: which replies end a FAK, which keep it open ---
const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const signer = createWalletClient({ account, chain: polygon, transport: http("http://127.0.0.1:9") });
const creds = { key: "k", passphrase: "p", secret: randomBytes(32).toString("base64url") };
const sdk = new ClobClient({ host: "https://clob.polymarket.com", chain: 137, signer, creds, signatureType: 0, funderAddress: account.address });
sdk.tickSizes[T] = "0.01";                              // no network: warmMarket's caches
const wrapper = new ClobWrapper(sdk, account.address, account.address, creds, 0);
wrapper.negRiskByToken.set(T, false);
wrapper.requestTimeoutMs = 200;
const gateway = new PolymarketGateway(wrapper);
let hash;
const realFetch = globalThis.fetch;
async function post(reply, timeInForce = "FAK") {
  globalThis.fetch = async (_url, init) => {
    const value = reply();
    if (value === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    if (value === "reset") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    return new Response(JSON.stringify(value[1]), { status: value[0] });
  };
  try {
    return await gateway.submit({ tokenId: T, price: 0.42, shares: 5, direction: "BUY", timeInForce, postOnly: false },
      { tokenId: T, marketId: "0xm", tickSize: 0.01, minOrderSize: 5 }, prepared => { hash = prepared.orderHash; });
  } finally { globalThis.fetch = realFetch; }
}
const replies = {
  // Definitely not filled: end it.
  "400 {error, orderID} (live, issue #54)": [() => [400, { error: NO_MATCH, orderID: hash }], "rejected"],
  "400 {error} (error-codes doc)": [() => [400, { error: NO_MATCH }], "rejected"],
  "200 success:false errorMsg orderID '' (docs)": [() => [200, { success: false, errorMsg: NO_MATCH, orderID: "", status: "" }], "rejected"],
  "200 success:false errorMsg orderID hash": [() => [200, { success: false, errorMsg: NO_MATCH, orderID: hash, status: "" }], "rejected"],
  "200 success:true unmatched, 0/0, no trades": [() => [200, { success: true, errorMsg: "", orderID: hash, status: "unmatched",
    makingAmount: "0", takingAmount: "0", tradeIDs: [] }], "rejected"],
  // Not known: keep it UNKNOWN or open.
  "200 success:true delayed, 0/0": [() => [200, { success: true, errorMsg: "", orderID: hash, status: "delayed",
    makingAmount: "0", takingAmount: "0", tradeIDs: [] }], "accepted"],
  "200 success:true matched + trade": [() => [200, { success: true, errorMsg: "", orderID: hash, status: "matched",
    makingAmount: "2.1", takingAmount: "5.25", tradeIDs: ["t1"] }], "accepted"],
  "200 success:true unmatched but a trade id": [() => [200, { success: true, errorMsg: "", orderID: hash, status: "unmatched",
    makingAmount: "0", takingAmount: "0", tradeIDs: ["t1"] }], "accepted"],
  "500 {error: there are no matching orders}": [() => [500, { error: "there are no matching orders" }], "unknown"],
  "timeout": [() => "hang", "unknown"],
  "connection reset": [() => "reset", "unknown"],
};
const acks = {}, wrong = [];
for (const [name, [reply, expected]] of Object.entries(replies)) {
  const ack = await post(reply);
  acks[name] = ack;
  if (ack.status !== expected) wrong.push(`${name}: got ${ack.status}, want ${expected}`);
}
assert.deepEqual(wrong, [], "every reply shape maps to its outcome");
assert.equal(acks["400 {error, orderID} (live, issue #54)"].error, NO_MATCH, "the venue's words reach the order");
assert.equal(acks["200 success:true unmatched, 0/0, no trades"].venueStatus, "unmatched");
// The same 400 for a GTC is not a FAK kill: its id still needs reconciliation.
assert.equal((await post(() => [400, { error: "order couldn't be placed", orderID: hash }], "GTC")).status, "unknown",
  "an error with an order id on a non-FAK stays unknown");

// --- the core: a FAK ended by its reply holds nothing and blocks nothing ---
const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: T, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
async function submitWith(ack) {
  const platform = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, now: () => START + 21,
    adapters: { gateway: { mode: "live", durableIdentity: true, async submit(request, instrument, prepared) {
      prepared({ orderHash: "0xhash", signedPayload: { sig: "s" }, preparedAt: START + 21 });
      return { ...ack, orderId: ack.orderId === undefined ? undefined : "0xhash" }; }, async cancel() { return true; } },
    estimateFee: () => 0.05 } });
  platform.ingest({ kind: "market", market });
  const order = await platform.core.submit({ clientOrderId: "binance-lead:0xm:1", strategyId: "binance-lead", tokenId: T, direction: "BUY",
    price: 0.42, shares: 5, timeInForce: "FAK", postOnly: false });
  return { order, risk: platform.core.risk() };
}
for (const name of ["400 {error, orderID} (live, issue #54)", "200 success:true unmatched, 0/0, no trades", "400 {error} (error-codes doc)"]) {
  const { order, risk } = await submitWith(acks[name]);
  assert.equal(order.status, "REJECTED", `${name}: ended at once`);
  assert.equal(order.reservedUsd, 0, `${name}: reservation released`);
  assert.equal(risk.reconciliationRequired, false, `${name}: nothing to reconcile`);
  assert.equal(risk.halted, false, `${name}: the account trades on`);
  assert.deepEqual(risk.blockedMarketIds, [], `${name}: the market is free`);
}
{
  const { order, risk } = await submitWith(acks["200 success:true delayed, 0/0"]);
  assert.equal(order.status, "OPEN", "delayed: accepted, waits for the user feed");
  assert.ok(order.reservedUsd > 2, "delayed: still reserved");
  assert.equal(risk.halted, false);
}
for (const name of ["timeout", "500 {error: there are no matching orders}"]) {
  const { order } = await submitWith(acks[name]);
  assert.equal(order.status, "UNKNOWN", `${name}: not known, stays UNKNOWN`);
  assert.ok(order.reservedUsd > 2, `${name}: still reserved`);
}

// --- recovery: a FAK the venue never heard of (404, no trade/position/open order) ends at once ---
const { abandonsMissingFak } = connector;
assert.equal(typeof abandonsMissingFak, "function", "recovery has a FAK rule");
const NOW = START + 30;
const fak =(extra = {}) => ({ status: "UNKNOWN", timeInForce: "FAK", filledShares: 0, httpAckAt: START + 21.3, createdAt: START + 21, ...extra });
const evidence = (extra = {}) => ({ missing: true, open: false, tradeScanned: true, hasFill: false, hasPosition: false,
  accountAt: NOW, ...extra });
assert.equal(abandonsMissingFak(fak(), evidence(), NOW), true, "404 + nothing on the venue: end it, 9 s after the POST");
assert.equal(abandonsMissingFak(fak({ timeInForce: "GTC" }), evidence(), NOW), false, "a GTC keeps the 5-minute wait");
assert.equal(abandonsMissingFak(fak({ httpAckAt: undefined }), evidence(), NOW), false, "no answer to the POST: it may still be in flight");
assert.equal(abandonsMissingFak(fak({ venueStatus: "delayed" }), evidence(), NOW), false, "delayed: matching has not happened yet");
assert.equal(abandonsMissingFak(fak({ venueStatus: "matched" }), evidence(), NOW), false, "matched: its trades are on their way");
assert.equal(abandonsMissingFak(fak({ status: "OPEN" }), evidence(), NOW), false, "only an UNKNOWN");
assert.equal(abandonsMissingFak(fak({ filledShares: 1 }), evidence(), NOW), false, "a fill already applied");
assert.equal(abandonsMissingFak(fak(), evidence({ missing: false }), NOW), false, "the venue knows the order");
assert.equal(abandonsMissingFak(fak(), evidence({ open: true }), NOW), false, "still open");
assert.equal(abandonsMissingFak(fak(), evidence({ tradeScanned: false }), NOW), false, "trade scan incomplete");
assert.equal(abandonsMissingFak(fak(), evidence({ hasFill: true }), NOW), false, "a trade names it");
assert.equal(abandonsMissingFak(fak(), evidence({ hasPosition: true }), NOW), false, "a position on its token");
assert.equal(abandonsMissingFak(fak(), evidence({ accountAt: START + 21.2 }), NOW), false, "account read older than the answer");
assert.equal(abandonsMissingFak(fak(), evidence({ accountAt: NOW - 200 }), NOW), false, "stale account read");
console.log("fak-no-match OK");
