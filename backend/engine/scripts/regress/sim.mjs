// Paper simulator (模拟交易), schemaVersion 3: three variants per round.
//
// A  实盘现状: the real strategy on raw frames; each firing is a GTC BUY at 0.70
//    that reaches the venue 0.3 s later, takes the asks <= 0.70 there (taker),
//    and rests until round end, filled only by NEW ask size <= 0.70 (maker, fee 0).
//    The rung is consumed at submit even with 0 fill (that is live).
// B1 建议·立即 / B2 建议·停1秒: a pure state machine on clean frames (sum <= 1.05),
//    FAK only; rung 1 = 5 @ <= 0.70, hedges sized from the ladder with a
//    break-even cap computed from the actual cost; a rung counts once it buys.
//
// Run after `npm run build`:  node scripts/regress/sim.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReversalSim } from "../../dist/sim/reversal-sim.js";

const START = 1_799_900_100 - (1_799_900_100 % 300);
const OLD_START = 1_790_877_600;          // before 1790878037: depth is known bad
const near = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${msg}: ${a} vs ${b}`);

const f = (t, ua, da, extra = {}) => ({ t, ua, da, ...extra });
const book = (round, clock, ua, da, extra = {}) => ({ marketId: `0x${round}`, roundId: String(round),
  upTokenId: `${round}:up`, downTokenId: `${round}:down`,
  upAsk: ua, upBid: ua - 0.01, downAsk: da, downBid: da - 0.01,
  upAskLevels: extra.ual ?? [[ua, 1000]], downAskLevels: extra.dal ?? [[da, 1000]],
  upSourceAt: clock, downSourceAt: clock, expiresAt: clock + 2, sequence: Math.round(clock * 1000) });
/** Drive one round through a fresh sim; a next-round frame closes it. Returns the written lines. */
function run(start, frames, { closeRound = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pm-sim-"));
  const sim = new ReversalSim(dir, { now: () => start - 1000, retentionDays: 3650 });
  for (const frame of frames) sim.observe("btc", book(start, start + frame.t, frame.ua, frame.da, frame), start + frame.t);
  if (closeRound) sim.observe("btc", book(start + 300, start + 301, 0.5, 0.51), start + 301);
  sim.flush();
  let lines = [];
  try { lines = readFileSync(join(dir, "btc.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return lines;
}
const one = (lines) => { assert.equal(lines.length, 1, "one round line written"); return lines[0]; };
const B = (round, v = "B1") => round.variants[v];
const brief = (events) => events.map(e => `${e.rung}:${e.dir}:${e.status}`);

// 1. 67 alternating crossings held 1.2 s: A fires 67 with the fixed ladder; B
//    hedges 5/20/60/140 and then the break-even cap stops it.
{
  const frames = [f(1, 0.50, 0.51)];
  let t = 2;
  for (let i = 0; i < 67; i += 1) {
    const up = i % 2 === 0;
    frames.push(f(t, up ? 0.68 : 0.33, up ? 0.33 : 0.68), f(t + 1.2, up ? 0.68 : 0.33, up ? 0.33 : 0.68)); t += 2.4;
  }
  frames.push(f(299, 0.99, 0.02));
  const round = one(run(START, frames));
  assert.equal(round.schemaVersion, 3);
  assert.equal(round.winner, "UP");
  assert.equal(round.depthOk, true);
  const a = round.variants.A;
  assert.equal(a.firings, 67, `A fires 67, got ${a.firings}`);
  assert.equal(a.rawSeconds.length, 67);
  assert.deepEqual(a.events.slice(0, 5).map(e => e.want), [5, 20, 60, 140, 140], "A ladder 5/20/60/140/140");
  assert.equal(typeof a.pnl, "number");
  const b = B(round);
  assert.deepEqual(b.events.slice(0, 4).map(e => [e.rung, e.want, e.status]),
    [[1, 5, "full"], [2, 20, "full"], [3, 60, "full"], [4, 140, "full"]], "B rungs 1..4");
  assert.equal(b.events[4].status, "over_cap", "rung 5 is above break-even");
  assert.equal(b.firings, 4, "B counts rungs that bought");
  near(b.pnl, b.held.UP - b.cost, "B pnl = held[winner] - cost", 1e-3);
}

// 2. B rung 1 with zero fill is not counted; the next cross of either side is rung 1 again.
{
  const noUp = { ual: [[0.72, 100]] };      // no UP ask <= 0.70 for the rest of the round
  const round = one(run(START, [f(1, 0.50, 0.51), f(9.5, 0.50, 0.51), f(10, 0.68, 0.30, noUp), f(10.4, 0.68, 0.30, noUp),
    f(19, 0.30, 0.50, noUp), f(20, 0.30, 0.68, noUp), f(20.4, 0.30, 0.68, noUp), f(299, 0.02, 0.99, noUp)]));
  const b = B(round);
  assert.deepEqual(brief(b.events), ["1:UP:none", "1:DOWN:full"]);
  assert.equal(b.events[1].want, 5);
  assert.equal(b.firings, 1);
  assert.deepEqual(b.held, { UP: 0, DOWN: 5 });
  // A: the same 0-fill rung 1 is consumed at submit, so DOWN is rung 2 (20 shares).
  assert.deepEqual(round.variants.A.events.map(e => e.want), [5, 20], "A consumes the rung at submit");
  assert.equal(round.variants.A.events[0].filled, 0);
}

// 3. Hedge cap from the actual cost; partial hedge then top-up stays the same rung;
//    a same-side cross is ignored.
{
  const round = one(run(START, [f(1, 0.50, 0.51),
    f(10, 0.68, 0.30), f(10.4, 0.68, 0.30, { ual: [[0.70, 5]] }),          // rung 1: 5 @ .70
    f(12, 0.50, 0.30), f(13, 0.68, 0.30), f(13.4, 0.68, 0.30),               // UP again: leader, ignored
    f(19, 0.30, 0.50), f(20, 0.30, 0.68), f(20.4, 0.30, 0.68, { dal: [[0.75, 3]] }),   // rung 2 partial 3
    f(22, 0.30, 0.50), f(23, 0.30, 0.68), f(23.4, 0.30, 0.68, { dal: [[0.75, 3], [0.76, 100]] }),
    f(299, 0.02, 0.99)]));
  const [r1, r2, top] = B(round).events;
  assert.equal(B(round).events.length, 3, "the UP re-cross while UP leads is ignored");
  assert.equal(r1.status, "full"); near(r1.cost, 3.5, "rung 1 notional"); near(r1.fee, 0.0735, "taker fee 0.07·p·(1−p)");
  assert.equal(r2.rung, 2); assert.equal(r2.want, 20);
  assert.equal(r2.cap, 0.81, "20 >= 3.5735 + 20·(p + fee(p)) → 0.81");
  assert.equal(r2.status, "partial"); assert.equal(r2.filled, 3); near(r2.avgPrice, 0.75, "avg");
  assert.equal(top.rung, 2, "top-up keeps rung 2"); assert.equal(top.status, "topup"); assert.equal(top.want, 17);
  assert.equal(top.avail, 100, "the 0.75 level was used once; 0.76 is available");
  assert.equal(B(round).firings, 2);
}

// 4. over_cap buys nothing and is not counted; leader is by held shares.
{
  const round = one(run(START, [f(1, 0.50, 0.51),
    f(10, 0.68, 0.30), f(10.4, 0.68, 0.30, { ual: [[0.70, 5]] }),
    f(19, 0.30, 0.50), f(20, 0.30, 0.68), f(20.4, 0.30, 0.68, { dal: [[0.85, 100]] }),   // over cap
    f(22, 0.30, 0.50), f(23, 0.30, 0.68), f(23.4, 0.30, 0.68, { dal: [[0.75, 8]] }),     // rung 2 partial 8 → DOWN leads
    f(25, 0.30, 0.50), f(26, 0.30, 0.68), f(26.4, 0.30, 0.68),                             // DOWN leads: ignored
    f(28, 0.50, 0.30), f(29, 0.68, 0.30), f(29.4, 0.68, 0.30),                             // UP: rung 3
    f(299, 0.99, 0.02)]));
  const b = B(round);
  assert.deepEqual(brief(b.events), ["1:UP:full", "2:DOWN:over_cap", "2:DOWN:partial", "3:UP:full"]);
  assert.equal(b.events[1].filled, 0);
  assert.equal(b.events[3].want, 60);
  assert.deepEqual(b.held, { UP: 65, DOWN: 8 });
}

// 5. No resting fill in B; A's resting remainder fills only from NEW size <= 0.70, maker fee 0, no reuse.
{
  const round = one(run(START, [f(1, 0.50, 0.51), f(9.5, 0.50, 0.51), f(10, 0.68, 0.30),
    f(10.4, 0.68, 0.30, { ual: [[0.70, 2], [0.71, 50]] }),   // taker 2
    f(11, 0.68, 0.30, { ual: [[0.70, 2], [0.71, 50]] }),     // nothing new
    f(12, 0.68, 0.30, { ual: [[0.70, 3], [0.71, 80]] }),     // +1 at .70 (0.71 is above the limit)
    f(13, 0.68, 0.30, { ual: [[0.69, 10]] }),                // a new level: fills the last 2
    f(14, 0.68, 0.30, { ual: [[0.69, 10]] }),
    f(299, 0.99, 0.02)]));
  const a = round.variants.A.events[0];
  assert.equal(a.filled, 5); assert.equal(a.maker, 3); assert.equal(a.status, "full");
  near(a.fee, 0.0294, "only the 2 taker shares pay fee");
  near(a.cost, 2 * 0.70 + 0.70 + 2 * 0.69, "maker fills at the level price");
  const b = B(round).events[0];
  assert.equal(b.filled, 2, "B is FAK: nothing rests"); assert.equal(b.status, "partial");
  assert.deepEqual(B(round).held, { UP: 2, DOWN: 0 });
}

// 6. B2 fires only after 1.0 s above 0.67 following a true cross, once per excursion.
{
  const round = one(run(START, [f(1, 0.50, 0.51), f(10, 0.68, 0.30), f(10.6, 0.68, 0.30), f(10.7, 0.50, 0.30),
    f(19, 0.30, 0.50), f(20, 0.30, 0.68), f(20.5, 0.30, 0.68), f(21.1, 0.30, 0.68), f(21.5, 0.30, 0.68),
    f(22.5, 0.30, 0.68), f(299, 0.02, 0.99)]));
  assert.deepEqual(brief(B(round, "B1").events), ["1:UP:full", "2:DOWN:full"]);
  const b2 = B(round, "B2").events;
  assert.deepEqual(brief(b2), ["1:DOWN:full"], "the 0.7 s UP blip is not a B2 firing");
  assert.equal(b2[0].t, 21.1);
}

// 7. Crashed frames (sum > 1.05) reach neither B nor the winner; A sees them raw.
{
  const round = one(run(START, [f(1, 0.50, 0.51), f(19.5, 0.40, 0.50), f(20, 0.40, 0.90), f(21, 0.40, 0.50),
    f(299, 0.99, 0.02), f(299.5, 0.50, 0.99)]));
  assert.equal(B(round).events.filter(e => e.dir === "DOWN").length, 0, "the crashed DOWN cross is dropped");
  assert.equal(round.variants.A.firings, 1, "A acts on the raw frame");
  assert.equal(round.winner, "UP", "the winner comes from the last clean frame");
}

// 8. B: no clean frame in [t+0.3, t+1.3] is a gap; at round end it is too_late.
{
  const round = one(run(START, [f(1, 0.50, 0.51), f(10, 0.68, 0.30), f(12, 0.68, 0.30),
    f(296, 0.30, 0.50), f(299.6, 0.30, 0.68), f(299.8, 0.30, 0.68)]));
  assert.deepEqual(brief(B(round).events), ["1:UP:gap", "1:DOWN:too_late"]);
}

// 9. Depth before 1790878037 is known bad: no_depth, PnL null.
{
  const round = one(run(OLD_START, [f(1, 0.50, 0.51), f(9.5, 0.50, 0.51), f(10, 0.68, 0.33), f(10.4, 0.68, 0.33), f(299, 0.99, 0.02)]));
  assert.equal(B(round).events[0].status, "no_depth");
  assert.equal(round.variants.A.events[0].status, "no_depth");
  assert.equal(round.depthOk, false);
  assert.equal(B(round).pnl, null); assert.equal(round.variants.A.pnl, null);
}

// 10. A round first seen mid-round (restart) is not written; nor is one still in progress.
assert.equal(run(START, [f(150, 0.50, 0.51), f(160, 0.68, 0.33), f(299, 0.99, 0.02)]).length, 0, "mid-round round dropped");
assert.equal(run(START, [f(1, 0.50, 0.51), f(200, 0.99, 0.02)], { closeRound: false }).length, 0, "in-progress round not written");

// 11. One strategy instance per round, dropped at finalize.
{
  const dir = mkdtempSync(join(tmpdir(), "pm-sim-"));
  const sim = new ReversalSim(dir, { now: () => START - 1000, retentionDays: 3650 });
  sim.observe("btc", book(START, START + 1, 0.5, 0.51), START + 1);
  assert.equal(sim.liveStrategies(), 1);
  for (let i = 1; i <= 3; i += 1) sim.observe("btc", book(START + i * 300, START + i * 300 + 1, 0.5, 0.51), START + i * 300 + 1);
  assert.equal(sim.liveStrategies(), 1, "ended rounds drop their strategy");
  sim.flush();
  assert.equal(sim.liveStrategies(), 0);
  rmSync(dir, { recursive: true, force: true });
}

console.log("sim OK");
process.exit(0);
