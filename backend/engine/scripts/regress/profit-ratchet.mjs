// Profit ratchet (user 2026-11-25, replaces the 80/40 trailing stop): the daily
// loss limit counts from the day's opening equity, so a day up +1000 had to lose
// 1040 before it stopped. New: every ratchetStepUsd the day's peak gains lifts
// the stop line ratchetLiftUsd, and the stop stays dailyLossUsd under that line.
// Off (line at -dailyLossUsd all day) unless both are set; needs dailyLossUsd.
//   line = floor(max(peak, 0) / step) * lift - dailyLossUsd
// - peak 0: the stop is the plain daily loss limit, unchanged;
// - 20/10 with a 40 limit: peak +20 stops at -30, peak +56 stops at -20;
// - the line only rises (the peak only rises), so it never loosens mid-day;
//   as with the plain daily loss limit, equity recovering above the line (held
//   positions marking up or settling) resumes trading at the tighter line;
// - a new Beijing day resets the peak and lifts the halt;
// - the peak and the halt survive a restart; turning the ratchet off puts the
//   line back at -dailyLossUsd, which can lift the halt.
// Real TradingPlatform/TradingCore, only the gateway faked.
// Run after `npm run build`:  node scripts/regress/profit-ratchet.mjs
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";

const AT = 1794739000;   // a Beijing day's middle
const gateway = { mode: "live", durableIdentity: true, async submit() {}, async cancel() { return true; } };
const read = (cash, at) => ({ accountId: "t", at, cashAt: at, cashUsd: cash, positions: [], openOrders: [], complete: true });
let now = AT + 5;
const start = (cash, limits, restored) => new TradingPlatform({ account: read(cash, AT), instruments: [], restored,
  limits: { capitalUsd: 1000, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null, ...limits }, now: () => now, adapters: { gateway } });
const step = (p, cash) => { now += 1; p.core.reconcile(read(cash, now)); return p.core.risk(); };
const RATCHET = { dailyLossUsd: 40, ratchetStepUsd: 20, ratchetLiftUsd: 10 };

// The day opens at 100. Nothing earned yet: the plain daily loss limit.
{
  const p = start(100, RATCHET);
  assert.equal(step(p, 70).halted, false, "-30: still trading");
  const r = step(p, 59);
  assert.equal(r.halted, true, "-41: the daily loss limit, unchanged by the ratchet");
  assert.equal(r.reason, "daily loss limit");
}
// Earned +20: the line rises 10, so the stop is -30 rather than -40.
{
  const p = start(100, RATCHET);
  assert.equal(step(p, 120).dailyPeakPnlUsd, 20, "the day's peak");
  assert.equal(step(p, 75).halted, false, "-25: above the raised line");
  const r = step(p, 69);
  assert.equal(r.halted, true, "-31: the raised line stops it");
  assert.equal(r.reason, "daily profit ratchet", "its own reason, not the plain limit");
  // As with the plain daily loss limit: back above the line, trading resumes —
  // but at the raised line, so the room is 30 and not 40.
  assert.equal(step(p, 95).halted, false, "-5 is above the raised line");
  assert.equal(step(p, 120).dailyPeakPnlUsd, 20, "the peak does not fall");
  assert.equal(step(p, 69).reason, "daily profit ratchet", "-31 stops again at the same line");
}
// Earned +56: two full steps (not three), so the line is +20 and the stop -20.
{
  const p = start(100, RATCHET);
  step(p, 156);
  assert.equal(p.core.risk().dailyPeakPnlUsd, 56);
  assert.equal(step(p, 81).halted, false, "-19: above the line");
  assert.equal(step(p, 79).reason, "daily profit ratchet", "-21: stopped");
}
// The peak and the halt survive a restart; turning the ratchet off puts the line
// back at -dailyLossUsd, which lifts a halt the ratchet alone caused.
{
  const p = start(100, RATCHET);
  step(p, 120);
  step(p, 69);
  const saved = p.core.snapshot();
  const q = start(69, RATCHET, saved);
  assert.equal(q.core.risk().dailyPeakPnlUsd, 20, "the peak survives");
  assert.equal(q.core.risk().reason, "daily profit ratchet", "the halt survives");
  q.core.updateLimits({ ratchetStepUsd: null, ratchetLiftUsd: null });
  assert.equal(q.core.risk().halted, false, "off: -31 is inside the plain 40 limit again");
  // A new Beijing day resets the peak and lifts the halt.
  const r = start(69, RATCHET, saved);
  now += 86400;
  const d2 = step(r, 69);
  assert.equal(d2.halted, false, "a new day starts fresh");
  assert.equal(d2.dailyPeakPnlUsd, 0);
}
// Off unless both are set, and off without a daily loss limit (there is no line
// to lift): the engine must not stop at a bare +10 give-back.
{
  const p = start(100, { dailyLossUsd: 40, ratchetStepUsd: 20 });
  step(p, 120);
  assert.equal(step(p, 69).halted, false, "only one of the two set: no lift, -31 is inside the 40 limit");
  assert.equal(step(p, 59).reason, "daily loss limit", "-41: the plain limit");
  const n = start(100, { dailyLossUsd: null, ratchetStepUsd: 20, ratchetLiftUsd: 10 });
  step(n, 160);
  assert.equal(step(n, 110).halted, false, "no daily loss limit: the ratchet alone never stops");
}
// The retired 80/40 trailing stop is gone.
{
  const p = start(100, { dailyLossUsd: 40 });
  assert.throws(() => p.core.updateLimits({ profitTrailFromUsd: 80, profitTrailGivebackUsd: 40 }),
    /unknown hard limit/, "the retired trail fields are rejected, not silently ignored");
}
console.log("profit-ratchet OK");
