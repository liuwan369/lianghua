import type { StrategyConfig } from "../config.js";
import { Inventory, SideInventory } from "../inventory.js";
import { polymarketFillFee, Side } from "../models.js";
import { RiskState } from "../risk.js";
import type { BuyStrategy } from "./types.js";

/** Observation never produces order intentions, including automatic exits. */
export class ObserveStrategy implements BuyStrategy {
  readonly id = "observe";
  readonly executionMode = "observe";
  risk = new RiskState();

  constructor(readonly config: StrategyConfig) {}

  onMarketStart(start: number): void {
    this.risk.onMarketStart(start, this.config);
  }

  onMarketEnd(pnl: number, ts: number): void {
    this.risk.onMarketEnd(pnl, ts, this.config);
  }

  recordFill(inventory: Inventory): void {
    const accounting = Object.assign(new Inventory(), inventory);
    accounting.up = Object.assign(new SideInventory(), inventory.up);
    accounting.down = Object.assign(new SideInventory(), inventory.down);
    for (const fill of inventory.fills) {
      const fee = polymarketFillFee(fill.shares, fill.price, fill.isMaker,
        this.config.takerFeeRate, this.config.makerFeeRate, this.config.feeExponent);
      (fill.side === Side.Up ? accounting.up : accounting.down).cost += fee;
    }
    this.risk.onFill(accounting, this.config);
  }

  chooseSide(): undefined { return undefined; }
  buildFill(): undefined { return undefined; }
  lastDecisionRejection(): null { return null; }
}
