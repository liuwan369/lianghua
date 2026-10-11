// Quiet two-sided book (2026-10-11): nobody changes a price for a few seconds,
// the paired quote's exchange time passes 2 s and the console said "已过期"
// though the venue's book was unchanged. The collector now asks the venue's
// REST book; if both tops are the same it publishes quiet_confirmed_at. The
// row stays stale and unhealthy: live trading still requires fresh quotes.
//
// Drives the real runMarketSnapshot with a stub feed and stub REST books.
// Run after `npm run build`:  node scripts/regress/quiet-book.mjs
import assert from "node:assert/strict";
import { runMarketSnapshot } from "../../dist/cli/market-snapshot.js";

const ROUND = 1_800_000_000;
let now = ROUND + 100;
const market = { asset: "eth", slug: `eth-updown-5m-${ROUND}`, conditionId: "0xm", roundId: String(ROUND),
  start: ROUND, end: ROUND + 300, upToken: "up", downToken: "dn", tickSize: 0.01, minOrderSize: 5 };
const side = (assetId, bid, ask, at) => ({ assetId, bid, ask, sourceAt: at, expiresAt: at + 2, sequence: 7 });
const book = (at) => ({ kind: "book", snapshot: { source: "polymarket-ws", marketId: "0xm", roundId: String(ROUND),
  sequence: 7, sourceAt: at, expiresAt: at + 2, receivedAtUnix: at, tsUnix: at,
  YES: side("up", 0.56, 0.57, at), NO: side("dn", 0.43, 0.44, at) } });
let rest = { up: { bid: 0.56, ask: 0.57 }, dn: { bid: 0.43, ask: 0.44 } };
const asked = [];
const published = [];
let sink;
const abort = new AbortController();
const run = runMarketSnapshot({ assets: ["eth"], output: "unused", durationSec: 0, staleAfterMs: 2000,
  publishMs: 20, discoveryMs: 50, recordDays: 1 }, {
  now: () => now,
  discover: async () => market,
  feed: (s) => { sink = s; return { stop() {} }; },
  publish: (_path, value) => published.push(JSON.parse(JSON.stringify(value))),
  restBooks: async (tokens) => { asked.push(tokens); return new Map(tokens.map((t) => [t, { ...rest[t], at: now }])); },
}, abort.signal);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const row = () => published.at(-1).current_markets.find((item) => item.roundId === String(ROUND));
await wait(150);
sink(book(now));
await wait(60);
assert.equal(row().quote_fresh, true, "control: a fresh book");
assert.equal(row().quiet_confirmed_at ?? null, null, "control: no confirmation while fresh");

now += 4;                                    // nobody changed a price for 4 s
await wait(2300);                            // one quiet-check tick
const quiet = row();
assert.ok(asked.length >= 1, "the venue's REST book was asked");
assert.equal(quiet.quote_fresh, false, "the quote is still stale for trading");
assert.equal(quiet.healthy, false);
assert.equal(quiet.quiet_confirmed_at, now, `the unchanged book is confirmed; got ${JSON.stringify(quiet)}`);

rest = { up: { bid: 0.55, ask: 0.56 }, dn: { bid: 0.43, ask: 0.44 } };   // the venue moved, our feed did not
now += 1;
await wait(2300);
assert.equal(row().quiet_confirmed_at ?? null, null, "a REST book that differs is not confirmed: data may be missing");
abort.abort(); await run.catch(() => {});
console.log("quiet-book OK");
process.exit(0);
