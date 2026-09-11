import type { MakerEvent } from "../live-maker.js";

import { Side } from "../models.js";

import { Engine, type EngineConfig } from "./engine.js";

import { Executor, UnknownOrderStateError } from "./executor.js";

import { findMarket, marketToken, type Market } from "./discovery.js";

import { runBtcFeed } from "./feeds/btc.js";

import { runClobPollFeed } from "./feeds/clob-poll.js";

import { runPolymarketFeed } from "./feeds/polymarket.js";

import { runRtdsFeed } from "./feeds/rtds.js";
import { runCollectorBookFeed } from "./feeds/collector.js";

import { runUserFeed } from "./feeds/user.js";
import type { UserFeedControl } from "./feeds/user.js";

import {

  bookIsComplete,

  FeedQueue,

  nowUnix,

  sleep,

  type BookSnapshot,

  type FeedEvent,

} from "./feeds/index.js";

import { Journal, r2, r4, recordTraded } from "./journal.js";
import { preflight } from "./onchain.js";
import { ownerSignerPrivateKey } from "./account.js";

export const LIVE_BOOK_MAX_AGE_MS = 250;
const OFFICIAL_CLOB_HEALTH = "https://clob.polymarket.com/";

export function liveBookIsFresh(
  snapshot: BookSnapshot,
  nowMs = Date.now(),
  maxAgeMs = LIVE_BOOK_MAX_AGE_MS,
): boolean {
  const timestamps = snapshot.source === "polymarket-ws"
    ? [snapshot.upExchangeTsUnix, snapshot.downExchangeTsUnix]
    : [snapshot.tsUnix];
  return timestamps.every((tsUnix) => {
    if (tsUnix == null || !Number.isFinite(tsUnix)) return false;
    const ageMs = nowMs - tsUnix * 1000;
    return ageMs >= -1_000 && ageMs <= maxAgeMs;
  });
}

/** Verify the official CLOB is reachable without a third-party health package. */
export async function assertOfficialClobHealth(timeoutMs = 3_000): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(OFFICIAL_CLOB_HEALTH, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`official CLOB health returned HTTP ${response.status}`);
    }
    return performance.now() - started;
  } finally {
    clearTimeout(timer);
  }
}

export interface RunConfig {

  live: boolean;

  engine: EngineConfig;

  orderUsd: number;

  pairCostMax?: number;

  maxOrders: number;

  maxTotalUsd?: number;

  heartbeatMs: number;

  btcMoveBps: number;

  bookPollHz: number;

  oracle: boolean;

  logPath: string;

  tradedPath: string;

  durationMin: number;

  /** Run wallet preflight before live connect (default true). */
  preflight?: boolean;

}

/** Skip markets with less than this many seconds left — need time to rest GTD quotes. */
const MIN_WINDOW_REMAINING_SEC = 90;
// Paper mode has no exchange order expiry to protect. Let it observe the
// current window even when started late, while keeping the stricter live gate.
const PAPER_MIN_WINDOW_REMAINING_SEC = 15;



export function recordLatency(journal: Journal, market: Market | undefined, metric: string,
  durationMs: number | undefined, live: boolean, orderId?: string): void {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return;
  journal.log("latency", market, nowUnix(), { metric, duration_ms: durationMs,
    mode: live ? "live" : "paper", live, order_id: orderId ?? null });
}

export function recordResidualExposure(engine: Engine, journal: Journal, market: Market,
  reason: string, live: boolean): void {
  const exposure = engine.session.exposure();
  journal.log("inventory_exposure", market, nowUnix(), { ...exposure, reason,
    state: exposure.residualShares > 1e-8 ? "unhedged" : exposure.cost > 0 ? "matched_unsettled" : "flat" });
  if (live && exposure.cost > 0) {
    engine.session.haltNew = true;
    throw new Error("live inventory remains unsettled; refusing next market until official settlement and account reconciliation");
  }
}

