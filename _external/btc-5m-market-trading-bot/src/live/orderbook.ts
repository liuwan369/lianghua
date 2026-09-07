function tick(price: number): number {
  return Math.round(price * 1000);
}

function untick(t: number): number {
  return t / 1000;
}

/** Local L2 order-book replica synced from Polymarket CLOB WS. */
export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();

  applySnapshot(bids: [number, number][], asks: [number, number][]): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, s] of bids) {
      if (p > 0 && p < 1 && s > 0) this.bids.set(tick(p), s);
    }
    for (const [p, s] of asks) {
      if (p > 0 && p < 1 && s > 0) this.asks.set(tick(p), s);
    }
  }

  applyChange(price: number, size: number, isBuy: boolean): void {
    if (!(price > 0 && price < 1)) return;
    const book = isBuy ? this.bids : this.asks;
    const t = tick(price);
    if (size > 0) book.set(t, size);
    else book.delete(t);
  }

  bestBid(): [number, number] | undefined {
    let best: number | undefined;
    for (const k of this.bids.keys()) {
      if (best == null || k > best) best = k;
    }
    if (best == null) return undefined;
    return [untick(best), this.bids.get(best)!];
  }

  bestAsk(): [number, number] | undefined {
    let best: number | undefined;
    for (const k of this.asks.keys()) {
      if (best == null || k < best) best = k;
    }
    if (best == null) return undefined;
    return [untick(best), this.asks.get(best)!];
  }

  bidLevels(): [number, number][] {
    return [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([p, s]) => [untick(p), s]);
  }

  microprice(): number | undefined {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (!bb || !ba) return undefined;
    const [b, bs] = bb;
    const [a, as_] = ba;
    const denom = bs + as_;
    return denom > 0 ? (b * as_ + a * bs) / denom : (b + a) / 2;
  }

  mid(): number | undefined {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (!bb || !ba) return undefined;
    return (bb[0] + ba[0]) / 2;
  }

  imbalance(levels: number): number | undefined {
    const bidLevels = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, levels);
    const askLevels = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, levels);
    const bd = bidLevels.reduce((s, [, v]) => s + v, 0);
    const ad = askLevels.reduce((s, [, v]) => s + v, 0);
    const tot = bd + ad;
    return tot > 0 ? (bd - ad) / tot : undefined;
  }

  nLevels(): [number, number] {
    return [this.bids.size, this.asks.size];
  }
}
