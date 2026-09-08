import type { MakerEvent } from "../live-maker.js";

import { Side } from "../models.js";

import { Engine, type EngineConfig } from "./engine.js";

import { Executor, UnknownOrderStateError } from "./executor.js";

import { findMarket, marketToken, type Market } from "./discovery.js";

import { runBtcFeed } from "./feeds/btc.js";

import { runClobPollFeed } from "./feeds/clob-poll.js";

import { runPolymarketFeed } from "./feeds/polymarket.js";

import { runRtdsFeed } from "./feeds/rtds.js";
import { runTokyoBookFeed } from "./feeds/tokyo.js";

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



async function applyEvents(
  events: MakerEvent[],
  executor: Executor,
  engine: Engine,
  mkt: Market,
  journal: Journal,
  ts: number,
  live: boolean,
  user?: UserFeedControl,
  canSubmit?: () => boolean,
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

      case "cancel":

        journal.logEvent(ev, mkt, ts);

        await executor.cancelSide(ev.side);

        break;

    }

  }

}



async function handleUserEvent(

  engine: Engine,

  executor: Executor,

  mkt: Market,

  journal: Journal,

  ts: number,

  event: Extract<FeedEvent, { kind: "user" }>["event"],

): Promise<void> {

  switch (event.kind) {

    case "exchangeFill": {

      const fillEv = engine.confirmExchangeFill(event.fill);

      executor.noteFill(event.fill.side, event.orderId, event.fill.shares);

      journal.logEvent(fillEv, mkt, ts);

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

      executor.onOrderCancelled(event.orderId, event.side);

      engine.onOrderCancelled(event.side);

      journal.log("exchange_cancel", mkt, ts, {

        order_id: event.orderId,

        side: event.side != null ? Side.asStr(event.side) : null,

      });

      break;

    }

  }

}



async function runOneMarket(

  mkt: Market,

  engine: Engine,

  executor: Executor,

  journal: Journal,

  queue: FeedQueue,

  cfg: RunConfig,

  stopAt?: number,

): Promise<void> {

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

  const tokyo = !cfg.live
    ? runTokyoBookFeed(pushFallback, mkt.upToken, mkt.downToken, deadline, Math.max(cfg.bookPollHz, 2))
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

  let lastTrig: number | undefined;

  let strike: number | undefined;

  let latestOracle: number | undefined;



  const decideAndApply = async (ts: number, b: BookSnapshot) => {

    if (cfg.live && !liveBookIsFresh(b)) return;
    if (cfg.live && (!user?.isHealthy() || !pm.isHealthy(5_000))) return;

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
        upTickSize: b.tickSize,
        downTickSize: b.tickSize,
      },

    );

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
    );

  };



  let nextHb = Date.now() + cfg.heartbeatMs;



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

  while (nowUnix() < deadline) {

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

        await decideAndApply(msg.snapshot.tsUnix, msg.snapshot);

        break;

      case "tickSize":

        executor.updateTickSize(msg.token, msg.tickSize);

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
  } catch (error) {
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
    tokyo?.stop();
    user?.stop();
  }



  const reachedMarketEnd = nowUnix() >= mkt.end;
  await executor.cancelAll();
  if (!reachedMarketEnd) {
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
      `paper mode: official CLOB health unavailable (${error instanceof Error ? error.message : String(error)}); continuing with Tokyo/Polymarket feeds`,
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
  const gracefulStop = async () => {
    if (stopping) return;
    stopping = true;
    console.warn("stop requested — cancelling open orders");
    try {
      await executor?.shutdown();
      console.info("open orders cancelled — stopping");
      process.exitCode = 0;
    } catch (error) {
      console.error("cancel-all failed during stop", error);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
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
        await executor.prepareMarket(mkt.conditionId);
      } catch (error) {
        console.error(`CLOB market warmup failed; skipping ${mkt.slug}: ${error}`);
        await sleep(Math.max(1000, (remaining + 3) * 1000));
        continue;
      }

      journal.log("reset", mkt, mkt.start, {});

      console.info(

        `LIVE MARKET ${mkt.slug} window ${mkt.end - Math.floor(nowUnix())}s left`,

      );



      await runOneMarket(mkt, engine, executor, journal, queue, cfg, stopAt);

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

