import type { Book, GatewayAck, Instrument, OrderGateway, OrderRequest, TradeFill } from "./contracts.js";

const EPS = 1e-8;
type PaperOrder = { request: OrderRequest; left: number; seq: number; placedAt: number };
type Liquidity = { book: Book; bid: number; ask: number };
type Delivery = { kind: "fill"; fill: TradeFill } | { kind: "cancel"; orderId: string };

/** Independent paper venue. Public trades drive passive fills; a quote alone is never a fill. */
export class PaperGateway implements OrderGateway {
  readonly mode = "paper" as const;
  private next = 0;
  private orders = new Map<string, PaperOrder>();
  private books = new Map<string, Liquidity>();
  private deliveries: Delivery[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private callbackErrors: unknown[] = [];
  private closing?: Promise<void>;
  constructor(private readonly onFill: (fill: TradeFill) => void,
    private readonly fee: (request: OrderRequest, shares: number,
      execution: Pick<TradeFill, "price" | "isMaker">) => number = () => 0,
    private readonly onCancel: (orderId: string) => void = () => undefined) {}

  book(book: Book): void {
    this.assertOpen();
    if (!book.tokenId || !Number.isFinite(book.ts) || book.ts < 0
      || [book.bid, book.ask].some(n => n != null && (!Number.isFinite(n) || n <= 0 || n >= 1))
      || [book.bidSize, book.askSize].some(n => n != null && (!Number.isFinite(n) || n < 0))
      || (book.bid != null && book.ask != null && book.bid > book.ask)) throw new Error("invalid paper book");
    const previous = this.books.get(book.tokenId)?.book;
    if (previous && (book.ts < previous.ts || (book.ts === previous.ts
      && book.bid === previous.bid && book.ask === previous.ask
      && book.bidSize === previous.bidSize && book.askSize === previous.askSize))) return;
    // Each new venue observation refreshes displayed depth; repeated/stale snapshots do not.
    this.books.set(book.tokenId, { book: structuredClone(book), bid: book.bidSize ?? 0, ask: book.askSize ?? 0 });
  }
  async submit(request: OrderRequest, instrument: Instrument): Promise<GatewayAck> {
    this.assertOpen();
    if (!request.clientOrderId || !request.strategyId || request.tokenId !== instrument.tokenId
      || !["BUY", "SELL"].includes(request.direction) || !["GTC", "FOK", "FAK"].includes(request.timeInForce)
      || typeof request.postOnly !== "boolean" || (request.postOnly && request.timeInForce !== "GTC")
      || ![request.price, request.shares, instrument.tickSize, instrument.minOrderSize].every(Number.isFinite)
      || request.price <= 0 || request.price >= 1 || request.shares <= 0
      || instrument.tickSize <= 0 || instrument.tickSize >= 1 || instrument.minOrderSize <= 0
      || request.shares < instrument.minOrderSize - EPS
      || Math.abs(request.price / instrument.tickSize - Math.round(request.price / instrument.tickSize)) > 1e-6) {
      return { status: "rejected", error: "invalid paper order or instrument rules" };
    }
    const liquidity = this.books.get(request.tokenId);
    const book = liquidity?.book;
    const opposing = request.direction === "BUY" ? book?.ask : book?.bid;
    const crosses = opposing != null && (request.direction === "BUY" ? request.price >= opposing : request.price <= opposing);
    if (request.postOnly && crosses) return { status: "rejected", error: "post-only would cross" };
    const available = !crosses ? 0 : (request.direction === "BUY" ? liquidity?.ask : liquidity?.bid) ?? 0;
    if (request.timeInForce !== "GTC" && available <= 0) return { status: "rejected", error: "no executable liquidity" };
    if (request.timeInForce === "FOK" && available < request.shares - EPS) {
      return { status: "rejected", error: "insufficient displayed FOK liquidity" };
    }
    const amount = Math.min(request.shares, available);
    let feeUsd = 0;
    try { if (amount > 0) feeUsd = this.fillFee(request, amount, opposing!, false); }
    catch (error) { return { status: "rejected", error: error instanceof Error ? error.message : "paper fee calculation failed" }; }
    const id = `paper-order-${++this.next}`;
    this.orders.set(id, { request: structuredClone(request), left: request.shares,
      seq: this.next, placedAt: book?.ts ?? 0 });
    if (amount > 0) {
      // Consume now, before the async ACK, so concurrent submissions share the same liquidity.
      if (request.direction === "BUY") liquidity!.ask -= amount; else liquidity!.bid -= amount;
      this.fill(id, amount, opposing!, book!.ts, false, feeUsd);
    }
    if (request.timeInForce !== "GTC" && this.orders.delete(id)) {
      this.enqueue({ kind: "cancel", orderId: id });
    }
    return { status: "accepted", orderId: id };
  }
  async cancel(orderId: string): Promise<boolean> { this.orders.delete(orderId); return true; }
  trade(tokenId: string, takerDirection: "BUY" | "SELL", price: number, shares: number, ts: number): void {
    this.assertOpen();
    if (!tokenId || !["BUY", "SELL"].includes(takerDirection) || ![price, shares, ts].every(Number.isFinite)
      || price <= 0 || price >= 1 || shares <= 0 || ts < 0) throw new Error("invalid paper trade");
    let remaining = shares;
    const matches = [...this.orders].filter(([, o]) => o.request.tokenId === tokenId
      && ts >= o.placedAt
      && o.request.direction !== takerDirection && (o.request.direction === "BUY" ? price <= o.request.price : price >= o.request.price))
      .sort(([, a], [, b]) => (a.request.direction === "BUY" ? b.request.price - a.request.price : a.request.price - b.request.price) || a.seq - b.seq);
    for (const [id, order] of matches) {
      if (remaining <= 0) break;
      const size = Math.min(remaining, order.left);
      this.fill(id, size, order.request.price, ts, true, this.fillFee(order.request, size, order.request.price, true));
      remaining -= size;
    }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("paper gateway closed");
    if (this.callbackErrors.length) throw new AggregateError(this.callbackErrors, "paper callback failed");
  }
  private fillFee(request: OrderRequest, shares: number, price: number, isMaker: boolean): number {
    const fee = this.fee(structuredClone(request), shares, { price, isMaker });
    if (!Number.isFinite(fee) || fee < 0) throw new Error("invalid paper fill fee");
    return fee;
  }
  private fill(id: string, shares: number, price: number, ts: number, isMaker: boolean, feeUsd: number): void {
    const order = this.orders.get(id);
    if (!order) return;
    order.left -= shares;
    if (order.left <= EPS) this.orders.delete(id);
    this.enqueue({ kind: "fill", fill: { tradeId: `paper-trade-${++this.next}`, orderId: id, tokenId: order.request.tokenId,
      direction: order.request.direction, price, shares, feeUsd, ts, isMaker } });
  }
  private enqueue(delivery: Delivery): void {
    this.deliveries.push(delivery);
    // Matching is committed immediately; events reach the account only after its submission ACK.
    this.timer ??= setTimeout(() => { this.timer = undefined; this.drain(); }, 0);
  }
  private drain(): void {
    for (const delivery of this.deliveries.splice(0)) {
      try {
        if (delivery.kind === "fill") this.onFill(delivery.fill); else this.onCancel(delivery.orderId);
      } catch (error) { this.callbackErrors.push(error); }
    }
  }
  close(): Promise<void> {
    return this.closing ??= this.closeOnce();
  }
  private async closeOnce(): Promise<void> {
    this.closed = true;
    // Existing submit continuations must receive their ACK before committed events are delivered.
    await Promise.resolve();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (const orderId of this.orders.keys()) this.deliveries.push({ kind: "cancel", orderId });
    this.orders.clear();
    this.drain();
    this.books.clear();
    if (this.callbackErrors.length) throw new AggregateError(this.callbackErrors, "paper callback failed");
  }
}
