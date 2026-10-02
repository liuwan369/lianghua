// P0-3: every 2 s the engine writes one platform_status line holding
// ALL strategy rounds plus every market / snapshot / book it has ever seen,
// none of which is ever pruned. The ledger reads 256 KB per pass and marks the
// run broken once a single line exceeds it (~4 h continuous); the journal
// refuses a critical line over 1 MB and the engine stops itself (~17 h), and
// because the state file is reused across runs, every later start stops too.
//
// Fix under test: summaryView() bounds each status line. It keeps the current
// round, the recent rounds the ledger shows (rounds[-8:]), and any round still
// needing work (an active order or unsettled position); it drops the rest from
// the LINE only. The strategy's own state is untouched, so settlement recovery
// still sees every round.
//
// Run after `npm run build`:  node scripts/regress/P0-3.mjs
import assert from "node:assert/strict";
import { summaryView, STATUS_RECENT_ROUNDS } from "../../dist/cli/platform.js";

const START = 1_800_000_000;
const mkRound = (i, extra = {}) => ({ marketId: `0x${String(i).padStart(64, "0")}`, roundId: String(START + i * 300),
  startsAt: START + i * 300, endsAt: START + i * 300 + 300, status: "ended", upTokenId: `u${i}`, downTokenId: `d${i}`,
  stages: [], reason: "本场已结束", config: { maxStages: 4 }, ...extra });
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

const view = summaryView({ rounds, currentRound: current, markets, now,
  needsWork: (marketId) => needsWork.has(marketId) });

// --- bug: the old line carried everything and blew the ledger's 256 KB budget ---
const unbounded = Buffer.byteLength(JSON.stringify({ rounds, markets }));
assert.ok(unbounded > 256 * 1024, `old unbounded line should exceed 256 KB; got ${unbounded}`);
// --- size: the line must stay far below the ledger's 256 KB read budget ---
const size = Buffer.byteLength(JSON.stringify(view));
assert.ok(size < 64 * 1024, `status line must stay small; got ${size} bytes for ${N} rounds`);
// --- contents: current + recent + needs-work kept, the rest dropped ---
const ids = new Set(view.rounds.map((r) => r.marketId));
assert.ok(ids.has(current.marketId), "the current round is kept");
for (const r of rounds.slice(-STATUS_RECENT_ROUNDS)) assert.ok(ids.has(r.marketId), "each recent round is kept");
assert.ok(ids.has(markets[5].id), "an old round with an unsettled position is kept (never drop a pending redemption)");
assert.ok(ids.has(markets[7].id), "an old round with a live order is kept");
assert.ok(!ids.has(markets[100].id), "an old, fully resolved round is dropped from the line");
// Markets follow the same rule: ended markets drop unless they still need work.
const mids = new Set(view.markets.map((m) => m.id));
assert.ok(mids.has(markets[N].id), "the current market is kept");
assert.ok(mids.has(markets[5].id), "a market still needing settlement is kept");
assert.ok(!mids.has(markets[100].id), "an ended, resolved market is dropped");
console.log(`P0-3: ${N} rounds -> status line ${size} bytes, ${view.rounds.length} rounds, ${view.markets.length} markets`);
console.log("P0-3 OK");
