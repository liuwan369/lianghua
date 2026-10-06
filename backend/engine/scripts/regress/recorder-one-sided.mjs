// Recording blind spot: near the close the winning side has no asks, the feed
// called the book incomplete and nothing was recorded, so the last ~50 s of
// every round had trades but no book (btc: last book at 242 s, last trade at
// 291 s). A one-sided top is now recorded as a row of kind "o".
//
// Drives the real runMarketSnapshot with a stub feed that emits one book and
// then a bookTop with UP's ask empty; checks the recording file.
// Run after `npm run build`:  node scripts/regress/recorder-one-sided.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { runMarketSnapshot } from "../../dist/cli/market-snapshot.js";

const dir = mkdtempSync(join(tmpdir(), "rec1-"));
const ROUND = 1_800_000_000, now = ROUND + 280;
const market = { asset: "btc", slug: `btc-updown-5m-${ROUND}`, conditionId: "0xm", roundId: String(ROUND),
  start: ROUND, end: ROUND + 300, upToken: "up", downToken: "dn", tickSize: 0.01, minOrderSize: 5 };
const abort = new AbortController();
const run = runMarketSnapshot({ assets: ["btc"], output: join(dir, "snap.json"), durationSec: 0, staleAfterMs: 2000,
  publishMs: 50, discoveryMs: 50, recordDir: join(dir, "hist"), recordDays: 10 }, {
  now: () => now,
  discover: async () => market,
  feed: (sink) => {
    setTimeout(() => sink({ kind: "bookTop", marketId: "0xm", roundId: String(ROUND), tsUnix: now,
      upBid: 0.99, upAsk: undefined, downBid: undefined, downAsk: 0.01, downAskLevels: [[0.01, 5000]] }), 30);
    return { stop() {} };
  },
  publish: () => {}, reference: () => ({ stop() {} }),
}, abort.signal);
await new Promise((resolve) => setTimeout(resolve, 400));
abort.abort(); await run.catch(() => {});
const files = readdirSync(join(dir, "hist", "btc"));
const rows = gunzipSync(readFileSync(join(dir, "hist", "btc", files[0]))).toString().trim().split("\n").map((l) => JSON.parse(l));
rmSync(dir, { recursive: true, force: true });
const top = rows.find((row) => row.k === "o");
assert.ok(top, `a one-sided book is recorded; got ${JSON.stringify(rows)}`);
assert.equal(top.ub, 0.99); assert.equal(top.ua, undefined, "the empty side stays empty");
assert.equal(top.da, 0.01); assert.equal(top.r, String(ROUND));
console.log("recorder-one-sided OK");
process.exit(0);
