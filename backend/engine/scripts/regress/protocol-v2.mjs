// Polymarket Protocol V2 (docs migrate/polymarket-v2, 2026-11): new markets
// trade on ExchangeV3 (EIP-712 domain version "3",
// 0xe3333700cA9d93003F00f0F71f8515005F6c00Aa) with V2 position IDs; CTF (V1)
// markets keep domain "2" and their exchange. BTC 5m traded on V2 11-24 1:00-
// 1:15 PM ET only; our 3 orders then were refused "invalid POLY_1271 signature:
// signature does not match order hash" (signed for the V1 exchange).
// - discovery: a Gamma market with version "v2" gives its positionIds (an
//   array) and is marked v2; "v1" keeps clobTokenIds; any other version is
//   rejected (docs: "Reject missing or unsupported versions");
// - the client learns a market's version from /clob-markets ("v": "v1"/"v2");
//   a V2 token's order is signed under domain "3" / ExchangeV3, its durable hash
//   is that domain's, and a presigned V2 order posts the same way;
// - a V1 token is signed exactly as before (domain "2", CTF Exchange V2).
// Run after `npm run build`:  node scripts/regress/protocol-v2.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWalletClient, http, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import { parseMarket } from "../../dist/live/discovery.js";
import { ClobWrapper, signedV2OrderHash } from "../../dist/live/clob/client.js";

const EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
const EXCHANGE_V3 = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";
const UP2 = "798179898617452349377818383492013402217559367369383810129520465787159052288";
const DOWN2 = "798179898617452349377818383492013402217559367369383810129520465787159052289";
const UP1 = "93455411843972578999076137600262092130765419370434050704333490982864173375576";
const DOWN1 = "51877843767974679584945941425779048856773069806396187625231520161118011742360";

// --- discovery: the trading ID by version (Gamma, the 11-24 test round and a V1 one) ---
const gamma = (extra) => ({ slug: "btc-updown-5m-1795543200", conditionId: "0x01c3", outcomes: '["Up", "Down"]', closed: false, ...extra });
{
  const v2 = parseMarket(gamma({ version: "v2", positionIds: [UP2, DOWN2], clobTokenIds: JSON.stringify(["1", "2"]) }));
  assert.equal(v2?.version, "v2");
  assert.deepEqual([v2.upToken, v2.downToken], [UP2, DOWN2], "v2: positionIds, even with clobTokenIds present");
  const v1 = parseMarket(gamma({ version: "v1", clobTokenIds: JSON.stringify([UP1, DOWN1]) }));
  assert.equal(v1?.version, "v1");
  assert.deepEqual([v1.upToken, v1.downToken], [UP1, DOWN1]);
  // Down listed first: the index follows outcomes.
  const flipped = parseMarket(gamma({ version: "v2", outcomes: '["Down", "Up"]', positionIds: [DOWN2, UP2] }));
  assert.deepEqual([flipped.upToken, flipped.downToken], [UP2, DOWN2]);
  // Before Gamma carried a version every market was CTF: no version = v1.
  assert.equal(parseMarket(gamma({ clobTokenIds: JSON.stringify([UP1, DOWN1]) }))?.version, "v1");
  assert.equal(parseMarket(gamma({ version: "v3", positionIds: [UP2, DOWN2] })), undefined, "unsupported version");
  assert.equal(parseMarket(gamma({ version: "v2" })), undefined, "v2 without positionIds");
  assert.equal(parseMarket(gamma({ version: "v2", positionIds: [UP2, "x1"] })), undefined, "non-decimal ID");
}

// --- signing: the client picks the exchange from the market's version ---
const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const signer = createWalletClient({ account, chain: polygon, transport: http("http://127.0.0.1:9") });
const creds = { key: "k", passphrase: "p", secret: randomBytes(32).toString("base64url") };
const sdk = new ClobClient({ host: "https://clob.polymarket.com", chain: 137, signer, creds, signatureType: 0, funderAddress: account.address });
const wrapper = new ClobWrapper(sdk, account.address, account.address, creds, 0);
wrapper.requestTimeoutMs = 500;
const market = (cid, v, up, down) => ({ r: { mi: 50, ma: 4.5 }, t: [{ t: up, o: "Up" }, { t: down, o: "Down" }], c: cid,
  mos: 5, mts: 0.01, itode: true, fd: { r: 0.05, e: 1 }, v });
