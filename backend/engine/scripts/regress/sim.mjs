// Paper simulator (模拟交易): count how many times the real reversal strategy
// fires per round from real market data — uncapped. The max could be ~67.
//
// Drives the real ReversalSim with a synthetic round where UP and DOWN cross the
// trigger (0.67) alternately 67 times:
//   - firings 67, reversals 66;
//   - the ladder is 5, 20, 60, 140, 140, ... (uncapped at 140);
//   - the first complete pair is only a baseline (no firing);
//   - a same-direction re-cross is not counted (needs the opposite side).
//
// Run after `npm run build`:  node scripts/regress/sim.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReversalSim } from "../../dist/sim/reversal-sim.js";

const START = 1_799_900_100 - (1_799_900_100 % 300);
const dir = mkdtempSync(join(tmpdir(), "pm-sim-"));
const sim = new ReversalSim(dir, { now: () => START - 1000, retentionDays: 3650 });
const book = (up, down, clock) => ({ marketId: "0xm", roundId: String(START),
  upTokenId: "0xm:up", downTokenId: "0xm:down",
  upAsk: up, upBid: up - 0.02, downAsk: down, downBid: down - 0.02,
  upSourceAt: clock, downSourceAt: clock, expiresAt: clock + 2, sequence: Math.round((clock - START) * 10) });

let clock = START + 1;
// First complete pair: both below trigger — a baseline only, never a firing.
sim.observe("btc", book(0.50, 0.50, clock), clock); clock += 1;
// First real crossing: UP above the trigger. This is firing #1 (initial entry).
sim.observe("btc", book(0.68, 0.50, clock), clock); clock += 1;
// A same-direction re-cross must NOT count: UP dips below, then crosses UP again.
// The strategy only fires on the opposite direction, so this adds no firing.
sim.observe("btc", book(0.50, 0.50, clock), clock); clock += 1;
sim.observe("btc", book(0.69, 0.50, clock), clock); clock += 1;
// Now 66 more alternating crossings (DOWN, UP, DOWN, ...) → 67 firings total.
for (let i = 0; i < 66; i += 1) {
  const upAbove = i % 2 !== 0;                 // i=0 -> DOWN crosses, i=1 -> UP, ...
  sim.observe("btc", book(upAbove ? 0.68 : 0.50, upAbove ? 0.50 : 0.68, clock), clock); clock += 1;
}
// A decisive late in-window quote (UP wins): the result reads the last quote.
sim.observe("btc", book(0.95, 0.05, START + 299), START + 299);
// Flush finalizes the still-open round and writes the result line.
sim.flush();

const lines = readFileSync(join(dir, "btc.jsonl"), "utf8").trim().split("\n");
assert.equal(lines.length, 1, "one round line written");
const round = JSON.parse(lines[0]);
assert.equal(round.firings, 67, `expected 67 firings, got ${round.firings}`);
assert.equal(round.reversals, 66, `expected 66 reversals, got ${round.reversals}`);
assert.deepEqual(round.events.slice(0, 5).map(e => e.shares), [5, 20, 60, 140, 140],
  "ladder is 5, 20, 60, 140, 140 (uncapped at 140)");
assert.equal(round.events[66].shares, 140, "the 67th firing still uses 140");
assert.ok(["UP", "DOWN"].includes(round.winner), "a decisive last quote names a winner");
assert.equal(round.roundId, String(START));
assert.equal(typeof round.simPnl4, "number");
assert.equal(typeof round.simPnlAll, "number");

console.log("sim OK");
process.exit(0);
