import { Side } from "../models.js";
import {
  ClobWrapper,
  geocheck,
  MIN_ORDER_SHARES,
  tickRoundDown,
  type ApiKeyCreds,
} from "./clob/client.js";

export interface SubmitResult {
  ok: boolean;
  orderId?: string;
  price: number;
  size: number;
  notional: number;
  tradeIds?: string[];
  signLatencyMs?: number;
  ackLatencyMs?: number;
}

export interface UnknownOrderContext {
  kind: "maker" | "taker";
  side: Side;
  token: string;
  price: number;
  size: number;
  notional: number;
  submittedAtUnix: number;
}

export interface ReservationCoordinator {
  prepare(id: string, amountUsd: number, feeReserveUsd: number): void;
  transition(id: string, status: 'submitted' | 'unknown' | 'acknowledged' | 'partially_filled' | 'settlement_pending' | 'reconciled'): void;
}

export class UnknownOrderStateError extends Error {
  constructor(message: string, readonly context: UnknownOrderContext) {
    super(message);
    this.name = "UnknownOrderStateError";
  }

  get submittedAtUnix(): number {
    return this.context.submittedAtUnix;
  }
}

class RestingIds {
  up?: string;
  down?: string;

  get(side: Side): string | undefined {
    return side === Side.Up ? this.up : this.down;
  }

  set(side: Side, id: string | undefined): void {
    if (side === Side.Up) this.up = id;
    else this.down = id;
  }

  take(side: Side): string | undefined {
    const id = this.get(side);
    this.set(side, undefined);
    return id;
  }

  ids(): string[] {
    return [this.up, this.down].filter((x): x is string => x != null);
  }

  clear(): void {
    this.up = undefined;
    this.down = undefined;
  }

  has(id: string): boolean {
    return this.up === id || this.down === id;
  }
}

function tail(s: string, n: number): string {
  return s.slice(Math.max(0, s.length - n));
}

/** Order executor — paper or live via CLOB wrapper. */
export class Executor {
  live: boolean;
  spentUsd = 0;
  sent = 0;

  private maxOrderUsd: number;
  private maxOrders: number;
  private maxTotalUsd: number;
  private paperSeq = 0;
  private resting = new RestingIds();
  /** Track remaining size so partial fills stay cancellable. */
  private restingRemaining = new Map<string, number>();
  private allOrderIds = new Set<string>();
  /** Ownership persists for late fills after a cancellation ACK. */
  private knownOrderIds = new Set<string>();
  private takerInFlight = new Map<Side, { orderId?: string; remaining: number }>();
  private stopping = false;
  private paused = false;
  private submissions = new Set<Promise<SubmitResult>>();
  private clob?: ClobWrapper;
  private stopClobHeartbeat?: () => void;
  private tickCache = new Map<string, number>();
  private tickUpdatedAt = new Map<string, number>();
  private reservationCoordinator?: ReservationCoordinator;
  private reservationByOrderId = new Map<string, string>();
  private activeReservationIds = new Set<string>();

  constructor(
    live: boolean,
    maxOrderUsd: number,
    maxOrders: number,
    maxTotalUsd?: number,
    reservationCoordinator?: ReservationCoordinator,
  ) {
    this.live = live;
    this.maxOrderUsd = maxOrderUsd;
    this.maxOrders = maxOrders;
    this.maxTotalUsd = maxTotalUsd ?? maxOrders * maxOrderUsd;
    this.reservationCoordinator = reservationCoordinator;
  }

  attachReservationCoordinator(coordinator: ReservationCoordinator): void {
    this.reservationCoordinator = coordinator;
  }

  static async newLive(
    maxOrderUsd: number,
    maxOrders: number,
    maxTotalUsd: number | undefined,
    key: string,
  ): Promise<Executor> {
    await geocheck();
    const clob = await ClobWrapper.connect({ key });
    console.warn(
      `SIGNER EOA=${clob.signerAddress} funder=${clob.funder} sig_type=${clob.signatureType}`,
    );
    try {
      await clob.cancelAll();
    } catch (e) {
      throw new Error(`startup cancel_all failed; refusing to trade with unknown resting orders: ${e}`);
    }
    const maxTotal = maxTotalUsd ?? maxOrders * maxOrderUsd;
    console.warn(
      `EXECUTOR LIVE — REAL MONEY | max $${maxOrderUsd}/order, ${maxOrders} orders, $${maxTotal.toFixed(0)} total`,
    );
    const ex = new Executor(true, maxOrderUsd, maxOrders, maxTotal);
    ex.clob = clob;
    ex.stopClobHeartbeat = clob.startHeartbeat();
    return ex;
  }

