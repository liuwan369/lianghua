import type { AccountSnapshot, Book, CoreOptions, CoreState, Instrument, OrderRecord,
  OrderRequest, Position, RiskView, TradeFill, TradingEvent } from "./contracts.js";

const EPS = 1e-8;
const active = (order: OrderRecord) => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status);
const copy = <T>(value: T): T => structuredClone(value);
const finite = (value: number) => Number.isFinite(value);
const dayOf = (ts: number) => new Date(ts * 1000 + 8 * 3600_000).toISOString().slice(0, 10);

/** Account-wide accounting and execution. No price selection or strategy lifecycle rules. */
export class TradingCore {
  private state: CoreState;
  private instruments = new Map<string, Instrument>();
  private books = new Map<string, Book>();
  private jobs = new Set<Promise<unknown>>();
  private submissions = new Map<string, Promise<OrderRecord>>();
  private seenFills = new Set<string>();
  private clock: () => number;
  private stopped = false;

  constructor(private readonly options: CoreOptions) {
    this.clock = options.now ?? (() => Date.now() / 1000);
    for (const n of Object.values(options.limits)) {
      if (!finite(n) || n <= 0) throw new Error("hard limits must be positive and finite");
    }
    if (!Number.isInteger(options.limits.maxOpenOrders)) throw new Error("maxOpenOrders must be an integer");
    this.validateAccount(options.account);
    this.register(options.instruments);
    const initial = options.account;
    const equity = initial.cashUsd + initial.positions.reduce((n, p) => n + p.costUsd, 0);
    this.state = options.restored ? copy(options.restored) : {
      schemaVersion: 1, accountId: initial.accountId, mode: options.adapters.gateway.mode,
      cashUsd: initial.cashUsd, positions: copy(initial.positions), orders: copy(initial.openOrders), fills: [],
      risk: { halted: false, day: dayOf(this.clock()), baselineAt: initial.at,
        baselineEquityUsd: equity, equityUsd: equity, dailyPnlUsd: 0, occupiedUsd: 0, availableUsd: 0 },
    };
    if (this.state.schemaVersion !== 1 || this.state.accountId !== initial.accountId
      || this.state.mode !== options.adapters.gateway.mode) throw new Error("platform state identity mismatch");
    this.validateAccount({ ...initial, cashUsd: this.state.cashUsd, positions: this.state.positions,
      openOrders: this.state.orders });
    if (!Array.isArray(this.state.fills) || !this.state.risk || typeof this.state.risk.halted !== "boolean"
      || !/^\d{4}-\d{2}-\d{2}$/.test(this.state.risk.day)
      || ![this.state.risk.baselineAt, this.state.risk.baselineEquityUsd].every(finite)) {
      throw new Error("invalid persisted platform state");
    }
    if (this.state.risk.reason === "platform stopped") {
      this.state.risk.halted = false; delete this.state.risk.reason;
    }
    for (const fill of this.state.fills) this.seenFills.add(this.fillKey(fill));
    // Restored in-flight requests must be reconciled with the venue before another submission.
    if (options.restored && this.state.orders.some(active)) {
      this.state.risk.halted = true;
      this.state.risk.reason = "restored orders require reconciliation";
    }
    this.updateRisk();
  }

  private validateAccount(account: AccountSnapshot): void {
    if (!account.complete || !account.accountId || !finite(account.at) || !finite(account.cashUsd)
      || account.cashUsd < 0 || !Array.isArray(account.positions) || !Array.isArray(account.openOrders)) {
      throw new Error("complete ordinary account balance, positions and orders are required");
    }
    const tokens = new Set<string>();
    for (const p of account.positions) {
      if (!p.tokenId || tokens.has(p.tokenId) || ![p.shares, p.costUsd, p.realizedPnlUsd].every(finite)
        || p.shares < 0 || p.costUsd < 0) throw new Error("invalid account position");
      tokens.add(p.tokenId);
    }
    const clientIds = new Set<string>(), orderIds = new Set<string>();
    for (const o of account.openOrders) {
      if (!o.clientOrderId || !o.tokenId || !["BUY", "SELL"].includes(o.direction)
        || !o.strategyId || clientIds.has(o.clientOrderId) || (o.orderId && orderIds.has(o.orderId))
        || !["SUBMITTING", "OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN"].includes(o.status)
        || !["GTC", "FOK", "FAK"].includes(o.timeInForce) || typeof o.postOnly !== "boolean"
        || ![o.shares, o.price, o.filledShares, o.reservedUsd, o.reservedShares, o.createdAt, o.updatedAt].every(finite)
        || o.shares <= 0 || o.price <= 0 || o.price >= 1 || o.filledShares < 0
        || o.filledShares > o.shares + EPS || o.reservedUsd < 0 || o.reservedShares < 0
        || (active(o) && o.direction === "BUY" && o.reservedUsd + EPS < (o.shares - o.filledShares) * o.price)
        || (active(o) && o.direction === "SELL" && Math.abs(o.reservedShares - (o.shares - o.filledShares)) > EPS)) {
        throw new Error("invalid account order");
      }
      clientIds.add(o.clientOrderId); if (o.orderId) orderIds.add(o.orderId);
    }
  }

