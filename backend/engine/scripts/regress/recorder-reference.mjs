// Coin price in the recording (operator 2026-10-07): the 5-minute markets
// settle on the coin's price at the close against the open, so the recording
// needs the coin's own price next to the book. The collector runs the existing
// reference aggregator per coin and writes at most one row per coin per second:
// {t, a, r, k:"p", e (venue time), p (price)}, tagged with the round in force.
//
// Drives the real runMarketSnapshot with stub feeds.
// Run after `npm run build`:  node scripts/regress/recorder-reference.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { runMarketSnapshot } from "../../dist/cli/market-snapshot.js";

const dir = mkdtempSync(join(tmpdir(), "recref-"));
const ROUND = 1_800_000_000;
let now = ROUND + 10;
const market = { asset: "btc", slug: `btc-updown-5m-${ROUND}`, conditionId: "0xm", roundId: String(ROUND),
  start: ROUND, end: ROUND + 300, upToken: "up", downToken: "dn", tickSize: 0.01, minOrderSize: 5 };
const abort = new AbortController();
let referenceAsset;
const run = runMarketSnapshot({ assets: ["btc"], output: join(dir, "snap.json"), durationSec: 0, staleAfterMs: 2000,
  publishMs: 50, discoveryMs: 50, recordDir: join(dir, "hist"), recordDays: 10 }, {
  now: () => now,
  discover: async () => market,
  feed: () => ({ stop() {} }),
  reference: (sink, asset) => {
    referenceAsset = asset;
    // Three updates in the same second, then one a second later: two rows.
    setTimeout(() => {
      sink({ kind: "btc", asset: "btc", tsUnix: ROUND + 10.1, price: 100000 });
      sink({ kind: "btc", asset: "btc", tsUnix: ROUND + 10.5, price: 100001 });
      sink({ kind: "btc", asset: "btc", tsUnix: ROUND + 10.9, price: 100002 });
      now = ROUND + 11.2;
      sink({ kind: "btc", asset: "btc", tsUnix: ROUND + 11.2, price: 100010 });
    }, 60);
    return { stop() {}, getStatus: () => ({}) };
  },
  publish: () => {},
}, abort.signal);
await new Promise((resolve) => setTimeout(resolve, 400));
abort.abort(); await run.catch(() => {});
const files = readdirSync(join(dir, "hist", "btc"));
const rows = gunzipSync(readFileSync(join(dir, "hist", "btc", files[0]))).toString().trim().split("\n").map((l) => JSON.parse(l));
rmSync(dir, { recursive: true, force: true });
const prices = rows.filter((row) => row.k === "p");
assert.equal(referenceAsset, "btc", "the reference feed runs for each recorded coin");
assert.equal(prices.length, 2, `at most one price row per second; got ${JSON.stringify(prices)}`);
assert.equal(prices[0].p, 100000); assert.equal(prices[1].p, 100010);
assert.equal(prices[0].r, String(ROUND), "tagged with the round in force");
assert.equal(prices[0].e, ROUND + 10.1, "venue time kept");
console.log("recorder-reference OK");
process.exit(0);