  /** Cancel resting orders and stop CLOB heartbeat. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.pauseSubmissions();
    this.stopClobHeartbeat?.();
    this.stopClobHeartbeat = undefined;
    this.clob?.stopHeartbeat();
    await this.cancelAll();
  }

  async pauseSubmissions(): Promise<void> {
    this.paused = true;
    await Promise.allSettled([...this.submissions]);
  }

  resumeSubmissions(): void {
    if (!this.stopping) this.paused = false;
  }

  confirmAccountReconciled(): void {
    this.takerInFlight.clear();
    const unresolved = new Set<string>();
    for (const reservationId of this.activeReservationIds) {
      try { this.reservationCoordinator?.transition(reservationId, 'reconciled'); }
      catch { unresolved.add(reservationId); }
    }
    this.activeReservationIds = unresolved;
    for (const [orderId, reservationId] of this.reservationByOrderId) {
      if (!unresolved.has(reservationId)) this.reservationByOrderId.delete(orderId);
    }
  }

  apiCreds(): ApiKeyCreds | undefined {
    return this.clob?.creds;
  }

  isOurOrder(orderId: string): boolean {
    return this.knownOrderIds.has(orderId) || this.allOrderIds.has(orderId) || this.resting.has(orderId);
  }

  async prepareMarket(conditionId: string, tokens: string[] = []): Promise<void> {
    if (this.clob) {
      const latencyMs = await this.clob.warmMarket(conditionId);
      console.info(`CLOB market metadata ready in ${latencyMs.toFixed(1)}ms`);
    }
    await Promise.all(tokens.map(token => this.tick(token)));
  }

  private capSize(price: number, size: number): number {
    const notional = price * size;
    if (notional <= this.maxOrderUsd) return size;
    return Math.max(0, this.maxOrderUsd / Math.max(price, 1e-6));
  }

  private async tick(token: string): Promise<number> {
    const cached = this.tickCache.get(token);
    if (cached != null) return cached;
    let t: number;
    if (this.clob) t = await this.clob.tickSize(token);
    else {
      const response = await fetch(`https://clob.polymarket.com/tick-size?token_id=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error("market tick size lookup failed");
      const payload = await response.json() as { minimum_tick_size?: unknown };
      t = Number(payload.minimum_tick_size);
    }
    if (!Number.isFinite(t) || t <= 0 || t >= 1) throw new Error("market tick size is unavailable or invalid");
    this.tickCache.set(token, t);
    return t;
  }

  knownTickSize(token: string): number | undefined {
    return this.tickCache.get(token);
  }

  updateTickSize(token: string, tickSize: number, updatedAtUnix = Date.now() / 1000): void {
    if (!Number.isFinite(tickSize) || tickSize <= 0) return;
    if (!Number.isFinite(updatedAtUnix) || updatedAtUnix < (this.tickUpdatedAt.get(token) ?? 0)) return;
    this.tickUpdatedAt.set(token, updatedAtUnix);
    this.tickCache.set(token, tickSize);
    this.clob?.updateTickSize(token, tickSize);
  }

  private prepSize(px: number, shares: number, minOrderShares: number): number {
    let size = Math.floor((this.capSize(px, shares) + 1e-9) * 100) / 100;
    if (size > 0 && size < minOrderShares) {
      // The strategy already approved this quantity against inventory risk.
      // Increasing it to a venue minimum would bypass that approval.
      console.warn(`skip: ${size.toFixed(2)} shares below market minimum ${minOrderShares}`);
      size = 0;
    }
    if (px * size > this.maxOrderUsd + 1e-9) size = 0;
    return size;
  }

  private canSpend(notional: number): boolean {
    if (this.sent >= this.maxOrders) {
      console.warn(`MAX ORDERS (${this.maxOrders}) reached — refusing (kill switch)`);
      return false;
    }
    if (this.spentUsd + notional > this.maxTotalUsd + 1e-9) {
      console.warn(
        `MAX TOTAL $${this.maxTotalUsd.toFixed(0)} reached (spent $${this.spentUsd.toFixed(2)}) — refusing`,
      );
      return false;
    }
    return true;
  }

  submit(side: Side, token: string, price: number, shares: number): Promise<SubmitResult> {
    return this.trackSubmission(() => this.submitMaker(side, token, price, shares), price);
  }

  private trackSubmission(operation: () => Promise<SubmitResult>, price: number): Promise<SubmitResult> {
    if (this.stopping || this.paused || this.submissions.size > 0 || this.takerInFlight.size > 0) {
      return Promise.resolve({ok:false,price,size:0,notional:0});
    }
    const submission = operation();
    this.submissions.add(submission);
    void submission.then(() => this.submissions.delete(submission), () => this.submissions.delete(submission));
    return submission;
  }

  private async submitMaker(
    side: Side,
    token: string,
    price: number,
    shares: number,
  ): Promise<SubmitResult> {
    const tick = await this.tick(token);
    const px = tickRoundDown(price, tick);
    const marketMinimum = this.clob?.minOrderSize(token);
    if (this.clob && marketMinimum == null) {
      console.error("skip live order: market minimum order size was not loaded");
      return { ok: false, price: px, size: 0, notional: 0 };
    }
    const size = this.prepSize(px, shares, marketMinimum ?? MIN_ORDER_SHARES);
    const notional = px * size;
    const none: SubmitResult = { ok: false, price: px, size, notional };

    if (this.stopping || this.takerInFlight.size > 0 || !Number.isFinite(size) || !Number.isFinite(px) || size <= 0 || px <= 0 || px >= 1) return none;
    if (!this.canSpend(notional)) return none;

    const existing = this.resting.get(side);
    if (existing) {
      await this.cancelSide(side);
    }
    if (this.stopping || this.paused) return none;

    if (!this.clob) {
      this.paperSeq += 1;
      this.sent += 1;
      this.spentUsd += notional;
      const id = `paper-${this.paperSeq}`;
      this.resting.set(side, id);
      this.allOrderIds.add(id);
      this.knownOrderIds.add(id);
      this.restingRemaining.set(id, size);
      console.info(
        `PAPER GTC BUY ${Side.asStr(side)} …${tail(token, 6)} ${size.toFixed(2)}@${px.toFixed(4)} ($${notional.toFixed(2)}) id=${id}`,
      );
      return { ok: true, orderId: id, price: px, size, notional };
    }

    const reservationId = `order-${Date.now()}-${this.sent + 1}-${Side.asStr(side)}`;
    this.reservationCoordinator?.prepare(reservationId, notional, 0);
    this.reservationCoordinator?.transition(reservationId, 'submitted');
    this.activeReservationIds.add(reservationId);
    const submittedAtUnix = Date.now() / 1000;
    let resp: Awaited<ReturnType<ClobWrapper['submitOrder']>>;
    try {
      resp = await this.clob.submitOrder({ tokenId: token, price: px, size, tickSize: tick });
    } catch {
      this.reservationCoordinator?.transition(reservationId, 'unknown');
      this.paused = true;
      throw new UnknownOrderStateError('order submission failed with unknown exchange state',
        { kind: 'maker', side, token, price: px, size, notional, submittedAtUnix });
    }

    if (resp.success && resp.orderId) {
      this.reservationCoordinator?.transition(reservationId, 'acknowledged');
      this.reservationByOrderId.set(resp.orderId, reservationId);
      this.sent += 1;
      this.spentUsd += notional;
      if (resp.orderId) {
        this.resting.set(side, resp.orderId);
        this.allOrderIds.add(resp.orderId);
        this.knownOrderIds.add(resp.orderId);
        this.restingRemaining.set(resp.orderId, size);
      }
      console.info(
        `LIVE GTC BUY ${Side.asStr(side)} …${tail(token, 6)} ${size.toFixed(2)}@${px.toFixed(4)} ($${notional.toFixed(2)}) id=…${tail(resp.orderId ?? "", 8)} sign=${resp.signLatencyMs?.toFixed(1) ?? "?"}ms ack=${resp.ackLatencyMs?.toFixed(1) ?? "?"}ms total=${resp.latencyMs?.toFixed(1) ?? "?"}ms`,
      );
      return {
        ok: true,
        orderId: resp.orderId,
        price: px,
        size,
        notional,
        tradeIds: resp.tradeIds,
        signLatencyMs: resp.signLatencyMs,
        ackLatencyMs: resp.ackLatencyMs,
      };
    }

    if (resp.stateUnknown || resp.success || resp.orderId) {
      this.reservationCoordinator?.transition(reservationId, 'unknown');
      if (resp.orderId) this.reservationByOrderId.set(resp.orderId, reservationId);
      this.paused = true;
      this.sent += 1;
      this.spentUsd += notional;
      throw new UnknownOrderStateError(
        `order ACK timeout; exchange state is unknown, stopping before any retry: ${resp.errorMsg ?? "timeout"}`,
        { kind: "maker", side, token, price: px, size, notional, submittedAtUnix },
      );
    }

    console.error(`LIVE order rejected: ${resp.errorMsg ?? resp.status ?? "unknown"}`);
    this.reservationCoordinator?.transition(reservationId, 'reconciled');
    this.activeReservationIds.delete(reservationId);
    return none;
  }

  /** FOK market cross for urgent hedges (live only). */
  submitTaker(side: Side, token: string, price: number, shares: number): Promise<SubmitResult> {
    return this.trackSubmission(() => this.submitTakerOrder(side, token, price, shares), price);
  }

