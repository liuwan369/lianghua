import "dotenv/config";
import { AssetType } from "@polymarket/clob-client-v2";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ClobWrapper, tickRoundDown } from "../src/live/clob/client.js";
import { findMarket } from "../src/live/discovery.js";
import { runUserFeed, type UserFeedEvent } from "../src/live/feeds/user.js";
import { nowUnix, sleep } from "../src/live/feeds/index.js";

type Profile = Record<string, string>;
type ProbeMode = "cancel" | "calibration";

function loadProfile(): Profile {
  const path = process.env.PM_ACCOUNT_PROFILE ?? "/root/.config/pm-system/account.json";
  const profile = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("account profile invalid");
  return profile as Profile;
}

function setProfileEnv(): void {
  const profile = loadProfile();
  for (const [name, value] of Object.entries(profile)) if (typeof value === "string" && value) process.env[name] = value;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envNumber(name: string, fallback: number): number {
  const value = number(process.env[name]);
  return value == null ? fallback : value;
}

function beijingDay(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporary, path);
}

function staleLock(path: string): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    const pid = number(value?.pid);
    if (pid != null && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }
    return Date.now() - statSync(path).mtimeMs > 6 * 60 * 60 * 1000;
  } catch {
    try { return Date.now() - statSync(path).mtimeMs > 6 * 60 * 60 * 1000; } catch { return false; }
  }
}

function acquireCalibrationGuard(): { release: () => void; reserve: (notional: number) => void } | undefined {
  if (process.env.PM_PROBE_MODE !== "calibration") return undefined;
  const stateDir = process.env.PM_PROBE_STATE_DIR ?? join(process.cwd(), "results", "live-calibration");
  const lockPath = process.env.PM_PROBE_LOCK_FILE ?? join(stateDir, "probe.lock");
  const budgetPath = process.env.PM_PROBE_BUDGET_FILE ?? join(stateDir, "budget.json");
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2 && fd == null; attempt += 1) {
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), "utf8");
    } catch {
      if (existsSync(lockPath) && staleLock(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* retry below */ }
        continue;
      }
      if (existsSync(lockPath)) throw new Error(`calibration probe already running: ${lockPath}`);
      throw new Error(`unable to acquire calibration lock: ${lockPath}`);
    }
  }
  if (fd == null) throw new Error(`unable to acquire calibration lock: ${lockPath}`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* another cleanup may have removed it */ }
  };
  return {
    release,
    reserve: (notional: number) => {
      const dailyCap = Math.min(5, Math.max(0.5, envNumber("PM_PROBE_DAILY_NOTIONAL_CAP", 5)));
      let state: { day?: string; spent?: number } = {};
      if (existsSync(budgetPath)) {
        try { state = JSON.parse(readFileSync(budgetPath, "utf8")) as { day?: string; spent?: number }; }
        catch { throw new Error(`calibration budget state is invalid: ${budgetPath}`); }
        if (state.day !== beijingDay()) state = {};
        if (state.spent != null && (!Number.isFinite(state.spent) || state.spent < 0)) {
          throw new Error(`calibration budget state is invalid: ${budgetPath}`);
        }
      }
      const spent = Number(state.spent ?? 0);
      if (spent + notional > dailyCap + 1e-9) {
        throw new Error(`calibration daily notional cap reached: spent=$${spent.toFixed(4)} cap=$${dailyCap.toFixed(4)}`);
      }
      atomicWriteJson(budgetPath, { day: beijingDay(), spent: spent + notional });
    },
  };
}

async function fetchPositionSize(wallet: string, conditionId: string, tokenId: string): Promise<number> {
  const limit = 500;
  let offset = 0;
  let total = 0;
  for (let page = 0; page < 100; page += 1) {
    const url = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(wallet)}&sizeThreshold=0&limit=${limit}&offset=${offset}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`position query failed (${response.status})`);
    const payload = await response.json() as unknown;
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data)
      ? (payload as Record<string, unknown>).data as unknown[] : undefined;
    if (!rows) throw new Error("position query returned an incomplete payload");
    total += rows.reduce((sum, raw) => {
      if (!raw || typeof raw !== "object") return sum;
      const row = raw as Record<string, unknown>;
      const asset = String(row.asset ?? row.asset_id ?? "");
      const market = String(row.conditionId ?? row.condition_id ?? "");
      if (asset && asset !== tokenId) return sum;
      if (!asset && market !== conditionId) return sum;
      return sum + Math.max(0, number(row.size) ?? 0);
    }, 0);
    if (rows.length < limit) return total;
    offset += rows.length;
  }
  throw new Error("position query exceeded pagination limit");
}

