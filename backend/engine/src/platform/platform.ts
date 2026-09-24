import type { AccountSnapshot, Book, CoreOptions, CoreState, ExecutionTiming, MarketBookSnapshot, MarketInfo, OrderRequest,
  SettlementRequest, StrategyAction, StrategyContext, StrategyPlugin, TradingEvent } from "./contracts.js";
import { TradingCore } from "./core.js";

const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/** One shared platform per account. Strategies are optional event consumers. */
export class TradingPlatform {
  readonly core: TradingCore;
  private markets = new Map<string, MarketInfo>();
  private books = new Map<string, Book>();
  private snapshots = new Map<string, MarketBookSnapshot>();
  private listeners = new Set<(event: TradingEvent) => void>();
  private plugins = new Map<string, StrategyPlugin>();
  private records: TradingEvent[] = [];
  private recordStart = 0;
  private jobs = new Set<Promise<unknown>>();
  private closing = false;
  private dispatching = false;
  private queued: TradingEvent[] = [];
  private queueStart = 0;
  private sequence = 0;
  private latestAccount?: AccountSnapshot;
  private refreshJob?: Promise<AccountSnapshot>;

  constructor(private readonly options: CoreOptions) {
    this.core = new TradingCore({ ...options, onEvent: event => {
      try { options.onEvent?.(event); } catch { /* External observers cannot interrupt a fill. */ }
      this.publish(event);
    } });
  }

  readonly market = {
    list: (): MarketInfo[] => clone([...this.markets.values()]),
    books: (): Book[] => clone([...this.books.values()]),
    book: (tokenId: string): Book | undefined => clone(this.books.get(tokenId)),
    snapshots: (): MarketBookSnapshot[] => clone([...this.snapshots.values()]),
    depth: (tokenId: string, levels = 5): Book | undefined => {
      if (!Number.isSafeInteger(levels) || levels <= 0) throw new Error("depth levels must be a positive integer");
      const book = this.books.get(tokenId);
      return book ? clone({ ...book, bids: book.bids?.slice(0, levels), asks: book.asks?.slice(0, levels) }) : undefined;
    },
    discover: async (): Promise<MarketInfo[]> => {
      if (!this.options.adapters.discoverMarkets) throw new Error("market discovery unavailable");
      const markets = await this.options.adapters.discoverMarkets();
      for (const market of markets) this.ingest({ kind: "market", market });
      return clone(markets);
    },
  };
  readonly account = {
    current: (): CoreState => this.core.view(),
    latestRead: (): AccountSnapshot | undefined => clone(this.latestAccount),
    refresh: (): Promise<AccountSnapshot> => {
      if (this.refreshJob) return this.refreshJob;
      const reader = this.options.adapters.readAccount;
      if (!reader) return Promise.reject(new Error("account reader unavailable"));
      const job = reader().then(snapshot => { this.latestAccount = clone(snapshot); return clone(snapshot); });
      this.refreshJob = job;
      void job.finally(() => { if (this.refreshJob === job) this.refreshJob = undefined; }).catch(() => undefined);
      return job;
    },
    // A slow read is never silently substituted into the live event ledger.
    reconcile: (snapshot: AccountSnapshot, netCashFlowUsd = 0, cancelledOrderIds?: readonly string[]): void =>
      this.core.reconcile(snapshot, netCashFlowUsd, cancelledOrderIds),
  };
  readonly orders = {
    submit: (order: OrderRequest, timing?: ExecutionTiming) => this.core.submit(order, timing),
    cancel: (id: string) => this.core.cancel(id),
    replace: (id: string, order: OrderRequest) => this.core.replace(id, order),
    cancelAll: (strategyId?: string) => this.core.cancelAll(strategyId),
    list: () => this.core.orders(),
    get: (id: string) => this.core.order(id),
  };
  readonly portfolio = { positions: () => this.core.positions(), fills: () => this.core.snapshot().fills };
  readonly risk = { current: () => this.core.risk(), limits: () => clone(this.options.limits) };
  readonly history = { events: () => clone(this.records.slice(this.recordStart)) };
  readonly telemetry = {
    snapshot: () => ({ events: this.sequence, strategies: [...this.plugins.keys()],
      actionsInFlight: this.jobs.size, stopped: this.closing }),
  };
  readonly settlement = {
    redeem: async (request: SettlementRequest) => {
      const market = this.markets.get(request.marketId);
      const roundId = request.roundId ?? market?.roundId;
      if (!market || !roundId || roundId !== market.roundId) {
        const result = { marketId: request.marketId, roundId, state: "unsupported" as const,
          reason: "settlement market round identity unavailable or mismatched" };
        this.publish({ kind: "settlement", result });
        return clone(result);
      }
      const scopedRequest = { ...clone(request), roundId };
      const result = this.options.adapters.settle
        ? await this.options.adapters.settle(scopedRequest)
        : { marketId: scopedRequest.marketId, roundId: scopedRequest.roundId, state: "unsupported" as const,
          reason: "no settlement adapter for this wallet" };
      if (result.marketId !== request.marketId || (result.roundId !== undefined && result.roundId !== roundId)) {
        const invalid = { marketId: request.marketId, roundId, state: "unsupported" as const,
          reason: "settlement adapter returned mismatched market identity" };
        this.publish({ kind: "settlement", result: invalid });
        return clone(invalid);
      }
      const scopedResult = { ...result, roundId: result.roundId ?? roundId };
      // A broadcast receipt is not a cash credit; the account service reconciles actual proceeds.
      this.publish({ kind: "settlement", result: scopedResult });
      return clone(scopedResult);
    },
  };

