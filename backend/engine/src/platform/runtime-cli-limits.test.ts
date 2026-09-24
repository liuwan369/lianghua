import assert from "node:assert/strict";
import { parsePlatformOptions, resolveReversalLimits } from "../cli/platform.js";

const options = parsePlatformOptions(["--live", "--capital-usd", "10", "--order-usd", "4",
  "--daily-loss-usd", "3", "--duration-sec", "360", "--markets", "one-round.json"]);
assert.ok(options);
const operator = { ...options.limits };

const startup = resolveReversalLimits(operator, { totalBudgetUsd: 100, dailyLossUsd: 30 });
assert.equal(startup.capitalUsd, 10, "a larger strategy budget cannot override --capital-usd");
assert.equal(startup.maxOrderUsd, 4, "the strategy budget cannot override --order-usd");
assert.equal(startup.dailyLossUsd, 3, "the strategy cannot loosen the operator loss stop");

const tighter = resolveReversalLimits(operator, { totalBudgetUsd: 2, dailyLossUsd: 1 });
assert.equal(tighter.capitalUsd, 2, "a tighter strategy budget remains effective");
assert.equal(tighter.maxOrderUsd, 2, "an order cannot exceed the effective capital ceiling");
assert.equal(tighter.dailyLossUsd, 1);

// A later revision can relax its own budget, but the original run's CLI caps survive.
const reloaded = resolveReversalLimits(operator, { totalBudgetUsd: 8, dailyLossUsd: 20 });
assert.equal(reloaded.capitalUsd, 8);
assert.equal(reloaded.maxOrderUsd, 4);
assert.equal(reloaded.dailyLossUsd, 3);
const removed = resolveReversalLimits(operator, {});
assert.deepEqual(removed, operator, "removing optional strategy budgets restores only the operator ceilings");
assert.deepEqual(options.limits, operator, "budget resolution does not mutate the operator ceilings");

const defaults = parsePlatformOptions(["--live"])!;
const strategyOnly = resolveReversalLimits(defaults.limits, { totalBudgetUsd: 7, dailyLossUsd: 2 });
assert.equal(strategyOnly.capitalUsd, 7, "runs without CLI ceilings still respect the strategy budget");
assert.equal(strategyOnly.maxOrderUsd, 7);
assert.equal(strategyOnly.dailyLossUsd, 2);
assert.equal(resolveReversalLimits(defaults.limits, {}).dailyLossUsd, null);
assert.equal(startup.maxOpenOrders, operator.maxOpenOrders);

console.log("runtime-cli-limits.test: PASS");