  /** Reduce an existing position via FOK; this path never opens exposure. */
  submitExit(side: Side, token: string, price: number, shares: number): Promise<SubmitResult> {
    return this.trackSubmission(async () => {
      if (!this.clob || this.stopping || this.paused || shares <= 0 || price <= 0 || price >= 1) {
        return { ok: false, price, size: 0, notional: 0 };
      }
      const tick = await this.tick(token);
      const px = tickRoundDown(price, tick);
      const size = Math.floor(shares * 100) / 100;
      const notional = px * size;
      if (size <= 0 || !this.canSpend(notional)) return { ok: false, price: px, size, notional };
      const resp = await this.clob.submitMarketSell(token, size, px, tick);
      if (!resp.success && (resp.stateUnknown || resp.orderId)) {
        this.paused = true;
        throw new UnknownOrderStateError("exit ACK timeout; account reconciliation required", {
          kind: "taker", side, token, price: px, size, notional, submittedAtUnix: Date.now() / 1000,
        });
      }
      if (!resp.success) return { ok: false, price: px, size, notional };
      this.sent += 1;
      return { ok: true, orderId: resp.orderId, price: px, size, notional, tradeIds: resp.tradeIds,
        signLatencyMs: resp.signLatencyMs, ackLatencyMs: resp.ackLatencyMs };
    }, price);
  }

