// P0-3: every 2 s the engine writes one platform_status line holding
// ALL strategy rounds plus every market / snapshot / book it has ever seen,
// none of which is ever pruned. The ledger reads 256 KB per pass and marks the
// run broken once a single line exceeds it (~4 h continuous); the journal
// refuses a critical line over 1 MB and the engine stops itself (~17 h), and
// because the state file is reused across runs, every later start stops too.
//
// Fix under test: summaryView() bounds each status line. It keeps the current
// round and any round still needing work (an active order or unsettled
// position); it drops the rest from the LINE only. The strategy's own state is
// untouched, so settlement recovery still sees every round. (Until 2026-11-14
// it also kept the 8 most recent rounds: 14 KB of a 50 KB line every 2 s that
// the console never read.)
//
// Run after `npm run build`:  node scripts/regress/P0-3.mjs
import assert from "node:assert/strict";
import { summaryView } from "../../dist/cli/platform.js";

const START = 1_800_000_000;
const mkRound = (i, extra = {}) => ({ marketId: `0x${String(i).padStart(64, "0")}`, roundId: String(START + i * 300),
  startsAt: START + i * 300, endsAt: START + i * 300 + 300, status: "ended", upTokenId: `u${i}`, downTokenId: `d${i}`,
  stages: [], reason: "本场已结束", config: { shares: 5 }, ...extra });
const mkMarket = (i) => ({ id: `0x${String(i).padStart(64, "0")}`, roundId: String(START + i * 300),
  startsAt: START + i * 300, endsAt: START + i * 300 + 300, instruments: [{ tokenId: `u${i}` }, { tokenId: `d${i}` }] });

// 1000 ended rounds, then the current one.
const N = 1000;
const rounds = Array.from({ length: N }, (_, i) => mkRound(i));
const current = mkRound(N, { status: "running" });
rounds.push(current);
const markets = Array.from({ length: N + 1 }, (_, i) => mkMarket(i));
// Round 5 is old but still holds an unsettled position; round 7 has a live order.
const needsWork = new Set([markets[5].id, markets[7].id]);
const now = START + N * 300 + 60;

const view = summaryView({ rounds, currentRound: current, markets, now, currentMarketId: markets[N].id,
  needsWork: (marketId) => needsWork.has(marketId) });

// --- bug: the old line carried everything and blew the ledger's 256 KB budget ---
const unbounded = Buffer.byteLength(JSON.stringify({ rounds, markets }));
assert.ok(unbounded > 256 * 1024, `old unbounded line should exceed 256 KB; got ${unbounded}`);
// --- size: the line must stay far below the ledger's 256 KB read budget ---
const size = Buffer.byteLength(JSON.stringify(view));
assert.ok(size < 64 * 1024, `status line must stay small; got ${size} bytes for ${N} rounds`);
// --- contents: current + recent + needs-work kept, the rest dropped ---
const ids = new Set(view.rounds.map((r) => r.marketId));
assert.ok(!ids.has(current.marketId), "the current round rides as currentRound, not twice");
assert.ok(!ids.has(rounds[N - 1].marketId), "a recent, fully resolved round is dropped (the console never read it)");
assert.ok(ids.has(markets[5].id), "an old round with an unsettled position is kept (never drop a pending redemption)");
assert.ok(ids.has(markets[7].id), "an old round with a live order is kept");
assert.ok(!ids.has(markets[100].id), "an old, fully resolved round is dropped from the line");
// Markets follow the same rule: ended markets drop unless they still need work.
const mids = new Set(view.markets.map((m) => m.id));
assert.ok(mids.has(markets[N].id), "the current market is kept");
assert.equal(view.markets.length, 1, "and nothing else: rounds 5 and 7 name their own markets");
assert.ok(!mids.has(markets[5].id), "a settling market is named by its kept round, not twice");
const orphan = summaryView({ rounds: [current], currentRound: current, markets, now, currentMarketId: markets[N].id,
  needsWork: (marketId) => marketId === markets[3].id });
assert.ok(orphan.markets.some((m) => m.id === markets[3].id),
  "a market needing work without a strategy round (older run's position) keeps its identity");
assert.ok(!mids.has(markets[100].id), "an ended, resolved market is dropped");
// --- books: only the current market's. Ended markets' books were 25 KB of a
// 41 KB line (2026-10-13); the next, not yet open market's book is not shown
// either (GET /api/runtime/book reads the current round only). ---
const upcoming = { id: "0xnext", roundId: String(START + (N + 1) * 300), startsAt: START + (N + 1) * 300,
  endsAt: START + (N + 2) * 300, instruments: [] };
const withNext = summaryView({ rounds, currentRound: current, markets: [...markets, upcoming], now,
  currentMarketId: markets[N].id, needsWork: (marketId) => needsWork.has(marketId) });
const quoted = new Set(withNext.quotedMarketIds);
assert.deepEqual([...quoted], [markets[N].id], "only the running market's book is kept");
assert.ok(!withNext.markets.some((m) => m.id === "0xnext"), "the next market joins the line when it opens");
assert.ok(!quoted.has(markets[5].id), "an ended market still settling needs no book");
console.log(`P0-3: ${N} rounds -> status line ${size} bytes, ${view.rounds.length} rounds, ${view.markets.length} markets`);
console.log("P0-3 OK");
