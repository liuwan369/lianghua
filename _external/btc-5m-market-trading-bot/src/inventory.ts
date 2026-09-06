import type { Fill } from "./models.js";
import { Side } from "./models.js";

export class SideInventory {
  shares = 0;
  cost = 0;

  avgPrice(): number {
    return this.shares <= 0 ? 0 : this.cost / this.shares;
  }

  add(shares: number, price: number): void {
    this.shares += shares;
    this.cost += shares * price;
  }
}

export class Inventory {
  up = new SideInventory();
  down = new SideInventory();
  fills: Fill[] = [];
  lastFillUnix = 0;
  lastSide?: Side;
  bothSidesOpened = false;

  totalCost(): number {
    return this.up.cost + this.down.cost;
  }

  pairCost(): number {
    if (this.up.shares > 0 && this.down.shares > 0) {
      return this.up.avgPrice() + this.down.avgPrice();
    }
    if (this.up.shares > 0) return this.up.avgPrice();
    if (this.down.shares > 0) return this.down.avgPrice();
    return 0;
  }

  projectedPairCostIfBuy(side: Side, shares: number, price: number): number {
    const inv = side === Side.Up ? this.up : this.down;
    const other = side === Side.Up ? this.down : this.up;
    const newShares = inv.shares + shares;
    const newCost = inv.cost + shares * price;
    const newAvg = newShares > 0 ? newCost / newShares : 0;
    if (other.shares <= 0) return newAvg;
    return newAvg + other.avgPrice();
  }

  netImbalanceRatio(): number {
    const total = this.up.shares + this.down.shares;
    if (total <= 0) return 0;
    return Math.abs(this.up.shares - this.down.shares) / total;
  }

  execute(fill: Fill): void {
    if (fill.side === Side.Up) this.up.add(fill.shares, fill.price);
    else this.down.add(fill.shares, fill.price);
    if (this.up.shares > 0 && this.down.shares > 0) this.bothSidesOpened = true;
    this.lastFillUnix = fill.tsUnix;
    this.lastSide = fill.side;
    this.fills.push(fill);
  }

  payoutIfWinner(winner: Side): number {
    return winner === Side.Up ? this.up.shares : this.down.shares;
  }
}
