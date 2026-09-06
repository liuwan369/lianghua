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

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
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
  private takerInFlight = new Set<Side>();
  private clob?: ClobWrapper;
  private stopClobHeartbeat?: () => void;
  private tickCache = new Map<string, number>();
  private windowEnd = 0;

  constructor(
    live: boolean,
    maxOrderUsd: number,
    maxOrders: number,
    maxTotalUsd?: number,
  ) {
    this.live = live;
    this.maxOrderUsd = maxOrderUsd;
    this.maxOrders = maxOrders;
    this.maxTotalUsd = maxTotalUsd ?? maxOrders * maxOrderUsd;
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
    this.stopClobHeartbeat?.();
    this.stopClobHeartbeat = undefined;
    this.clob?.stopHeartbeat();
    await this.cancelAll();
  }

  apiCreds(): ApiKeyCreds | undefined {
    return this.clob?.creds;
  }

  isOurOrder(orderId: string): boolean {
    return this.allOrderIds.has(orderId) || this.resting.has(orderId);
  }

  setWindowEnd(end: number): void {
    this.windowEnd = end;
  }

  async prepareMarket(conditionId: string): Promise<void> {
    if (!this.clob) return;
    const latencyMs = await this.clob.warmMarket(conditionId);
    console.info(`CLOB market metadata ready in ${latencyMs.toFixed(1)}ms`);
  }

  private capSize(price: number, size: number): number {
    const notional = price * size;
    if (notional <= this.maxOrderUsd) return size;
    return Math.max(0, this.maxOrderUsd / Math.max(price, 1e-6));
  }

  private async tick(token: string): Promise<number> {
    const cached = this.tickCache.get(token);
    if (cached != null) return cached;
    const t = this.clob ? await this.clob.tickSize(token) : 0.01;
    this.tickCache.set(token, t);
    return t;
  }

  updateTickSize(token: string, tickSize: number): void {
    if (!Number.isFinite(tickSize) || tickSize <= 0) return;
    this.tickCache.set(token, tickSize);
    this.clob?.updateTickSize(token, tickSize);
  }

  private prepSize(px: number, shares: number): number {
    let size = Math.round(this.capSize(px, shares) * 100) / 100;
    if (size > 0 && size < MIN_ORDER_SHARES) {
      const minNotional = px * MIN_ORDER_SHARES;
      if (minNotional <= this.maxOrderUsd + 1e-9) {
        size = MIN_ORDER_SHARES;
      } else {
        console.warn(
          `skip: ${size.toFixed(2)} shares below min ${MIN_ORDER_SHARES} and bump would exceed cap`,
        );
        size = 0;
      }
    }
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

  async submit(
    side: Side,
    token: string,
    price: number,
    shares: number,
  ): Promise<SubmitResult> {
    const tick = await this.tick(token);
    const px = tickRoundDown(price, tick);
    const size = this.prepSize(px, shares);
    const notional = px * size;
    const none: SubmitResult = { ok: false, price: px, size, notional };

    if (size <= 0 || px <= 0 || px >= 1) return none;
    if (!this.canSpend(notional)) return none;

    const existing = this.resting.get(side);
    if (existing) {
      await this.cancelSide(side);
    }

    if (!this.clob) {
      this.paperSeq += 1;
      this.sent += 1;
      this.spentUsd += notional;
      const id = `paper-${this.paperSeq}`;
      this.resting.set(side, id);
      this.allOrderIds.add(id);
      this.restingRemaining.set(id, size);
      console.info(
        `PAPER GTD BUY ${Side.asStr(side)} …${tail(token, 6)} ${size.toFixed(2)}@${px.toFixed(4)} ($${notional.toFixed(2)}) id=${id}`,
      );
      return { ok: true, orderId: id, price: px, size, notional };
    }

    const now = nowSecs();
    let expiration: number;
    if (this.windowEnd > 0) {
      if (this.windowEnd < now + 62) {
        console.warn(
          "skip submit: <62s to window end — cannot rest a valid GTD this close to resolution",
        );
        return none;
      }
      expiration = Math.min(now + 120, this.windowEnd);
    } else {
      expiration = now + 120;
    }

    const submittedAtUnix = Date.now() / 1000;
    const resp = await this.clob.submitOrder({
      tokenId: token,
      price: px,
      size,
      expiration,
      tickSize: tick,
    });

    if (resp.success || resp.orderId) {
      this.sent += 1;
      this.spentUsd += notional;
      if (resp.orderId) {
        this.resting.set(side, resp.orderId);
        this.allOrderIds.add(resp.orderId);
        this.restingRemaining.set(resp.orderId, size);
      }
      console.info(
        `LIVE GTD BUY ${Side.asStr(side)} …${tail(token, 6)} ${size.toFixed(2)}@${px.toFixed(4)} ($${notional.toFixed(2)}) id=…${tail(resp.orderId ?? "", 8)} sign=${resp.signLatencyMs?.toFixed(1) ?? "?"}ms ack=${resp.ackLatencyMs?.toFixed(1) ?? "?"}ms total=${resp.latencyMs?.toFixed(1) ?? "?"}ms`,
      );
      return {
        ok: true,
        orderId: resp.orderId,
        price: px,
        size,
        notional,
        tradeIds: resp.tradeIds,
      };
    }

    if (resp.stateUnknown) {
      this.sent += 1;
      this.spentUsd += notional;
      throw new UnknownOrderStateError(
        `order ACK timeout; exchange state is unknown, stopping before any retry: ${resp.errorMsg ?? "timeout"}`,
        { kind: "maker", side, token, price: px, size, notional, submittedAtUnix },
      );
    }

    console.error(`LIVE order rejected: ${resp.errorMsg ?? resp.status ?? "unknown"}`);
    return none;
  }

  /** FOK market cross for urgent hedges (live only). */
  async submitTaker(
    side: Side,
    token: string,
    price: number,
    shares: number,
  ): Promise<SubmitResult> {
    const tick = await this.tick(token);
    const px = tickRoundDown(price, tick);
    const size = this.prepSize(px, shares);
    const notional = px * size;
    const none: SubmitResult = { ok: false, price: px, size, notional };

    if (size <= 0 || px <= 0 || px >= 1) return none;
    if (!this.canSpend(notional)) return none;
    if (this.takerInFlight.has(side)) {
      console.warn(`taker in-flight ${Side.asStr(side)} — skip duplicate`);
      return none;
    }

    await this.cancelSide(side);

    if (!this.clob) {
      this.paperSeq += 1;
      this.sent += 1;
      this.spentUsd += notional;
      this.takerInFlight.add(side);
      const id = `paper-taker-${this.paperSeq}`;
      this.allOrderIds.add(id);
      console.info(
        `PAPER TAKER BUY ${Side.asStr(side)} …${tail(token, 6)} ${size.toFixed(2)}@${px.toFixed(4)} ($${notional.toFixed(2)})`,
      );
      return { ok: true, orderId: id, price: px, size, notional };
    }

    const submittedAtUnix = Date.now() / 1000;
    const resp = await this.clob.submitMarketBuy(token, notional, px, tick);
    if (resp.success || resp.orderId) {
      this.sent += 1;
      this.spentUsd += notional;
      this.takerInFlight.add(side);
      if (resp.orderId) this.allOrderIds.add(resp.orderId);
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
      };
    }

    if (resp.stateUnknown) {
      this.sent += 1;
      this.spentUsd += notional;
      this.takerInFlight.add(side);
      throw new UnknownOrderStateError(
        `taker ACK timeout; exchange state is unknown, stopping before any retry: ${resp.errorMsg ?? "timeout"}`,
        { kind: "taker", side, token, price: px, size, notional, submittedAtUnix },
      );
    }

    console.error(`LIVE taker rejected: ${resp.errorMsg ?? resp.status ?? "unknown"}`);
    return none;
  }

  noteFill(side: Side, orderId?: string, shares?: number): void {
    this.takerInFlight.delete(side);
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

  onOrderCancelled(orderId: string, side?: Side): void {
    this.allOrderIds.delete(orderId);
    this.restingRemaining.delete(orderId);
    if (side != null) {
      const cur = this.resting.get(side);
      if (cur === orderId) this.resting.set(side, undefined);
    } else if (this.resting.up === orderId) {
      this.resting.set(Side.Up, undefined);
    } else if (this.resting.down === orderId) {
      this.resting.set(Side.Down, undefined);
    }
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
      this.resting.take(side);
      this.restingRemaining.delete(id);
      this.allOrderIds.delete(id);
    } catch (e) {
      console.error(`LIVE cancel error id=…${tail(id, 8)}: ${e}`);
      // Keep the order tracked so a later stop/retry cannot claim success
      // while an unconfirmed live order may still be resting.
      this.resting.set(side, id);
      this.allOrderIds.add(id);
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