  private async submitTakerOrder(
    side: Side,
    token: string,
    price: number,
    shares: number,
  ): Promise<SubmitResult> {
    const tick = await this.tick(token);
    const px = tickRoundDown(price, tick);
    const marketMinimum = this.clob?.minOrderSize(token);
    if (this.clob && marketMinimum == null) {
      console.error("skip live taker: market minimum order size was not loaded");
      return { ok: false, price: px, size: 0, notional: 0 };
    }
    const size = this.prepSize(px, shares, marketMinimum ?? MIN_ORDER_SHARES);
    const notional = px * size;
    const none: SubmitResult = { ok: false, price: px, size, notional };

    if (this.stopping || this.takerInFlight.size > 0 || !Number.isFinite(size) || !Number.isFinite(px) || size <= 0 || px <= 0 || px >= 1) return none;
    if (!this.canSpend(notional)) return none;
    if (this.takerInFlight.has(side)) {
      console.warn(`taker in-flight ${Side.asStr(side)} — skip duplicate`);
      return none;
    }

    await this.cancelSide(side);
    if (this.stopping || this.paused) return none;

    if (!this.clob) {
      this.paperSeq += 1;
      this.sent += 1;
      this.spentUsd += notional;
      const id = `paper-taker-${this.paperSeq}`;
      this.takerInFlight.set(side, {orderId:id,remaining:size});
      this.allOrderIds.add(id);
      this.knownOrderIds.add(id);
      console.info(
        `PAPER TAKER BUY ${Side.asStr(side)} …${tail(token, 6)} ${size.toFixed(2)}@${px.toFixed(4)} ($${notional.toFixed(2)})`,
      );
      return { ok: true, orderId: id, price: px, size, notional };
    }

    const reservationId = `order-${Date.now()}-${this.sent + 1}-${Side.asStr(side)}-taker`;
    this.reservationCoordinator?.prepare(reservationId, notional, 0);
    this.reservationCoordinator?.transition(reservationId, 'submitted');
    this.activeReservationIds.add(reservationId);
    const submittedAtUnix = Date.now() / 1000;
    let resp: Awaited<ReturnType<ClobWrapper['submitMarketBuy']>>;
    try {
      resp = await this.clob.submitMarketBuy(token, notional, px, tick);
    } catch {
      this.reservationCoordinator?.transition(reservationId, 'unknown');
      this.paused = true;
      throw new UnknownOrderStateError('taker submission failed with unknown exchange state',
        { kind: 'taker', side, token, price: px, size, notional, submittedAtUnix });
    }
    if (resp.success && resp.orderId) {
      this.reservationCoordinator?.transition(reservationId, 'acknowledged');
      this.reservationByOrderId.set(resp.orderId, reservationId);
      this.sent += 1;
      this.spentUsd += notional;
      this.takerInFlight.set(side, {orderId:resp.orderId,remaining:size});
      if (resp.orderId) {
        this.allOrderIds.add(resp.orderId);
        this.knownOrderIds.add(resp.orderId);
      }
      console.info(
        `LIVE TAKER BUY ${Side.asStr(side)} …${tail(token, 6)} ~${size.toFixed(2)}@${px.toFixed(4)} ($${notional.toFixed(2)}) id=…${tail(resp.orderId ?? "", 8)} sign=${resp.signLatencyMs?.toFixed(1) ?? "?"}ms ack=${resp.ackLatencyMs?.toFixed(1) ?? "?"}ms total=${resp.latencyMs?.toFixed(1) ?? "?"}ms`,
      );
      return {
        ok: true,
        orderId: resp.orderId,
        price: px,
        size,
        notional,
        tradeIds: resp.tradeIds,
        signLatencyMs: resp.signLatencyMs,
        ackLatencyMs: resp.ackLatencyMs,
      };
    }

    if (resp.stateUnknown || resp.success || resp.orderId) {
      this.reservationCoordinator?.transition(reservationId, 'unknown');
      if (resp.orderId) this.reservationByOrderId.set(resp.orderId, reservationId);
      this.paused = true;
      this.sent += 1;
      this.spentUsd += notional;
      this.takerInFlight.set(side, {orderId:resp.orderId,remaining:size});
      throw new UnknownOrderStateError(
        `taker ACK timeout; exchange state is unknown, stopping before any retry: ${resp.errorMsg ?? "timeout"}`,
        { kind: "taker", side, token, price: px, size, notional, submittedAtUnix },
      );
    }

    console.error(`LIVE taker rejected: ${resp.errorMsg ?? resp.status ?? "unknown"}`);
    this.reservationCoordinator?.transition(reservationId, 'reconciled');
    this.activeReservationIds.delete(reservationId);
    return none;
  }

