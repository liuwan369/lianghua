// The order body sends deferExec false by default, as every official SDK does
// (2026-10-30: with true, 4 of 7 live FAKs took 1.9-2.9 s to match; with false
// 19 of 19 replied within 0.8 s). CLOB_DEFER_EXEC=1 sends true again. The real
// ClobWrapper posts to a local HTTP server that echoes what it received.
// Run after `npm run build`:  node scripts/regress/defer-exec.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createWalletClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";

const bodies = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", chunk => { raw += chunk; });
  req.on("end", () => {
    bodies.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.", orderID: "" }));
  });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
process.env.CLOB_HOST = `http://127.0.0.1:${server.address().port}`;
const { ClobWrapper } = await import("../../dist/live/clob/client.js");

const T = "1".repeat(77);
const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const signer = createWalletClient({ account, chain: polygon, transport: viemHttp("http://127.0.0.1:9") });
const creds = { key: "k", passphrase: "p", secret: randomBytes(32).toString("base64url") };
const sdk = new ClobClient({ host: process.env.CLOB_HOST, chain: 137, signer, creds, signatureType: 0, funderAddress: account.address });
sdk.tickSizes[T] = "0.01";
const wrapper = new ClobWrapper(sdk, account.address, account.address, creds, 0);
wrapper.negRiskByToken.set(T, false);
const order = { tokenId: T, price: 0.5, size: 5, tickSize: 0.01, direction: "BUY", timeInForce: "FAK", postOnly: false };
try {
  delete process.env.CLOB_DEFER_EXEC;
  assert.equal((await wrapper.submitOrder(order)).venueRefused, true);
  assert.equal(bodies.at(-1).deferExec, false, "default: deferExec false, as the official SDKs");
  process.env.CLOB_DEFER_EXEC = "0";
  await wrapper.submitOrder(order);
  assert.equal(bodies.at(-1).deferExec, false, "CLOB_DEFER_EXEC=0 (the 10-30 server override) still false");
  process.env.CLOB_DEFER_EXEC = "1";
  await wrapper.submitOrder(order);
  assert.equal(bodies.at(-1).deferExec, true, "CLOB_DEFER_EXEC=1 sends true");
} finally { server.closeAllConnections(); server.close(); }
console.log("defer-exec OK");
