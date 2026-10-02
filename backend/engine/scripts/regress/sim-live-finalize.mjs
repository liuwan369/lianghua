// The live collector runs one feed per round, and a round's feed stops at its
// end, so no later book of THAT market ever arrives. finalizeExpired() only
// closed rounds of the market being observed, so live rounds were never
// written (server: 0 live rounds in 10 minutes). A book of any later round of
// the same coin must close the rounds that have ended.
// Run after `npm run build`:  node scripts/regress/sim-live-finalize.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReversalSim } from "../../dist/sim/reversal-sim.js";

const dir = mkdtempSync(join(tmpdir(), "sim-live-"));
const R = (Math.floor(Date.now() / 1000 / 300) - 3) * 300;
const sim = new ReversalSim(dir, { now: () => R + 1000 });
const book = (round, t, ua, da) => ({ marketId: `0x${round}`, roundId: String(round), upTokenId: `${round}:up`, downTokenId: `${round}:down`,
  upAsk: ua, upBid: ua - 0.01, downAsk: da, downBid: da - 0.01, upSourceAt: t, downSourceAt: t, expiresAt: t + 2, sequence: Math.round(t) });
// round 1: baseline, then UP crosses; its feed then stops (no book after its end)
sim.observe("btc", book(R, R + 1, 0.5, 0.5), R + 1);
sim.observe("btc", book(R, R + 3, 0.68, 0.33), R + 3);
sim.observe("btc", book(R, R + 299, 0.99, 0.02), R + 299);
// the next round's feed delivers books
sim.observe("btc", book(R + 300, R + 301, 0.5, 0.5), R + 301);
let lines = [];
try { lines = readFileSync(join(dir, "btc.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
rmSync(dir, { recursive: true, force: true });
assert.equal(lines.length, 1, "the ended round is written when the next round's books arrive");
assert.equal(lines[0].roundId, String(R));
assert.equal(lines[0].firings, 1);
assert.equal(lines[0].winner, "UP");
console.log("sim-live-finalize OK");