  noteFill(side: Side, orderId?: string, shares?: number): void {
    if (orderId) {
      const reservationId = this.reservationByOrderId.get(orderId);
      if (reservationId && shares != null && Number.isFinite(shares) && shares > 0) {
        const remaining = this.restingRemaining.get(orderId)
          ?? [...this.takerInFlight.values()].find(item => item.orderId === orderId)?.remaining;
        try {
          this.reservationCoordinator?.transition(reservationId,
            remaining != null && remaining - shares > 1e-8 ? 'partially_filled' : 'settlement_pending');
        } catch { /* account reconciliation will keep the reservation active */ }
      }
    }
    const taker = this.takerInFlight.get(side);
    if (taker && (orderId != null ? taker.orderId === orderId : !this.live)) {
      if (!this.live || (shares != null && Number.isFinite(shares) && shares > 0)) {
        taker.remaining -= shares ?? taker.remaining;
        if (taker.remaining <= 1e-8) this.takerInFlight.delete(side);
      }
    }
    const id = this.resting.get(side);
    if (!id) {
      if (orderId != null) this.allOrderIds.delete(orderId);
      return;
    }
    if (orderId != null && orderId !== id) return;
    if (this.live && shares != null && shares > 0) {
      const remaining = (this.restingRemaining.get(id) ?? 0) - shares;
      if (remaining > 1e-8) {
        this.restingRemaining.set(id, remaining);
        return;
      }
    }
    this.resting.take(side);
    this.restingRemaining.delete(id);
    this.allOrderIds.delete(id);
  }