export async function applyEvents(
  events: MakerEvent[],
  executor: Executor,
  engine: Engine,
  mkt: Market,
  journal: Journal,
  ts: number,
  live: boolean,
  user?: UserFeedControl,
  canSubmit?: () => boolean,
  triggerReceivedAtMonoMs?: number,
): Promise<void> {
  for (const ev of events) {
    switch (ev.kind) {
      case "quote": {
        if (live && !canSubmit?.()) {
          throw new Error("live feeds became unhealthy before quote submission");
        }
        const res = await executor.submit(
          ev.side,
          marketToken(mkt, ev.side),
          ev.price,
          ev.shares,
        );
        if (res.orderId) user?.registerOrder(res.orderId, res.tradeIds);
        if (live && res.ok) {
          recordLatency(journal,mkt,"order_sign",res.signLatencyMs,true,res.orderId);
          recordLatency(journal,mkt,"order_ack",res.ackLatencyMs,true,res.orderId);
          recordLatency(journal,mkt,"reaction",triggerReceivedAtMonoMs == null ? undefined
            : performance.now() - triggerReceivedAtMonoMs,true,res.orderId);
          journal.log("order_ack",mkt,ts,{order_id:res.orderId,side:Side.asStr(ev.side),price:res.price,shares:res.size});
        }
        if (!res.ok) {
          if (live) console.warn(`quote submit failed ${Side.asStr(ev.side)} — clearing pending`);
          else console.info(`paper quote skipped ${Side.asStr(ev.side)} — configured limit reached`);
          engine.onOrderCancelled(ev.side);
        } else {
          engine.resizePendingQuote(ev.side, res.size, res.price);
          journal.logEvent({ ...ev, price: res.price, shares: res.size }, mkt, ts);
        }
        break;
      }

      case "taker": {

        if (live && !canSubmit?.()) {
          throw new Error("live feeds became unhealthy before hedge submission");
        }

        const res = await executor.submitTaker(

          ev.side,

          marketToken(mkt, ev.side),

          ev.price,

          ev.shares,

        );
        if (res.orderId) user?.registerOrder(res.orderId, res.tradeIds);
        if (live && res.ok) {
          recordLatency(journal,mkt,"order_sign",res.signLatencyMs,true,res.orderId);
          recordLatency(journal,mkt,"order_ack",res.ackLatencyMs,true,res.orderId);
          recordLatency(journal,mkt,"reaction",triggerReceivedAtMonoMs == null ? undefined
            : performance.now() - triggerReceivedAtMonoMs,true,res.orderId);
          journal.log("order_ack",mkt,ts,{order_id:res.orderId,side:Side.asStr(ev.side),price:res.price,shares:res.size});
        }

        if (!res.ok) {

          if (live) console.warn(`taker submit failed ${Side.asStr(ev.side)}`);
          else console.info(`paper taker skipped ${Side.asStr(ev.side)} — configured limit reached`);

        } else {

          journal.logEvent({ ...ev, price: res.price, shares: res.size }, mkt, ts);

        }

        break;

      }

      case "fill":

        journal.logEvent(ev, mkt, ts);

        if (!live) {

          executor.noteFill(ev.side);

        }

        break;

      case "cancel": {
        const cancelStarted = performance.now();
        const cancelledOrderId = executor.restingId(ev.side);
        journal.logEvent(ev, mkt, ts);

        await executor.cancelSide(ev.side);
        if (live) {
          engine.onOrderCancelled(ev.side);
          if (cancelledOrderId) {
            recordLatency(journal,mkt,"cancel_ack",performance.now()-cancelStarted,true,cancelledOrderId);
            journal.log("cancel_ack",mkt,ts,{order_id:cancelledOrderId,side:Side.asStr(ev.side)});
          }
        }
        break;
      }

    }

  }

}



