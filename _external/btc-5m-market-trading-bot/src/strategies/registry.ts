import type { StrategyConfig } from "../config.js";
import { PairCostMarketMaker } from "../strategy.js";
import { ObserveStrategy } from "./observe.js";
import type { BuyStrategy, BuyStrategyFactory } from "./types.js";

export const DEFAULT_BUY_STRATEGY_ID = "pair-cost";
export const BUY_STRATEGY_IDS = [DEFAULT_BUY_STRATEGY_ID, "observe"] as const;

const factories = new Map<string, BuyStrategyFactory>([
  [DEFAULT_BUY_STRATEGY_ID, (config) => new PairCostMarketMaker(config)],
  ["observe", (config) => new ObserveStrategy(config)],
]);

export function buyStrategyFactory(id = DEFAULT_BUY_STRATEGY_ID): BuyStrategyFactory {
  const factory = factories.get(id);
  if (!factory) {
    throw new Error(`Unknown strategy '${id}'; available: ${BUY_STRATEGY_IDS.join(", ")}`);
  }
  return factory;
}

export function createBuyStrategy(id: string | undefined, config: StrategyConfig): BuyStrategy {
  return buyStrategyFactory(id)(config);
}
