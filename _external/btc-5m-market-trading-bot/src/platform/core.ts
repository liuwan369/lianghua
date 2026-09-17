import type { AccountSnapshot, Book, CoreOptions, CoreState, GatewayAck, Instrument, MarketInfo, OrderRecord,
  OrderRequest, Position, RiskView, TradeFill, TradingEvent } from "./contracts.js";

const EPS = 1e-8;
const active = (order: OrderRecord) => ["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(order.status);
const reservationPending = (order: OrderRecord) => active(order) || order.reconciliationPending === true;
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
  private recovering = false;

  constructor(private readonly options: CoreOptions) {
    this.clock = options.now ?? (() => Date.now() / 1000);
    for (const n of Object.values(options.limits)) {
      if (n == null) continue;
      if (!finite(n) || n <= 0) throw new Error("hard limits must be positive and finite");
    }
    if (!Number.isInteger(options.limits.maxOpenOrders)) throw new Error("maxOpenOrders must be an integer");
    this.validateAccount(options.account);
    this.register(options.instruments);
    const initial = options.account;
    const equity = initial.cashUsd + initial.positions.reduce((n, p) => n + p.costUsd, 0);
    this.state = options.restored ? copy(options.restored) : {
      schemaVersion: 1, accountId: initial.accountId, accountAt: initial.at, mode: options.adapters.gateway.mode,
      cashUsd: initial.cashUsd, positions: copy(initial.positions), orders: copy(initial.openOrders), fills: [],
      risk: { halted: false, day: dayOf(this.clock()), baselineAt: initial.at,
        baselineEquityUsd: equity, equityUsd: equity, dailyPnlUsd: 0, occupiedUsd: 0, availableUsd: 0 },
    };
    if (this.state.schemaVersion !== 1 || this.state.accountId !== initial.accountId
      || this.state.mode !== options.adapters.gateway.mode) throw new Error("platform state identity mismatch");
    if (this.state.accountAt !== undefined && (!finite(this.state.accountAt) || this.state.accountAt < 0)) {
      throw new Error("invalid persisted account snapshot time");
    }
    this.state.accountAt ??= initial.at;
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
    for (const order of this.state.orders) {
      if (["SUBMITTING", "UNKNOWN"].includes(order.status) && order.identityProtocol === "signed-before-post" && !order.prepared) {
        // In this protocol HTTP cannot begin until the signed identity commit.
        order.status = "REJECTED"; order.error = "process interrupted before signed submission";
        order.reservedUsd = 0; order.reservedShares = 0; order.reconciliationPending = false;
      }
    }
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
        || !o.strategyId || clientIds.has(o.clientOrderId) || orderIds.has(o.clientOrderId)
        || (o.orderId && (orderIds.has(o.orderId) || clientIds.has(o.orderId)))
        || !["SUBMITTING", "OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN"].includes(o.status)
        || !["GTC", "FOK", "FAK"].includes(o.timeInForce) || typeof o.postOnly !== "boolean"
        || ![o.shares, o.price, o.filledShares, o.reservedUsd, o.reservedShares, o.createdAt, o.updatedAt].every(finite)
        || o.shares <= 0 || o.price <= 0 || o.price >= 1 || o.filledShares < 0
        || o.filledShares > o.shares + EPS || o.reservedUsd < 0 || o.reservedShares < 0
        || (o.reconciliationPending !== undefined && typeof o.reconciliationPending !== "boolean")
        || (reservationPending(o) && o.direction === "BUY" && o.reservedUsd + EPS < (o.shares - o.filledShares) * o.price)
        || (reservationPending(o) && o.direction === "SELL" && Math.abs(o.reservedShares - (o.shares - o.filledShares)) > EPS)
        || (!reservationPending(o) && (o.reservedUsd > EPS || o.reservedShares > EPS))) {
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
      || !this.validDepth(book.bids, true) || !this.validDepth(book.asks, false)
      || (book.bid != null && book.bids?.[0] != null && Math.abs(book.bid - book.bids[0][0]) > EPS)
      || (book.ask != null && book.asks?.[0] != null && Math.abs(book.ask - book.asks[0][0]) > EPS)
      || (book.bidSize != null && book.bids?.[0] != null && Math.abs(book.bidSize - book.bids[0][1]) > EPS)
      || (book.askSize != null && book.asks?.[0] != null && Math.abs(book.askSize - book.asks[0][1]) > EPS)
      || (book.sourceAgeMs != null && !finite(book.sourceAgeMs))
      || (book.processingLatencyMs != null && (!finite(book.processingLatencyMs) || book.processingLatencyMs < 0))) return false;
    this.books.set(book.tokenId, copy(book));
    this.updateRisk();
    return true;
  }

  private validDepth(levels: Book["bids"], descending: boolean): boolean {
    if (levels == null) return true;
    if (!Array.isArray(levels)) return false;
    let previous: number | undefined;
    return levels.every(level => {
      if (!Array.isArray(level) || level.length !== 2 || !finite(level[0]) || !finite(level[1])
        || level[0] <= 0 || level[0] >= 1 || level[1] <= 0) return false;
      if (previous != null && (descending ? level[0] >= previous : level[0] <= previous)) return false;
      previous = level[0];
      return true;
    });
  }

  snapshot(): CoreState { this.updateRisk(); return copy(this.state); }
  setRecovering(recovering: boolean): void { this.recovering = recovering; }
  requireReconciliation(reason: string): void {
    this.state.risk.halted = true; this.state.risk.reason = `${reason}: reconciliation required`;
    this.persist(true);
  }
  setStrategyState(strategyId: string, state: unknown): void {
    this.state.strategyStates ??= {};
    this.state.strategyStates[strategyId] = copy(state);
    this.persist(true);
  }
  rememberMarket(market: MarketInfo): void {
    this.state.markets ??= [];
    const index = this.state.markets.findIndex(item => item.id === market.id);
    if (index >= 0) this.state.markets[index] = copy(market);
    else this.state.markets.push(copy(market));
    this.persist();
  }
  contextSnapshot(): Omit<CoreState, "fills"> {
    this.updateRisk();
    return copy({ schemaVersion: this.state.schemaVersion, accountId: this.state.accountId,
      mode: this.state.mode, cashUsd: this.state.cashUsd, positions: this.state.positions,
      orders: this.state.orders.filter(reservationPending), risk: this.recovering
        ? { ...this.state.risk, halted: true, reason: "账户恢复中" } : this.state.risk });
  }
  orders(): OrderRecord[] { return copy(this.state.orders); }
  positions(): Position[] { return copy(this.state.positions); }
  risk(): RiskView { this.updateRisk(); return copy(this.state.risk); }
  order(id: string): OrderRecord | undefined {
    const order = this.find(id);
    return order && copy(order);
  }
  markPreparedReplay(id: string): void {
    const order = this.find(id);
    if (!order?.prepared || !["SUBMITTING", "UNKNOWN"].includes(order.status)) throw new Error("order is not eligible for signed replay");
    if ((order.preparedReplayAttempts ?? 0) >= 2) throw new Error("signed replay attempt limit");
    order.preparedReplayAttempts = (order.preparedReplayAttempts ?? 0) + 1;
    this.notify(order, true);
  }
  recoverPreparedAck(id: string, ack: GatewayAck): void {
    const order = this.find(id);
    if (!order?.prepared || ack.status !== "accepted" || ack.orderId !== order.prepared.orderHash) return;
    order.orderId = ack.orderId; order.tradeIds = [...new Set([...(order.tradeIds ?? []), ...(ack.tradeIds ?? [])])];
    if (["SUBMITTING", "UNKNOWN"].includes(order.status)) order.status = order.filledShares > 0 ? "PARTIAL" : "OPEN";
    this.notify(order, true);
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
    const reserved = this.state.orders.filter(reservationPending).reduce((sum, o) => sum + o.reservedUsd, 0);
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
    if (this.options.limits.dailyLossUsd != null && risk.dailyPnlUsd <= -this.options.limits.dailyLossUsd + EPS && (!risk.halted || risk.reason === "daily loss limit")) {
      risk.halted = true; risk.reason = "daily loss limit";
    }
  }
  updateLimits(limits: Partial<CoreOptions["limits"]>): void {
    const next = { ...this.options.limits, ...limits };
    for (const value of Object.values(next)) {
      if (value != null && (!finite(value) || value <= 0)) throw new Error("hard limits must be positive and finite");
    }
    if (!Number.isInteger(next.maxOpenOrders)) throw new Error("maxOpenOrders must be an integer");
    Object.assign(this.options.limits, next);
    if (next.dailyLossUsd == null && this.state.risk.reason === "daily loss limit") {
      this.state.risk.halted = false; delete this.state.risk.reason;
    }
    this.updateRisk(); this.persist(true);
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
      for (const field of ["strategyId", "tokenId", "direction", "price", "shares", "timeInForce", "postOnly", "roundBudgetUsd"] as const) {
        if (previous[field] !== request[field]) throw new Error("clientOrderId reused for a different order");
      }
      return copy(previous);
    }
    if (this.state.orders.some(o => o.orderId === request.clientOrderId)) {
      throw new Error("clientOrderId conflicts with a venue order ID");
    }
    this.updateRisk();
    if (this.recovering) throw new Error("account recovery in progress");
    const reducingAfterLoss = this.state.risk.reason === "daily loss limit" && request.direction === "SELL";
    if (this.stopped || (this.state.risk.halted && !reducingAfterLoss)) throw new Error(this.state.risk.reason ?? "platform stopped");
    const instrument = this.instruments.get(request.tokenId);
    if (!instrument || !request.clientOrderId || !request.strategyId || request.strategyId === "external"
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
    if (request.roundBudgetUsd != null) {
      if (!finite(request.roundBudgetUsd) || request.roundBudgetUsd <= 0) throw new Error("invalid round budget");
      const tokens = new Set([...this.instruments.values()].filter(item => item.marketId === instrument.marketId).map(item => item.tokenId));
      const occupied = this.state.positions.filter(position => tokens.has(position.tokenId)).reduce((sum, position) => sum + position.costUsd, 0)
        + this.state.orders.filter(order => tokens.has(order.tokenId) && reservationPending(order)).reduce((sum, order) => sum + order.reservedUsd, 0);
      if (request.direction === "BUY" && occupied + amount + fee > request.roundBudgetUsd + EPS) {
        throw new Error("round budget including fees and pending orders exceeded");
      }
    }
    if (amount > this.options.limits.maxOrderUsd + EPS) throw new Error("per-order limit");
    if (this.state.orders.filter(active).length >= this.options.limits.maxOpenOrders) throw new Error("open-order limit");
    if (request.direction === "BUY" && amount + fee > this.state.risk.availableUsd + EPS) throw new Error("insufficient cash or capital");
    if (request.direction === "SELL") {
      const reservedShares = this.state.orders.filter(o => reservationPending(o) && o.tokenId === request.tokenId)
        .reduce((sum, o) => sum + o.reservedShares, 0);
      if (request.shares > this.position(request.tokenId).shares - reservedShares + EPS) throw new Error("insufficient sellable shares");
      const reservedUsd = this.state.orders.filter(reservationPending).reduce((sum, o) => sum + o.reservedUsd, 0);
      if (fee > this.state.cashUsd - reservedUsd + EPS) throw new Error("insufficient fee balance");
    }
    const order: OrderRecord = { ...request, status: "SUBMITTING", filledShares: 0,
      identityProtocol: this.options.adapters.gateway.durableIdentity ? "signed-before-post" : undefined,
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
      const ack = await this.options.adapters.gateway.submit(request, copy(instrument), prepared => {
        if (!prepared.orderHash || !prepared.signedPayload) throw new Error("signed order identity missing");
        if (this.state.orders.some(existing => existing !== order
          && (existing.orderId === prepared.orderHash || existing.clientOrderId === prepared.orderHash))) {
          throw new Error("duplicate signed order identity");
        }
        order.prepared = copy(prepared); order.orderId = prepared.orderHash;
        this.notify(order, true);
      });
      order.tradeIds = ack.tradeIds; order.signLatencyMs = ack.signLatencyMs; order.ackLatencyMs = ack.ackLatencyMs;
      if (order.prepared && ack.orderId && order.prepared.orderHash !== ack.orderId) {
        order.orderId = ack.orderId;
        order.status = "UNKNOWN"; order.error = "signed hash differs from venue order ID";
        this.state.risk.halted = true; this.state.risk.reason = "signed identity requires reconciliation";
        return this.notify(order, true);
      }
      if (ack.orderId && (ack.orderId === order.clientOrderId || this.state.orders.some(o => o !== order
        && (o.orderId === ack.orderId || o.clientOrderId === ack.orderId)))) {
        order.status = "UNKNOWN";
        order.error = "duplicate venue order ID requires reconciliation";
        this.state.risk.halted = true;
        this.state.risk.reason = "unknown order requires reconciliation";
        return this.notify(order, true);
      }
      if (ack.orderId) order.orderId = ack.orderId;
      if (ack.status === "accepted" && ack.orderId && ["SUBMITTING", "UNKNOWN"].includes(order.status)) order.status = "OPEN";
      else if (ack.status === "accepted" && ack.orderId) { /* A fill can arrive before the HTTP ACK. */ }
      else if (ack.status === "rejected" && !ack.orderId) {
        order.status = "REJECTED"; order.reservedUsd = 0; order.reservedShares = 0;
      } else if (ack.status === "unknown" && order.orderId && ["FILLED", "PARTIAL"].includes(order.status)) {
        // Authenticated fills already proved this signed order reached the venue.
      } else {
        order.status = "UNKNOWN"; this.state.risk.halted = true; this.state.risk.reason = "unknown order requires reconciliation";
      }
      order.error = ack.error;
    } catch (error) {
      if (!(order.orderId && ["FILLED", "PARTIAL"].includes(order.status))) {
        order.status = "UNKNOWN"; this.state.risk.halted = true; this.state.risk.reason = "unknown order requires reconciliation";
      }
      order.error = error instanceof Error ? error.message : "submission failed";
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
      if (order.status !== "FILLED") {
        order.status = "CANCELLED";
        // Keep the reservation until the user stream or an account read proves
        // that no fill raced the cancel request.
        order.reconciliationPending ??= true;
      }
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
  confirmCancelled(id: string, releaseReservation = false): void {
    const order = this.find(id);
    if (!order) throw new Error("unowned cancellation");
    if (order.status === "FILLED") return;
    order.status = "CANCELLED";
    if (releaseReservation) {
      order.reconciliationPending = false;
      order.reservedUsd = 0; order.reservedShares = 0;
    } else {
      order.reconciliationPending = true;
    }
    this.notify(order, true);
  }
  applyFill(fill: TradeFill): boolean {
    const previous = this.state.fills.find(item => this.fillKey(item) === this.fillKey(fill));
    if (previous) return this.updateFill(previous, fill);
    if (fill.status === "FAILED") {
      const order = this.find(fill.orderId);
      if (!order || order.tokenId !== fill.tokenId || order.direction !== fill.direction || !fill.tradeId) {
        throw new Error("invalid or unowned failed trade");
      }
      order.status = "UNKNOWN"; order.reconciliationPending = true;
      this.state.risk.halted = true; this.state.risk.reason = "failed trade requires reconciliation";
      this.state.fills.push(copy(fill)); this.seenFills.add(this.fillKey(fill));
      this.notify(order, true); this.emit({ kind: "fill", fill: copy(fill) }); return true;
    }
    const order = this.find(fill.orderId);
    if (!order || order.tokenId !== fill.tokenId || order.direction !== fill.direction
      || order.status === "FILLED" || (order.status === "CANCELLED" && !order.reconciliationPending)
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
      fill = { ...fill, accountingBasisUsd: basis, accountingInventoryBeforeShares: position.shares };
      position.shares = Math.max(0, position.shares - fill.shares);
      position.costUsd = Math.max(0, position.costUsd - basis);
      position.realizedPnlUsd += amount - fill.feeUsd - basis;
      this.state.cashUsd += amount - fill.feeUsd;
    }
    const remainingBefore = order.shares - order.filledShares;
    order.filledShares += fill.shares;
    const left = Math.max(0, order.shares - order.filledShares);
    order.reservedUsd *= remainingBefore > EPS ? left / remainingBefore : 0;
    order.reservedShares = order.direction === "SELL" && reservationPending(order) ? left : 0;
    if (left <= EPS) {
      order.status = "FILLED";
      order.reconciliationPending = false;
      order.reservedUsd = 0; order.reservedShares = 0;
    }
    else if (order.status !== "CANCELLED") order.status = "PARTIAL";
    order.updatedAt = this.clock();
    this.seenFills.add(this.fillKey(fill)); this.state.fills.push(copy(fill));
    this.persist(true);
    // Inventory is authoritative in the event context before the strategy sees the fill.
    this.emit({ kind: "fill", fill: copy(fill) });
    this.emit({ kind: "order", order: copy(order) });
    return true;
  }

  private updateFill(previous: TradeFill, incoming: TradeFill): boolean {
    const oldStatus = previous.status ?? "CONFIRMED", nextStatus = incoming.status ?? "CONFIRMED";
    const improvesFee = incoming.feeSource === "reported" && previous.feeSource !== "reported" && nextStatus !== "FAILED";
    if (oldStatus === "FAILED" || (oldStatus === "CONFIRMED" && (nextStatus !== "CONFIRMED" || !improvesFee))
      || (oldStatus === nextStatus && !improvesFee)) return false;
    if (["tokenId", "direction", "shares", "price"].some(key =>
      previous[key as keyof TradeFill] !== incoming[key as keyof TradeFill])) throw new Error("trade identity changed during status update");
    if (nextStatus !== "FAILED") {
      const rank = { MATCHED_NOT_BROADCASTED: 0, MATCHED: 1, RETRYING: 1, MINED: 2, CONFIRMED: 3, FAILED: 3 };
      if (rank[nextStatus] < rank[oldStatus]) return false;
      if (!finite(incoming.feeUsd) || incoming.feeUsd < 0) throw new Error("invalid confirmed trade fee");
      if (incoming.feeSource === "reported" && previous.feeSource !== "reported") {
        const delta = incoming.feeUsd - previous.feeUsd;
        const position = this.position(previous.tokenId);
        if (previous.direction === "BUY") {
          let retained = 1;
          const subsequentSells = this.state.fills.slice(this.state.fills.indexOf(previous) + 1)
            .filter(later => later.tokenId === previous.tokenId && later.direction === "SELL" && later.status !== "FAILED");
          if (subsequentSells.some(later => !later.accountingInventoryBeforeShares || later.accountingBasisUsd == null)) {
            throw new Error("fee correction requires historical sell inventory reconciliation");
          }
          for (const later of subsequentSells) {
            const fraction = Math.min(1, later.shares / later.accountingInventoryBeforeShares!);
            later.accountingBasisUsd! += delta * retained * fraction;
            retained *= 1 - fraction;
          }
          position.costUsd += delta * retained;
          position.realizedPnlUsd -= delta * (1 - retained);
        }
        else position.realizedPnlUsd -= delta;
        this.state.cashUsd -= delta;
        previous.feeUsd = incoming.feeUsd; previous.feeSource = "reported";
      }
      previous.status = nextStatus;
      this.persist(true); this.emit({ kind: "fill", fill: copy(previous) }); return true;
    }
    const order = this.find(previous.orderId);
    if (!order) throw new Error("failed trade has no owned order");
    const position = this.position(previous.tokenId), amount = previous.shares * previous.price;
    if (previous.direction === "BUY") {
      if (position.shares + EPS < previous.shares || position.costUsd + EPS < amount + previous.feeUsd) {
        this.state.risk.halted = true; this.state.risk.reason = "failed trade requires account reconciliation";
        this.persist(true); throw new Error("failed provisional buy was already disposed; account reconciliation required");
      }
      position.shares = Math.max(0, position.shares - previous.shares);
      position.costUsd = Math.max(0, position.costUsd - (amount + previous.feeUsd));
      this.state.cashUsd += amount + previous.feeUsd;
    } else {
      const basis = previous.accountingBasisUsd;
      if (basis == null) throw new Error("failed provisional sell has no basis");
      position.shares += previous.shares; position.costUsd += basis;
      position.realizedPnlUsd -= amount - previous.feeUsd - basis;
      this.state.cashUsd -= amount - previous.feeUsd;
    }
    previous.status = "FAILED";
    order.filledShares = Math.max(0, order.filledShares - previous.shares);
    order.status = "UNKNOWN"; order.reconciliationPending = true;
    const remaining = order.shares - order.filledShares;
    order.reservedUsd = (order.direction === "BUY" ? remaining * order.price : 0)
      + (this.options.adapters.estimateFee?.({ ...order, shares: remaining }) ?? 0);
    order.reservedShares = order.direction === "SELL" ? remaining : 0;
    this.state.risk.halted = true; this.state.risk.reason = "failed trade requires reconciliation";
    this.notify(order, true); this.emit({ kind: "fill", fill: copy(previous) });
    return true;
  }

  reconcile(account: AccountSnapshot, netCashFlowUsd = 0, cancelledOrderIds: readonly string[] = []): void {
    this.validateAccount(account);
    if (!finite(netCashFlowUsd)) throw new Error("invalid external cash flow adjustment");
    if (account.accountId !== this.state.accountId || this.jobs.size) throw new Error("reconciliation requires the same account and no requests in flight");
    const lastAccountAt = this.state.accountAt ?? -Infinity;
    if (account.at + EPS < lastAccountAt) throw new Error("account snapshot is older than the last accepted snapshot");
    if (this.state.orders.some(o => o.status === "UNKNOWN" && !o.orderId)) {
      throw new Error("unidentified submission must be resolved before replacing account state");
    }
    // Reconciliation may reject late in validation. Stage every mutation so a
    // rejected read cannot release reservations or double-count a later fill.
    const next = copy(this.state);
    const cancelled = new Set(cancelledOrderIds);
    const newlyCancelled = new Set<string>();
    const openIds = new Set(account.openOrders.map(o => o.orderId));
    for (const order of next.orders.filter(active)) {
      if (!order.orderId) throw new Error("active order without identity requires reconciliation");
      if (!openIds.has(order.orderId)) {
        if (!cancelled.has(order.orderId)) throw new Error("missing order needs trade/cancel evidence before reconciliation");
        // Keep the reservation for one subsequent account read in case a
        // fill is still in flight from the disconnect window.
        order.status = "CANCELLED";
        order.reconciliationPending = true;
        newlyCancelled.add(order.orderId);
        continue;
      }
      const incoming = account.openOrders.find(o => o.orderId === order.orderId)!;
      if (incoming.filledShares !== order.filledShares) throw new Error("apply missing fills before reconciliation");
    }
    for (const order of next.orders.filter(o => o.reconciliationPending)) {
      if (!order.orderId) throw new Error("cancelled order without identity requires reconciliation");
      const incoming = account.openOrders.find(o => o.orderId === order.orderId);
      if (!incoming) {
        if (newlyCancelled.has(order.orderId)) continue;
        order.reconciliationPending = false;
        order.reservedUsd = 0;
        order.reservedShares = 0;
      }
    }
    next.cashUsd = account.cashUsd; next.positions = copy(account.positions); next.accountAt = account.at;
    for (const incoming of account.openOrders) {
      const current = incoming.orderId && next.orders.find(o => o.orderId === incoming.orderId || o.clientOrderId === incoming.orderId);
      if (current) {
        if (current.reconciliationPending) {
          if (incoming.filledShares !== current.filledShares) {
            throw new Error("apply missing fills before reconciliation");
          }
          // A venue may still list an order after a cancel ACK. Keep the
          // local cancelled state until a later read removes it.
          continue;
        }
        if (!active(current) && !current.reconciliationPending) {
          throw new Error("terminal order reappeared in account snapshot");
        }
        Object.assign(current, copy(incoming), { clientOrderId: current.clientOrderId,
          strategyId: current.strategyId, reconciliationPending: false });
      }
      else next.orders.push(copy(incoming));
    }
    this.validateAccount({ ...account, openOrders: next.orders });
    if (next.risk.reason?.includes("reconciliation")) {
      next.risk.halted = false; delete next.risk.reason;
    }
    next.risk.baselineEquityUsd += netCashFlowUsd;
    this.state = next;
    this.persist(true); this.emit({ kind: "account", snapshot: copy(account) });
  }
  async idle(): Promise<void> { while (this.jobs.size) await Promise.allSettled([...this.jobs]); }
  async stop(reason = "operator stop"): Promise<void> {
    this.stopped = true;
    if (!this.state.risk.halted) { this.state.risk.halted = true; this.state.risk.reason = "platform stopped"; }
    await this.idle();
    const ownedActive = () => this.state.orders.filter(o => active(o) && o.strategyId !== "external");
    const result = await Promise.allSettled(ownedActive().map(o => this.cancel(o.orderId ?? o.clientOrderId)));
    if (result.some(item => item.status === "rejected")) throw new Error("stop left unresolved orders");
    this.options.adapters.beforeFinalReconcile?.();
    let unresolved = this.state.orders.some(o => reservationPending(o) && o.strategyId !== "external");
    if (unresolved && this.options.adapters.readAccount) {
      try {
        this.reconcile(await this.options.adapters.readAccount());
      } catch {
        // Keep the fail-closed state when the final ordinary account read
        // cannot prove every cancellation and fill outcome.
      }
      unresolved = this.state.orders.some(o => reservationPending(o) && o.strategyId !== "external");
    }
    if (unresolved) throw new Error("stop left unresolved orders");
    this.persist(true); this.emit({ kind: "stopped", reason });
  }
}
