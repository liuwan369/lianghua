/** Normalize venue decimals without assuming a 0.001 tick size. */
function key(price: number): number {
  return Number(price.toFixed(10));
}

/** Local L2 order-book replica synced from Polymarket CLOB WS. */
export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private bestBidPrice: number | undefined;
  private bestAskPrice: number | undefined;

  applySnapshot(bids: [number, number][], asks: [number, number][]): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, s] of bids) {
      if (p > 0 && p < 1 && s > 0) this.bids.set(key(p), s);
    }
    for (const [p, s] of asks) {
      if (p > 0 && p < 1 && s > 0) this.asks.set(key(p), s);
    }
    this.bestBidPrice = this.findBest(this.bids, true);
    this.bestAskPrice = this.findBest(this.asks, false);
  }

  applyChange(price: number, size: number, isBuy: boolean): void {
    if (!(price > 0 && price < 1)) return;
    const book = isBuy ? this.bids : this.asks;
    const t = key(price);
    if (size > 0) book.set(t, size);
    else book.delete(t);

    if (isBuy) {
      if (size > 0 && (this.bestBidPrice == null || t > this.bestBidPrice)) {
        this.bestBidPrice = t;
      } else if (size <= 0 && t === this.bestBidPrice) {
        this.bestBidPrice = this.findBest(this.bids, true);
      }
    } else if (size > 0 && (this.bestAskPrice == null || t < this.bestAskPrice)) {
      this.bestAskPrice = t;
    } else if (size <= 0 && t === this.bestAskPrice) {
      this.bestAskPrice = this.findBest(this.asks, false);
    }
  }

  bestBid(): [number, number] | undefined {
    const best = this.bestBidPrice;
    return best == null ? undefined : [best, this.bids.get(best)!];
  }

  bestAsk(): [number, number] | undefined {
    const best = this.bestAskPrice;
    return best == null ? undefined : [best, this.asks.get(best)!];
  }

  bidLevels(limit = Number.POSITIVE_INFINITY): [number, number][] {
    return this.sortedLevels(this.bids, true, limit);
  }

  askLevels(limit = Number.POSITIVE_INFINITY): [number, number][] {
    return this.sortedLevels(this.asks, false, limit);
  }

  levels(limit = Number.POSITIVE_INFINITY): { bids: [number, number][]; asks: [number, number][] } {
    if (!Number.isFinite(limit) && limit !== Number.POSITIVE_INFINITY) throw new Error("invalid depth limit");
    const count = Math.max(0, Math.floor(limit));
    return { bids: this.bidLevels(count), asks: this.askLevels(count) };
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
    const bidLevels = this.bidLevels(levels);
    const askLevels = this.askLevels(levels);
    const bd = bidLevels.reduce((s, [, v]) => s + v, 0);
    const ad = askLevels.reduce((s, [, v]) => s + v, 0);
    const tot = bd + ad;
    return tot > 0 ? (bd - ad) / tot : undefined;
  }

  nLevels(): [number, number] {
    return [this.bids.size, this.asks.size];
  }

  private findBest(book: Map<number, number>, highest: boolean): number | undefined {
    let best: number | undefined;
    for (const price of book.keys()) {
      if (best == null || (highest ? price > best : price < best)) best = price;
    }
    return best;
  }

  private sortedLevels(
    book: Map<number, number>,
    highest: boolean,
    limit: number,
  ): [number, number][] {
    if (!Number.isFinite(limit)) {
      return [...book.entries()].sort((a, b) => highest ? b[0] - a[0] : a[0] - b[0]);
    }
    const count = Math.max(0, Math.floor(limit));
    if (count === 0) return [];
    const out: [number, number][] = [];
    for (const entry of book.entries()) {
      let index = 0;
      while (index < out.length && (highest ? out[index][0] > entry[0] : out[index][0] < entry[0])) index++;
      if (index >= count) continue;
      out.splice(index, 0, [entry[0], entry[1]]);
      if (out.length > count) out.pop();
    }
    return out;
  }
}
