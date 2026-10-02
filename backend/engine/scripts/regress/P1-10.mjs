// P1-10: starting in a round's last minutes always failed. There the
// console offers only the next round, the control plane passed that as the
// expected identity, and the engine, which discovers the current round, threw
// "initial discovered market does not match". Live: two failed runs created at
// seconds 287 and 264 of their rounds.
//
// Run after `npm run build`:  node scripts/regress/P1-10.mjs
import assert from "node:assert/strict";
import { checkInitialMarket } from "../../dist/cli/platform.js";

const current = { id: "0xcur", roundId: "1790726700", endsAt: 1790727000 };
const next = { id: "0xnext", roundId: "1790727000" };
const asked = [];
const discoverAt = async (at) => { asked.push(at); return next; };

// --- bug: the next round, confirmed by the venue, is accepted ---
await checkInitialMarket(current, { marketId: "0xnext", roundId: "1790727000" }, discoverAt);
assert.deepEqual(asked, [1790727000], "the next round's identity is looked up at the current round's end");
// --- control: the current round still matches as before ---
await checkInitialMarket(current, { marketId: "0xcur", roundId: "1790726700" }, discoverAt);
// --- edge: a next-round id the venue does not confirm is still rejected ---
await assert.rejects(() => checkInitialMarket(current, { marketId: "0xother", roundId: "1790727000" }, discoverAt),
  /does not match/);
// --- edge: any other round is still rejected, without a lookup ---
asked.length = 0;
await assert.rejects(() => checkInitialMarket(current, { marketId: "0xold", roundId: "1790726400" }, discoverAt), /does not match/);
assert.equal(asked.length, 0);
console.log("P1-10 OK");