export async function handleUserEvent(

  engine: Engine,

  executor: Executor,

  mkt: Market,

  journal: Journal,

  ts: number,

  event: Extract<FeedEvent, { kind: "user" }>["event"],
  journaledFills: Set<string> = new Set(),

): Promise<void> {

  switch (event.kind) {

    case "exchangeFill": {
      if (!event.tradeId || !event.orderId) throw new Error("fill identity is incomplete; account reconciliation required");
      const eventId = JSON.stringify([event.tradeId, event.orderId, event.fill.side]);
      if (journaledFills.has(eventId)) return;

      const pendingFillShares = event.orderId != null &&
        executor.restingId(event.fill.side) === event.orderId ? event.fill.shares : 0;
      const fillEv = engine.confirmExchangeFill(event.fill, pendingFillShares);

      executor.noteFill(event.fill.side, event.orderId, event.fill.shares);

      if (fillEv.kind !== "fill") throw new Error("exchange fill did not produce a fill journal record");
      journal.log("fill", mkt, ts, {
        event_id: eventId,
        trade_id: event.tradeId,
        order_id: event.orderId,
        side: Side.asStr(fillEv.side),
        price: r4(fillEv.price),
        shares: r2(fillEv.shares),
        is_maker: fillEv.isMaker,
        fee: r4(fillEv.fee),
      });
      journaledFills.add(eventId);
      recordLatency(journal,mkt,"fill_report",event.reportLatencyMs,executor.live,event.orderId);

      journal.log("exchange_fill", mkt, ts, {

        side: Side.asStr(event.fill.side),

        price: r4(event.fill.price),

        shares: r2(event.fill.shares),

        is_maker: event.fill.isMaker,

        order_id: event.orderId ?? null,

        trade_id: event.tradeId ?? null,

      });

      console.info(

        `EXCHANGE FILL ${Side.asStr(event.fill.side)} ${event.fill.shares.toFixed(2)}@${event.fill.price.toFixed(4)} maker=${event.fill.isMaker}`,

      );

      break;

    }

    case "orderCancelled": {

      const cancelledSide = executor.onOrderCancelled(event.orderId, event.side);
      if (cancelledSide != null) engine.onOrderCancelled(cancelledSide);

      journal.log("exchange_cancel", mkt, ts, {

        order_id: event.orderId,

        side: event.side != null ? Side.asStr(event.side) : null,

      });

      break;

    }

  }

}



export async function finalizeMarketAccount(
  executor: Executor, engine: Engine, market: Market, user: UserFeedControl,
  journalFinalFill?: (event: Extract<FeedEvent, { kind: "user" }>["event"]) => Promise<void>,
  journaledFillIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  await executor.pauseSubmissions();
  await executor.cancelAll();
  let emptyReads = 0;
  for (let attempt = 0; attempt < 3 && emptyReads < 2; attempt += 1) {
    const orders = await executor.getOpenOrders(market.conditionId);
    if (orders.length === 0) emptyReads += 1;
    else { emptyReads = 0; await executor.cancelAll(); }
    if (emptyReads < 2) await sleep(250);
  }
  if (emptyReads < 2) throw new Error("market stop could not confirm all orders cancelled");
  // Keep the authenticated feed alive while settlement-time fills are read.
  const snapshot = await user.reconcileRecentTrades(market.start - 5);
  if (!user.isHealthy()) throw new Error("user feed unhealthy during final account reconciliation");
  const recovered = snapshot.filter(event => {
    if (event.kind !== "exchangeFill") return false;
    if (!event.orderId || !event.tradeId) throw new Error("final trade snapshot has incomplete fill identity");
    return executor.isOurOrder(event.orderId);
  });
  const recoveredIds = new Set(recovered.flatMap(event => event.kind === "exchangeFill"
    ? [JSON.stringify([event.tradeId, event.orderId, event.fill.side])] : []));
  if ([...journaledFillIds].some(id => !recoveredIds.has(id))) {
    throw new Error("final trade snapshot omits previously journaled fills; account remains unreconciled");
  }
  for (const event of recovered) await journalFinalFill?.(event);
  engine.replaceCurrentMarketFills(recovered.flatMap(event => event.kind === "exchangeFill" ? [event.fill] : []));
  engine.onOrderCancelled();
  executor.confirmAccountReconciled();
}

