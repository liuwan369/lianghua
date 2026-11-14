// Review of 1bcc1cc: the rest order is a post-only GTC. When it would cross,
// the venue refuses it with HTTP 400 "invalid post-only order: order crosses
// book" (docs/resources/error-codes) and an order id. client.ts set
// venueRefused only for a FAK, so the gateway answered "unknown", the core
// marked the order UNKNOWN and halted for reconciliation.
// A post-only order the venue refused for crossing never traded: REJECTED,
// nothing reserved, no reconciliation. A reply that names a trade or an amount
// still does not end it.
// Real ClobWrapper + PolymarketGateway (fetch stubbed) inside a real TradingPlatform.
// Run after `npm run build`:  node scripts/regress/post-only-crossed.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import { ClobWrapper } from "../../dist/live/clob/client.js";
import { PolymarketGateway } from "../../dist/platform/polymarket.js";
import { TradingPlatform } from "../../dist/platform/platform.js";

const T = "1".repeat(77), DOWN = "2".repeat(77), START = 1_800_000_000;
const CROSSES = "invalid post-only order: order crosses book";
const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const signer = createWalletClient({ account, chain: polygon, transport: http("http://127.0.0.1:9") });
const creds = { key: "k", passphrase: "p", secret: randomBytes(32).toString("base64url") };
const sdk = new ClobClient({ host: "https://clob.polymarket.com", chain: 137, signer, creds, signatureType: 0, funderAddress: account.address });
sdk.tickSizes[T] = "0.01";
const wrapper = new ClobWrapper(sdk, account.address, account.address, creds, 0);
wrapper.negRiskByToken.set(T, false);
wrapper.requestTimeoutMs = 200;
const gateway = new PolymarketGateway(wrapper);
const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: T, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };

const realFetch = globalThis.fetch;
let posted;
async function submit(reply, order) {
  globalThis.fetch = async (url, init) => {
    if (!(String(url).endsWith("/order") && init?.method === "POST")) throw new Error(`unexpected fetch ${url}`);
    posted = JSON.parse(init.body);
    const [status, body] = reply(posted);
    return new Response(JSON.stringify(body), { status });
  };
  try {
    const platform = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: 100, positions: [], openOrders: [], complete: true },
      instruments: market.instruments, limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, now: () => START + 22,
      adapters: { gateway: venue, estimateFee: () => 0 } });
    platform.ingest({ kind: "market", market });
    const result = await platform.core.submit({ clientOrderId: "binance-lead:0xm:rest", strategyId: "binance-lead", tokenId: T,
      direction: "BUY", price: 0.42, shares: 5, ...order });
    return { order: result, risk: platform.core.risk() };
  } finally { globalThis.fetch = realFetch; }
}
const rest = { timeInForce: "GTC", postOnly: true };
// The venue's orderID is the signed order's hash (the real gateway, its
// prepared callback observed on the way to the core).
let hash;
const venue = { mode: "live", durableIdentity: true, cancel: () => gateway.cancel?.(),
  submit: (request, instrument, prepared, timing) => gateway.submit(request, instrument,
    value => { hash = value.orderHash; prepared?.(value); }, timing) };
const orderId = () => hash;

// The venue refuses the post-only rest for crossing, with an order id.
{
  const { order, risk } = await submit(body => [400, { error: CROSSES, orderID: orderId(body) }], rest);
  assert.equal(posted.postOnly, true, "the wire order is post-only");
  assert.equal(posted.orderType, "GTC", "and a GTC");
  assert.equal(order.status, "REJECTED", "a post-only refused for crossing ends REJECTED, not UNKNOWN");
  assert.equal(order.reservedUsd, 0, "its reservation is released");
  assert.equal(order.error, CROSSES, "the venue's words reach the order");
  assert.equal(risk.reconciliationRequired, false, "nothing to reconcile");
  assert.equal(risk.halted, false, "the account trades on");
  assert.deepEqual(risk.blockedMarketIds, [], "the market is free");
}
// Without an order id: the same.
{
  const { order, risk } = await submit(() => [400, { error: CROSSES }], rest);
  assert.equal(order.status, "REJECTED");
  assert.equal(risk.halted, false);
}
// A reply that names a trade is not proof of no trade: it stays UNKNOWN.
{
  const { order } = await submit(body => [400, { error: CROSSES, orderID: orderId(body), tradeIDs: ["t1"] }], rest);
  assert.equal(order.status, "UNKNOWN", "a trade id keeps it for reconciliation");
}
// The crossing text on an order that is not post-only is not this refusal.
{
  const { order } = await submit(body => [400, { error: CROSSES, orderID: orderId(body) }], { timeInForce: "GTC", postOnly: false });
  assert.equal(order.status, "UNKNOWN", "a non-post-only GTC with an id stays UNKNOWN");
}
console.log("post-only-crossed OK");
