import "dotenv/config";
import { AssetType } from "@polymarket/clob-client-v2";
import { readFileSync } from "node:fs";
import { ClobWrapper, tickRoundDown } from "../src/live/clob/client.js";
import { findMarket } from "../src/live/discovery.js";
import { runUserFeed, type UserFeedEvent } from "../src/live/feeds/user.js";
import { nowUnix } from "../src/live/feeds/index.js";

type Profile = Record<string, string>;

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

async function main(): Promise<void> {
  setProfileEnv();
  const key = process.env.POLYMARKET_OWNER_PRIVATE_KEY;
  const wallet = process.env.POLYMARKET_WALLET_ADDRESS;
  if (!key || !wallet) throw new Error("owner signer or wallet is not configured");
  // Live probe must use the official Gamma market source directly. The local
  // collector is an optional paper-mode fallback and may not run on this host.
  const market = await findMarket(nowUnix(), false);
  if (!market) throw new Error("no current btc-updown-5m market");

  const clob = await ClobWrapper.connect({ key, funder: wallet as `0x${string}` });
  if (clob.funder.toLowerCase() !== wallet.toLowerCase()) throw new Error("resolved funder does not match configured wallet");
  const initialOpenOrders = await clob.getOpenOrders(market.conditionId);
  if (initialOpenOrders.length > 0) throw new Error("refusing probe while the target market already has open orders");
  const initialBalance = await clob.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const events: UserFeedEvent[] = [];
  let orderId: string | undefined;
  const deadline = nowUnix() + 90;
  const user = runUserFeed((event) => {
    if (event.kind === "user") events.push(event.event);
  }, {
    creds: clob.creds,
    conditionId: market.conditionId,
    upToken: market.upToken,
    downToken: market.downToken,
    accountAddress: clob.funder,
    isOurOrder: (id) => events.some((event) => event.kind === "orderCancelled" && event.orderId === id) || id === orderId,
    fetchRecentTrades: (afterUnix) => clob.getRecentTrades(market.conditionId, afterUnix),
    fetchOpenOrders: () => clob.getOpenOrders(market.conditionId),
    verifyAuthenticated: async () => {
      await clob.getOpenOrders(market.conditionId);
      return true;
    },
    fetchTrades: (ids) => clob.getTradesByIds(ids),
  }, deadline);
  try {
    let userFeedReady = false;
    try {
      await user.waitUntilReady(5_000);
      userFeedReady = true;
    } catch {
      // Polymarket may omit a standalone user-channel ack. The controlled
      // probe below uses one minimum maker order to obtain an actual channel
      // event; the normal live orchestrator remains fail-closed until ready.
      console.warn("user feed has no standalone ack; continuing controlled channel challenge");
    }
    const info = await clob.client.getClobMarketInfo(market.conditionId) as { mos?: unknown; mts?: unknown };
    const minSize = number(info.mos);
    if (!minSize || minSize <= 0) throw new Error("market minimum size unavailable");
    const tokenId = market.upToken;
    const tick = await clob.tickSize(tokenId);
    const book = await clob.client.getOrderBook(tokenId) as { bids?: Array<{ price?: unknown }> };
    const bestBid = number(book.bids?.[0]?.price);
    const price = tickRoundDown(Math.max(tick, (bestBid ?? 0.01) - tick * 2), tick);
    const notional = price * minSize;
    if (!Number.isFinite(notional) || notional <= 0 || notional > 50) throw new Error("probe notional exceeds the authorized $50 cap");
    const submittedAt = nowUnix();
    const ack = await clob.submitOrder({ tokenId, price, size: minSize, tickSize: tick });
    orderId = ack.orderId;
    if (!ack.success || !orderId) throw new Error(`maker order rejected: ${ack.errorMsg ?? "missing order id"}`);
    user.registerOrder(orderId, ack.tradeIds);
    // Some deployments omit a standalone subscription ACK. Once the HTTP
    // order ACK has registered our id, the first target-market order/trade
    // event is the provider's concrete authenticated-channel evidence.
    try {
      await user.waitUntilReady(5_000);
      userFeedReady = true;
    } catch {
      userFeedReady = false;
    }
    const cancelRequestedAt = nowUnix();
    const cancelAck = await clob.cancel(orderId);
    const cancelAckAt = nowUnix();
    const until = Date.now() + 15_000;
    while (Date.now() < until && !events.some((event) => event.kind === "orderCancelled" && event.orderId === orderId)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let openOrders = await clob.getOpenOrders(market.conditionId);
    for (let attempt = 0; attempt < 3 && openOrders.some((row) => row && typeof row === "object" && String((row as Record<string, unknown>).id) === orderId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await clob.cancel(orderId).catch(() => undefined);
      try { openOrders = await clob.getOpenOrders(market.conditionId); } catch { openOrders = [{ id: "query-error" }]; }
    }
    const stillOpen = openOrders.some((row) => row && typeof row === "object" && String((row as Record<string, unknown>).id) === orderId);
    const websocketCancelEvent = events.some((event) => event.kind === "orderCancelled" && event.orderId === orderId);
    const fills = events.filter((event) => event.kind === "exchangeFill");
    const restRows = await clob.getRecentTrades(market.conditionId, submittedAt - 5);
    const restOrderMatched = restRows.some((row) => row && typeof row === "object" &&
      (String((row as Record<string, unknown>).taker_order_id) === orderId ||
       (Array.isArray((row as Record<string, unknown>).maker_orders) &&
        ( (row as Record<string, unknown>).maker_orders as unknown[]).some((maker: unknown) => maker && typeof maker === "object" && String((maker as Record<string, unknown>).order_id) === orderId))));
    const finalBalance = await clob.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const balanceDelta = Number(initialBalance.balance ?? 0) - Number(finalBalance.balance ?? 0);
    const probeSafe = cancelAck && websocketCancelEvent && fills.length === 0 && !restOrderMatched && !stillOpen && Number.isFinite(balanceDelta) && Math.abs(balanceDelta) <= 1;
    console.log(JSON.stringify({
      kind: "live_auth_maker_probe",
      wallet,
      market: market.slug,
      condition_id: market.conditionId,
      token_id: tokenId,
      size: minSize,
      price,
      notional,
      submitted_at: submittedAt,
      order_ack: { success: ack.success, order_id: orderId, status: ack.status, latency_ms: ack.latencyMs, ack_latency_ms: ack.ackLatencyMs },
      cancel_requested_at: cancelRequestedAt,
      cancel_ack: { confirmed: cancelAck, at: cancelAckAt },
      user_feed_ready: userFeedReady,
      websocket_cancel_event: events.some((event) => event.kind === "orderCancelled" && event.orderId === orderId),
      fills,
      still_open: stillOpen,
      rest_order_matched: restOrderMatched,
      balance_delta_raw: balanceDelta,
      probe_safe: probeSafe,
    }, null, 2));
    if (!probeSafe) throw new Error("maker probe did not prove a clean cancel and zero-fill account state");
  } finally {
    user.stop();
    if (orderId) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await clob.cancel(orderId).catch(() => undefined);
        let remaining: unknown[];
        try { remaining = await clob.getOpenOrders(market.conditionId); } catch { continue; }
        if (!remaining.some((row) => row && typeof row === "object" && String((row as Record<string, unknown>).id) === orderId)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