async function runOneMarket(

  mkt: Market,

  engine: Engine,

  executor: Executor,

  journal: Journal,

  queue: FeedQueue,

  cfg: RunConfig,

  stopAt?: number,
  shouldStop: () => boolean = () => false,

): Promise<void> {
  // Previous-market fills/status notices must never enter the next market.
  while (queue.tryPop() != null) { /* drained after old feeds have stopped */ }
  executor.resumeSubmissions();

  // A duration limit may interrupt a market before its official end. Do not
  // resolve from a partial book/oracle snapshot, or the dashboard shows fake PnL.
  const deadline = Math.min(mkt.end + 3, stopAt ?? Number.POSITIVE_INFINITY);

  const pm = runPolymarketFeed(

    (ev) => queue.push(ev),

    mkt.upToken,

    mkt.downToken,

    deadline,

  );

  const pushFallback = (ev: FeedEvent) => {
    if (!pm.isHealthy()) queue.push(ev);
  };

  // Live orders only use the primary websocket. REST fallbacks are useful for
  // paper observation but are too stale to drive real orders.
  const poll = !cfg.live ? runClobPollFeed(

    pushFallback,

    mkt.upToken,

    mkt.downToken,

    deadline,

    cfg.bookPollHz,

  ) : undefined;

  const collector = !cfg.live
    ? runCollectorBookFeed(pushFallback, mkt.upToken, mkt.downToken, deadline, Math.max(cfg.bookPollHz, 2))
    : undefined;



  const creds = cfg.live ? executor.apiCreds() : undefined;

  const user =

    cfg.live && creds

      ? runUserFeed(

          (ev) => queue.push(ev),

          {

            creds,

            conditionId: mkt.conditionId,

            upToken: mkt.upToken,

            downToken: mkt.downToken,

            isOurOrder: (id) => executor.isOurOrder(id),
            fetchTrades: (ids) => executor.getTradesByIds(ids),
            fetchRecentTrades: (afterUnix) =>
              executor.getRecentTrades(mkt.conditionId, afterUnix),
            accountAddress: executor.accountAddress(),

          },

          deadline,

        )

      : undefined;



  let latest: BookSnapshot | undefined;
  const journaledFills = new Set<string>();
  let lastDecisionRejection: string | undefined;

  let lastTrig: number | undefined;

  let strike: number | undefined;

  let latestOracle: number | undefined;

  const attemptResidualExit = async (reason: string) => {
    if (!cfg.live || !latest) return;
    const exposure = engine.session.exposure();
    if (exposure.residualShares <= 1e-8 || exposure.residualSide == null) return;
    const side = exposure.residualSide;
    const token = side === Side.Up ? mkt.upToken : mkt.downToken;
    const bid = side === Side.Up ? latest.upBid : latest.downBid;
    if (bid == null || !Number.isFinite(bid) || bid <= 0 || bid >= 1) {
      journal.log("exit_unavailable", mkt, nowUnix(), { reason, ...exposure });
      return;
    }
    try {
      const result = await executor.submitExit(side, token, bid, exposure.residualShares);
      journal.log(result.ok ? "exit_submitted" : "exit_rejected", mkt, nowUnix(), {
        reason, side: Side.asStr(side), price: result.price, shares: result.size,
        notional: result.notional, order_id: result.orderId ?? null,
      });
    } catch (error) {
      journal.log("exit_unknown", mkt, nowUnix(), { reason, ...exposure,
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };



  const decideAndApply = async (ts: number, b: BookSnapshot) => {

    if (cfg.live && !liveBookIsFresh(b)) return;
    if (cfg.live && (!user?.isHealthy() || !pm.isHealthy(5_000))) return;

    const decisionStarted = performance.now();
    const ev = engine.onBook(

      ts,

      b.upBid,

      b.upAsk,

      b.downBid,

      b.downAsk,

      {
        upBidSize: b.upBidSz,
        downBidSize: b.downBidSz,
        upBidLevels: b.upBidLevels?.map(([price, size]) => ({ price, size })),
        downBidLevels: b.downBidLevels?.map(([price, size]) => ({ price, size })),
        upSellTradeRateSharesPerSec: b.upSellTradeRate,
        downSellTradeRateSharesPerSec: b.downSellTradeRate,
        upTickSize: executor.knownTickSize(mkt.upToken),
        downTickSize: executor.knownTickSize(mkt.downToken),
      },

    );

    recordLatency(journal,mkt,"strategy_decision",performance.now() - decisionStarted,cfg.live);
    const rejection = engine.session.lastDecisionRejection();
    const rejectionKey = rejection ? JSON.stringify(rejection) : undefined;
    if (rejectionKey !== lastDecisionRejection) {
      lastDecisionRejection = rejectionKey;
      if (rejection) journal.log("decision_rejected", mkt, ts, { ...rejection,
        side: rejection.side != null ? Side.asStr(rejection.side) : null });
    }

    // Health can change while the strategy computes. Never submit a real
    // order unless both authenticated events and both book sides are fresh.
    if (cfg.live && (!user?.isHealthy() || !pm.isHealthy(5_000))) return;
    await applyEvents(
      ev,
      executor,
      engine,
      mkt,
      journal,
      ts,
      cfg.live,
      user,
      () => Boolean(
        liveBookIsFresh(b) && user?.isHealthy() && pm.isHealthy(5_000),
      ),
      b.receivedAtMonoMs,
    );

  };



  let nextHb = Date.now() + cfg.heartbeatMs;
  let reachedMarketEnd = false;



  try {
    if (cfg.live) {
      if (!user) throw new Error("live mode requires the authenticated user websocket");
      await user.waitUntilReady(10_000);
      if (!user.isHealthy()) throw new Error("authenticated user websocket is not healthy");
      const bookReadyDeadline = Date.now() + 10_000;
      while (!pm.isHealthy(5_000) && Date.now() < bookReadyDeadline) {
        await sleep(25);
      }
      if (!pm.isHealthy(5_000)) throw new Error("polymarket book websocket is not ready");
      console.info("authenticated order/fill feed ready — live decisions enabled");
    }

  while (nowUnix() < deadline && !shouldStop()) {

    if (cfg.live && !user?.isHealthy()) {
      console.error("authenticated order/fill feed stale — cancelling and stopping");
      await executor.cancelAll();
      throw new Error("authenticated order/fill feed is not healthy");
    }

    if (cfg.live && !pm.isHealthy(5_000)) {
      console.error("polymarket book feed stale or disconnected — cancelling and stopping");
      await executor.cancelAll();
      throw new Error("polymarket book feed is not healthy");
    }

    const waitMs = Math.max(1, Math.min(nextHb - Date.now(), 250));

    const msg = await queue.pop(waitMs);



    if (Date.now() >= nextHb) {

      if (latest) await decideAndApply(nowUnix(), latest);

      nextHb = Date.now() + cfg.heartbeatMs;

    }



    if (!msg) continue;



    switch (msg.kind) {

      case "btc":

        engine.onBtc(msg.tsUnix, msg.price);

        if (latest && bookIsComplete(latest)) {

          const movedBps = lastTrig != null

            ? (Math.abs(msg.price - lastTrig) / lastTrig) * 1e4

            : Number.POSITIVE_INFINITY;

          if (movedBps >= cfg.btcMoveBps) {

            await decideAndApply(nowUnix(), latest);

            lastTrig = msg.price;

          }

        }

        break;

      case "oracle":

        if (strike == null) strike = msg.price;

        latestOracle = msg.price;

        break;

      case "book":

        if (msg.snapshot.source !== "polymarket-ws" && pm.isHealthy()) break;

        latest = msg.snapshot;
        recordLatency(journal,mkt,"market_age",latest.marketAgeMs,cfg.live);
        recordLatency(journal,mkt,"book_processing",latest.receivedAtMonoMs == null || latest.processedAtMonoMs == null
          ? undefined : latest.processedAtMonoMs - latest.receivedAtMonoMs,cfg.live);

        await decideAndApply(msg.snapshot.tsUnix, msg.snapshot);

        break;

      case "tickSize":

        executor.updateTickSize(msg.token, msg.tickSize, msg.tsUnix);

        console.info(`CLOB tick size updated …${msg.token.slice(-6)} -> ${msg.tickSize}`);

        break;

      case "marketTrade":
        if (msg.token === mkt.upToken) {
          engine.onMarketTrade(Side.Up, msg.takerSide, msg.shares, msg.tsUnix);
        } else if (msg.token === mkt.downToken) {
          engine.onMarketTrade(Side.Down, msg.takerSide, msg.shares, msg.tsUnix);
        }
        break;

      case "user":

        await handleUserEvent(

          engine,

          executor,

          mkt,

          journal,

          nowUnix(),

          msg.event,
          journaledFills,

        );

        break;

      case "userStatus":
        if (cfg.live && !msg.healthy) {
          console.error("authenticated order/fill feed dropped — cancelling and stopping");
          await executor.cancelAll();
          throw new Error("authenticated order/fill feed disconnected");
        }
        break;

      case "bookStatus":
        if (cfg.live && !msg.healthy) {
          console.error("Polymarket order book feed dropped — cancelling and stopping");
          await executor.cancelAll();
          throw new Error("Polymarket order book feed disconnected");
        }
        break;

      case "venue":

        break;

    }

  }
    reachedMarketEnd = nowUnix() >= mkt.end;
    if (cfg.live && user) {
      if (!reachedMarketEnd) await attemptResidualExit("duration_stop");
      await finalizeMarketAccount(executor, engine, mkt, user,
      event => handleUserEvent(engine, executor, mkt, journal, event.kind === "exchangeFill" ? event.fill.tsUnix : nowUnix(), event, journaledFills), journaledFills);
    } else await executor.cancelAll();
  } catch (error) {
    await executor.pauseSubmissions();
    if (cfg.live && user && !(error instanceof UnknownOrderStateError)) {
      try {
        await finalizeMarketAccount(executor,engine,mkt,user,
          event => handleUserEvent(engine,executor,mkt,journal,nowUnix(),event,journaledFills),journaledFills);
        journal.log("account_reconciled",mkt,nowUnix(),{reason:"run_failed",...engine.session.exposure()});
      } catch (reconcileError) {
        journal.log("account_unreconciled",mkt,nowUnix(),{reason:"run_failed",...engine.session.exposure(),
          detail:reconcileError instanceof Error ? reconcileError.message : String(reconcileError)});
      }
    }
    if (cfg.live && error instanceof UnknownOrderStateError && user) {
      console.error("order ACK state unknown — freezing submissions and reconciling account");
      let cancelFailure: unknown;
      try {
        await executor.cancelAll();
      } catch (cancelError) {
        cancelFailure = cancelError;
      }
      const recovered = await user.reconcileRecentTrades(mkt.start - 5);
      const recoveredFills = recovered.flatMap((event) =>
        event.kind === "exchangeFill" ? [event.fill] : [],
      );
      engine.replaceCurrentMarketFills(recoveredFills);
      journal.log("account_reconciled", mkt, nowUnix(), {
        reason: "order_ack_state_unknown",
        fills: recoveredFills.length,
        submitted_at: error.submittedAtUnix,
        order_kind: error.context.kind,
        side: Side.asStr(error.context.side),
        notional: r2(error.context.notional),
      });
      let consecutiveEmpty = 0;
      let openOrders: unknown[] = [];
      for (let attempt = 0; attempt < 3 && consecutiveEmpty < 2; attempt += 1) {
        openOrders = await executor.getOpenOrders(mkt.conditionId);
        if (openOrders.length === 0) consecutiveEmpty += 1;
        else {
          consecutiveEmpty = 0;
          await executor.cancelAll();
        }
        if (consecutiveEmpty < 2) await sleep(250);
      }
      if (consecutiveEmpty < 2) {
        throw new Error(
          `unknown order state: ${openOrders.length} open order(s) remain after cancel-all`,
          { cause: cancelFailure ?? error },
        );
      }
      if (!user.isHealthy()) {
        throw new Error("user websocket became unhealthy during account reconciliation", {
          cause: error,
        });
      }
      console.error(
        `unknown order state reconciled (${recoveredFills.length} fill(s)); run remains stopped`,
      );
    }
    throw error;
  } finally {
    pm.stop();
    poll?.stop();
    collector?.stop();
    user?.stop();
  }



  if (!reachedMarketEnd) {
    recordResidualExposure(engine,journal,mkt,"duration_stop",cfg.live);
    journal.log("stopped", mkt, undefined, {
      reason: "运行时间到达，市场尚未结束，未结算",
      fills: engine.fills(),
    });
    console.info(
      `STOPPED ${mkt.slug} before resolution; fills=${engine.fills()} — PnL left unsettled`,
    );
    return;
  }

  // A book price is not the official outcome. Without an oracle/strike,
  // leave the market unsettled instead of turning a guess into PnL.
  if (strike == null || latestOracle == null) {
    recordResidualExposure(engine,journal,mkt,"oracle_unavailable",cfg.live);
    journal.log("unresolved", mkt, undefined, {
      reason: "没有官方结算价，保留未结算",
      winner_src: "unavailable",
      fills: engine.fills(),
    });
    console.info(
      `UNRESOLVED ${mkt.slug}; no official oracle result, fills=${engine.fills()}`,
    );
    return;
  }

  // A sampled BTC price is only a paper estimate, never official settlement.
  if (cfg.live) {
    recordResidualExposure(engine,journal,mkt,"official_settlement_required",true);
    return;
  }
  const winner = latestOracle >= strike ? Side.Up : Side.Down;



  const r = engine.resolve(winner);

  journal.log("resolved", mkt, undefined, {

    winner: Side.asStr(winner),

    winner_src: strike != null && latestOracle != null ? "oracle" : "book",

    oracle_strike: strike ?? null,

    oracle_last: latestOracle ?? null,

    pnl: r2(r.pnl),

    fees: r2(r.fees),

    up_shares: r2(r.upShares),

    down_shares: r2(r.downShares),

    cost: r2(r.cost),

    fills: r.fills,

    pair_cost: r4(r.pairCost),

    matched_pair_over_1: r.matchedPairOver1,

    daily_halted: r.dailyHalted,

  });

  console.info(

    `RESOLVED ${mkt.slug} winner=${Side.asStr(winner)} pnl=${r.pnl.toFixed(2)} fills=${r.fills} pair_cost=${r.pairCost.toFixed(4)} halted=${r.dailyHalted}`,

  );

}



/** Top-level entry for live run loop. */

export async function run(cfg: RunConfig): Promise<void> {
  try {
    const healthMs = await assertOfficialClobHealth();
    console.info(`official CLOB health ${healthMs.toFixed(1)}ms`);
  } catch (error) {
    if (cfg.live) throw error;
    console.warn(
      `paper mode: official CLOB health unavailable (${error instanceof Error ? error.message : String(error)}); continuing with collector/Polymarket feeds`,
    );
  }

  const sessionId = String(Math.floor(nowUnix()));

  const journal = Journal.open(cfg.logPath, sessionId);

  const engine = new Engine({ ...cfg.engine, liveMode: cfg.live });



  console.info(

    `RUN ${cfg.live ? "LIVE ⚠ REAL MONEY" : "PAPER"} | preset=${engine.preset} | caps $${cfg.orderUsd}/order, ${cfg.maxOrders} orders | log ${cfg.logPath}`,

  );



  let executor: Executor | undefined;
  let stopping = false;
  const gracefulStop = () => {
    if (stopping) return;
    stopping = true;
    console.warn("stop requested — pausing submissions, then cancelling and reconciling account");
    void executor?.pauseSubmissions();
  };
  const onSigint = () => void gracefulStop();
  const onSigterm = () => void gracefulStop();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  if (cfg.live) {
    const key = ownerSignerPrivateKey();
    if (!key) {
      throw new Error(
        "实盘已拒绝：未配置 Owner 签名私钥。Session Key 是可选的 Beta 委托方案，不是必需项",
      );
    }
    if (cfg.preflight !== false) {
      console.info("running wallet preflight…");
      await preflight(undefined, { strict: true });
    }
    executor = await Executor.newLive(
      cfg.orderUsd,
      cfg.maxOrders,
      cfg.maxTotalUsd,
      key,
    );

  } else {

    executor = new Executor(

      false,

      cfg.orderUsd,

      cfg.maxOrders,

      cfg.maxTotalUsd,

    );

  }



  const queue = new FeedQueue();

  const push = (ev: FeedEvent) => queue.push(ev);

  const btc = runBtcFeed(push);

  const oracle = cfg.oracle ? runRtdsFeed(push) : undefined;



  const stopAt =

    cfg.durationMin > 0 ? nowUnix() + cfg.durationMin * 60 : undefined;



  try {

    while (true) {
      if (stopping) return;

      if (stopAt != null && nowUnix() >= stopAt) {
        await executor.shutdown();
        console.info(`duration (${cfg.durationMin.toFixed(1)} min) reached — stopping`);
        return;
      }

      const mkt = await findMarket(nowUnix(), !cfg.live);
      if (!mkt) {
        console.warn("no live btc-updown-5m market found; retry in 5s");
        await sleep(5000);
        continue;
      }

      const remaining = mkt.end - Math.floor(nowUnix());
      const minRemaining = cfg.live ? MIN_WINDOW_REMAINING_SEC : PAPER_MIN_WINDOW_REMAINING_SEC;
      if (remaining < minRemaining) {
        console.warn(
          `only ${remaining}s left in ${mkt.slug} — waiting for next 5m window`,
        );
        await sleep(Math.max(1000, (remaining + 3) * 1000));
        continue;
      }

      engine.reset(mkt.start, mkt.end);

      try {
        await executor.prepareMarket(mkt.conditionId, [mkt.upToken, mkt.downToken]);
      } catch (error) {
        console.error(`CLOB market warmup failed; skipping ${mkt.slug}: ${error}`);
        await sleep(Math.max(1000, (remaining + 3) * 1000));
        continue;
      }

      journal.log("reset", mkt, mkt.start, {});

      console.info(

        `LIVE MARKET ${mkt.slug} window ${mkt.end - Math.floor(nowUnix())}s left`,

      );



      if (stopping) return;
      await runOneMarket(mkt, engine, executor, journal, queue, cfg, stopAt, () => stopping);

      recordTraded(cfg.tradedPath, mkt.conditionId);



      if (engine.session.dailyHalted()) {
        console.warn("daily/session circuit breaker tripped — stopping run loop");
        await executor.shutdown();
        return;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    btc.stop();
    oracle?.stop();
    if (executor) {
      await executor.shutdown().catch(() => executor!.cancelAll());
    }
  }
}

