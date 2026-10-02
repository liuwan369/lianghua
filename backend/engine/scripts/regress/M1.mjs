// BUGS M1 (second audit): the collector's periodic 15 s discovery asked for the
// current AND the next round on every tick. Gamma lists the next market as soon
// as the current round starts, so its sockets opened ~296 s early instead of at
// the 75 s prewarm: double the sockets and reconnect churn on all 7 coins.
//
// Drives the real runMarketSnapshot with a stub clock, discovery and feed:
// 60 s into a round no feed for the next round may be open.
// Run after `npm run build`:  node scripts/regress/M1.mjs
import assert from "node:assert/strict";
import { runMarketSnapshot } from "../../dist/cli/market-snapshot.js";

const ROUND = 1_800_000_000;
const now = ROUND + 60;
const market = (start) => ({ asset: "btc", slug: `btc-updown-5m-${start}`, conditionId: `0x${start}`, roundId: String(start),
  start, end: start + 300, upToken: `up${start}`, downToken: `down${start}`, tickSize: 0.01, minOrderSize: 5 });
const opened = [];
const abort = new AbortController();
const run = runMarketSnapshot({ assets: ["btc"], output: "unused", durationSec: 0, staleAfterMs: 2000, publishMs: 1000, discoveryMs: 50, recordDays: 1 }, {
  now: () => now,
  discover: async (at) => market(Math.floor(at / 300) * 300),
  feed: (_sink, up) => { opened.push(up); return { stop() {} }; },
  publish: () => {},
}, abort.signal);
await new Promise((resolve) => setTimeout(resolve, 300));
abort.abort();
await run.catch(() => {});
assert.ok(opened.includes(`up${ROUND}`), "control: the current round's feed opens");
assert.ok(!opened.includes(`up${ROUND + 300}`), `M1: 240 s before it starts the next round has no feed yet; opened ${[...new Set(opened)]}`);
console.log("M1 OK");
process.exit(0);
