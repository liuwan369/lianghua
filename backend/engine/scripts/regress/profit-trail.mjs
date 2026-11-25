// Trailing profit stop (user 2026-11-25): the daily loss limit only counts
// from the day's opening equity, so a day up +1000 had to lose 1040 before it
// stopped. New: once the day's PnL has reached profitTrailFromUsd, stop new
// orders when it falls profitTrailGivebackUsd below the day's peak. Off unless
// both are set. The day's peak is kept in the risk state, so a restart keeps it.
// - below the activation level: no stop, however far it falls from the peak;
// - activated (peak >= from): a give-back of the amount halts ("daily profit
//   trail"); a smaller give-back does not;
// - a new day resets the peak and lifts the halt;
// - the peak survives a restart; turning the trail off lifts its halt;
// - the daily loss limit still works alongside it.
// Real TradingPlatform/TradingCore, only the gateway faked.
// Run after `npm run build`:  node scripts/regress/profit-trail.mjs
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";

const AT = 1794739000;   // a Beijing day's middle
const gateway = { mode: "live", durableIdentity: true, async submit() {}, async cancel() { return true; } };
const read = (cash, at) => ({ accountId: "t", at, cashAt: at, cashUsd: cash, positions: [], openOrders: [], complete: true });
let now = AT + 5;
const start = (cash, limits, restored) => new TradingPlatform({ account: read(cash, AT), instruments: [], restored,
  limits: { capitalUsd: 1000, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null, ...limits }, now: () => now, adapters: { gateway } });
const step = (p, cash) => { now += 1; p.core.reconcile(read(cash, now)); return p.core.risk(); };

// The day opens at 100.
{
  const p = start(100, { profitTrailFromUsd: 100, profitTrailGivebackUsd: 60 });
  assert.equal(step(p, 180).halted, false, "+80: not yet activated");
  assert.equal(step(p, 110).halted, false, "below the activation level a fall from the peak does not stop");
  assert.equal(step(p, 260).halted, false, "+160: activated, at the peak");
  assert.equal(p.core.risk().dailyPeakPnlUsd, 160, "the day's peak is kept");
  assert.equal(step(p, 210).halted, false, "-50 from the peak: under the give-back");
  const r = step(p, 200);
  assert.equal(r.halted, true, "-60 from the peak: stop");
  assert.equal(r.reason, "daily profit trail");
  assert.equal(step(p, 240).halted, true, "a recovery the same day does not restart it");
  // The peak and the halt survive a restart with the same limits.
  const saved = p.core.snapshot();
  const q = start(240, { profitTrailFromUsd: 100, profitTrailGivebackUsd: 60 }, saved);
  assert.equal(q.core.risk().dailyPeakPnlUsd, 160);
  assert.equal(q.core.risk().reason, "daily profit trail", "restart keeps the halt");
  // Turned off: trading again.
  q.core.updateLimits({ profitTrailFromUsd: null, profitTrailGivebackUsd: null });
  assert.equal(q.core.risk().halted, false, "off lifts the trail's halt");
  // A new Beijing day resets the peak and lifts the halt.
  const r2 = start(240, { profitTrailFromUsd: 100, profitTrailGivebackUsd: 60 }, saved);
  now += 86400;
  const d2 = step(r2, 240);
  assert.equal(d2.halted, false, "a new day starts fresh");
  assert.equal(d2.dailyPeakPnlUsd, 0);
}
// Off unless both are set; the daily loss limit still works alongside it.
{
  now = AT + 5;
  const p = start(100, { profitTrailFromUsd: 100 });
  step(p, 260);
  assert.equal(step(p, 120).halted, false, "only one of the two set: off");
  const l = start(100, { dailyLossUsd: 40, profitTrailFromUsd: 100, profitTrailGivebackUsd: 60 });
  const r = step(l, 59);
  assert.equal(r.reason, "daily loss limit", "-41: the loss limit, as before");
}
console.log("profit-trail OK");
