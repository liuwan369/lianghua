import type { AccountSnapshot, Book, CashFlowTracking, CancellationSource, CoreOptions, CoreState, ExecutionTiming, GatewayAck, Instrument, MarketInfo, OrderRecord,
  OrderRequest, Position, RiskView, TradeFill, TradingEvent, VenueStateSource } from "./contracts.js";

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
  private submissionRequests = new Map<string, OrderRequest>();
  private cancellations = new Map<string, Promise<OrderRecord>>();
  private preparationTail: Promise<void> = Promise.resolve();
  private fillByKey = new Map<string, TradeFill>();
  private fillIndexByKey = new Map<string, number>();
  private fillOrderByTradeId = new Map<string, string>();
  private clock: () => number;
  private stopped = false;
  private recovering = false;
  /** Markets being reconciled; an empty set means all markets are available. */
  private recoveringMarkets = new Set<string>();

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
      schemaVersion: 1, accountId: initial.accountId, accountAt: initial.at, cashAt: initial.cashAt ?? initial.at, mode: options.adapters.gateway.mode,
      cashUsd: initial.cashUsd, positions: copy(initial.positions), orders: copy(initial.openOrders), fills: [], quarantinedOrderIds: [],
      risk: { halted: false, day: dayOf(this.clock()), baselineAt: initial.at,
        baselineAccountAt: initial.cashAt ?? initial.at,
        baselineEquityUsd: equity, equityUsd: equity, dailyPnlUsd: 0, occupiedUsd: 0, availableUsd: 0 },
    };
    if (this.state.schemaVersion !== 1 || this.state.accountId !== initial.accountId
      || this.state.mode !== options.adapters.gateway.mode) throw new Error("platform state identity mismatch");
    if (this.state.accountAt !== undefined && (!finite(this.state.accountAt) || this.state.accountAt < 0)) {
      throw new Error("invalid persisted account snapshot time");
    }
    this.state.accountAt ??= initial.at;
    this.state.cashAt ??= this.state.accountAt;
    if (!finite(this.state.cashAt) || this.state.cashAt < 0 || this.state.cashAt > this.state.accountAt + EPS) {
      throw new Error("invalid persisted cash observation time");
    }
    this.validateAccount({ ...initial, cashUsd: this.state.cashUsd, positions: this.state.positions,
      openOrders: this.state.orders });
    if (!Array.isArray(this.state.fills) || !this.state.risk || typeof this.state.risk.halted !== "boolean"
      || !/^\d{4}-\d{2}-\d{2}$/.test(this.state.risk.day)
      || ![this.state.risk.baselineAt, this.state.risk.baselineEquityUsd].every(finite)) {
      throw new Error("invalid persisted platform state");
    }
    this.state.quarantinedOrderIds ??= [];
    if (!Array.isArray(this.state.quarantinedOrderIds)
      || this.state.quarantinedOrderIds.some(id => typeof id !== "string" || !id)
      || new Set(this.state.quarantinedOrderIds).size !== this.state.quarantinedOrderIds.length
      || this.state.quarantinedOrderIds.some(id => !this.state.orders.some(order => order.orderId === id))) {
      throw new Error("invalid persisted quarantined orders");
    }
    this.state.risk.baselineAccountAt ??= this.state.risk.baselineAt;
    if (!finite(this.state.risk.baselineAccountAt) || this.state.risk.baselineAccountAt < 0) throw new Error("invalid persisted cash baseline time");
    this.state.cashFlowTracking ??= { baselineAt: options.restored ? this.state.risk.baselineAt : initial.cashAt ?? initial.at, complete: false,
      reason: "external_cash_flow_coverage_unavailable", appliedFlows: [] };
    if (this.state.risk.reason === "platform stopped") {
      this.state.risk.halted = false; delete this.state.risk.reason;
    }
    this.validateCashFlowTracking(this.state.cashFlowTracking);
    if (!options.restored) this.applyCashFlowEvidence(this.state, initial);
    this.state.fills.forEach((fill, index) => {
      if (!fill.tradeId || !fill.orderId) throw new Error("invalid persisted fill identity");
      const existingOrderId = this.fillOrderByTradeId.get(fill.tradeId);
      if (existingOrderId && existingOrderId !== fill.orderId) throw new Error("duplicate persisted trade identity");
      this.fillOrderByTradeId.set(fill.tradeId, fill.orderId);
      const key = this.fillKey(fill);
      this.fillByKey.set(key, fill);
      this.fillIndexByKey.set(key, index);
    });
    for (const order of this.state.orders) {
      if (order.status !== "SUBMITTING") continue;
      if (order.identityProtocol === "signed-before-post" && !order.prepared) {
        // In this protocol HTTP cannot begin until the signed identity commit.
        order.status = "REJECTED"; order.error = "process interrupted before signed submission";
        order.reservedUsd = 0; order.reservedShares = 0; order.reconciliationPending = false;
      } else {
        // A restored process has no in-memory submission promise to await. A
        // durable order identity means the POST may already have reached the
        // venue, so continue through UNKNOWN/reconciliation instead of leaving
        // stop() stuck on an ACK that can never arrive in this process.
        order.status = "UNKNOWN";
        order.error ??= "process interrupted before order acknowledgement";
      }
    }
    // Restored in-flight requests must be reconciled with the venue before another submission.
    if (options.restored && this.state.orders.some(order => active(order) && !this.isOrderQuarantined(order.orderId ?? ""))) {
      this.state.risk.halted = true;
      this.state.risk.reason = "restored orders require reconciliation";
    }
    this.updateRisk();
  }

  private validateAccount(account: AccountSnapshot): void {
    if (!account.complete || !account.accountId || !finite(account.at) || !finite(account.cashUsd)
      || account.at < 0 || (account.cashAt !== undefined && (!finite(account.cashAt) || account.cashAt < 0 || account.cashAt > account.at + EPS))
      || account.cashUsd < 0 || !Array.isArray(account.positions) || !Array.isArray(account.openOrders)) {
      throw new Error("complete ordinary account balance, positions and orders are required");
    }
    const coverage = account.cashFlowCoverage;
    if (coverage && (!Number.isSafeInteger(coverage.fromBlock) || coverage.fromBlock < 0
      || !Number.isSafeInteger(coverage.toBlock) || coverage.toBlock < coverage.fromBlock
      || !finite(coverage.fromAt) || !finite(coverage.toAt) || coverage.fromAt < 0 || coverage.toAt < coverage.fromAt
      || typeof coverage.complete !== "boolean")) throw new Error("invalid cash flow coverage");
    if (account.externalFlows !== undefined && (!Array.isArray(account.externalFlows) || !coverage)) {
      throw new Error("external flows require a coverage interval");
    }
    const flowIds = new Set<string>();
    for (const flow of account.externalFlows ?? []) {
      if (!flow.id || flowIds.has(flow.id) || !["deposit", "withdrawal"].includes(flow.kind)
        || !finite(flow.amountUsd) || flow.amountUsd <= 0 || !Number.isSafeInteger(flow.block)
        || flow.block < coverage!.fromBlock || flow.block > coverage!.toBlock
        || !finite(flow.at) || flow.at < coverage!.fromAt || flow.at > coverage!.toAt || flow.at > (account.cashAt ?? account.at) + EPS
        || !/^0x[0-9a-f]{64}$/i.test(flow.transactionHash)) throw new Error("invalid external cash flow evidence");
      flowIds.add(flow.id);
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
        || (o.cancelRequestedAt !== undefined && (!finite(o.cancelRequestedAt) || o.cancelRequestedAt < 0))
        || (o.cancelAckAt !== undefined && (!finite(o.cancelAckAt) || o.cancelAckAt < 0))
        || (o.cancelAckLatencyMs !== undefined && (!finite(o.cancelAckLatencyMs) || o.cancelAckLatencyMs < 0))
        || (o.venueStatusAt !== undefined && (!finite(o.venueStatusAt) || o.venueStatusAt < 0))
        || (o.venueStatusLatencyMs !== undefined && (!finite(o.venueStatusLatencyMs) || o.venueStatusLatencyMs < 0))
        || (o.venueStatusAfterAckLatencyMs !== undefined && (!finite(o.venueStatusAfterAckLatencyMs) || o.venueStatusAfterAckLatencyMs < 0))
        || (o.httpAckAt !== undefined && (!finite(o.httpAckAt) || o.httpAckAt < 0))
        || (o.venueStatusSource !== undefined && !["http_ack", "user_ws", "account_read"].includes(o.venueStatusSource))
        || (o.cancellationSource !== undefined && !["local_http", "user_ws", "account_read"].includes(o.cancellationSource))
        || [o.signLatencyMs, o.ackLatencyMs, o.totalLatencyMs, o.triggerToPostLatencyMs, o.reactionLatencyMs,
          o.riskMetadataLatencyMs, o.l2HeaderLatencyMs, o.responseHeadersLatencyMs, o.responseBodyLatencyMs,
          o.postLatencyMs, o.decisionToPostLatencyMs, o.durableCommitLatencyMs]
          .some(value => value !== undefined && (!finite(value) || value < 0))
        || (o.failurePhase !== undefined && !["risk_metadata", "signing", "post"].includes(o.failurePhase))
        || (o.cancelAckAt !== undefined && o.cancelRequestedAt === undefined)
        || (o.cancelAckLatencyMs !== undefined && o.cancelAckAt === undefined)
        || (reservationPending(o) && o.direction === "BUY" && o.reservedUsd + EPS < (o.shares - o.filledShares) * o.price)
        || (reservationPending(o) && o.direction === "SELL" && Math.abs(o.reservedShares - (o.shares - o.filledShares)) > EPS)
        || (!reservationPending(o) && (o.reservedUsd > EPS || o.reservedShares > EPS))) {
        throw new Error("invalid account order");
      }
      clientIds.add(o.clientOrderId); if (o.orderId) orderIds.add(o.orderId);
    }
  }

  private validateCashFlowTracking(tracking: CashFlowTracking): void {
    if (!finite(tracking.baselineAt) || tracking.baselineAt < 0 || typeof tracking.complete !== "boolean"
      || !Array.isArray(tracking.appliedFlows) || new Set(tracking.appliedFlows.map(flow => flow.id)).size !== tracking.appliedFlows.length
      || (tracking.cursorBlock != null && (!Number.isSafeInteger(tracking.cursorBlock) || tracking.cursorBlock < 0))
      || (tracking.baselineBlock != null && (!Number.isSafeInteger(tracking.baselineBlock) || tracking.baselineBlock < 0))
      || (tracking.coveredThroughAt != null && (!finite(tracking.coveredThroughAt) || tracking.coveredThroughAt < 0))) {
      throw new Error("invalid persisted cash flow tracking");
    }
    for (const flow of tracking.appliedFlows) {
      if (!flow.id || !["deposit", "withdrawal"].includes(flow.kind) || !finite(flow.amountUsd) || flow.amountUsd <= 0
        || !Number.isSafeInteger(flow.block) || flow.block < 0 || !finite(flow.at) || flow.at < 0
        || !/^0x[0-9a-f]{64}$/i.test(flow.transactionHash)) throw new Error("invalid persisted external cash flow");
    }
  }

  private applyCashFlowEvidence(next: CoreState, account: AccountSnapshot): void {
    const tracking = next.cashFlowTracking!;
    const coverage = account.cashFlowCoverage;
    if (!coverage) {
      tracking.complete = false;
      tracking.reason = "external_cash_flow_coverage_unavailable";
      return;
    }
    if (coverage.reason === "confirmation_window_empty" && tracking.cursorBlock !== undefined
      && coverage.toBlock <= tracking.cursorBlock && !(account.externalFlows?.length)) return;
    for (const flow of account.externalFlows ?? []) {
      const previous = tracking.appliedFlows.find(item => item.id === flow.id);
      if (previous) {
        if (["kind", "amountUsd", "block", "at", "transactionHash"].some(key =>
          previous[key as keyof typeof previous] !== flow[key as keyof typeof flow])) throw new Error("external cash flow identity changed");
        continue;
      }
      if (flow.at <= tracking.baselineAt) continue;
      tracking.appliedFlows.push(copy(flow));
      // A day-boundary baseline already includes account reads at/before this
      // observation. Late confirmations must not shift the new day twice.
      if (flow.at > (next.risk.baselineAccountAt ?? next.risk.baselineAt)) {
        next.risk.baselineEquityUsd += flow.kind === "deposit" ? flow.amountUsd : -flow.amountUsd;
      }
    }
    const contiguous = tracking.cursorBlock === undefined
      ? coverage.fromAt <= tracking.baselineAt + EPS
      : coverage.fromBlock <= tracking.cursorBlock + 1;
    if (tracking.baselineBlock === undefined && coverage.fromAt > 0 && coverage.fromAt <= tracking.baselineAt + EPS) {
      // Retain a located start block even if later transfer classification is
      // incomplete; repeated reads need not binary-search the chain again.
      tracking.baselineBlock = coverage.fromBlock;
    }
    if (coverage.complete && contiguous) {
      tracking.baselineBlock ??= coverage.fromBlock;
      if (tracking.cursorBlock === undefined || coverage.toBlock >= tracking.cursorBlock) {
        tracking.cursorBlock = coverage.toBlock; tracking.coveredThroughAt = coverage.toAt;
      }
      tracking.complete = true; tracking.reason = coverage.reason;
    } else {
      tracking.complete = false;
      tracking.reason = !contiguous ? "external_cash_flow_scan_gap" : coverage.reason ?? "external_cash_flow_classification_incomplete";
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
    return this.markBatch([book]);
  }

  /** Validate and apply one venue frame as a single state transition. */
  markBatch(books: readonly Book[]): boolean {
    if (!books.length || new Set(books.map(book => book.tokenId)).size !== books.length) return false;
    const staged = new Map(this.books);
    for (const book of books) {
      if (!this.validBook(book, staged.get(book.tokenId))) return false;
      staged.set(book.tokenId, copy(book));
    }
    // Stage a single cloned map and publish it only after every book passes
    // validation. This keeps the bilateral update atomic while avoiding a
    // second clone/write pass on every websocket frame.
    this.books = staged;
    this.updateRisk();
    return true;
  }

  private validBook(book: Book, previous?: Book): boolean {
    if (!this.instruments.has(book.tokenId) || !finite(book.ts) || book.ts < (previous?.ts ?? -Infinity)) return false;
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
  /** Public account view includes the in-memory recovery gate without persisting it. */
  view(): CoreState { this.updateRisk(); return copy({ ...this.state, risk: this.recoveryRisk() }); }
  setRecovering(recovering: boolean, marketIds?: readonly string[]): void {
    this.recovering = recovering;
    this.recoveringMarkets = recovering
      ? new Set(marketIds ?? ["*"])
      : new Set<string>();
  }
  requireReconciliation(reason: string): void {
    this.state.risk.halted = true; this.state.risk.reason = `${reason}: reconciliation required`;
    this.persist(true);
  }
  isOrderQuarantined(id: string): boolean { return this.state.quarantinedOrderIds?.includes(id) === true; }
  private refreshReconciliationRisk(): void {
    const blockedMarketIds = this.reconciliationMarketIds();
    const unmapped = this.hasUnmappedReconciliation();
    this.state.risk.blockedMarketIds = blockedMarketIds;
    this.state.risk.reconciliationRequired = this.state.orders.some(candidate =>
      ["SUBMITTING", "UNKNOWN"].includes(candidate.status) || candidate.reconciliationPending === true);
    // An unresolved order reserves only its own market's capital.  Do not
    // turn a delayed venue response for one five-minute round into a global
    // strategy halt that suppresses the next round.
    if (unmapped && (!this.state.risk.reason || this.isScopedReconciliationReason(this.state.risk.reason))) {
      this.state.risk.halted = true;
      this.state.risk.reason = "unknown order requires reconciliation";
    } else if (this.state.orders.some(candidate => candidate.status === "SUBMITTING")
      && (!this.state.risk.reason || this.isScopedReconciliationReason(this.state.risk.reason))) {
      this.state.risk.halted = true;
      this.state.risk.reason = "restored orders require reconciliation";
    } else if (blockedMarketIds.length > 0 && this.isScopedReconciliationReason(this.state.risk.reason)) {
      this.state.risk.halted = false;
      delete this.state.risk.reason;
    } else if (blockedMarketIds.length === 0 && !unmapped && this.state.risk.reason?.includes("reconciliation")
      && !(this.state.risk.reason === "restored orders require reconciliation" && this.state.orders.some(active))) {
      this.state.risk.halted = false;
      delete this.state.risk.reason;
    }
  }
  private reconciliationMarketIds(): string[] {
    return [...new Set(this.reconciliationCandidates()
      .filter(candidate => !this.localCancellationPending(candidate))
      .map(candidate => this.instruments.get(candidate.tokenId)?.marketId)
      .filter((id): id is string => !!id))];
  }
  private reconciliationCandidates(): OrderRecord[] {
    return this.state.orders.filter(candidate => (candidate.status === "UNKNOWN" || candidate.reconciliationPending === true)
      && !this.isOrderQuarantined(candidate.orderId ?? "")
      && !["canceled", "cancelled", "expired"].includes(candidate.venueStatus ?? ""));
  }
  private hasUnmappedReconciliation(): boolean {
    return this.reconciliationCandidates()
      .filter(candidate => !this.localCancellationPending(candidate))
      .some(candidate => !this.instruments.get(candidate.tokenId)?.marketId);
  }
  /**
   * A successful local cancel ACK proves the order is no longer open. Keep its
   * reservation until the user stream/account read settles any raced fill, but
   * do not stop the whole market while that evidence arrives.
   */
  private localCancellationPending(order: OrderRecord): boolean {
    return order.status === "CANCELLED" && order.reconciliationPending === true
      && order.cancellationSource === "local_http" && order.cancelAckAt !== undefined;
  }
  private isScopedReconciliationReason(reason: string | undefined): boolean {
    return reason === "unknown order requires reconciliation"
      || reason === "signed identity requires reconciliation"
      || reason === "failed trade requires reconciliation"
      || reason === "restored orders require reconciliation"
      || reason?.includes("reconciliation required") === true;
  }
  private recoveryRisk(): RiskView {
    if (!this.recovering) return this.state.risk;
    const blockedMarketIds = [...new Set([...(this.state.risk.blockedMarketIds ?? []),
      ...[...this.recoveringMarkets].filter(id => id !== "*")])];
    return this.recoveringMarkets.has("*")
      ? { ...this.state.risk, halted: true, reason: "账户恢复中", blockedMarketIds }
      : { ...this.state.risk,
          ...(this.isScopedReconciliationReason(this.state.risk.reason) ? { halted: false } : {}),
          blockedMarketIds };
  }
  private marketReconciliationBlocked(tokenId: string): boolean {
    if (this.hasUnmappedReconciliation()) return true;
    const marketId = this.instruments.get(tokenId)?.marketId;
    return marketId != null && (this.reconciliationMarketIds().includes(marketId)
      || this.recoveringMarkets.has("*") || this.recoveringMarkets.has(marketId));
  }
  /**
   * Keep an UNKNOWN order and its reservation, but stop a temporarily
   * unavailable detail endpoint from permanently blocking new verification.
   * The caller must have a complete authenticated open-order snapshot and no
   * terminal venue evidence before invoking this method.
   */
  quarantineUnknown(id: string, reason = "order detail unavailable; venue outcome pending"): boolean {
    const order = this.find(id);
    if (!order?.orderId || order.status !== "UNKNOWN"
      || ["canceled", "cancelled", "expired"].includes(order.venueStatus ?? "")) return false;
    this.state.quarantinedOrderIds ??= [];
    if (!this.state.quarantinedOrderIds.includes(order.orderId)) this.state.quarantinedOrderIds.push(order.orderId);
    order.reconciliationPending = true;
    order.error = reason;
    this.refreshReconciliationRisk();
    const result = this.notify(order, true);
    return result.orderId === order.orderId;
  }
  /**
   * Drop a quarantined UNKNOWN from the local active ledger after a complete
   * account and trade read proves that it has no venue-visible consequence.
   * This is deliberately a local abandonment, never a venue cancellation.
   */
  abandonUnknown(id: string, reason = "account snapshot confirmed no open order, position, or fill", persist = true): boolean {
    const order = this.find(id);
    if (!order?.orderId || order.status !== "UNKNOWN" || !this.isOrderQuarantined(order.orderId)
      || order.filledShares > EPS || this.state.fills.some(fill => fill.orderId === order.orderId && fill.shares > EPS)) return false;
    const { orderId, clientOrderId, strategyId } = order;
    this.state.orders = this.state.orders.filter(candidate => candidate.orderId !== orderId);
    this.state.quarantinedOrderIds = (this.state.quarantinedOrderIds ?? []).filter(candidate => candidate !== orderId);
    this.refreshReconciliationRisk();
    this.updateRisk();
    if (persist) this.persist(true);
    this.emit({ kind: "error", strategyId, clientOrderId, orderId, code: "order_abandoned", message: reason });
    return true;
  }
  /** Flush a state mutation that was intentionally held until synchronous observers updated their state. */
  commit(): void { this.persist(true); }
  /** Background funding scans do not replace the live cash/position ledger.
   * A newly classified deposit/withdrawal requests an ordinary reconciliation. */
  observeCashFlowCoverage(account: AccountSnapshot): boolean {
    this.validateAccount(account);
    if (account.accountId !== this.state.accountId) throw new Error("cash flow account identity mismatch");
    if (account.at < (this.state.accountAt ?? -Infinity) || (account.cashAt ?? account.at) < (this.state.cashAt ?? -Infinity)) return true;
    const tracking = this.state.cashFlowTracking!;
    if (account.cashFlowCoverage && tracking.cursorBlock !== undefined && account.cashFlowCoverage.toBlock < tracking.cursorBlock) return true;
    if ((account.externalFlows ?? []).some(flow => flow.at > tracking.baselineAt
      && !tracking.appliedFlows.some(previous => previous.id === flow.id))) return false;
    const next = copy(this.state);
    this.applyCashFlowEvidence(next, account);
    // This path never applies a new flow. Commit only its independently
    // staged cursor so an in-flight submit/cancel keeps its live order object.
    this.state.cashFlowTracking = next.cashFlowTracking;
    this.updateRisk(); this.persist(true);
    return true;
  }
  setStrategyState(strategyId: string, state: unknown): void {
    this.state.strategyStates ??= {};
    this.state.strategyStates[strategyId] = copy(state);
    // A live signed-order commit immediately following this update makes the
    // stage and order identity durable together. Non-order changes batch normally.
    this.persist();
  }
  rememberMarket(market: MarketInfo): void {
    if (!market.id || !/^\d+$/.test(market.roundId) || market.roundId !== String(market.startsAt)
      || !Number.isFinite(market.startsAt) || market.endsAt - market.startsAt !== 300) {
      throw new Error("market round identity is required");
    }
    const tokens = new Set(market.instruments.map(instrument => instrument.tokenId));
    for (const order of this.state.orders) {
      if (tokens.has(order.tokenId)
        && ((order.marketId !== undefined && order.marketId !== market.id)
          || (order.roundId !== undefined && order.roundId !== market.roundId))) {
        throw new Error("order market identity changed");
      }
    }
    for (const fill of this.state.fills) {
      if (tokens.has(fill.tokenId)
        && ((fill.marketId !== undefined && fill.marketId !== market.id)
          || (fill.roundId !== undefined && fill.roundId !== market.roundId))) {
        throw new Error("fill market identity changed");
      }
    }
    this.state.markets ??= [];
    const index = this.state.markets.findIndex(item => item.id === market.id);
    if (index >= 0) {
      // States written before round identity was added have the market, start,
      // end and token set but no roundId. The next discovery supplies the
      // authoritative identity. Backfill only after those durable anchors
      // match; never infer a round from a slug or from the current clock.
      const persisted = this.state.markets[index] as unknown as {
        roundId?: unknown;
        startsAt?: unknown;
        endsAt?: unknown;
        instruments?: unknown;
      };
      if (persisted.roundId !== undefined
        && (typeof persisted.roundId !== "string" || persisted.roundId !== market.roundId)) {
        throw new Error("market round identity changed");
      }
      if (persisted.startsAt !== market.startsAt || persisted.endsAt !== market.endsAt
        || !Array.isArray(persisted.instruments)) {
        throw new Error("market identity changed");
      }
      const persistedTokens = persisted.instruments.map(item =>
        item && typeof item === "object" && "tokenId" in item && typeof item.tokenId === "string"
          ? item.tokenId : undefined);
      if (persistedTokens.some(token => token === undefined)
        || new Set(persistedTokens).size !== tokens.size
        || persistedTokens.some(token => !tokens.has(token!))) {
        throw new Error("market token identity changed");
      }
    }
    if (index >= 0) this.state.markets[index] = copy(market);
    else this.state.markets.push(copy(market));
    for (const order of this.state.orders) {
      if (tokens.has(order.tokenId)) {
        order.marketId ??= market.id;
        order.roundId ??= market.roundId;
      }
    }
    for (const fill of this.state.fills) {
      if (tokens.has(fill.tokenId)) {
        fill.marketId ??= market.id;
        fill.roundId ??= market.roundId;
      }
    }
    this.persist();
  }

  private roundIdForMarket(marketId: string): string | undefined {
    return this.state.markets?.find(market => market.id === marketId)?.roundId;
  }
  contextSnapshot(): Omit<CoreState, "fills"> {
    this.updateRisk();
    return copy({ schemaVersion: this.state.schemaVersion, accountId: this.state.accountId,
      mode: this.state.mode, cashUsd: this.state.cashUsd, positions: this.state.positions,
      orders: this.state.orders.filter(reservationPending),
      quarantinedOrderIds: this.state.quarantinedOrderIds,
      risk: this.recoveryRisk() });
  }
  orders(): OrderRecord[] { return copy(this.state.orders); }
  positions(): Position[] { return copy(this.state.positions); }
  risk(): RiskView { this.updateRisk(); return copy(this.recoveryRisk()); }
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
    this.state.quarantinedOrderIds = (this.state.quarantinedOrderIds ?? []).filter(item => item !== order.orderId);
    order.reconciliationPending = false;
    if (ack.venueStatus && !order.venueStatus) {
      order.venueStatus = ack.venueStatus;
      order.venueStatusSource = "http_ack";
      order.venueStatusAt = this.clock();
      order.venueStatusLatencyMs = Math.max(0, (order.venueStatusAt - order.createdAt) * 1000);
      order.venueStatusAfterAckLatencyMs = 0;
    }
    if (["SUBMITTING", "UNKNOWN"].includes(order.status)) order.status = order.filledShares > 0 ? "PARTIAL" : "OPEN";
    this.refreshReconciliationRisk();
    this.notify(order, true);
  }
  observeVenueStatus(id: string, status: NonNullable<OrderRecord["venueStatus"]>, metadata: {
    source?: VenueStateSource;
    observedAt?: number;
  } = {}): boolean {
    const order = this.find(id);
    const observedAt = metadata.observedAt ?? this.clock();
    if (!finite(observedAt) || observedAt < 0) return false;
    if (!order || (order.venueStatus === status && !this.isOrderQuarantined(order.orderId ?? "") && order.reconciliationPending !== true
      && !(["live", "delayed", "unmatched"].includes(status) && order.status === "UNKNOWN"))) return false;
    order.venueStatus = status;
    if (metadata.source) order.venueStatusSource = metadata.source;
    order.venueStatusAt = observedAt;
    order.venueStatusLatencyMs = Math.max(0, (observedAt - order.createdAt) * 1000);
    if (order.httpAckAt !== undefined) {
      order.venueStatusAfterAckLatencyMs = Math.max(0, (observedAt - order.httpAckAt) * 1000);
    }
    this.state.quarantinedOrderIds = (this.state.quarantinedOrderIds ?? []).filter(item => item !== order.orderId);
    if (status !== "canceled" && status !== "cancelled" && status !== "expired") order.reconciliationPending = false;
    if (["live", "delayed", "unmatched"].includes(status) && order.status === "UNKNOWN") {
      order.status = order.filledShares > 0 ? "PARTIAL" : "OPEN";
    }
    this.refreshReconciliationRisk();
    order.updatedAt = Math.max(order.updatedAt, this.clock());
    this.notify(order, false);
    return true;
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
      risk.baselineAccountAt = this.state.cashAt ?? this.state.accountAt ?? risk.baselineAt;
      if (risk.reason === "daily loss limit") { risk.halted = false; delete risk.reason; }
    }
    risk.equityUsd = equity;
    risk.dailyPnlUsd = equity - risk.baselineEquityUsd;
    const flowTracking = this.state.cashFlowTracking;
    risk.cashFlowComplete = flowTracking?.complete === true;
    risk.cashFlowReason = flowTracking?.reason;
    risk.cashFlowCoverageFrom = flowTracking?.baselineAt;
    risk.cashFlowCoverageUntil = flowTracking?.coveredThroughAt;
    risk.netExternalFlowUsd = (flowTracking?.appliedFlows ?? []).filter(flow => flow.at > (risk.baselineAccountAt ?? risk.baselineAt))
      .reduce((total, flow) => total + (flow.kind === "deposit" ? flow.amountUsd : -flow.amountUsd), 0);
    risk.pnlVerified = risk.cashFlowComplete
      && (flowTracking?.coveredThroughAt ?? -Infinity) + EPS >= (this.state.cashAt ?? this.state.accountAt ?? this.clock());
    risk.dailyLossStatus = this.options.limits.dailyLossUsd == null ? "disabled" : risk.pnlVerified ? "active" : "estimated";
    risk.occupiedUsd = held + reserved;
    risk.availableUsd = Math.max(0, Math.min(this.state.cashUsd - reserved,
      this.options.limits.capitalUsd - risk.occupiedUsd));
    risk.unresolvedOrderCount = this.state.orders.filter(order => order.status === "UNKNOWN" || order.reconciliationPending === true).length;
    risk.blockedMarketIds = this.reconciliationMarketIds();
    risk.reconciliationRequired = risk.unresolvedOrderCount > 0;
    if (this.hasUnmappedReconciliation() && (!risk.reason || this.isScopedReconciliationReason(risk.reason))) {
      risk.halted = true;
      risk.reason = "unknown order requires reconciliation";
    } else if (risk.blockedMarketIds.length > 0 && this.isScopedReconciliationReason(risk.reason)) {
      risk.halted = false;
      delete risk.reason;
    }
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
  private emitOrder(order: OrderRecord): void {
    this.emit({ kind: "order", order: copy(order), marketId: order.marketId, roundId: order.roundId });
  }
  private emitFill(fill: TradeFill): void {
    this.emit({ kind: "fill", fill: copy(fill), marketId: fill.marketId, roundId: fill.roundId });
  }
  private notify(order: OrderRecord, critical = false): OrderRecord {
    order.updatedAt = Math.max(order.updatedAt, this.clock());
    this.persist(critical); this.emitOrder(order);
    return copy(order);
  }
  private track<T>(job: Promise<T>): Promise<T> {
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
    return job;
  }
  private async acquirePreparation(): Promise<() => void> {
    const previous = this.preparationTail;
    let release!: () => void;
    this.preparationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  }
  submit(request: OrderRequest, timing?: ExecutionTiming): Promise<OrderRecord> {
    const pending = this.submissions.get(request.clientOrderId);
    if (pending) {
      const original = this.submissionRequests.get(request.clientOrderId)
        ?? this.state.orders.find(order => order.clientOrderId === request.clientOrderId);
      if (original && ["strategyId", "marketId", "roundId", "tokenId", "direction", "price", "shares", "timeInForce", "postOnly", "roundBudgetUsd"]
        .some(field => original[field as keyof OrderRequest] !== request[field as keyof OrderRequest])) {
        return Promise.reject(new Error("clientOrderId reused for a different order"));
      }
      return pending;
    }
    const job = this.submitOrder(copy(request), timing && copy(timing));
    this.submissions.set(request.clientOrderId, job);
    this.submissionRequests.set(request.clientOrderId, copy(request));
    const release = () => {
      if (this.submissions.get(request.clientOrderId) === job) {
        this.submissions.delete(request.clientOrderId);
        this.submissionRequests.delete(request.clientOrderId);
      }
    };
    void job.then(release, release);
    return this.track(job);
  }
  private async submitOrder(request: OrderRequest, timing?: ExecutionTiming): Promise<OrderRecord> {
    const previous = this.state.orders.find(o => o.clientOrderId === request.clientOrderId);
    if (previous) {
      for (const field of ["strategyId", "marketId", "roundId", "tokenId", "direction", "price", "shares", "timeInForce", "postOnly", "roundBudgetUsd"] as const) {
        if (previous[field] !== request[field]) throw new Error("clientOrderId reused for a different order");
      }
      return copy(previous);
    }
    if (this.state.orders.some(o => o.orderId === request.clientOrderId)) {
      throw new Error("clientOrderId conflicts with a venue order ID");
    }
    this.updateRisk();
    if (this.recovering && this.recoveringMarkets.has("*")) throw new Error("account recovery in progress");
    if (this.marketReconciliationBlocked(request.tokenId)) throw new Error("market reconciliation in progress");
    const reducingAfterLoss = this.state.risk.reason === "daily loss limit" && request.direction === "SELL";
    const scopedRecovery = this.recovering && !this.recoveringMarkets.has("*")
      && this.isScopedReconciliationReason(this.state.risk.reason);
    if (this.stopped || (this.state.risk.halted && !scopedRecovery && !reducingAfterLoss)) throw new Error(this.state.risk.reason ?? "platform stopped");
    const instrument = this.instruments.get(request.tokenId);
    if (!instrument || !request.clientOrderId || !request.strategyId || request.strategyId === "external"
      || !["BUY", "SELL"].includes(request.direction) || !["GTC", "FOK", "FAK"].includes(request.timeInForce)
      || typeof request.postOnly !== "boolean" || (request.postOnly && request.timeInForce !== "GTC")
      || ![request.price, request.shares].every(finite) || request.price <= 0 || request.price >= 1
      || request.shares < instrument.minOrderSize - EPS
      || Math.abs(request.price / instrument.tickSize - Math.round(request.price / instrument.tickSize)) > 1e-6) {
      throw new Error("invalid order or instrument rules");
    }
    if (request.marketId !== undefined && request.marketId !== instrument.marketId) {
      throw new Error("order market identity mismatch");
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
    const releasePreparation = this.options.adapters.gateway.durableIdentity === true
      ? await this.acquirePreparation() : undefined;
    try {
      // Another order can reserve cash while this request waits for the short
      // signed-identity commit lock. Recheck every mutable execution gate here.
      this.updateRisk();
      if (this.recovering && this.recoveringMarkets.has("*")) throw new Error("account recovery in progress");
      if (this.marketReconciliationBlocked(request.tokenId)) throw new Error("market reconciliation in progress");
      const reducingAfterWait = this.state.risk.reason === "daily loss limit" && request.direction === "SELL";
      const scopedRecovery = this.recovering && !this.recoveringMarkets.has("*")
        && this.isScopedReconciliationReason(this.state.risk.reason);
      if (this.stopped || (this.state.risk.halted && !scopedRecovery && !reducingAfterWait)) {
        throw new Error(this.state.risk.reason ?? "platform stopped");
      }
      if (request.roundBudgetUsd != null) {
        const tokens = new Set([...this.instruments.values()].filter(item => item.marketId === instrument.marketId).map(item => item.tokenId));
        const occupied = this.state.positions.filter(position => tokens.has(position.tokenId)).reduce((sum, position) => sum + position.costUsd, 0)
          + this.state.orders.filter(order => tokens.has(order.tokenId) && reservationPending(order)).reduce((sum, order) => sum + order.reservedUsd, 0);
        if (request.direction === "BUY" && occupied + amount + fee > request.roundBudgetUsd + EPS) {
          throw new Error("round budget including fees and pending orders exceeded");
        }
      }
      if (this.state.orders.filter(active).length >= this.options.limits.maxOpenOrders) throw new Error("open-order limit");
      if (request.direction === "BUY" && amount + fee > this.state.risk.availableUsd + EPS) throw new Error("insufficient cash or capital");
      if (request.direction === "SELL") {
        const reservedShares = this.state.orders.filter(o => reservationPending(o) && o.tokenId === request.tokenId)
          .reduce((sum, o) => sum + o.reservedShares, 0);
        if (request.shares > this.position(request.tokenId).shares - reservedShares + EPS) throw new Error("insufficient sellable shares");
        const reservedUsd = this.state.orders.filter(reservationPending).reduce((sum, o) => sum + o.reservedUsd, 0);
        if (fee > this.state.cashUsd - reservedUsd + EPS) throw new Error("insufficient fee balance");
      }
    } catch (error) {
      releasePreparation?.();
      throw error;
    }
    const roundId = this.roundIdForMarket(instrument.marketId);
    if (!roundId) throw new Error("market round identity unavailable");
    if (request.roundId !== undefined && request.roundId !== roundId) {
      throw new Error("order round identity mismatch");
    }
    const order: OrderRecord = { ...request, marketId: instrument.marketId, roundId,
      status: "SUBMITTING", filledShares: 0,
      identityProtocol: this.options.adapters.gateway.durableIdentity ? "signed-before-post" : undefined,
      reservedUsd: request.direction === "BUY" ? amount + fee : fee,
      reservedShares: request.direction === "SELL" ? request.shares : 0,
      createdAt: this.clock(), updatedAt: this.clock() };
    this.state.orders.push(order);
    // A live durable-identity gateway cannot POST until its signed identity is
    // committed. Keep this reservation in the pending snapshot and fsync once
    // from the prepared callback, together with the strategy stage and hash.
    try {
      if (this.options.adapters.gateway.durableIdentity === true) this.options.adapters.deferPersistence?.();
      else this.persist(true);
    }
    catch (error) {
      releasePreparation?.();
      order.status = "REJECTED"; order.error = "reservation persistence failed before submission";
      order.reservedUsd = 0; order.reservedShares = 0;
      this.emitOrder(order);
      throw error;
    }
    this.emitOrder(order);
    let ackOutcome: GatewayAck["status"] | undefined;
    try {
      const scopedRequest: OrderRequest = { ...request, marketId: order.marketId, roundId: order.roundId };
      const ack = await this.options.adapters.gateway.submit(scopedRequest, copy(instrument), prepared => {
        if (!prepared.orderHash || !prepared.signedPayload) throw new Error("signed order identity missing");
        if (this.state.orders.some(existing => existing !== order
          && (existing.orderId === prepared.orderHash || existing.clientOrderId === prepared.orderHash))) {
          throw new Error("duplicate signed order identity");
        }
        order.prepared = copy(prepared); order.orderId = prepared.orderHash;
        order.updatedAt = Math.max(order.updatedAt, this.clock());
        const started = performance.now();
        try {
          if (this.options.adapters.persistPreparedOrder) this.options.adapters.persistPreparedOrder(copy(order));
          else this.persist(true);
        } catch (error) {
          this.state.risk.halted = true; this.state.risk.reason = "state persistence failed";
          throw error;
        }
        releasePreparation?.();
        order.durableCommitLatencyMs = Math.max(0, performance.now() - started);
        this.emitOrder(order);
        queueMicrotask(() => this.emitLatency("durable_commit", order.durableCommitLatencyMs, order));
      }, timing);
      ackOutcome = ack.status;
      // User WebSocket can report a newer venue state before the HTTP ACK
      // arrives. An ACK only fills an unknown state; it must not move it back.
      if (ack.venueStatus && !order.venueStatus) {
        order.venueStatus = ack.venueStatus;
        order.venueStatusSource = "http_ack";
        order.venueStatusAt = this.clock();
        order.venueStatusLatencyMs = Math.max(0, (order.venueStatusAt - order.createdAt) * 1000);
        order.venueStatusAfterAckLatencyMs = 0;
      }
      order.tradeIds = ack.tradeIds; order.signLatencyMs = ack.signLatencyMs;
      order.riskMetadataLatencyMs = ack.riskMetadataLatencyMs; order.l2HeaderLatencyMs = ack.l2HeaderLatencyMs;
      order.responseHeadersLatencyMs = ack.responseHeadersLatencyMs;
      order.responseBodyLatencyMs = ack.responseBodyLatencyMs;
      order.postLatencyMs = ack.postLatencyMs; order.failurePhase = ack.failurePhase;
      order.ackLatencyMs = ack.ackLatencyMs;
      if (ack.status === "accepted" || ack.status === "unknown") order.httpAckAt = this.clock();
      if (order.venueStatusAt !== undefined && order.httpAckAt !== undefined) {
        order.venueStatusAfterAckLatencyMs = Math.max(0, (order.venueStatusAt - order.httpAckAt) * 1000);
      }
      order.totalLatencyMs = ack.totalLatencyMs; order.triggerToPostLatencyMs = ack.triggerToPostLatencyMs;
      order.decisionToPostLatencyMs = ack.decisionToPostLatencyMs; order.reactionLatencyMs = ack.reactionLatencyMs;
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
      if (ack.status === "accepted" && ack.orderId && ["SUBMITTING", "UNKNOWN"].includes(order.status)) {
        order.status = "OPEN";
      }
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
      releasePreparation?.();
      if (!(order.orderId && ["FILLED", "PARTIAL"].includes(order.status))) {
        order.status = "UNKNOWN"; this.state.risk.halted = true; this.state.risk.reason = "unknown order requires reconciliation";
      }
      order.error = error instanceof Error ? error.message : "submission failed";
    }
    for (const [metric, duration] of [
      ["order_risk_metadata", order.riskMetadataLatencyMs],
      ["order_sign", order.signLatencyMs], ["order_submit_roundtrip", order.totalLatencyMs],
      ["order_l2_headers", order.l2HeaderLatencyMs], ["order_http_post", order.postLatencyMs],
      ["trigger_to_http_post", order.triggerToPostLatencyMs],
      ["decision_to_http_post", order.decisionToPostLatencyMs],
    ] as const) this.emitLatency(metric, duration, order, ackOutcome);
    if (ackOutcome === "accepted") {
      this.emitLatency("order_http_ack", order.ackLatencyMs, order, ackOutcome);
      this.emitLatency("reaction", order.reactionLatencyMs, order, ackOutcome);
    }
    releasePreparation?.();
    return this.notify(order, order.status === "REJECTED" || !order.prepared);
  }

  cancel(id: string): Promise<OrderRecord> {
    const order = this.find(id);
    const key = order?.clientOrderId ?? id;
    const pending = this.cancellations.get(key);
    if (pending) return pending;
    const job = this.cancelOrder(id);
    this.cancellations.set(key, job);
    const clear = () => { if (this.cancellations.get(key) === job) this.cancellations.delete(key); };
    void job.then(clear, clear);
    return this.track(job);
  }
  private async cancelOrder(id: string): Promise<OrderRecord> {
    const order = this.find(id);
    if (!order) throw new Error("order not found");
    if (!active(order)) return copy(order);
    if (order.status === "SUBMITTING") {
      const pending = this.submissions.get(order.clientOrderId);
      if (pending) {
        await pending;
        if (order.status === "SUBMITTING") throw new Error("order ACK pending");
        return this.cancelOrder(id);
      }
      // After a restart the in-memory submission map is empty. A persisted
      // order identity proves the POST may have reached the venue, so cancel
      // it through the normal UNKNOWN/reconciliation path instead of waiting
      // forever for an ACK that belongs to the previous process.
      if (!order.orderId) throw new Error("unidentified submission requires reconciliation");
      order.status = "UNKNOWN";
    }
    if (!order.orderId) throw new Error("unidentified order requires reconciliation");
    const cancelRequestedAt = this.clock();
    const cancelStarted = performance.now();
    try {
      if (!(await this.options.adapters.gateway.cancel(order.orderId))) throw new Error("cancellation not confirmed");
      order.cancelRequestedAt = cancelRequestedAt;
      order.cancelAckAt = this.clock();
      order.cancelAckLatencyMs = Math.max(0, performance.now() - cancelStarted);
      order.cancellationSource = "local_http";
      if (order.status !== "FILLED") {
        // The CLOB DELETE response includes this order in `canceled`, so it
        // is already venue evidence for cancellation. Keep the reservation
        // pending for a possible fill race, but do not wait for a later User
        // WS event before exposing the cancellation state or latency.
        order.venueStatus = "canceled";
        order.venueStatusSource = "http_ack";
        order.venueStatusAt = order.cancelAckAt;
        order.venueStatusLatencyMs = Math.max(0, (order.venueStatusAt - order.createdAt) * 1000);
        if (order.httpAckAt !== undefined) {
          order.venueStatusAfterAckLatencyMs = Math.max(0, (order.venueStatusAt - order.httpAckAt) * 1000);
        }
        order.status = "CANCELLED";
        this.state.quarantinedOrderIds = (this.state.quarantinedOrderIds ?? []).filter(item => item !== order.orderId);
        // Keep the reservation until the user stream or an account read proves
        // that no fill raced the cancel request.
        order.reconciliationPending ??= true;
      }
    } catch (error) {
      if (!active(order)) return copy(order);
      order.cancelRequestedAt = cancelRequestedAt;
      delete order.cancelAckAt;
      delete order.cancelAckLatencyMs;
      order.status = "UNKNOWN"; order.error = error instanceof Error ? error.message : "cancellation failed";
      this.state.risk.halted = true; this.state.risk.reason = "unknown order requires reconciliation";
    }
    const result = this.notify(order, true);
    this.emitLatency("cancel_http_ack", order.cancelAckLatencyMs, order);
    return result;
  }

  private emitLatency(metric: string, durationMs: number | undefined, order: OrderRecord, outcome?: string): void {
    if (durationMs == null || !finite(durationMs) || durationMs < 0) return;
    this.emit({ kind: "latency", metric, durationMs, ts: this.clock(),
      marketId: this.instruments.get(order.tokenId)?.marketId, tokenId: order.tokenId,
      strategyId: order.strategyId, clientOrderId: order.clientOrderId, orderId: order.orderId, outcome });
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
  confirmCancelled(id: string, releaseReservation = false, source: CancellationSource = "account_read", observedAt?: number): void {
    const order = this.find(id);
    if (!order) throw new Error("unowned cancellation");
    if (order.status === "FILLED") return;
    order.status = "CANCELLED";
    // A delayed User WS/account event confirms the venue state, but must not
    // overwrite a local HTTP cancellation that already received its ACK.
    order.cancellationSource = order.cancelAckAt !== undefined ? "local_http" : source;
    if (observedAt !== undefined && finite(observedAt)) {
      order.venueStatusAt = observedAt;
      order.venueStatusLatencyMs = Math.max(0, (observedAt - order.createdAt) * 1000);
      if (order.httpAckAt !== undefined) {
        order.venueStatusAfterAckLatencyMs = Math.max(0, (observedAt - order.httpAckAt) * 1000);
      }
      order.venueStatusSource = source === "user_ws" ? "user_ws" : "account_read";
    }
    this.state.quarantinedOrderIds = (this.state.quarantinedOrderIds ?? []).filter(item => item !== order.orderId);
    if (releaseReservation) {
      order.reconciliationPending = false;
      order.reservedUsd = 0; order.reservedShares = 0;
    } else {
      order.reconciliationPending = true;
    }
    this.notify(order, true);
  }
  applyFill(fill: TradeFill): boolean {
    if (!fill.tradeId || !fill.orderId) throw new Error("invalid trade identity");
    const existingOrderId = this.fillOrderByTradeId.get(fill.tradeId);
    if (existingOrderId && existingOrderId !== fill.orderId) {
      throw new Error("trade identity collision requires reconciliation");
    }
    const key = this.fillKey(fill);
    const previous = this.fillByKey.get(key);
    if (previous) return this.updateFill(previous, fill);
    const order = this.find(fill.orderId);
    if (fill.status === "FAILED") {
      if (!order || order.tokenId !== fill.tokenId || order.direction !== fill.direction || !fill.tradeId) {
        throw new Error("invalid or unowned failed trade");
      }
      if (fill.marketId !== undefined && fill.marketId !== order.marketId
        || fill.roundId !== undefined && fill.roundId !== order.roundId) {
        throw new Error("trade market identity changed");
      }
      fill = { ...fill, marketId: order.marketId, roundId: order.roundId };
      order.status = "UNKNOWN"; order.reconciliationPending = true;
      this.state.risk.halted = true; this.state.risk.reason = "failed trade requires reconciliation";
      const saved = copy(fill), failedKey = this.fillKey(saved);
      this.fillIndexByKey.set(failedKey, this.state.fills.length);
      this.fillByKey.set(failedKey, saved);
      this.fillOrderByTradeId.set(saved.tradeId, saved.orderId);
      this.state.fills.push(saved);
      this.notify(order, true); this.emitFill(fill); return true;
    }
    if (!order || order.tokenId !== fill.tokenId || order.direction !== fill.direction
      || order.status === "FILLED" || (order.status === "CANCELLED" && !order.reconciliationPending)
      || !fill.tradeId || ![fill.shares, fill.price, fill.feeUsd, fill.ts].every(finite)
      || fill.shares <= 0 || fill.price <= 0 || fill.price >= 1 || fill.feeUsd < 0
      || (fill.direction === "BUY" ? fill.price > order.price + EPS : fill.price < order.price - EPS)
      || order.filledShares + fill.shares > order.shares + EPS) throw new Error("invalid or unowned fill");
    if (fill.marketId !== undefined && fill.marketId !== order.marketId
      || fill.roundId !== undefined && fill.roundId !== order.roundId) {
      throw new Error("trade market identity changed");
    }
    fill = { ...fill, marketId: order.marketId, roundId: order.roundId };
    this.state.quarantinedOrderIds = (this.state.quarantinedOrderIds ?? []).filter(item => item !== order.orderId);
    order.reconciliationPending = order.status === "CANCELLED";
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
    const saved = copy(fill), savedKey = this.fillKey(saved);
    this.fillIndexByKey.set(savedKey, this.state.fills.length);
    this.fillByKey.set(savedKey, saved);
    this.fillOrderByTradeId.set(saved.tradeId, saved.orderId);
    this.state.fills.push(saved);
    this.persist(true);
    // Inventory is authoritative in the event context before the strategy sees the fill.
    this.emitFill(fill);
    this.emitOrder(order);
    return true;
  }

  private updateFill(previous: TradeFill, incoming: TradeFill): boolean {
    if ((incoming.marketId !== undefined && incoming.marketId !== previous.marketId)
      || (incoming.roundId !== undefined && incoming.roundId !== previous.roundId)) {
      throw new Error("trade market identity changed");
    }
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
          const previousIndex = this.fillIndexByKey.get(this.fillKey(previous));
          const subsequentSells = this.state.fills.slice((previousIndex ?? -1) + 1)
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
      this.persist(true); this.emitFill(previous); return true;
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
    this.notify(order, true); this.emitFill(previous);
    return true;
  }

  reconcile(account: AccountSnapshot, netCashFlowUsd = 0, cancelledOrderIds: readonly string[] = []): void {
    this.validateAccount(account);
    if (!finite(netCashFlowUsd)) throw new Error("invalid external cash flow adjustment");
    if (account.accountId !== this.state.accountId || this.jobs.size) throw new Error("reconciliation requires the same account and no requests in flight");
    const lastAccountAt = this.state.accountAt ?? -Infinity;
    if (account.at + EPS < lastAccountAt) throw new Error("account snapshot is older than the last accepted snapshot");
    if ((account.cashAt ?? account.at) + EPS < (this.state.cashAt ?? -Infinity)) throw new Error("cash observation is older than the last accepted snapshot");
    if (this.state.orders.some(o => o.status === "UNKNOWN" && !o.orderId)) {
      throw new Error("unidentified submission must be resolved before replacing account state");
    }
    // Reconciliation may reject late in validation. Stage every mutation so a
    // rejected read cannot release reservations or double-count a later fill.
    const next = copy(this.state);
    const cancelled = new Set(cancelledOrderIds);
    const newlyCancelled = new Set<string>();
    const quarantined = new Set(next.quarantinedOrderIds ?? []);
    const openIds = new Set(account.openOrders.map(o => o.orderId));
    for (const order of next.orders.filter(active)) {
      if (!order.orderId) throw new Error("active order without identity requires reconciliation");
      if (!openIds.has(order.orderId)) {
        if (quarantined.has(order.orderId) && order.status === "UNKNOWN") continue;
        if (!cancelled.has(order.orderId)) throw new Error("missing order needs trade/cancel evidence before reconciliation");
        // Keep the reservation for one subsequent account read in case a
        // fill is still in flight from the disconnect window.
        order.status = "CANCELLED";
        order.cancellationSource = "account_read";
        order.venueStatus = order.venueStatus ?? "canceled";
        order.venueStatusSource = "account_read";
        order.venueStatusAt = account.at;
        order.venueStatusLatencyMs = Math.max(0, (account.at - order.createdAt) * 1000);
        if (order.httpAckAt !== undefined) {
          order.venueStatusAfterAckLatencyMs = Math.max(0, (account.at - order.httpAckAt) * 1000);
        }
        order.reconciliationPending = true;
        quarantined.delete(order.orderId);
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
        if (quarantined.has(order.orderId) && order.status === "UNKNOWN") continue;
        if (newlyCancelled.has(order.orderId)) continue;
        order.reconciliationPending = false;
        order.reservedUsd = 0;
        order.reservedShares = 0;
      }
    }
    next.cashUsd = account.cashUsd; next.positions = copy(account.positions); next.accountAt = account.at; next.cashAt = account.cashAt ?? account.at;
    for (const incoming of account.openOrders) {
      const current = incoming.orderId && next.orders.find(o => o.orderId === incoming.orderId || o.clientOrderId === incoming.orderId);
      if (current) {
        if (current.reconciliationPending) {
          if (incoming.filledShares !== current.filledShares) {
            throw new Error("apply missing fills before reconciliation");
          }
          if (quarantined.has(current.orderId!)) {
            quarantined.delete(current.orderId!);
            current.reconciliationPending = false;
          } else {
            // A venue may still list an order after a cancel ACK. Keep the
            // local cancelled state until a later read removes it.
            continue;
          }
        }
        if (!active(current) && !current.reconciliationPending) {
          throw new Error("terminal order reappeared in account snapshot");
        }
        Object.assign(current, copy(incoming), { clientOrderId: current.clientOrderId,
          strategyId: current.strategyId, reconciliationPending: false });
      }
      else next.orders.push(copy(incoming));
    }
    next.quarantinedOrderIds = [...quarantined];
    this.validateAccount({ ...account, openOrders: next.orders });
    const reconciliationBlocked = next.orders.some(order =>
      (order.status === "UNKNOWN" || order.reconciliationPending === true)
      && !quarantined.has(order.orderId ?? "")
      && !["canceled", "cancelled", "expired"].includes(order.venueStatus ?? ""));
    if (next.risk.reason?.includes("reconciliation") && !reconciliationBlocked) {
      next.risk.halted = false; delete next.risk.reason;
    }
    if (netCashFlowUsd !== 0 && (account.cashFlowCoverage || account.externalFlows)) {
      throw new Error("external cash flow adjustment must use either classified evidence or an explicit amount");
    }
    this.applyCashFlowEvidence(next, account);
    const priorBaseline = this.state.risk.baselineEquityUsd;
    next.risk.baselineEquityUsd += netCashFlowUsd;
    if (next.risk.reason === "daily loss limit" && next.risk.baselineEquityUsd !== priorBaseline) {
      const equity = next.cashUsd + next.positions.reduce((sum, position) =>
        sum + (this.books.get(position.tokenId)?.bid == null ? position.costUsd : position.shares * this.books.get(position.tokenId)!.bid!), 0);
      if (this.options.limits.dailyLossUsd != null && equity - next.risk.baselineEquityUsd > -this.options.limits.dailyLossUsd + EPS) {
        next.risk.halted = false; delete next.risk.reason;
      }
    }
    this.state = next;
    this.persist(true); this.emit({ kind: "account", snapshot: copy(account) });
  }
  async idle(): Promise<void> { while (this.jobs.size) await Promise.allSettled([...this.jobs]); }
  async stop(reason = "operator stop"): Promise<void> {
    this.stopped = true;
    if (!this.state.risk.halted) { this.state.risk.halted = true; this.state.risk.reason = "platform stopped"; }
    await this.idle();
    // A quarantined UNKNOWN order has already had a complete authenticated
    // open-order snapshot and has no venue terminal evidence.  Its outcome is
    // still unresolved, but retrying cancel on every local shutdown cannot
    // make that evidence appear and used to turn every otherwise clean run
    // into a process failure.  Keep its reservation and reconciliation flag;
    // only orders that are still actionable are sent through cancel here.
    const isQuarantined = (order: OrderRecord) =>
      order.orderId != null && this.isOrderQuarantined(order.orderId);
    const ownedActive = () => this.state.orders.filter(o =>
      active(o) && o.strategyId !== "external" && !isQuarantined(o));
    let failure: unknown;
    try {
      const result = await Promise.allSettled(ownedActive().map(o => this.cancel(o.orderId ?? o.clientOrderId)));
      if (result.some(item => item.status === "rejected")) throw new Error("stop left unresolved orders");
      this.options.adapters.beforeFinalReconcile?.();
      let unresolved = this.state.orders.some(o =>
        reservationPending(o) && o.strategyId !== "external" && !isQuarantined(o));
      if (unresolved && this.options.adapters.readAccount) {
        try {
          this.reconcile(await this.options.adapters.readAccount());
        } catch {
          // Keep the fail-closed state when the final ordinary account read
          // cannot prove every cancellation and fill outcome.
        }
        unresolved = this.state.orders.some(o =>
          reservationPending(o) && o.strategyId !== "external" && !isQuarantined(o));
      }
      if (unresolved) throw new Error("stop left unresolved orders");
    } catch (error) {
      failure = error;
    }
    // Operators and the control plane need a terminal event even when a
    // venue timeout leaves an order unresolved. The risk state remains closed
    // and the original error is still returned to the caller.
    try { this.persist(true); } catch (error) { failure ??= error; }
    this.emit({ kind: "stopped", reason: failure ? `${reason}: unresolved orders` : reason });
    if (failure) throw failure instanceof Error ? failure : new Error("stop failed");
  }
}