function cleanOrder(row: unknown): Record<string, unknown> | undefined {
  if (!row || typeof row !== "object") return undefined;
  const source = row as Record<string, unknown>;
  const keys = ["id", "status", "size", "size_matched", "price", "side", "asset_id", "created_at", "timestamp"];
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] != null) out[key] = source[key];
  return Object.keys(out).length > 0 ? out : undefined;
}

function cleanTrade(row: unknown): Record<string, unknown> | undefined {
  if (!row || typeof row !== "object") return undefined;
  const source = row as Record<string, unknown>;
  const keys = [
    "id", "status", "market", "asset_id", "side", "trader_side", "price", "size",
    "fee", "fee_rate_bps", "fee_rate", "match_time", "match_time_nano", "last_update",
    "transaction_hash", "transactionHashes", "taker_order_id",
  ];
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] != null) out[key] = source[key];
  if (Array.isArray(source.maker_orders)) {
    out.maker_orders = source.maker_orders
      .filter((maker): maker is Record<string, unknown> => Boolean(maker && typeof maker === "object"))
      .map((maker) => {
        const clean: Record<string, unknown> = {};
        for (const key of ["order_id", "maker_address", "owner", "asset_id", "side", "price", "matched_amount", "fee_rate_bps", "fee_rate"]) {
          if (maker[key] != null) clean[key] = maker[key];
        }
        return clean;
      });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function orderIdOf(row: unknown): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const id = (row as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

function matchedOf(row: unknown): number {
  if (!row || typeof row !== "object") return 0;
  return number((row as Record<string, unknown>).size_matched) ?? 0;
}

function validTradeStatus(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  return ["MATCHED", "MINED", "CONFIRMED"].includes(String((row as Record<string, unknown>).status ?? "").toUpperCase());
}

function relatedTrade(row: unknown, orderId: string): boolean {
  if (!validTradeStatus(row)) return false;
  const trade = row as Record<string, unknown>;
  if (String(trade.taker_order_id ?? "") === orderId) return true;
  if (!Array.isArray(trade.maker_orders)) return false;
  return trade.maker_orders.some((maker) => maker && typeof maker === "object" &&
    String((maker as Record<string, unknown>).order_id ?? "") === orderId);
}

function matchedTradeShares(row: unknown, orderId: string): number {
  if (!validTradeStatus(row)) return 0;
  const trade = row as Record<string, unknown>;
  if (String(trade.taker_order_id ?? "") === orderId) return Math.max(0, number(trade.size) ?? 0);
  if (!Array.isArray(trade.maker_orders)) return 0;
  return trade.maker_orders.reduce((sum, maker) => {
    if (!maker || typeof maker !== "object") return sum;
    const value = maker as Record<string, unknown>;
    return String(value.order_id ?? "") === orderId ? sum + Math.max(0, number(value.matched_amount) ?? 0) : sum;
  }, 0);
}

function makerPrice(bestBid: number | undefined, bestAsk: number | undefined, tick: number): number | undefined {
  const bid = bestBid ?? tick;
  if (bestAsk != null && bestAsk <= tick) return undefined;
  const maxMaker = bestAsk == null ? bid : tickRoundDown(bestAsk - tick, tick);
  // Prefer one tick inside a visible spread, but never cross the ask. This
  // keeps the calibration order post-only and still gives it a chance to fill.
  const inside = bestAsk == null ? bid : tickRoundDown(Math.max(tick, bid + tick), tick);
  const price = Math.max(tick, Math.min(inside, maxMaker));
  return bestAsk != null && price >= bestAsk ? undefined : price;
}

async function main(): Promise<void> {
  setProfileEnv();
  const key = process.env.POLYMARKET_OWNER_PRIVATE_KEY;
  const wallet = process.env.POLYMARKET_WALLET_ADDRESS;
  if (!key || !wallet) throw new Error("owner signer or wallet is not configured");

  const mode: ProbeMode = process.env.PM_PROBE_MODE === "calibration" ? "calibration" : "cancel";
  const waitMs = Math.max(0, Math.min(180_000, Math.round(envNumber("PM_PROBE_WAIT_MS", mode === "calibration" ? 60_000 : 0))));
  const configuredMaxNotional = envNumber("PM_PROBE_MAX_NOTIONAL", mode === "calibration" ? 0.50 : 30);
  if (mode === "calibration" && configuredMaxNotional > 0.50 + 1e-9) {
    throw new Error("calibration probe hard cap is $0.50 per order; lower PM_PROBE_MAX_NOTIONAL");
  }
  const maxNotional = Math.max(0.05, Math.min(mode === "calibration" ? 0.50 : 30, configuredMaxNotional));
  const pollMs = Math.max(100, Math.min(10_000, Math.round(envNumber("PM_PROBE_POLL_MS", 250))));
  const requestedToken = String(process.env.PM_PROBE_TOKEN ?? "").toLowerCase();
  const calibrationGuard = acquireCalibrationGuard();
  if (calibrationGuard) process.once("exit", calibrationGuard.release);

  // Live probe must use the official Gamma market source directly. The local
  // collector is an optional paper-mode fallback and may not run on this host.
  const market = await findMarket(nowUnix(), false);
  if (!market) throw new Error("no current btc-updown-5m market");
  const remainingMarketSec = market.end - nowUnix();
  if (remainingMarketSec < waitMs / 1000 + 35) {
    throw new Error(`current market expires too soon for calibration (${Math.max(0, Math.round(remainingMarketSec))}s remaining)`);
  }

  const clob = await ClobWrapper.connect({ key, funder: wallet as `0x${string}` });
  if (clob.funder.toLowerCase() !== wallet.toLowerCase()) throw new Error("resolved funder does not match configured wallet");
  const initialOpenOrders = await clob.getOpenOrders(market.conditionId);
  if (initialOpenOrders.length > 0) throw new Error("refusing probe while the target market already has open orders");
  let sweepQueryFailed = false;
  const sweepUntrackedOrders = async (): Promise<unknown[]> => {
    let rows: unknown[];
    try { rows = await clob.getOpenOrders(market.conditionId); } catch { sweepQueryFailed = true; return []; }
    for (const row of rows) {
      const id = orderIdOf(row);
      if (!id) continue;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await clob.cancel(id).catch(() => undefined);
        try { rows = await clob.getOpenOrders(market.conditionId); } catch { sweepQueryFailed = true; break; }
        if (!rows.some((candidate) => orderIdOf(candidate) === id)) break;
        await sleep(500);
      }
    }
    return rows;
  };
  const initialBalance = await clob.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const events: UserFeedEvent[] = [];
  const seenEventKeys = new Map<string, number>();
  let orderId: string | undefined;
  let exitOrderId: string | undefined;
  let orderWsEventAtMonoMs: number | undefined;
  let orderWsPlacementAtMonoMs: number | undefined;
  let orderWsUpdateAtMonoMs: number | undefined;
  let cancelWsEventAtMonoMs: number | undefined;
  let ackReturnedAtMonoMs: number | undefined;
  const fillReceivedAtMonoMs = new Map<string, number>();
  const appendEvent = (event: UserFeedEvent, receivedViaWebSocket = false): void => {
    const receivedAtMonoMs = performance.now();
    if (event.kind === "orderCancelled" && event.orderId === orderId) {
      cancelWsEventAtMonoMs ??= receivedAtMonoMs;
    }
    if (receivedViaWebSocket && event.kind === "exchangeFill" && event.orderId === orderId) {
      const key = `${event.tradeId ?? `${event.orderId ?? ""}:${event.fill.tsUnix}:${event.fill.price}`}`;
      fillReceivedAtMonoMs.set(key, receivedAtMonoMs);
    }
    // A trade can be reported more than once as its status advances. Keep
    // one row per trade/order and retain the largest cumulative quantity.
    const key = event.kind === "exchangeFill"
      ? `fill:${event.tradeId ?? `${event.orderId ?? ""}:${event.fill.tsUnix}:${event.fill.price}`}:${event.orderId ?? ""}`
      : `cancel:${event.orderId}`;
    const previousIndex = seenEventKeys.get(key);
    if (previousIndex != null) {
      const previous = events[previousIndex];
      if (event.kind === "exchangeFill" && previous?.kind === "exchangeFill" &&
        event.fill.shares > previous.fill.shares) events[previousIndex] = event;
      return;
    }
    seenEventKeys.set(key, events.length);
    events.push(event);
  };
  let exitSubmittedAt: number | undefined;
  const submittedAt = nowUnix();
  const deadline = submittedAt + Math.ceil((waitMs + 30_000) / 1000);
  const user = runUserFeed((event) => {
    if (event.kind === "user") appendEvent(event.event, true);
  }, {
    creds: clob.creds,
    conditionId: market.conditionId,
    upToken: market.upToken,
    downToken: market.downToken,
    accountAddress: clob.funder,
    isOurOrder: (id) => id === orderId || id === exitOrderId,
    onOrderEvent: (event) => {
      if (event.orderId !== orderId) return;
      orderWsEventAtMonoMs ??= event.receivedAtMonoMs;
      if (event.type === "PLACEMENT") orderWsPlacementAtMonoMs ??= event.receivedAtMonoMs;
      if (event.type === "UPDATE") orderWsUpdateAtMonoMs ??= event.receivedAtMonoMs;
    },
    fetchRecentTrades: (afterUnix) => clob.getRecentTrades(market.conditionId, afterUnix),
    fetchOpenOrders: () => clob.getOpenOrders(market.conditionId),
    verifyAuthenticated: async () => {
      await clob.getOpenOrders(market.conditionId);
      return true;
    },
    fetchTrades: (ids) => clob.getTradesByIds(ids),
  }, deadline);

  const openSnapshots: Array<{ at: number; order?: Record<string, unknown> }> = [];
  const bookSnapshots: Array<{ at: number; bid?: number; ask?: number }> = [];
  const relatedTrades = new Map<string, unknown>();
  const observationErrors = new Set<string>();
  const addObservationError = (kind: string, error?: unknown): void => {
    const detail = error instanceof Error ? error.message : error == null ? "unknown" : String(error);
    observationErrors.add(`${kind}: ${detail}`);
  };
  let firstVisibleAt: number | undefined;
  let firstVisibleAtMonoMs: number | undefined;
  let cancelRequestedAt: number | undefined;
  let cancelAckAt: number | undefined;
  let cancelAck = false;
  let userFeedReady = false;
  let stillOpen = false;
  let restOrderMatched = false;
  let finalBalance: { balance?: unknown } = {};
  let positionBefore = 0;
  let positionAfter = 0;
  let exitAttempt: Record<string, unknown> | undefined;
  let stateUnknownSubmission = false;
  let reconciliationError = false;

  try {
    try {
      await user.waitUntilReady(5_000);
      userFeedReady = true;
    } catch {
      // Some deployments omit a standalone user-channel ACK. A target order
      // event can still prove the authenticated channel after registration.
      console.warn("user feed has no standalone ack; continuing controlled channel challenge");
    }

    const info = await clob.client.getClobMarketInfo(market.conditionId) as { mos?: unknown };
    const minSize = number(info.mos);
    if (!minSize || minSize <= 0) throw new Error("market minimum size unavailable");

    const candidates = requestedToken === "down"
      ? [market.downToken]
      : requestedToken === "up"
        ? [market.upToken]
        : [market.upToken, market.downToken];
    let selected: { tokenId: string; tick: number; price: number; notional: number; bestBid?: number; bestAsk?: number } | undefined;
    for (const tokenId of candidates) {
      const tick = await clob.tickSize(tokenId);
      const book = await clob.client.getOrderBook(tokenId) as {
        bids?: Array<{ price?: unknown }>;
        asks?: Array<{ price?: unknown }>;
      };
      const bestBid = number(book.bids?.[0]?.price);
      const bestAsk = number(book.asks?.[0]?.price);
      const price = makerPrice(bestBid, bestAsk, tick);
      if (price == null) continue;
      const notional = price * minSize;
      if (!Number.isFinite(notional) || notional <= 0 || notional > maxNotional) continue;
      if (!selected || notional < selected.notional) selected = { tokenId, tick, price, notional, bestBid, bestAsk };
    }
    if (!selected) throw new Error(`no maker candidate fits PM_PROBE_MAX_NOTIONAL=$${maxNotional.toFixed(2)} at the current minimum size`);
    if (mode === "calibration") {
      positionBefore = await fetchPositionSize(wallet, market.conditionId, selected.tokenId);
      if (positionBefore > 1e-9) throw new Error(`refusing calibration while target token position already exists: ${positionBefore}`);
    }

    const submittedAtExact = nowUnix();
    const submittedAtMonoMs = performance.now();
    calibrationGuard?.reserve(selected.notional);
    const ack = await clob.submitOrder({ tokenId: selected.tokenId, price: selected.price, size: minSize, tickSize: selected.tick });
    ackReturnedAtMonoMs = performance.now();
    orderId = ack.orderId;
    if (!ack.success || !orderId) {
      stateUnknownSubmission = Boolean(ack.stateUnknown);
      if (stateUnknownSubmission && mode === "calibration") await sweepUntrackedOrders();
      throw new Error(`maker order rejected: ${ack.errorMsg ?? "missing order id"}${ack.stateUnknown ? " (state unknown; target-market sweep attempted)" : ""}`);
    }
    user.registerOrder(orderId, ack.tradeIds);
    try {
      await user.waitUntilReady(5_000);
      userFeedReady = true;
    } catch {
      userFeedReady = false;
    }

    const observeUntil = Date.now() + waitMs;
    while (Date.now() < observeUntil) {
      const [rows, book, trades] = await Promise.all([
        clob.getOpenOrders(market.conditionId).catch((error) => {
          addObservationError("open_orders", error);
          return null;
        }),
        clob.client.getOrderBook(selected.tokenId).catch((error) => {
          addObservationError("order_book", error);
          return undefined;
        }),
        clob.getRecentTrades(market.conditionId, submittedAtExact - 5).catch((error) => {
          addObservationError("recent_trades", error);
          return null;
        }),
      ]);
      if (rows) {
        const row = rows.find((candidate) => orderIdOf(candidate) === orderId);
        if (row && firstVisibleAt == null) {
          firstVisibleAt = nowUnix();
          firstVisibleAtMonoMs = performance.now();
        }
        openSnapshots.push({ at: nowUnix(), order: cleanOrder(row) });
      }
      if (book) {
        const bookValue = book as {
          bids?: Array<{ price?: unknown }>;
          asks?: Array<{ price?: unknown }>;
        };
        bookSnapshots.push({ at: nowUnix(), bid: number(bookValue.bids?.[0]?.price), ask: number(bookValue.asks?.[0]?.price) });
      }
      for (const trade of trades ?? []) {
        if (relatedTrade(trade, orderId)) {
          const tradeId = typeof (trade as Record<string, unknown>).id === "string"
            ? String((trade as Record<string, unknown>).id) : undefined;
          if (tradeId) {
            const previous = relatedTrades.get(tradeId);
            if (!previous || matchedTradeShares(trade, orderId) >= matchedTradeShares(previous, orderId)) relatedTrades.set(tradeId, trade);
          }
          if (matchedTradeShares(trade, orderId) > 0) restOrderMatched = true;
        }
      }
      await sleep(pollMs);
    }

    cancelRequestedAt = nowUnix();
    cancelAck = await clob.cancel(orderId).catch(() => false);
    cancelAckAt = nowUnix();
    const cancelWaitUntil = Date.now() + 10_000;
    while (Date.now() < cancelWaitUntil && !events.some((event) => event.kind === "orderCancelled" && event.orderId === orderId)) {
      await sleep(100);
    }
    try {
      // This also catches a fill that raced with cancellation or arrived while
      // the user feed was reconnecting. It is evidence, not a synthetic fill.
      const reconciled = await user.reconcileRecentTrades(submittedAtExact - 5);
      for (const event of reconciled) {
        if (event.kind === "exchangeFill" && event.orderId !== orderId) continue;
        appendEvent(event);
      }
    } catch (error) {
      reconciliationError = true;
      addObservationError("trade_reconciliation", error);
      console.warn(`post-cancel trade reconciliation incomplete: ${error instanceof Error ? error.message : String(error)}`);
    }
    let openOrders: unknown[] = [];
    let finalOpenQueryFailed = false;
    try { openOrders = await clob.getOpenOrders(market.conditionId); }
    catch (error) { finalOpenQueryFailed = true; addObservationError("final_open_orders", error); }
    for (let attempt = 0; attempt < 3 && openOrders.some((row) => orderIdOf(row) === orderId); attempt += 1) {
      await sleep(500);
      await clob.cancel(orderId).catch(() => undefined);
      try { openOrders = await clob.getOpenOrders(market.conditionId); } catch (error) { finalOpenQueryFailed = true; addObservationError("final_open_orders", error); break; }
    }
    stillOpen = finalOpenQueryFailed || openOrders.some((row) => orderIdOf(row) === orderId);
    try { finalBalance = await clob.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }); }
    catch (error) { addObservationError("final_balance", error); finalBalance = {}; }
    const rawInitialBalance = number(initialBalance.balance);
    const rawFinalBalance = number(finalBalance.balance);
    let balanceDelta = rawInitialBalance != null && rawFinalBalance != null ? rawInitialBalance - rawFinalBalance : Number.NaN;
    let fills = events.filter((event): event is Extract<UserFeedEvent, { kind: "exchangeFill" }> => event.kind === "exchangeFill");
    let relatedTradeRows = [...relatedTrades.values()];
    const fillSharesByTrade = new Map<string, number>();
    for (const event of fills) {
      const key = `${event.tradeId ?? `${event.orderId ?? ""}:${event.fill.tsUnix}:${event.fill.price}`}`;
      fillSharesByTrade.set(key, Math.max(fillSharesByTrade.get(key) ?? 0, event.fill.shares));
    }
    let matchedShares = Math.max(
      [...fillSharesByTrade.values()].reduce((sum, shares) => sum + shares, 0),
      openSnapshots.reduce((max, snapshot) => Math.max(max, matchedOf(snapshot.order)), 0),
      relatedTradeRows.reduce<number>((sum, trade) => sum + matchedTradeShares(trade, orderId ?? ""), 0),
    );
    if (mode === "calibration") {
      try { positionAfter = await fetchPositionSize(wallet, market.conditionId, selected.tokenId); }
      catch (error) { positionAfter = Number.NaN; addObservationError("position_after", error); }
    }
    if (mode === "calibration" && Number.isFinite(positionAfter) && positionAfter > positionBefore + 1e-9) {
      const exitBook = await clob.client.getOrderBook(selected.tokenId).catch((error) => {
        addObservationError("exit_order_book", error);
        return undefined;
      }) as {
        bids?: Array<{ price?: unknown }>;
      } | undefined;
      const exitBid = number(exitBook?.bids?.[0]?.price);
      if (exitBid != null && exitBid > 0) {
        const residual = positionAfter - positionBefore;
        const exitPrice = tickRoundDown(exitBid, selected.tick);
        try { calibrationGuard?.reserve(exitPrice * residual); }
        catch (error) { addObservationError("calibration_budget_exit", error); }
        exitSubmittedAt = nowUnix();
        const exit = await clob.submitMarketSell(selected.tokenId, residual, exitPrice, selected.tick);
        exitOrderId = exit.orderId;
        if (exitOrderId) user.registerOrder(exitOrderId);
        exitAttempt = { success: exit.success, order_id: exit.orderId, status: exit.status, error: exit.errorMsg, latency_ms: exit.latencyMs, shares: residual, price: exitPrice };
        // Data API positions are eventually consistent after a matched exit.
        // Retry a bounded number of times before treating a residual as real.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await sleep(attempt === 0 ? 2_000 : 1_000);
          try {
            positionAfter = await fetchPositionSize(wallet, market.conditionId, selected.tokenId);
            if (positionAfter <= positionBefore + 1e-9) break;
          } catch (error) {
            positionAfter = Number.NaN;
            addObservationError("position_after_exit", error);
            break;
          }
        }
        if (exitOrderId) {
          try {
            const reconciled = await user.reconcileRecentTrades((exitSubmittedAt ?? nowUnix()) - 5);
            for (const event of reconciled) appendEvent(event);
          } catch (error) {
            reconciliationError = true;
            addObservationError("exit_trade_reconciliation", error);
          }
          const exitTrades = await clob.getRecentTrades((exitSubmittedAt ?? nowUnix()) - 5).catch((error) => {
            addObservationError("exit_recent_trades", error);
            return [] as unknown[];
          });
          for (const trade of exitTrades) {
            if (!relatedTrade(trade, exitOrderId)) continue;
            const tradeId = typeof (trade as Record<string, unknown>).id === "string"
              ? String((trade as Record<string, unknown>).id) : undefined;
            if (!tradeId) continue;
            const previous = relatedTrades.get(tradeId);
            if (!previous || matchedTradeShares(trade, exitOrderId) >= matchedTradeShares(previous, exitOrderId)) {
              relatedTrades.set(tradeId, trade);
            }
          }
        }
      } else {
        exitAttempt = { success: false, error: "no liquidation bid available", shares: positionAfter - positionBefore };
        addObservationError("residual_exit", "no liquidation bid available");
      }
    }
    fills = events.filter((event): event is Extract<UserFeedEvent, { kind: "exchangeFill" }> => event.kind === "exchangeFill");
    relatedTradeRows = [...relatedTrades.values()];
    const finalFillSharesByTrade = new Map<string, number>();
    for (const event of fills.filter((event) => event.orderId === orderId)) {
      const key = `${event.tradeId ?? `${event.orderId ?? ""}:${event.fill.tsUnix}:${event.fill.price}`}`;
      finalFillSharesByTrade.set(key, Math.max(finalFillSharesByTrade.get(key) ?? 0, event.fill.shares));
    }
    matchedShares = Math.max(
      [...finalFillSharesByTrade.values()].reduce((sum, shares) => sum + shares, 0),
      openSnapshots.reduce((max, snapshot) => Math.max(max, matchedOf(snapshot.order)), 0),
      relatedTradeRows.reduce<number>((sum, trade) => sum + matchedTradeShares(trade, orderId ?? ""), 0),
    );
    try { finalBalance = await clob.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }); }
    catch (error) { addObservationError("final_balance", error); finalBalance = {}; }
    const finalRawBalance = number(finalBalance.balance);
    balanceDelta = rawInitialBalance != null && finalRawBalance != null ? rawInitialBalance - finalRawBalance : Number.NaN;
    if (fills.length > 0) {
      const markoutUntil = Math.max(...fills.map((event) => event.fill.tsUnix)) * 1000 + 30_000;
      // Add one polling interval of grace so an integer exchange timestamp at
      // exactly the 30-second horizon is not discarded by clock skew.
      while (Date.now() < markoutUntil + Math.max(1_000, pollMs)) {
        const book = await clob.client.getOrderBook(selected.tokenId).catch((error) => {
          addObservationError("markout_order_book", error);
          return undefined;
        }) as { bids?: Array<{ price?: unknown }>; asks?: Array<{ price?: unknown }> } | undefined;
        if (book) bookSnapshots.push({ at: nowUnix(), bid: number(book.bids?.[0]?.price), ask: number(book.asks?.[0]?.price) });
        await sleep(Math.min(pollMs, Math.max(1, markoutUntil - Date.now())));
      }
    }
    const markouts = fills.map((event) => {
      const horizons = [5, 30].map((horizonSec) => {
        const target = event.fill.tsUnix + horizonSec;
        const sample = bookSnapshots.find((snapshot) => snapshot.at >= target && snapshot.bid != null && snapshot.ask != null);
        return [horizonSec, sample ? ((sample.bid! + sample.ask!) / 2) - event.fill.price : undefined] as const;
      });
      return {
        trade_id: event.tradeId,
        order_id: event.orderId,
        fill_price: event.fill.price,
        fill_ts: event.fill.tsUnix,
        markout: Object.fromEntries(horizons.map(([horizon, value]) => [`${horizon}s`, value])),
        markout_complete: horizons.every(([, value]) => value != null),
      };
    });
    const websocketCancelEvent = events.some((event) => event.kind === "orderCancelled" && event.orderId === orderId);
    const currentUserHealthy = user.isHealthy();
    const currentUserContinuous = user.isContinuous();
    const balanceLossUsdc = Number.isFinite(balanceDelta) ? balanceDelta / 1_000_000 : Number.NaN;
    const lossWithinCap = Number.isFinite(balanceLossUsdc) && balanceLossUsdc <= 30 + 1e-9;
    const markoutComplete = markouts.every((row) => row.markout_complete);
    const calibrationResult = observationErrors.size > 0 || reconciliationError || !currentUserContinuous
      ? "account_state_unknown"
      : fills.length > 0 || restOrderMatched ? "natural_fill_observed" : "no_natural_fill_observed";
    const gaps = [
      ...(fills.length === 0 && !restOrderMatched ? ["natural maker fill"] : []),
      ...(matchedShares > 0 && matchedShares < minSize ? ["partial fill"] : []),
      ...(fills.length === 0 ? ["fill price/markout"] : []),
      ...(fills.length > 0 && !markoutComplete ? ["complete 5s/30s markout"] : []),
      ...(mode === "calibration" && (!Number.isFinite(positionAfter) || positionAfter > positionBefore + 1e-9) ? ["residual position or position query"] : []),
      ...(!currentUserContinuous ? ["continuous authenticated user feed"] : []),
      ...[...observationErrors],
      "settlement and reward credit",
    ];
    const fullyFilled = (fills.length > 0 || restOrderMatched) && matchedShares >= minSize - 1e-9;
    const residualPositionClear = mode !== "calibration" || (Number.isFinite(positionAfter) && positionAfter <= positionBefore + 1e-9);
    const cancelTerminal = cancelAck && websocketCancelEvent && !stillOpen;
    const terminalReconciled = !stillOpen && !finalOpenQueryFailed && !sweepQueryFailed && (fullyFilled || cancelTerminal);
    const probeSafe = userFeedReady && currentUserHealthy && currentUserContinuous && terminalReconciled && residualPositionClear &&
      observationErrors.size === 0 && !reconciliationError && lossWithinCap && markoutComplete &&
      (mode === "calibration" || (!restOrderMatched && fills.length === 0 && Math.abs(balanceDelta) <= 1));
    console.log(JSON.stringify({
      kind: "live_auth_maker_probe",
      mode,
      wallet,
      market: market.slug,
      condition_id: market.conditionId,
      token_id: selected.tokenId,
      size: minSize,
      price: selected.price,
      notional: selected.notional,
      best_bid: selected.bestBid,
      best_ask: selected.bestAsk,
      submitted_at: submittedAtExact,
      first_visible_at: firstVisibleAt,
      wait_ms: waitMs,
      order_ack: { success: ack.success, order_id: orderId, status: ack.status, latency_ms: ack.latencyMs, sign_latency_ms: ack.signLatencyMs, ack_latency_ms: ack.ackLatencyMs },
      lifecycle_timestamps: {
        submit_started_at: submittedAtExact,
        ack_returned_at: ackReturnedAtMonoMs == null ? undefined : submittedAtExact + (ackReturnedAtMonoMs - submittedAtMonoMs) / 1000,
        ack_returned_latency_ms: ackReturnedAtMonoMs == null ? undefined : ackReturnedAtMonoMs - submittedAtMonoMs,
        websocket_order_event_at: orderWsEventAtMonoMs == null ? undefined : submittedAtExact + (orderWsEventAtMonoMs - submittedAtMonoMs) / 1000,
        websocket_order_event_latency_ms: orderWsEventAtMonoMs == null ? undefined : orderWsEventAtMonoMs - submittedAtMonoMs,
        websocket_placement_at: orderWsPlacementAtMonoMs == null ? undefined : submittedAtExact + (orderWsPlacementAtMonoMs - submittedAtMonoMs) / 1000,
        websocket_update_at: orderWsUpdateAtMonoMs == null ? undefined : submittedAtExact + (orderWsUpdateAtMonoMs - submittedAtMonoMs) / 1000,
        rest_first_visible_at: firstVisibleAt,
        rest_first_visible_latency_ms: firstVisibleAtMonoMs == null ? undefined : firstVisibleAtMonoMs - submittedAtMonoMs,
        websocket_cancel_event_at: cancelWsEventAtMonoMs == null ? undefined : submittedAtExact + (cancelWsEventAtMonoMs - submittedAtMonoMs) / 1000,
      },
      cancel_requested_at: cancelRequestedAt,
      cancel_ack: { confirmed: cancelAck, at: cancelAckAt },
      user_feed_ready: userFeedReady,
      websocket_cancel_event: websocketCancelEvent,
      fills,
      fill_observations: fills.map((event) => {
        const key = `${event.tradeId ?? `${event.orderId ?? ""}:${event.fill.tsUnix}:${event.fill.price}`}`;
        const receivedAt = fillReceivedAtMonoMs.get(key);
        return {
          trade_id: event.tradeId,
          order_id: event.orderId,
          exchange_match_at: event.fill.tsUnix,
          websocket_received_latency_ms: receivedAt == null ? event.reportLatencyMs : receivedAt - submittedAtMonoMs,
          venue_report_latency_ms: event.reportLatencyMs,
        };
      }),
      matched_shares: matchedShares,
      partial_fill_observed: matchedShares > 0 && matchedShares < minSize,
      position_before: positionBefore,
      position_after: positionAfter,
      residual_position: Number.isFinite(positionAfter) ? Math.max(0, positionAfter - positionBefore) : null,
      exit_order_id: exitOrderId,
      exit_attempt: exitAttempt,
      related_trades: relatedTradeRows.map(cleanTrade).filter((row): row is Record<string, unknown> => row != null),
      exit_trades: exitOrderId ? relatedTradeRows
        .filter((trade) => relatedTrade(trade, exitOrderId!))
        .map(cleanTrade).filter((row): row is Record<string, unknown> => row != null) : [],
      open_snapshots: openSnapshots,
      book_snapshots: bookSnapshots,
      markouts,
      still_open: stillOpen,
      rest_order_matched: restOrderMatched,
      balance_delta_raw: balanceDelta,
      balance_delta_usdc: balanceLossUsdc,
      user_feed_healthy: currentUserHealthy,
      user_feed_continuous: currentUserContinuous,
      observation_errors: [...observationErrors],
      calibration_result: calibrationResult,
      gaps,
      probe_safe: probeSafe,
      live_unlocked: false,
    }, null, 2));
    if (!probeSafe) throw new Error("maker probe did not prove a clean final order and account state");
  } finally {
    user.stop();
    if (orderId) {
      await clob.cancel(orderId).catch(() => undefined);
    }
    // A timeout can leave a live order without an order ID. Only a state
    // unknown submission authorizes a target-market recovery sweep.
    if (stateUnknownSubmission && mode === "calibration") await sweepUntrackedOrders();
    calibrationGuard?.release();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
