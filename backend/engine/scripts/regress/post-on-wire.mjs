// The order's post-send work (broadcasts) must not delay the POST bytes
// (review 2026-10-29: run right after fetch(), 20 ms of work delayed the
// request by 20 ms; fetch() only queues it). The real ClobWrapper posts to a
// local HTTP server (another process, as the venue is) through the same undici
// Agent as live; onPostSent does 25 ms of synchronous work. The server must
// receive the request well before that work ends, and the work must still run
// exactly once per order.
// Run after `npm run build`:  node scripts/regress/post-on-wire.mjs
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Agent, setGlobalDispatcher } from "undici";
import { createWalletClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";

// The venue: its own process, so our busy work cannot stall its receive. It
// stamps arrival on the shared monotonic clock (hrtime is process-independent).
const dir = mkdtempSync(join(tmpdir(), "post-on-wire-"));
const serverFile = join(dir, "venue.mjs");
writeFileSync(serverFile, `import http from "node:http";
const server = http.createServer((req, res) => {
  const at = String(process.hrtime.bigint());
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.", orderID: "", arrivedNs: at }));
  });
});
server.listen(0, "127.0.0.1", () => process.send(server.address().port));`);
const venue = fork(serverFile);
const port = await new Promise(r => venue.once("message", r));
process.env.CLOB_HOST = `http://127.0.0.1:${port}`;
let arrivedAt;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await realFetch(...args);
  const text = await response.text();
  try { const ns = JSON.parse(text).arrivedNs; if (ns) arrivedAt = Number(BigInt(ns)) / 1e6; } catch {}
  return new Response(text, { status: response.status, headers: response.headers });
};
const now = () => Number(process.hrtime.bigint()) / 1e6;
setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, pipelining: 1 }));
const { ClobWrapper } = await import("../../dist/live/clob/client.js");

const T = "1".repeat(77);
const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const signer = createWalletClient({ account, chain: polygon, transport: viemHttp("http://127.0.0.1:9") });
const creds = { key: "k", passphrase: "p", secret: randomBytes(32).toString("base64url") };
const sdk = new ClobClient({ host: process.env.CLOB_HOST, chain: 137, signer, creds, signatureType: 0, funderAddress: account.address });
sdk.tickSizes[T] = "0.01";
const wrapper = new ClobWrapper(sdk, account.address, account.address, creds, 0);
wrapper.negRiskByToken.set(T, false);
wrapper.requestTimeoutMs = 2000;
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };
const leads = [];
try {
  // warm the socket as live does
  await wrapper.submitOrder({ tokenId: T, price: 0.5, size: 5, tickSize: 0.01, direction: "BUY", timeInForce: "FAK", postOnly: false });
  for (let i = 0; i < 6; i++) {
    let sentRuns = 0, workStartedAt;
    arrivedAt = undefined;
    const result = await wrapper.submitOrder({ tokenId: T, price: 0.5, size: 5, tickSize: 0.01, direction: "BUY", timeInForce: "FAK",
      postOnly: false, onPostSent: () => { sentRuns++; workStartedAt = now(); busy(25); } });
    assert.equal(sentRuns, 1, "the post-send work runs once");
    assert.equal(result.venueRefused, true, "the venue's no-match ends the FAK as before");
    assert.ok(arrivedAt !== undefined, "the server got the order");
    leads.push(workStartedAt + 25 - arrivedAt);
  }
  leads.sort((a, b) => a - b);
  // The request reaches the server before the 25 ms of work ends (it started
  // after the bytes left); with the old placement it arrived after the work.
  assert.ok(leads[3] > 15, `the POST reached the server ${leads[3].toFixed(1)} ms before the post-send work ended`);
  // No onPostSent: nothing to wait for, the path is unchanged.
  const plain = await wrapper.submitOrder({ tokenId: T, price: 0.5, size: 5, tickSize: 0.01, direction: "BUY", timeInForce: "FAK", postOnly: false });
  assert.equal(plain.venueRefused, true);
} finally { venue.kill(); rmSync(dir, { recursive: true, force: true }); }
console.log("post-on-wire OK");
process.exit(0);
