// One-sided book near the close (2026-10-10, new server): the winner's ask
// goes empty, the feed sends bookTop instead of a paired book, and the
// collector kept publishing the last two-sided quote. The console then froze on
// it and said "已过期" for up to ~90 s, though the venue was live and quoting
// "bid 0.98, ask: none". The collector now publishes that top as `one_sided`
// on the row; the paired snapshot and its health stay untouched, so nothing
// one-sided can reach the strategy.
//
// Drives the real runMarketSnapshot with a stub feed: one paired book, then a
// one-sided top three seconds later.
// Run after `npm run build`:  node scripts/regress/one-sided-display.mjs
import assert from "node:assert/strict";
import { runMarketSnapshot } from "../../dist/cli/market-snapshot.js";

const ROUND = 1_800_000_000;
let now = ROUND + 240;
const market = { asset: "sol", slug: `sol-updown-5m-${ROUND}`, conditionId: "0xm", roundId: String(ROUND),
  start: ROUND, end: ROUND + 300, upToken: "up", downToken: "dn", tickSize: 0.01, minOrderSize: 5 };
const side = (assetId, bid, ask, at, sequence) => ({ assetId, bid, ask, sourceAt: at, expiresAt: at + 2, sequence });
const book = (at, sequence) => ({ kind: "book", snapshot: { source: "polymarket-ws", marketId: "0xm", roundId: String(ROUND),
  sequence, sourceAt: at, expiresAt: at + 2, receivedAtUnix: at, tsUnix: at,
  YES: side("up", 0.97, 0.99, at, sequence), NO: side("dn", 0.01, 0.03, at, sequence) } });
const published = [];
let sink;
const abort = new AbortController();
const run = runMarketSnapshot({ assets: ["sol"], output: "unused", durationSec: 0, staleAfterMs: 2000,
  publishMs: 20, discoveryMs: 50, recordDays: 1 }, {
  now: () => now,
  discover: async () => market,
  feed: (s) => { sink = s; return { stop() {} }; },
  publish: (_path, value) => published.push(JSON.parse(JSON.stringify(value))),
}, abort.signal);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(150);
sink(book(now, 7));
await wait(80);
const paired = published.at(-1).current_markets.find((row) => row.roundId === String(ROUND));
assert.equal(paired.quote_fresh, true, "control: a paired book is fresh");
assert.equal(paired.one_sided ?? null, null, "control: no one-sided top while the book is two-sided");

now += 3;
sink({ kind: "bookTop", marketId: "0xm", roundId: String(ROUND), tsUnix: now,
  upBid: 0.98, upAsk: undefined, downBid: undefined, downAsk: 0.02 });
await wait(80);
abort.abort(); await run.catch(() => {});
const row = published.at(-1).current_markets.find((item) => item.roundId === String(ROUND));
assert.equal(row.quote_fresh, false, "the paired quote is still reported stale: trading gating is unchanged");
assert.equal(row.healthy, false, "the row is still unhealthy for trading");
assert.equal(row.snapshot.YES.ask, 0.99, "the paired snapshot itself is untouched");
assert.ok(row.one_sided, `the one-sided top is published; got ${JSON.stringify(row)}`);
assert.equal(row.one_sided.at, now);
assert.equal(row.one_sided.up_bid, 0.98);
assert.equal(row.one_sided.up_ask, null, "the empty side is null, not an old price");
assert.equal(row.one_sided.down_bid, null);
assert.equal(row.one_sided.down_ask, 0.02);
console.log("one-sided-display OK");
process.exit(0);
