// Signing ahead (2026-10-29): a round's likely FAK limits are signed when the
// market is set up, and a signal posts the stored order instead of signing on
// the spot (server: signing 3.6 ms + hash 0.9 ms of an 11.9 ms hot path).
// - presignPrices: every ask the strategy buys maps to one limit (cap, tick, 1 USD minimum);
// - a matching order is used once, with its precomputed hash, and the POST body is it;
// - no match (other price/size), a CLOB version change, or a tick change: sign on the spot;
// - forgetPresigned drops a round's orders;
// - a signing failure never surfaces.
// Real ClobWrapper + PolymarketGateway, fetch stubbed. Run after `npm run build`.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import { ClobWrapper, signedV2OrderHash } from "../../dist/live/clob/client.js";
import { PolymarketGateway } from "../../dist/platform/polymarket.js";
import { presignPrices, leadLimitPrice, leadShares } from "../../dist/strategies/binance-lead.js";

// --- the price plan: one limit per ask the strategy would buy ---
{
  const plan = presignPrices({ maxAsk: 0.8, limitPremium: 0.03, makerHoldSec: 0, shares: 5 }, 0.01);
  assert.equal(plan.length, 80, "asks 0.01..0.80 give limits 0.04..0.83");
  assert.deepEqual(plan.slice(0, 3), [{ price: 0.04, shares: 25 }, { price: 0.05, shares: 20 }, { price: 0.06, shares: 17 }], "1 USD minimum");
  assert.deepEqual(plan.at(-1), { price: 0.83, shares: 5 });
  for (let n = 1; n <= 80; n++) {
    const ask = Number((n / 100).toFixed(2));
    const limit = leadLimitPrice(ask, 0.03, 0.01);
    assert.ok(plan.some(p => p.price === limit && p.shares === leadShares(5, limit)), `ask ${ask} is covered`);
  }
  assert.deepEqual(presignPrices({ maxAsk: 0.8, limitPremium: 0.03, makerHoldSec: 3, shares: 5 }, 0.01), [], "a maker round signs nothing");
  const fine = presignPrices({ maxAsk: 0.8, limitPremium: 0.03, makerHoldSec: 0, shares: 5 }, 0.001);
  assert.equal(fine.length, 800, "tick 0.001: one per ask");
  assert.ok(fine.every(p => p.price <= 0.99));
  const high = presignPrices({ maxAsk: 0.98, limitPremium: 0.03, makerHoldSec: 0, shares: 5 }, 0.01);
  assert.ok(high.every(p => p.price <= 0.99) && high.some(p => p.price === 0.99), "the limit never passes 0.99");
}

// --- the client: presign, take once, fall back ---
const T = "1".repeat(77);
const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const signer = createWalletClient({ account, chain: polygon, transport: http("http://127.0.0.1:9") });
const creds = { key: "k", passphrase: "p", secret: randomBytes(32).toString("base64url") };
const sdk = new ClobClient({ host: "https://clob.polymarket.com", chain: 137, signer, creds, signatureType: 0, funderAddress: account.address });
sdk.tickSizes[T] = "0.01";
const wrapper = new ClobWrapper(sdk, account.address, account.address, creds, 0);
wrapper.negRiskByToken.set(T, false);
wrapper.requestTimeoutMs = 500;
const gateway = new PolymarketGateway(wrapper);
const realFetch = globalThis.fetch;
const NO_MATCH = "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.";
let bodies = [];
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/order") && init?.method === "POST") {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(JSON.stringify({ error: NO_MATCH, orderID: "0x" + "0".repeat(64) }), { status: 400 });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const submit = (price, shares) => {
  let prepared;
  return gateway.submit({ tokenId: T, price, shares, direction: "BUY", timeInForce: "FAK", postOnly: false },
    { tokenId: T, marketId: "0xm", tickSize: 0.01, minOrderSize: 5 }, p => { prepared = p; })
    .then(ack => ({ ack, prepared }));
};
try {
  await wrapper.presign(T, [0.6, 0.61], () => 5, 0.01);
  assert.equal(wrapper.presignedCount(), 2);
  // A hit: the stored order goes out, its hash is the one precomputed.
  const sdkSign = sdk.createOrder.bind(sdk);
  let signedOnTheSpot = 0;
  sdk.createOrder = (...args) => { signedOnTheSpot++; return sdkSign(...args); };
  const hit = await submit(0.6, 5);
  assert.equal(signedOnTheSpot, 0, "no signing at the signal");
  assert.equal(wrapper.presignedCount(), 1, "used once");
  assert.equal(hit.ack.status, "rejected", "the venue's answer is handled as before");
  assert.equal(hit.prepared.orderHash, signedV2OrderHash(hit.prepared.signedPayload, false), "the stored hash matches the order");
  assert.equal(bodies.at(-1).order.signature, hit.prepared.signedPayload.signature, "the POST carries the stored signature");
  assert.equal(Number(bodies.at(-1).order.makerAmount), 3_000_000, "5 x 0.60 USDC");
  // The same price again: the stored one is gone, sign on the spot.
  const again = await submit(0.6, 5);
  assert.equal(signedOnTheSpot, 1, "a used order is never posted twice");
  assert.notEqual(again.prepared.orderHash, hit.prepared.orderHash, "a fresh order, a new hash");
  // Another size at a stored price: no match.
  await submit(0.61, 6);
  assert.equal(signedOnTheSpot, 2, "size must match exactly");
  assert.equal(wrapper.presignedCount(), 1, "the 0.61 x 5 order is still there");
  // A CLOB version change makes stored signatures stale.
  wrapper.orderVersion = 99;
  await submit(0.61, 5);
  assert.equal(signedOnTheSpot, 3, "a stale version signs anew");
  assert.equal(wrapper.presignedCount(), 0, "and drops the stale order");
  wrapper.orderVersion = 2;
  // forgetPresigned drops a round's tokens.
  await wrapper.presign(T, [0.5, 0.51, 0.52], () => 5, 0.01);
  assert.equal(wrapper.presignedCount(), 3);
  wrapper.forgetPresigned([T]);
  assert.equal(wrapper.presignedCount(), 0);
  // A signing failure in the background never throws, and the order path still works.
  sdk.createOrder = () => Promise.reject(new Error("signer down"));
  await wrapper.presign(T, [0.7], () => 5, 0.01);
  assert.equal(wrapper.presignedCount(), 0);
  sdk.createOrder = sdkSign;
  const fallback = await submit(0.7, 5);
  assert.equal(fallback.ack.status, "rejected", "the spot signer still serves the signal");
  // Two presign calls for the same token run one after the other and do not double-sign.
  signedOnTheSpot = 0;
  sdk.createOrder = (...args) => { signedOnTheSpot++; return sdkSign(...args); };
  await Promise.all([wrapper.presign(T, [0.3, 0.31], () => 5, 0.01), wrapper.presign(T, [0.3, 0.31], () => 5, 0.01)]);
  assert.equal(wrapper.presignedCount(), 2);
  assert.equal(signedOnTheSpot, 2, "an order already stored is not signed again");
} finally { globalThis.fetch = realFetch; }
console.log("presign OK");