  capabilities() {
    return { buy: true, sell: true, multipleOrders: true, cancel: true, replace: true,
      accountRead: !!this.options.adapters.readAccount, marketDiscovery: !!this.options.adapters.discoverMarkets,
      settlement: !!this.options.adapters.settle, persistence: !!this.options.adapters.persist,
      mode: this.options.adapters.gateway.mode };
  }
  subscribe(listener: (event: TradingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  attach(strategy: StrategyPlugin): () => void {
    if (this.closing || !strategy.id || strategy.id === "external" || this.plugins.has(strategy.id)) throw new Error("strategy ID unavailable");
    this.plugins.set(strategy.id, strategy);
    return () => {
      if (this.core.orders().some(o => o.strategyId === strategy.id
        && (["SUBMITTING", "OPEN", "PARTIAL", "UNKNOWN"].includes(o.status) || o.reconciliationPending))) {
        throw new Error("cancel or transfer owned orders before detaching strategy");
      }
      this.plugins.delete(strategy.id); strategy.onStop?.();
    };
  }
  ingest(event: TradingEvent): void {
    if (event.kind === "fill") {
      this.core.applyFill({ ...event.fill, marketId: event.fill.marketId ?? event.marketId,
        roundId: event.fill.roundId ?? event.roundId });
      return;
    }
    if (event.kind === "order" || event.kind === "account") throw new Error("use authenticated order/account service methods");
    if (event.kind === "market") {
      if (!/^\d+$/.test(event.market.roundId) || event.market.roundId !== String(event.market.startsAt)
        || !Number.isFinite(event.market.startsAt) || event.market.endsAt - event.market.startsAt !== 300) {
        throw new Error("market round identity is required");
      }
      this.core.rememberMarket(event.market);
      this.core.register(event.market.instruments);
      this.markets.set(event.market.id, clone(event.market));
    }
    if (event.kind === "book") {
      if (event.snapshot) { this.ingestSnapshot(event.snapshot, event.marketId, event.roundId); return; }
      this.ingestBooks([event.book]); return;
    }
    try { this.options.adapters.record?.(clone(event)); } catch { /* Background logging is not an order gate. */ }
    this.publish(event);
  }
  /** Apply all token books from one venue frame before one strategy callback. */
  ingestBooks(books: readonly Book[]): void {
    const appliedAt = performance.now();
    if (!books.length || !this.core.markBatch(books)) return;
    for (const book of books) {
      const snapshot = clone(book);
      this.books.set(book.tokenId, snapshot);
      try { this.options.adapters.record?.({ kind: "book", book: snapshot }); }
      catch { /* Background logging is not an order gate. */ }
    }
    const trigger = books.reduce((latest, book) => (book.receivedAtMonoMs ?? -Infinity) >= (latest.receivedAtMonoMs ?? -Infinity) ? book : latest);
    const completedAt = performance.now();
    this.publish({ kind: "book", book: clone(trigger) });
    const ts = this.options.now?.() ?? Date.now() / 1000;
    const marketId = this.core.instrument(trigger.tokenId)?.marketId;
    this.publish({ kind: "latency", metric: "book_batch_apply", durationMs: completedAt - appliedAt, ts, marketId });
    if (trigger.receivedAtMonoMs != null) this.publish({ kind: "latency", metric: "book_processing",
      durationMs: Math.max(0, completedAt - trigger.receivedAtMonoMs), ts, marketId });
    for (const book of books) if (book.sourceAgeMs != null && book.sourceAgeMs >= 0
      && book.receivedAtMonoMs === trigger.receivedAtMonoMs) {
      this.publish({ kind: "latency", metric: "market_age", durationMs: book.sourceAgeMs, ts, marketId,
        tokenId: book.tokenId });
    }
  }
  /** Apply one already-gated paired snapshot and publish that same shape to observers and strategies. */
  ingestSnapshot(snapshot: MarketBookSnapshot, marketId = snapshot.marketId, roundId = snapshot.roundId): boolean {
    if (!marketId || !roundId || snapshot.marketId !== marketId || snapshot.roundId !== roundId) return false;
    const market = this.markets.get(marketId);
    const yes = snapshot.YES;
    const no = snapshot.NO;
    const yesInstrument = market?.instruments.find(item => item.outcome.toUpperCase() === "UP");
    const noInstrument = market?.instruments.find(item => item.outcome.toUpperCase() === "DOWN");
    if (!market || !yes || !no || market.instruments.length !== 2 || !yesInstrument || !noInstrument
      || yes.assetId !== yesInstrument.tokenId || no.assetId !== noInstrument.tokenId) return false;
    const toBook = (asset: typeof yes): Book => ({
      tokenId: asset.assetId,
      ts: asset.sourceAt ?? snapshot.sourceAt ?? snapshot.tsUnix,
      exchangeTs: asset.sourceAt ?? snapshot.sourceAt,
      receivedAt: snapshot.receivedAtUnix,
      receivedAtMonoMs: snapshot.receivedAtMonoMs,
      processedAtMonoMs: snapshot.processedAtMonoMs,
      processingLatencyMs: snapshot.receivedAtMonoMs != null && snapshot.processedAtMonoMs != null
        ? Math.max(0, snapshot.processedAtMonoMs - snapshot.receivedAtMonoMs) : undefined,
      sourceAgeMs: snapshot.marketAgeMs,
      source: snapshot.source,
      bid: asset.bid,
      ask: asset.ask,
      bidSize: asset.bidSize,
      askSize: asset.askSize,
      bids: asset.bids,
      asks: asset.asks,
    });
    const books = [toBook(yes), toBook(no)];
    const appliedAt = performance.now();
    if (!this.core.markBatch(books)) return false;
    for (const book of books) this.books.set(book.tokenId, clone(book));
    const key = JSON.stringify([marketId, roundId]);
    this.snapshots.set(key, clone(snapshot));
    const recordEvent: TradingEvent = { kind: "book", snapshot: clone(snapshot), marketId, roundId };
    queueMicrotask(() => {
      try { this.options.adapters.record?.(recordEvent); }
      catch { /* Background logging is outside the decision gate. */ }
    });
    const completedAt = performance.now();
    this.publish({ kind: "book", snapshot: clone(snapshot), marketId, roundId });
    const ts = this.options.now?.() ?? Date.now() / 1000;
    this.publish({ kind: "latency", metric: "book_batch_apply", durationMs: completedAt - appliedAt, ts, marketId });
    if (snapshot.receivedAtMonoMs != null) this.publish({ kind: "latency", metric: "book_processing",
      durationMs: Math.max(0, completedAt - snapshot.receivedAtMonoMs), ts, marketId });
    if (snapshot.marketAgeMs != null && snapshot.marketAgeMs >= 0) this.publish({ kind: "latency", metric: "market_age",
      durationMs: snapshot.marketAgeMs, ts, marketId });
    return true;
  }
  private context(): StrategyContext {
    return freeze({ mode: this.options.adapters.gateway.mode, now: this.options.now?.() ?? Date.now() / 1000,
      markets: this.market.list(), books: this.market.books(), account: this.core.contextSnapshot(),
      estimateFee: (order: Omit<OrderRequest, "strategyId">) =>
        this.options.adapters.estimateFee?.({ ...order, strategyId: "estimate" }) ?? 0 });
  }
  private publish(event: TradingEvent): void {
    const snapshot = clone(event);
    this.records.push(snapshot);
    if (this.records.length - this.recordStart > 2000) this.recordStart++;
    if (this.recordStart > 1024 && this.recordStart * 2 > this.records.length) {
      this.records = this.records.slice(this.recordStart);
      this.recordStart = 0;
    }
    this.sequence += 1;
    this.queued.push(snapshot);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      let count = 0;
      while (this.queueStart < this.queued.length) {
        if (++count > 1000) {
          this.queued.length = 0;
          this.closing = true;
          this.track(this.core.stop("recursive strategy event loop"));
          break;
        }
        const current = this.queued[this.queueStart++]!;
        for (const listener of this.listeners) {
          try { listener(freeze(clone(current))); } catch { /* Observers cannot block execution. */ }
        }
        if (this.closing || current.kind === "latency"
          || (current.kind === "error" && (!current.strategyId || current.code === "strategy_callback_failed"))
          || current.kind === "stopped") continue;
        for (const strategy of this.plugins.values()) {
          if (current.kind === "error" && current.strategyId !== strategy.id) continue;
          try {
            const decisionStarted = performance.now();
            const actions = strategy.onEvent(freeze(clone(current)), this.context());
            const decisionAtMonoMs = performance.now();
            if (!Array.isArray(actions)) throw new Error("strategy callbacks must be synchronous action arrays");
            const currentBook = current.kind === "book" && current.book !== undefined ? current.book : undefined;
            const currentSnapshot = current.kind === "book" && current.snapshot !== undefined ? current.snapshot : undefined;
            const timing: ExecutionTiming | undefined = current.kind === "book" ? {
              triggerReceivedAtMonoMs: currentSnapshot?.receivedAtMonoMs ?? currentBook?.receivedAtMonoMs,
              decisionAtMonoMs,
            } : undefined;
            for (const action of actions) this.dispatch(strategy.id, action, timing);
            if (current.kind === "book") {
              const marketId = currentSnapshot?.marketId ?? (currentBook ? this.core.instrument(currentBook.tokenId)?.marketId : undefined);
              this.publish({ kind: "latency", metric: "strategy_decision", durationMs: decisionAtMonoMs - decisionStarted,
                ts: this.options.now?.() ?? Date.now() / 1000, marketId,
                tokenId: currentSnapshot?.YES?.assetId ?? currentBook?.tokenId, strategyId: strategy.id });
              const receivedAtMonoMs = currentSnapshot?.receivedAtMonoMs ?? currentBook?.receivedAtMonoMs;
              if (receivedAtMonoMs != null) this.publish({ kind: "latency", metric: "ws_receive_to_decision",
                durationMs: Math.max(0, decisionAtMonoMs - receivedAtMonoMs),
                ts: this.options.now?.() ?? Date.now() / 1000, marketId,
                tokenId: currentSnapshot?.YES?.assetId ?? currentBook?.tokenId, strategyId: strategy.id });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "failed";
            // A single malformed event or failed action must not unregister the
            // strategy.  Unregistering here silently disables every later
            // market, including the next five-minute round.  Keep the plugin
            // attached, cancel its working orders, and let the next event
            // drive recovery after the venue/account state catches up.
            this.publish({ kind: "error", strategyId: strategy.id,
              code: "strategy_callback_failed", message: `strategy ${strategy.id}: ${message}` });
            this.track(this.core.cancelAll(strategy.id), { strategyId: strategy.id });
          }
        }
      }
      if (this.queueStart > 1024 && this.queueStart * 2 > this.queued.length) {
        this.queued = this.queued.slice(this.queueStart);
        this.queueStart = 0;
      }
    } finally { this.dispatching = false; }
  }
  private dispatch(strategyId: string, action: StrategyAction, timing?: ExecutionTiming): void {
    if (action.kind === "submit") {
      this.track(this.orders.submit({ ...action.order, strategyId }, timing), { strategyId, clientOrderId: action.order.clientOrderId }); return;
    }
    const order = this.orders.get(action.orderId);
    if (!order || order.strategyId !== strategyId) throw new Error("strategy cannot modify another strategy's order");
    if (action.kind === "cancel") this.track(this.orders.cancel(action.orderId), { strategyId, orderId: action.orderId });
    else if (action.kind === "replace") this.track(this.orders.replace(action.orderId, { ...action.order, strategyId }),
      { strategyId, orderId: action.orderId, clientOrderId: action.order.clientOrderId });
    else throw new Error("unknown strategy action");
  }
  private track(job: Promise<unknown>, correlation: { strategyId?: string; clientOrderId?: string; orderId?: string } = {}): void {
    this.jobs.add(job);
    void job.catch(error => {
      const order = correlation.clientOrderId ? this.core.order(correlation.clientOrderId) : undefined;
      const code = correlation.clientOrderId && (!order || order.status === "REJECTED") ? "order_not_submitted" : undefined;
      this.publish({ kind: "error", ...correlation, code, message: error instanceof Error ? error.message : "action failed" });
    })
      .finally(() => this.jobs.delete(job));
  }
  async idle(): Promise<void> {
    do { await this.core.idle(); await Promise.allSettled([...this.jobs]); } while (this.jobs.size);
  }
  async stop(reason?: string): Promise<void> {
    this.closing = true;
    try { await this.idle(); await this.core.stop(reason); }
    finally {
      for (const strategy of this.plugins.values()) {
        try { strategy.onStop?.(); } catch { /* Stop every plugin even if one cleanup fails. */ }
      }
      this.plugins.clear();
      await this.options.adapters.gateway.close?.();
    }
  }
}
