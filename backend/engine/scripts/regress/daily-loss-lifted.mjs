// 2026-11-15 live: the account hit the 40 USD daily loss limit (state halted,
// reason "daily loss limit"). The operator removed the limit and restarted the
// engine; the restored state kept the halt and every signal was skipped
// ("daily loss limit"), because only updateLimits during a run lifted it.
// The halt now follows the limit in force, at start-up as well as later:
// removed or raised above the day's loss -> trading; lowered -> halted again.
//
// Real TradingPlatform/TradingCore, only the gateway faked.
// Run after `npm run build`:  node scripts/regress/daily-loss-lifted.mjs
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";

const AT = 1794739000;
const gateway = { mode: "live", durableIdentity: true, async submit() {}, async cancel() { return true; } };
const read = (cash, at) => ({ accountId: "t", at, cashAt: at, cashUsd: cash, positions: [], openOrders: [], complete: true });
const start = (cash, dailyLossUsd, restored) => new TradingPlatform({ account: read(cash, AT), instruments: [], restored,
  limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd }, now: () => AT + 5, adapters: { gateway } });

// The day opens at 144, the balance is 106: -38 against a 30 limit.
const opened = start(144, 30).core.snapshot();
const day = start(106, 30, opened);
day.core.reconcile(read(106, AT + 1));
assert.equal(day.core.risk().reason, "daily loss limit", "precondition: halted at the limit");
const halted = day.core.snapshot();

// --- restart with no limit: trading ---
{
  const p = start(106, null, halted);
  assert.equal(p.core.risk().halted, false, "no limit: the halt is lifted at start-up");
  assert.equal(p.core.risk().reason, undefined);
}
// --- restart with a limit above the day's loss: trading ---
{
  const p = start(106, 80, halted);
  assert.equal(p.core.risk().halted, false, "-38 is inside an 80 limit");
}
// --- restart with the same limit: still halted ---
{
  const p = start(106, 30, halted);
  assert.equal(p.core.risk().reason, "daily loss limit", "-38 is past a 30 limit");
}
// --- a lowered limit during the run halts again ---
{
  const p = start(106, 80, halted);
  p.core.updateLimits({ dailyLossUsd: 20 });
  assert.equal(p.core.risk().reason, "daily loss limit");
}
console.log("daily-loss-lifted OK");