  register(instruments: Instrument[]): void {
    for (const item of instruments) {
      if (!item.tokenId || !item.marketId || !finite(item.tickSize) || item.tickSize <= 0
        || item.tickSize >= 1 || !finite(item.minOrderSize) || item.minOrderSize <= 0) {
        throw new Error("invalid instrument rules");
      }
      this.instruments.set(item.tokenId, copy(item));
    }
  }

  instrument(tokenId: string): Instrument | undefined {
    const value = this.instruments.get(tokenId);
    return value && copy(value);
  }

  mark(book: Book): boolean {
    if (!this.instruments.has(book.tokenId) || !finite(book.ts) || book.ts < (this.books.get(book.tokenId)?.ts ?? -Infinity)) return false;
    if ([book.bid, book.ask].some(p => p != null && (!finite(p) || p < 0 || p > 1))
      || [book.bidSize, book.askSize].some(s => s != null && (!finite(s) || s < 0))
      || (book.bid != null && book.ask != null && book.bid > book.ask)
      || !this.validDepth(book.bids) || !this.validDepth(book.asks)
      || (book.sourceAgeMs != null && !finite(book.sourceAgeMs))
      || (book.processingLatencyMs != null && (!finite(book.processingLatencyMs) || book.processingLatencyMs < 0))) return false;
    this.books.set(book.tokenId, copy(book));
    this.updateRisk();
    return true;
  }

  private validDepth(levels: Book["bids"]): boolean {
    return levels == null || (Array.isArray(levels) && levels.every(level => Array.isArray(level)
      && level.length === 2 && finite(level[0]) && finite(level[1]) && level[0] > 0 && level[0] < 1 && level[1] > 0));
  }

