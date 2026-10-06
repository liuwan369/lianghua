// Coin price in the recording (operator 2026-10-07): the 5-minute markets
// settle on the coin's price at the close against the open, so the recording
// needs the coin's own price next to the book. Binance only (operator: the
// 4-venue aggregator tripled the collector's CPU): one socket for all coins on
// the 1-second kline stream; each CLOSED bar is one row
// {t, a, r, k:"p", e (bar open second), p (close), o (open)}, tagged with the
// round in force at that second.
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
let referenceAssets;
const bar = (symbol, second, open, close, closed = true) =>
  ({ stream: `${symbol}@kline_1s`, data: { e: "kline", s: symbol.toUpperCase(), k: { t: second * 1000, o: String(open), c: String(close), x: closed } } });
const run = runMarketSnapshot({ assets: ["btc"], output: join(dir, "snap.json"), durationSec: 0, staleAfterMs: 2000,
  publishMs: 50, discoveryMs: 50, recordDir: join(dir, "hist"), recordDays: 10 }, {
  now: () => now,
  discover: async () => market,
  feed: () => ({ stop() {} }),
  reference: (onMessage, assets) => {
    referenceAssets = assets;
    setTimeout(() => {
      onMessage(bar("btcusdt", ROUND + 10, 100000, 100002, false));   // still forming: not recorded
      onMessage(bar("btcusdt", ROUND + 10, 100000, 100002));
      onMessage(bar("btcusdt", ROUND + 11, 100002, 100010));
      onMessage({ result: null, id: 1 });                               // control frames are ignored
      onMessage(bar("ethusdt", ROUND + 11, 2600, 2601));                // a coin not recorded here
    }, 60);
    return { stop() {} };
  },
  publish: () => {},
}, abort.signal);
await new Promise((resolve) => setTimeout(resolve, 400));
abort.abort(); await run.catch(() => {});
const files = readdirSync(join(dir, "hist", "btc"));
const rows = gunzipSync(readFileSync(join(dir, "hist", "btc", files[0]))).toString().trim().split("\n").map((l) => JSON.parse(l));
rmSync(dir, { recursive: true, force: true });
const prices = rows.filter((row) => row.k === "p");
assert.deepEqual(referenceAssets, ["btc"], "one Binance socket for the recorded coins");
assert.equal(prices.length, 2, `one row per closed 1 s bar; got ${JSON.stringify(prices)}`);
assert.deepEqual([prices[0].p, prices[0].o, prices[0].e], [100002, 100000, ROUND + 10]);
assert.equal(prices[1].p, 100010);
assert.equal(prices[0].r, String(ROUND), "tagged with the round in force at that second");
console.log("recorder-reference OK");
process.exit(0);