  onOrderCancelled(orderId: string, _side?: Side): Side | undefined {
    const cancelledSide = this.resting.up === orderId ? Side.Up
      : this.resting.down === orderId ? Side.Down : undefined;
    this.allOrderIds.delete(orderId);
    this.restingRemaining.delete(orderId);
    if (cancelledSide != null) this.resting.set(cancelledSide, undefined);
    return cancelledSide;
  }

  async cancelSide(side: Side): Promise<void> {
    const id = this.resting.get(side);
    if (!id) return;
    if (!this.clob) {
      this.resting.take(side);
      this.restingRemaining.delete(id);
      this.allOrderIds.delete(id);
      console.info(`PAPER CANCEL ${Side.asStr(side)} -> ${id}`);
      return;
    }
    try {
      const ok = await this.clob.cancel(id);
      console.info(`LIVE CANCEL ${Side.asStr(side)} id=…${tail(id, 8)} confirmed=${ok}`);
      if (!ok) throw new Error(`cancel not confirmed for ${id}`);
      // A cancellation ACK does not prove that no fill raced with the cancel.
      // Keep the reservation bound to the order until authoritative reconciliation.
      this.resting.take(side);
      this.restingRemaining.delete(id);
      this.allOrderIds.delete(id);
    } catch (e) {
      console.error(`LIVE cancel error id=…${tail(id, 8)}: ${e}`);
      // Keep the order tracked so a later stop/retry cannot claim success
      // while an unconfirmed live order may still be resting.
      this.resting.set(side, id);
      this.allOrderIds.add(id);
      this.knownOrderIds.add(id);
      throw e;
    }
  }

  async cancelAll(): Promise<void> {
    const ids = this.resting.ids();
    if (this.clob) {
      try {
        await this.clob.cancelAll();
        this.resting.clear();
        for (const id of ids) this.restingRemaining.delete(id);
        for (const id of ids) this.allOrderIds.delete(id);
      } catch (e) {
        console.error(`LIVE cancel_all error: ${e}`);
        // Preserve tracked IDs so the caller can report and retry an
        // unconfirmed cancellation instead of silently losing them.
        for (const id of ids) this.allOrderIds.add(id);
        throw e;
      }
    } else {
      this.resting.clear();
      for (const id of ids) this.restingRemaining.delete(id);
      for (const id of ids) this.allOrderIds.delete(id);
      if (ids.length > 0) {
      console.info(`PAPER CANCEL ALL (${ids.length} orders)`);
      }
    }
    if (this.clob) this.allOrderIds.clear();
  }

  restingId(side: Side): string | undefined {
    return this.resting.get(side);
  }

  async getTradesByIds(ids: string[]): Promise<unknown[]> {
    return this.clob ? this.clob.getTradesByIds(ids) : [];
  }

  async getRecentTrades(conditionId: string, afterUnix: number): Promise<unknown[]> {
    return this.clob ? this.clob.getRecentTrades(conditionId, afterUnix) : [];
  }

  async getOpenOrders(conditionId: string): Promise<unknown[]> {
    return this.clob ? this.clob.getOpenOrders(conditionId) : [];
  }

  accountAddress(): string | undefined {
    return this.clob?.funder;
  }
}
