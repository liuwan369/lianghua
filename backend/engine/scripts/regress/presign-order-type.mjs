// Review of 1bcc1cc: presigned orders are FAK orders, but takePresigned
// matched token/direction/price/size only, so the post-only GTC rest order at
// the FAK's limit and remaining size could post the presigned FAK signature.
// A GTC post-only order is always signed on the spot; the FAK presign at the
// same key stays stored, and a later FAK there still takes it.
// Real ClobWrapper + PolymarketGateway, fetch stubbed. Run after `npm run build`.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import { ClobWrapper } from "../../dist/live/clob/client.js";
import { PolymarketGateway } from "../../dist/platform/polymarket.js";

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
const bodies = [];
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/order") && init?.method === "POST") {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true, errorMsg: "", orderID: "0x" + "cd".repeat(32), status: "live",
      makingAmount: "0", takingAmount: "0", tradeIDs: [] }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const submit = (timeInForce, postOnly) => {
  let prepared;
  return gateway.submit({ tokenId: T, price: 0.6, shares: 5, direction: "BUY", timeInForce, postOnly },
    { tokenId: T, marketId: "0xm", tickSize: 0.01, minOrderSize: 5 }, p => { prepared = p; }).then(() => prepared);
};
try {
  await wrapper.presign(T, [0.6], () => 5, 0.01);
  assert.equal(wrapper.presignedCount(), 1);
  const sdkSign = sdk.createOrder.bind(sdk);
  let signedOnTheSpot = 0;
  sdk.createOrder = (...args) => { signedOnTheSpot++; return sdkSign(...args); };
  // The rest: GTC post-only at the presigned (token, BUY, 0.60, 5).
  const restOrder = await submit("GTC", true);
  assert.equal(signedOnTheSpot, 1, "a GTC post-only order is signed on the spot");
  assert.equal(wrapper.presignedCount(), 1, "the FAK presign is still stored");
  assert.equal(bodies.at(-1).orderType, "GTC");
  assert.equal(bodies.at(-1).postOnly, true);
  assert.equal(bodies.at(-1).order.signature, restOrder.signedPayload.signature);
  // A later FAK at that key takes the stored order.
  const fak = await submit("FAK", false);
  assert.equal(signedOnTheSpot, 1, "the FAK posts the presigned order");
  assert.equal(wrapper.presignedCount(), 0, "used once");
  assert.equal(bodies.at(-1).orderType, "FAK");
  assert.notEqual(fak.signedPayload.signature, restOrder.signedPayload.signature, "two distinct orders");
  // A plain GTC (not post-only) at a presigned key does not take it either.
  await wrapper.presign(T, [0.6], () => 5, 0.01);
  signedOnTheSpot = 0;
  await submit("GTC", false);
  assert.equal(signedOnTheSpot, 1, "a GTC is signed on the spot");
  assert.equal(wrapper.presignedCount(), 1);
} finally { globalThis.fetch = realFetch; }
console.log("presign-order-type OK");
