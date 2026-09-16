import type { StrategyConfig } from "../config.js";
import type { Inventory } from "../inventory.js";
import type { Fill, MarketBooks, PendingExposure, Side } from "../models.js";
import type { RiskState } from "../risk.js";

export interface DecisionRejection {
  code: "maker_tick_missing_or_invalid" | "maker_price_invalid" | "hedge_pair_cost" |
    "order_limits_or_minimum" | "risk_blocked" | "entry_pair_cost";
  side?: Side;
  price?: number;
  pairCost?: number;
  limit?: number;
}

/** Synchronous BUY-outcome decisions. Execution, feeds and persistence stay outside. */
export interface BuyStrategy {
  readonly id: string;
  readonly executionMode: "buy" | "observe";
  readonly config: StrategyConfig;
  risk: RiskState;
  onMarketStart(start: number): void;
  onMarketEnd(pnl: number, ts: number): void;
  recordFill(inventory: Inventory): void;
  chooseSide(
    inventory: Inventory, book: MarketBooks, ts: number,
    start: number, end: number, btcChange?: number,
  ): Side | undefined;
  buildFill(
    side: Side, inventory: Inventory, book: MarketBooks,
    ts: number, end: number, pending?: PendingExposure,
  ): Fill | undefined;
  lastDecisionRejection(): DecisionRejection | null;
}

export type BuyStrategyFactory = (config: StrategyConfig) => BuyStrategy;

export function assertStrategyMode(strategy: BuyStrategy, live: boolean): void {
  if (live && strategy.executionMode === "observe") {
    throw new Error("observe strategy is paper-only; use read-only account/feed commands for live observation");
  }
}
