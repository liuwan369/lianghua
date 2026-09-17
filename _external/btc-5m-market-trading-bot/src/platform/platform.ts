import type { AccountSnapshot, Book, CoreOptions, CoreState, MarketInfo, OrderRequest,
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
  private listeners = new Set<(event: TradingEvent) => void>();
  private plugins = new Map<string, StrategyPlugin>();
  private records: TradingEvent[] = [];
  private jobs = new Set<Promise<unknown>>();
  private closing = false;
  private dispatching = false;
  private queued: TradingEvent[] = [];
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
    current: (): CoreState => this.core.snapshot(),
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
    submit: (order: OrderRequest) => this.core.submit(order),
    cancel: (id: string) => this.core.cancel(id),
    replace: (id: string, order: OrderRequest) => this.core.replace(id, order),
    cancelAll: (strategyId?: string) => this.core.cancelAll(strategyId),
    list: () => this.core.orders(),
    get: (id: string) => this.core.order(id),
  };
  readonly portfolio = { positions: () => this.core.positions(), fills: () => this.core.snapshot().fills };
  readonly risk = { current: () => this.core.risk(), limits: () => clone(this.options.limits) };
  readonly history = { events: () => clone(this.records) };
  readonly telemetry = {
    snapshot: () => ({ events: this.sequence, strategies: [...this.plugins.keys()],
      actionsInFlight: this.jobs.size, stopped: this.closing }),
  };
  readonly settlement = {
    redeem: async (request: SettlementRequest) => {
      const result = this.options.adapters.settle
        ? await this.options.adapters.settle(clone(request))
        : { marketId: request.marketId, state: "unsupported" as const, reason: "no settlement adapter for this wallet" };
      // A broadcast receipt is not a cash credit; the account service reconciles actual proceeds.
      this.publish({ kind: "settlement", result });
      return clone(result);
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
  /** Replay durable identities before fresh market events can produce intentions. */
  replayOrders(): void {
    for (const order of this.core.orders()) this.publish({ kind: "order", order });
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
    if (event.kind === "fill") { this.core.applyFill(event.fill); return; }
    if (event.kind === "order" || event.kind === "account") throw new Error("use authenticated order/account service methods");
    if (event.kind === "market") {
      this.core.register(event.market.instruments);
      this.core.rememberMarket(event.market);
      this.markets.set(event.market.id, clone(event.market));
    }
    if (event.kind === "book") {
      const previous = this.books.get(event.book.tokenId);
      if (previous && event.book.ts < previous.ts) return;
      if (!this.core.mark(event.book)) return;
      this.books.set(event.book.tokenId, clone(event.book));
    }
    try { this.options.adapters.record?.(clone(event)); } catch { /* Background logging is not an order gate. */ }
    this.publish(event);
  }
  private context(): StrategyContext {
    return freeze({ mode: this.options.adapters.gateway.mode, now: this.options.now?.() ?? Date.now() / 1000,
      markets: this.market.list(), books: this.market.books(), account: this.core.contextSnapshot(),
      estimateFee: (order: Omit<OrderRequest, "strategyId">) =>
        this.options.adapters.estimateFee?.({ ...order, strategyId: "estimate" }) ?? 0 });
  }
  private publish(event: TradingEvent): void {
    this.records.push(clone(event));
    if (this.records.length > 2000) this.records.shift();
    this.sequence += 1;
    this.queued.push(clone(event));
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      let count = 0;
      while (this.queued.length) {
        if (++count > 1000) {
          this.queued.length = 0;
          this.closing = true;
          this.track(this.core.stop("recursive strategy event loop"));
          break;
        }
        const current = this.queued.shift()!;
        for (const listener of this.listeners) {
          try { listener(freeze(clone(current))); } catch { /* Observers cannot block execution. */ }
        }
        if (this.closing || (current.kind === "error" && !current.strategyId) || current.kind === "stopped") continue;
        for (const strategy of this.plugins.values()) {
          if (current.kind === "error" && current.strategyId !== strategy.id) continue;
          try {
            const actions = strategy.onEvent(freeze(clone(current)), this.context());
            if (!Array.isArray(actions)) throw new Error("strategy callbacks must be synchronous action arrays");
            for (const action of actions) this.dispatch(strategy.id, action);
          } catch (error) {
            this.plugins.delete(strategy.id);
            this.publish({ kind: "error", message: `strategy ${strategy.id}: ${error instanceof Error ? error.message : "failed"}` });
            this.track(this.core.cancelAll(strategy.id));
          }
        }
      }
    } finally { this.dispatching = false; }
  }
  private dispatch(strategyId: string, action: StrategyAction): void {
    if (action.kind === "submit") {
      this.track(this.orders.submit({ ...action.order, strategyId }), { strategyId, clientOrderId: action.order.clientOrderId }); return;
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
