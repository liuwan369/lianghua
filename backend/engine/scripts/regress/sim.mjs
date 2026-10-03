// Paper simulator (模拟交易): count how many times the real reversal strategy
// fires per round from real market data — uncapped — and how much of each
// firing the book could really have filled.
//
// Two counts per round: RAW (every frame, raw asks — the live rule verbatim)
// and FILTERED (the main number): crashed frames (upAsk + downAsk > 1.05) are
// dropped, and an ask only counts as >= 0.67 after it stayed there 1 s.
// FILTERED firings are filled against the first accepted frame >= 0.3 s later,
// using that side's ask levels <= 0.70, each level size usable once per round.
//
// Run after `npm run build`:  node scripts/regress/sim.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReversalSim } from "../../dist/sim/reversal-sim.js";

const START = 1_799_900_100 - (1_799_900_100 % 300);
const OLD_START = 1_790_877_600;          // before 1790878037: depth is known bad

const f = (t, ua, da, extra = {}) => ({ t, ua, da, ...extra });
/** Drive one round through a fresh sim; a next-round frame closes it. Returns the written lines. */
function run(start, frames, { closeRound = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pm-sim-"));
  const sim = new ReversalSim(dir, { now: () => start - 1000, retentionDays: 3650 });
  const book = (round, clock, ua, da, extra) => ({ marketId: `0x${round}`, roundId: String(round),
    upTokenId: `${round}:up`, downTokenId: `${round}:down`,
    upAsk: ua, upBid: ua - 0.01, downAsk: da, downBid: da - 0.01,
    upAskLevels: extra.ual ?? [[ua, 1000]], downAskLevels: extra.dal ?? [[da, 1000]],
    upSourceAt: clock, downSourceAt: clock, expiresAt: clock + 2, sequence: Math.round(clock * 1000) });
  for (const frame of frames) sim.observe("btc", book(start, start + frame.t, frame.ua, frame.da, frame), start + frame.t);
  if (closeRound) sim.observe("btc", book(start + 300, start + 301, 0.5, 0.51, {}), start + 301);
  sim.flush();
  let lines = [];
  try { lines = readFileSync(join(dir, "btc.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return lines;
}
const one = (lines) => { assert.equal(lines.length, 1, "one round line written"); return lines[0]; };

// 1. Ladder: 67 alternating crossings, each held 1.2 s → raw 67, filtered 67.
{
  const frames = [f(1, 0.50, 0.51)];
  let t = 2;
  frames.push(f(t, 0.68, 0.33), f(t + 1.2, 0.68, 0.33)); t += 2.4;            // UP #1
  // A same-direction re-cross does not count: UP dips, crosses again and holds.
  frames.push(f(t, 0.50, 0.51), f(t + 0.5, 0.69, 0.33), f(t + 1.7, 0.69, 0.33)); t += 2.4;
  for (let i = 0; i < 66; i += 1) {
    const up = i % 2 !== 0;
    frames.push(f(t, up ? 0.68 : 0.33, up ? 0.33 : 0.68), f(t + 1.2, up ? 0.68 : 0.33, up ? 0.33 : 0.68)); t += 2.4;
  }
  frames.push(f(299, 0.99, 0.02));
  const round = one(run(START, frames));
  assert.equal(round.schemaVersion, 2);
  assert.equal(round.firingsRaw, 67, `raw 67, got ${round.firingsRaw}`);
  assert.equal(round.firings, 67, `filtered 67, got ${round.firings}`);
  assert.equal(round.reversals, 66);
  assert.equal(round.rawSeconds.length, 67);
  assert.deepEqual(round.events.slice(0, 5).map(e => e.shares), [5, 20, 60, 140, 140], "ladder 5/20/60/140/140");
  assert.equal(round.events[66].shares, 140);
  assert.equal(round.winner, "UP");
  assert.equal(round.depthOk, true);
  assert.equal(typeof round.simPnl4, "number");
  assert.equal(typeof round.simPnlAll, "number");
}

// 2. Crashed frames (sum > 1.05) reach neither the strategy, the dwell nor the winner.
{
  const round = one(run(START, [f(1, 0.50, 0.51), f(20, 0.68, 0.33),
    f(20.5, 0.40, 0.90),                 // crashed: would reset UP's dwell and cross DOWN
    f(21.2, 0.68, 0.33),                 // UP held 1.2 s → the one filtered firing
    f(299, 0.99, 0.02), f(299.5, 0.50, 0.99)]));   // last frame crashed: winner stays UP
  assert.equal(round.firings, 1, `filtered 1, got ${round.firings}`);
  assert.equal(round.events[0].dir, "UP");
  assert.equal(round.winner, "UP", "the winner comes from the last accepted frame");
}

// 3. Nine flips inside 0.3 s (btc 1790922000): raw 9, filtered at most 1.
{
  const frames = [f(1, 0.50, 0.51), f(261.5, 0.50, 0.51)];
  for (let i = 0; i < 9; i += 1) frames.push(i % 2 ? f(262.3 + i * 0.0375, 0.68, 0.33) : f(262.3 + i * 0.0375, 0.33, 0.68));
  frames.push(f(263.7, 0.33, 0.68), f(299, 0.02, 0.99));
  const round = one(run(START, frames));
  assert.equal(round.firingsRaw, 9, `raw 9, got ${round.firingsRaw}`);
  assert.ok(round.firings <= 1, `filtered <= 1, got ${round.firings}`);
}

// 4. A cross that falls back after 0.5 s is not a filtered firing.
{
  const round = one(run(START, [f(1, 0.50, 0.51), f(9, 0.50, 0.51), f(10, 0.68, 0.33), f(10.5, 0.50, 0.51),
    f(11.5, 0.50, 0.51), f(299, 0.99, 0.02)]));
  assert.equal(round.firingsRaw, 1);
  assert.equal(round.firings, 0);
}

// 5. Fills: the frame >= 0.3 s after the decision, levels <= 0.70, each size used once.
{
  const ual = [[0.69, 3], [0.70, 4], [0.71, 50]];
  const round = one(run(START, [f(1, 0.50, 0.51), f(9.5, 0.50, 0.51),
    f(10, 0.68, 0.33), f(11.2, 0.68, 0.33),                       // UP #1, 5 shares
    f(11.3, 0.68, 0.33, { ual: [[0.68, 100]] }),                  // only 0.1 s later: not used
    f(11.6, 0.68, 0.33, { ual }),                                 // fills 3@.69 + 2@.70
    f(12, 0.33, 0.68), f(13.2, 0.33, 0.68),                       // DOWN #2, 20 shares
    f(13.6, 0.33, 0.68, { dal: [[0.70, 50]] }),
    f(14, 0.68, 0.33), f(15.2, 0.68, 0.33),                       // UP #3, 60 shares
    f(15.6, 0.68, 0.33, { ual }),                                 // only 2@.70 left
    f(299, 0.99, 0.02)]));
  const [e1, e2, e3] = round.events;
  assert.equal(e1.status, "full"); assert.equal(e1.avail, 7); assert.equal(e1.filled, 5);
  assert.ok(Math.abs(e1.cost - 3.47) < 1e-6, `cost 3*.69+2*.70, got ${e1.cost}`);
  assert.equal(e2.status, "full"); assert.equal(e2.filled, 20);
  assert.equal(e3.status, "partial"); assert.equal(e3.avail, 2); assert.equal(e3.filled, 2);
  assert.ok(Math.abs(e3.cost - 1.4) < 1e-6);
  assert.equal(typeof round.simPnl4, "number");
}

// 6. A firing with no accepted frame >= +0.3 s before the round ends is too_late.
{
  const round = one(run(START, [f(1, 0.50, 0.51), f(296, 0.50, 0.51), f(297, 0.68, 0.33), f(298.2, 0.68, 0.33), f(298.4, 0.99, 0.02)]));
  assert.equal(round.firings, 1);
  assert.equal(round.events[0].status, "too_late");
  assert.equal(round.events[0].filled, 0);
}

// 7. Depth before 1790878037 is known bad: no_depth, PnL null.
{
  const round = one(run(OLD_START, [f(1, 0.50, 0.51), f(9.5, 0.50, 0.51), f(10, 0.68, 0.33), f(11.2, 0.68, 0.33),
    f(11.6, 0.68, 0.33), f(299, 0.99, 0.02)]));
  assert.equal(round.events[0].status, "no_depth");
  assert.equal(round.events[0].filled, null);
  assert.equal(round.depthOk, false);
  assert.equal(round.simPnl4, null);
}

// 8. A round first seen mid-round (restart) is not written; nor is one still in progress.
assert.equal(run(START, [f(150, 0.50, 0.51), f(160, 0.68, 0.33), f(299, 0.99, 0.02)]).length, 0, "mid-round round dropped");
assert.equal(run(START, [f(1, 0.50, 0.51), f(200, 0.99, 0.02)], { closeRound: false }).length, 0, "in-progress round not written");

console.log("sim OK");
process.exit(0);