  snapshot(): CoreState { this.updateRisk(); return copy(this.state); }
  contextSnapshot(): Omit<CoreState, "fills"> {
    this.updateRisk();
    return copy({ schemaVersion: this.state.schemaVersion, accountId: this.state.accountId,
      mode: this.state.mode, cashUsd: this.state.cashUsd, positions: this.state.positions,
      orders: this.state.orders.filter(active), risk: this.state.risk });
  }
  orders(): OrderRecord[] { return copy(this.state.orders); }
  positions(): Position[] { return copy(this.state.positions); }
  risk(): RiskView { this.updateRisk(); return copy(this.state.risk); }
  order(id: string): OrderRecord | undefined {
    const order = this.find(id);
    return order && copy(order);
  }
  private find(id: string): OrderRecord | undefined {
    return this.state.orders.find(order => order.orderId === id || order.clientOrderId === id);
  }
  private position(tokenId: string): Position {
    let position = this.state.positions.find(p => p.tokenId === tokenId);
    if (!position) {
      position = { tokenId, shares: 0, costUsd: 0, realizedPnlUsd: 0 };
      this.state.positions.push(position);
    }
    return position;
  }
  private updateRisk(): void {
    const held = this.state.positions.reduce((sum, p) => sum + p.costUsd, 0);
    const reserved = this.state.orders.filter(active).reduce((sum, o) => sum + o.reservedUsd, 0);
    const equity = this.state.cashUsd + this.state.positions.reduce((sum, p) => {
      const bid = this.books.get(p.tokenId)?.bid;
      return sum + (bid == null ? p.costUsd : p.shares * bid);
    }, 0);
    const risk = this.state.risk;
    // An observed day boundary establishes a new baseline; it is not a claim of a midnight snapshot.
    const day = dayOf(this.clock());
    if (risk.day !== day) {
      risk.day = day; risk.baselineAt = this.clock(); risk.baselineEquityUsd = equity;
      if (risk.reason === "daily loss limit") { risk.halted = false; delete risk.reason; }
    }
    risk.equityUsd = equity;
    risk.dailyPnlUsd = equity - risk.baselineEquityUsd;
    risk.occupiedUsd = held + reserved;
    risk.availableUsd = Math.max(0, Math.min(this.state.cashUsd - reserved,
      this.options.limits.capitalUsd - risk.occupiedUsd));
    if (risk.dailyPnlUsd <= -this.options.limits.dailyLossUsd + EPS && (!risk.halted || risk.reason === "daily loss limit")) {
      risk.halted = true; risk.reason = "daily loss limit";
    }
  }
  private persist(critical = false): void {
    try { this.options.adapters.persist?.(this.snapshot(), critical); }
    catch (error) {
      this.state.risk.halted = true; this.state.risk.reason = "state persistence failed";
      throw error;
    }
  }
  private emit(event: TradingEvent): void {
    try { this.options.adapters.record?.(copy(event)); } catch { /* Observability is outside execution. */ }
    this.options.onEvent?.(copy(event));
  }
  private notify(order: OrderRecord, critical = false): OrderRecord {
    order.updatedAt = this.clock();
    this.persist(critical); this.emit({ kind: "order", order: copy(order) });
    return copy(order);
  }
  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    return job;
  }
  submit(request: OrderRequest): Promise<OrderRecord> {
    const job = this.submitOrder(copy(request));
    if (!this.submissions.has(request.clientOrderId)) {
      this.submissions.set(request.clientOrderId, job);
      void job.then(() => this.submissions.delete(request.clientOrderId), () => this.submissions.delete(request.clientOrderId));
    }
    return this.track(job);
  }
  private async submitOrder(request: OrderRequest): Promise<OrderRecord> {
    const previous = this.state.orders.find(o => o.clientOrderId === request.clientOrderId);
    if (previous) {
      for (const field of ["strategyId", "tokenId", "direction", "price", "shares", "timeInForce", "postOnly"] as const) {
        if (previous[field] !== request[field]) throw new Error("clientOrderId reused for a different order");
      }
      return copy(previous);
    }
    this.updateRisk();
    const reducingAfterLoss = this.state.risk.reason === "daily loss limit" && request.direction === "SELL";
    if (this.stopped || (this.state.risk.halted && !reducingAfterLoss)) throw new Error(this.state.risk.reason ?? "platform stopped");
    const instrument = this.instruments.get(request.tokenId);
    if (!instrument || !request.clientOrderId || !request.strategyId
      || !["BUY", "SELL"].includes(request.direction) || !["GTC", "FOK", "FAK"].includes(request.timeInForce)
      || typeof request.postOnly !== "boolean" || (request.postOnly && request.timeInForce !== "GTC")
      || ![request.price, request.shares].every(finite) || request.price <= 0 || request.price >= 1
      || request.shares < instrument.minOrderSize - EPS
      || Math.abs(request.price / instrument.tickSize - Math.round(request.price / instrument.tickSize)) > 1e-6) {
      throw new Error("invalid order or instrument rules");
    }
    const amount = request.price * request.shares;
    const fee = this.options.adapters.estimateFee?.(request) ?? 0;
    if (!finite(fee) || fee < 0) throw new Error("invalid fee reserve");
    if (amount > this.options.limits.maxOrderUsd + EPS) throw new Error("per-order limit");
    if (this.state.orders.filter(active).length >= this.options.limits.maxOpenOrders) throw new Error("open-order limit");
    if (request.direction === "BUY" && amount + fee > this.state.risk.availableUsd + EPS) throw new Error("insufficient cash or capital");
    if (request.direction === "SELL") {
      const reservedShares = this.state.orders.filter(o => active(o) && o.tokenId === request.tokenId)
        .reduce((sum, o) => sum + o.reservedShares, 0);
      if (request.shares > this.position(request.tokenId).shares - reservedShares + EPS) throw new Error("insufficient sellable shares");
      const reservedUsd = this.state.orders.filter(active).reduce((sum, o) => sum + o.reservedUsd, 0);
      if (fee > this.state.cashUsd - reservedUsd + EPS) throw new Error("insufficient fee balance");
    }
    const order: OrderRecord = { ...request, status: "SUBMITTING", filledShares: 0,
      reservedUsd: request.direction === "BUY" ? amount + fee : fee,
      reservedShares: request.direction === "SELL" ? request.shares : 0,
      createdAt: this.clock(), updatedAt: this.clock() };
    this.state.orders.push(order);
    // Persist the reservation before sending; subsequent lifecycle updates may be coalesced.
    try { this.persist(true); }
    catch (error) {
      order.status = "REJECTED"; order.error = "reservation persistence failed before submission";
      order.reservedUsd = 0; order.reservedShares = 0;
      this.emit({ kind: "order", order: copy(order) });
      throw error;
    }
    this.emit({ kind: "order", order: copy(order) });
    try {
      const ack = await this.options.adapters.gateway.submit(request, copy(instrument));
      order.tradeIds = ack.tradeIds; order.signLatencyMs = ack.signLatencyMs; order.ackLatencyMs = ack.ackLatencyMs;
      if (ack.orderId) order.orderId = ack.orderId;
      if (ack.status === "accepted" && ack.orderId) order.status = "OPEN";
      else if (ack.status === "rejected" && !ack.orderId) {
        order.status = "REJECTED"; order.reservedUsd = 0; order.reservedShares = 0;
      } else {
        order.status = "UNKNOWN"; this.state.risk.halted = true; this.state.risk.reason = "unknown order requires reconciliation";
      }
      order.error = ack.error;
    } catch (error) {
      order.status = "UNKNOWN"; order.error = error instanceof Error ? error.message : "submission failed";
      this.state.risk.halted = true; this.state.risk.reason = "unknown order requires reconciliation";
    }
    return this.notify(order, true);
  }

  cancel(id: string): Promise<OrderRecord> { return this.track(this.cancelOrder(id)); }
  private async cancelOrder(id: string): Promise<OrderRecord> {
    const order = this.find(id);
    if (!order) throw new Error("order not found");
    if (!active(order)) return copy(order);
    if (order.status === "SUBMITTING") {
      await Promise.resolve();
      await this.submissions.get(order.clientOrderId);
      if (order.status === "SUBMITTING") throw new Error("order ACK pending");
      return this.cancelOrder(id);
    }
    if (!order.orderId) throw new Error("unidentified order requires reconciliation");
    try {
      if (!(await this.options.adapters.gateway.cancel(order.orderId))) throw new Error("cancellation not confirmed");
      if (order.status !== "FILLED") order.status = "CANCELLED";
      order.reservedUsd = 0; order.reservedShares = 0;
    } catch (error) {
      if (!active(order)) return copy(order);
      order.status = "UNKNOWN"; order.error = error instanceof Error ? error.message : "cancellation failed";
      this.state.risk.halted = true; this.state.risk.reason = "unknown order requires reconciliation";
    }
    return this.notify(order, true);
  }
  async replace(id: string, request: OrderRequest): Promise<OrderRecord> {
    const old = this.find(id);
    if (!old || old.clientOrderId === request.clientOrderId) throw new Error("replacement requires a new clientOrderId");
    const cancelled = await this.cancel(id);
    if (cancelled.status !== "CANCELLED") throw new Error("replacement requires confirmed cancellation");
    return this.submit(request);
  }
  async cancelAll(strategyId?: string): Promise<OrderRecord[]> {
    return Promise.all(this.state.orders.filter(o => active(o) && (strategyId ? o.strategyId === strategyId : o.strategyId !== "external"))
      .map(o => this.cancel(o.orderId ?? o.clientOrderId)));
  }

  private fillKey(fill: TradeFill): string { return JSON.stringify([fill.tradeId, fill.orderId]); }
  confirmCancelled(id: string): void {
    const order = this.find(id);
    if (!order) throw new Error("unowned cancellation");
    if (order.status === "FILLED") return;
    order.status = "CANCELLED"; order.reservedUsd = 0; order.reservedShares = 0;
    this.notify(order, true);
  }
  applyFill(fill: TradeFill): boolean {
    if (this.seenFills.has(this.fillKey(fill))) return false;
    const order = this.find(fill.orderId);
    if (!order || order.tokenId !== fill.tokenId || order.direction !== fill.direction
      || !fill.tradeId || ![fill.shares, fill.price, fill.feeUsd, fill.ts].every(finite)
      || fill.shares <= 0 || fill.price <= 0 || fill.price >= 1 || fill.feeUsd < 0
      || (fill.direction === "BUY" ? fill.price > order.price + EPS : fill.price < order.price - EPS)
      || order.filledShares + fill.shares > order.shares + EPS) throw new Error("invalid or unowned fill");
    const position = this.position(fill.tokenId);
    const amount = fill.shares * fill.price;
    if (fill.direction === "BUY") {
      position.shares += fill.shares; position.costUsd += amount + fill.feeUsd;
      this.state.cashUsd -= amount + fill.feeUsd;
    } else {
      if (fill.shares > position.shares + EPS) throw new Error("sell fill exceeds recorded inventory; reconciliation required");
      const basis = position.shares > EPS ? position.costUsd * fill.shares / position.shares : 0;
      position.shares = Math.max(0, position.shares - fill.shares);
      position.costUsd = Math.max(0, position.costUsd - basis);
      position.realizedPnlUsd += amount - fill.feeUsd - basis;
      this.state.cashUsd += amount - fill.feeUsd;
    }
    const remainingBefore = order.shares - order.filledShares;
    order.filledShares += fill.shares;
    const left = Math.max(0, order.shares - order.filledShares);
    order.reservedUsd *= remainingBefore > EPS ? left / remainingBefore : 0;
    order.reservedShares = order.direction === "SELL" && active(order) ? left : 0;
    if (left <= EPS) { order.status = "FILLED"; order.reservedUsd = 0; order.reservedShares = 0; }
    else if (order.status !== "CANCELLED") order.status = "PARTIAL";
    order.updatedAt = this.clock();
    this.seenFills.add(this.fillKey(fill)); this.state.fills.push(copy(fill));
    this.persist(true);
    // Inventory is authoritative in the event context before the strategy sees the fill.
    this.emit({ kind: "fill", fill: copy(fill) });
    this.emit({ kind: "order", order: copy(order) });
    return true;
  }

  reconcile(account: AccountSnapshot, netCashFlowUsd = 0): void {
    this.validateAccount(account);
    if (!finite(netCashFlowUsd)) throw new Error("invalid external cash flow adjustment");
    if (account.accountId !== this.state.accountId || this.jobs.size) throw new Error("reconciliation requires the same account and no requests in flight");
    if (this.state.orders.some(o => o.status === "UNKNOWN" && !o.orderId)) {
      throw new Error("unidentified submission must be resolved before replacing account state");
    }
    const openIds = new Set(account.openOrders.map(o => o.orderId));
    for (const order of this.state.orders.filter(active)) {
      if (!openIds.has(order.orderId)) throw new Error("missing order needs trade/cancel evidence before reconciliation");
      const incoming = account.openOrders.find(o => o.orderId === order.orderId)!;
      if (incoming.filledShares !== order.filledShares) throw new Error("apply missing fills before reconciliation");
    }
    this.state.cashUsd = account.cashUsd; this.state.positions = copy(account.positions);
    for (const incoming of account.openOrders) {
      const current = incoming.orderId && this.find(incoming.orderId);
      if (current) Object.assign(current, copy(incoming), { clientOrderId: current.clientOrderId, strategyId: current.strategyId });
      else this.state.orders.push(copy(incoming));
    }
    if (this.state.risk.reason?.includes("reconciliation")) {
      this.state.risk.halted = false; delete this.state.risk.reason;
    }
    this.state.risk.baselineEquityUsd += netCashFlowUsd;
    this.persist(true); this.emit({ kind: "account", snapshot: copy(account) });
  }
  async idle(): Promise<void> { while (this.jobs.size) await Promise.allSettled([...this.jobs]); }
  async stop(reason = "operator stop"): Promise<void> {
    this.stopped = true;
    if (!this.state.risk.halted) { this.state.risk.halted = true; this.state.risk.reason = "platform stopped"; }
    await this.idle();
    const ownedActive = () => this.state.orders.filter(o => active(o) && o.strategyId !== "external");
    const result = await Promise.allSettled(ownedActive().map(o => this.cancel(o.orderId ?? o.clientOrderId)));
    this.persist(true); this.emit({ kind: "stopped", reason });
    if (result.some(item => item.status === "rejected") || ownedActive().length) throw new Error("stop left unresolved orders");
  }
}