const markets = { "0xv2": market("0xv2", "v2", UP2, DOWN2), "0xv1": market("0xv1", "v1", UP1, DOWN1) };
// The SDK reads /clob-markets through its own HTTP client, not fetch.
sdk.getClobMarketInfo = async (cid) => markets[cid];
for (const t of [UP2, DOWN2, UP1, DOWN1]) { sdk.tickSizes[t] = "0.01"; }
const posted = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/version")) return new Response(JSON.stringify({ version: 2 }), { status: 200 });
  if (u.endsWith("/order") && init?.method === "POST") {
    posted.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true, orderID: "0x" + "1".repeat(64), status: "live" }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${u}`);
};
const FIELDS = [["salt", "uint256"], ["maker", "address"], ["signer", "address"], ["tokenId", "uint256"], ["makerAmount", "uint256"],
  ["takerAmount", "uint256"], ["side", "uint8"], ["signatureType", "uint8"], ["timestamp", "uint256"], ["metadata", "bytes32"], ["builder", "bytes32"]];
const signedFor = async (order) => {
  const message = Object.fromEntries(FIELDS.map(([k]) => [k, order[k]]));
  message.side = order.side === "BUY" || order.side === 0 ? 0 : 1;
  for (const [version, verifyingContract] of [["2", EXCHANGE_V2], ["3", EXCHANGE_V3]]) {
    const who = await recoverTypedDataAddress({ domain: { name: "Polymarket CTF Exchange", version, chainId: 137, verifyingContract },
      types: { Order: FIELDS.map(([name, type]) => ({ name, type })) }, primaryType: "Order", message, signature: order.signature });
    if (who.toLowerCase() === account.address.toLowerCase()) return version;
  }
  return null;
};
try {
  await wrapper.warmMarket("0xv2", 2000, 1);
  await wrapper.warmMarket("0xv1", 2000, 1);
  const submit = async (tokenId) => {
    let prepared;
    const r = await wrapper.submitOrder({ tokenId, price: 0.5, size: 5, tickSize: 0.01, direction: "BUY", timeInForce: "GTC",
      postOnly: false, onPrepared: p => { prepared = p; } });
    return { r, prepared };
  };
  const v2 = await submit(UP2);
  assert.equal(v2.r.success, true, v2.r.errorMsg);
  assert.equal(await signedFor(v2.prepared.signedPayload), "3", "a V2 token is signed for ExchangeV3");
  assert.equal(String(v2.prepared.signedPayload.tokenId), UP2, "with its position ID");
  assert.equal(v2.prepared.orderHash, signedV2OrderHash(v2.prepared.signedPayload, false, 3), "the durable hash is the V3 domain's");
  assert.equal(posted.at(-1).order.signature, v2.prepared.signedPayload.signature);
  const v1 = await submit(UP1);
  assert.equal(await signedFor(v1.prepared.signedPayload), "2", "a V1 token is signed as before");
  assert.equal(v1.prepared.orderHash, signedV2OrderHash(v1.prepared.signedPayload, false), "V1 hash unchanged");
  // Presigned: the stored V2 order is the V3 domain's, and is what posts.
  await wrapper.presign(DOWN2, [0.6], () => 5, 0.01);
  assert.equal(wrapper.presignedCount(), 1);
  const pre = await (async () => {
    let prepared;
    await wrapper.submitOrder({ tokenId: DOWN2, price: 0.6, size: 5, tickSize: 0.01, direction: "BUY", timeInForce: "FAK",
      postOnly: false, onPrepared: p => { prepared = p; } });
    return prepared;
  })();
  assert.equal(wrapper.presignedCount(), 0, "the stored order was used");
  assert.equal(await signedFor(pre.signedPayload), "3", "a presigned V2 order is signed for ExchangeV3");
  assert.equal(pre.orderHash, signedV2OrderHash(pre.signedPayload, false, 3));
} finally {
  globalThis.fetch = realFetch;
}
console.log("protocol-v2 OK");
