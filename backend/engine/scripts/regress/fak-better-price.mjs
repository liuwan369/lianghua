// 2026-10-26 live: a FAK BUY 5 @ 0.42 filled 5.25 @ 0.40, and 5 @ 0.88 filled
// 5.176466 @ 0.85. A BUY limit order signs a USDC budget (makerAmount = 5 x
// limit); a better price buys more shares with it. The core rejected the fill
// ("more shares than the order"), the order stayed OPEN, the round-end cancel
// was refused (a matched FAK has nothing resting), the order went UNKNOWN and
// was quarantined with its reservation held, and the books showed no fill.
//
// A BUY is bounded by what it spent (shares x limit), a SELL by its shares. A
// FAK the venue answered `matched` is over once every trade its answer named
// is applied: the unfilled rest is void, nothing is cancelled.
//
// Real TradingPlatform + binance-lead strategy, only the gateway faked.
// Run after `npm run build`:  node scripts/regress/fak-better-price.mjs
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { createStrategy } from "../../dist/strategies/binance-lead.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const ORDER = "0x" + "fa".repeat(32), SELL = "0x" + "5e".repeat(32);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const limits = { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null };
const FEE = 0.0882;                                   // 5.25 x 0.07 x 0.40 x 0.60
const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message}: ${a} vs ${b}`);

/** The venue: the FAK is answered matched with the given trade ids, a later order rests; every cancel is refused. */
function venue(tradeIds, beforeAck) {
  const g = { mode: "live", durableIdentity: true, submits: [], cancels: [],
    async submit(request, instrument, prepared) {
      g.submits.push(request);
      const orderId = request.timeInForce === "FAK" ? ORDER : SELL;
      prepared({ orderHash: orderId, signedPayload: { sig: "s" }, preparedAt: START + 21 });
      await beforeAck?.();
      return request.timeInForce === "FAK" ? { status: "accepted", orderId, venueStatus: "matched", tradeIds }
        : { status: "accepted", orderId, venueStatus: "live", tradeIds: [] };
    },
    async cancel(id) { g.cancels.push(id); return false; } };
  return g;
}
function rig(gateway) {
  const r = { now: START - 20 };
  const strategy = createStrategy({}, undefined, { persist: state => r.platform?.core.setStrategyState("binance-lead", state) });
  r.platform = new TradingPlatform({ account: { accountId: "t", at: START - 60, cashAt: START - 60, cashUsd: 100, positions: [],
    openOrders: [], complete: true }, instruments: market.instruments, limits, now: () => r.now,
    adapters: { gateway, estimateFee: () => FEE } });
  r.platform.ingest({ kind: "market", market });
  r.platform.attach(strategy);
  r.platform.ingest({ kind: "timer", ts: r.now });
  r.strategy = strategy; r.gateway = gateway;
  return r;
}
const side = (r, tokenId, ask) => ({ assetId: tokenId, bid: ask - 0.01, ask, bidSize: 100, askSize: 100, sourceAt: r.now, expiresAt: r.now + 2 });
/** UP ask 0.39 and an UP signal: one FAK BUY 5 @ 0.42 (cap 2.10 USDC). */
async function signal(r) {
  r.now = START + 20;
  r.platform.ingest({ kind: "book", marketId: "0xm", roundId: ROUND, snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND,
    sourceAt: r.now, expiresAt: r.now + 2, tsUnix: r.now, receivedAtUnix: r.now, receivedAtMonoMs: performance.now(), marketAgeMs: 40,
    YES: side(r, UP, 0.39), NO: side(r, DOWN, 0.62) } });
  r.now = START + 21.002;
  r.platform.ingest({ kind: "lead", assetId: "btc", direction: "UP", price: 100030, refPrice: 100000, moveBp: 3, tradeId: 1,
    tradeTimeMs: (START + 20.875) * 1000, receivedAtUnix: START + 21, receivedAtMonoMs: performance.now() });
  await r.platform.idle();
  assert.equal(r.gateway.submits.length, 1, "precondition: the signal placed one order");
  assert.equal(r.gateway.submits[0].price, 0.42, "precondition: limit = 0.39 + 0.03");
  assert.equal(r.gateway.submits[0].shares, 5);
}
const fill = (tradeId, shares, price, fee = FEE, direction = "BUY", orderId = ORDER) => ({ kind: "fill", marketId: "0xm", roundId: ROUND,
  fill: { tradeId, orderId, tokenId: UP, direction, price, shares, feeUsd: fee, ts: START + 21.3, status: "MATCHED", isMaker: false } });
const tryIngest = (r, event) => { try { r.platform.ingest(event); return true; } catch (error) { return error.message; } };
async function closeRound(r) {
  for (const t of [START + 300, START + 301.5]) { r.now = t; r.platform.ingest({ kind: "timer", ts: t }); await r.platform.idle(); }
}
const position = (r, tokenId = UP) => r.platform.core.positions().find(p => p.tokenId === tokenId);

// --- live: 5 @ 0.42 filled 5.25 @ 0.40, spending exactly the 2.10 budget ---
{
  const r = rig(venue(["t1"]));
  await signal(r);
  assert.equal(tryIngest(r, fill("t1", 5.25, 0.40)), true, "a 5.25 @ 0.40 fill of a 5 @ 0.42 BUY is ours");
  close(position(r).shares, 5.25, "position is the venue's 5.25 shares");
  close(position(r).costUsd, 5.25 * 0.40 + FEE, "cost = 2.10 + fee");
  close(r.platform.core.snapshot().cashUsd, 100 - 5.25 * 0.40 - FEE, "cash pays 5.25 x 0.40 + fee");
  const order = r.platform.core.order(ORDER);
  assert.equal(order.status, "FILLED");
  assert.equal(order.reservedUsd, 0, "the reservation is released");
  assert.equal(order.filledShares, 5.25);
  close(r.platform.core.risk().availableUsd, 100 - 5.25 * 0.40 - FEE, "nothing stays reserved");
  await closeRound(r);
  assert.deepEqual(r.gateway.cancels, [], "a filled FAK is never cancelled");
  assert.equal(r.platform.core.order(ORDER).status, "FILLED", "and never turns UNKNOWN");
  assert.equal(r.platform.core.risk().reconciliationRequired, false);
  const saved = r.platform.core.snapshot();
  const restored = createStrategy({}, saved.strategyStates["binance-lead"]);
  assert.equal(restored.exportState().rounds[0].stages[0].filledShares, 5.25, "the strategy restores a 5.25-share stage");
  assert.doesNotThrow(() => new TradingPlatform({ account: { accountId: "t", at: START + 310, cashAt: START + 310,
    cashUsd: saved.cashUsd, positions: saved.positions, openOrders: [], complete: true }, instruments: market.instruments, limits,
    restored: saved, now: () => START + 310, adapters: { gateway: venue([]), estimateFee: () => 0 } }), "the core restores it too");
  // A SELL is still bounded by its shares.
  r.now = START + 310;
  const sell = await r.platform.core.submit({ clientOrderId: "sell:1", strategyId: "manual", tokenId: UP, direction: "SELL",
    price: 0.30, shares: 5, timeInForce: "GTC", postOnly: false });
  assert.equal(sell.status, "OPEN");
  assert.match(String(tryIngest(r, fill("s1", 5.25, 0.30, 0, "SELL", SELL))), /invalid or unowned fill/, "a SELL fill above its shares is refused");
  assert.equal(tryIngest(r, fill("s1", 5, 0.30, 0, "SELL", SELL)), true, "a SELL of its 5 shares is accepted");
  assert.equal(r.platform.core.order(SELL).status, "FILLED");
}
// --- a fill above the USDC budget is still refused: 5.25 @ 0.42 = 2.205 > 2.10 ---
{
  const r = rig(venue(["t1"]));
  await signal(r);
  assert.match(String(tryIngest(r, fill("t1", 5.25, 0.42))), /invalid or unowned fill/);
  assert.equal(position(r), undefined, "no position from a refused fill");
  assert.equal(r.platform.core.snapshot().cashUsd, 100);
  assert.match(String(tryIngest(r, fill("t1", 2, 0.43))), /invalid or unowned fill/, "a price above the limit is refused");
}
// --- part filled over two trades: no cancel reaches the venue at the close; the last trade ends it ---
{
  const r = rig(venue(["t1", "t2"]));
  await signal(r);
  assert.equal(tryIngest(r, fill("t1", 3, 0.40, 0.05)), true);
  assert.equal(r.platform.core.order(ORDER).status, "PARTIAL", "one of its two trades is in");
  await closeRound(r);
  assert.deepEqual(r.gateway.cancels, [], "a matched FAK has nothing resting: no cancel reaches the venue");
  const waiting = r.platform.core.order(ORDER);
  assert.equal(waiting.status, "UNKNOWN", "t2 still missing at the close: left to account recovery");
  assert.ok(waiting.reservedUsd > 0, "the rest stays reserved until t2 is in");
  assert.equal(r.platform.core.risk().halted, false, "only this market waits, the account trades on");
  assert.equal(tryIngest(r, fill("t2", 1.5, 0.41, 0.03)), true);
  const order = r.platform.core.order(ORDER);
  assert.equal(order.status, "CANCELLED", "every named trade is in: the unfilled rest is void");
  close(order.filledShares, 4.5, "4.5 shares filled");
  assert.equal(order.reservedUsd, 0, "the rest's reservation is released");
  assert.equal(order.reconciliationPending, false);
  assert.equal(r.platform.core.risk().reconciliationRequired, false, "the market is free again");
  close(position(r).shares, 4.5, "position");
  close(r.platform.core.snapshot().cashUsd, 100 - 3 * 0.40 - 0.05 - 1.5 * 0.41 - 0.03, "cash");
  assert.equal(r.strategy.exportState().rounds[0].stages[0].status, "CANCELLED");
}
// --- 5 shares in t1, the 0.25 bought with the rest of the budget in t2: t1 alone does not end it ---
{
  const r = rig(venue(["t1", "t2"]));
  await signal(r);
  assert.equal(tryIngest(r, fill("t1", 5, 0.40, 0.084)), true);
  assert.equal(r.platform.core.order(ORDER).status, "FILLED", "5 of 5 shares");
  assert.equal(tryIngest(r, fill("t2", 0.25, 0.40, 0.0042)), true, "the budget's last 0.10 buys 0.25 more, still ours");
  assert.equal(r.platform.core.order(ORDER).status, "FILLED");
  close(r.platform.core.order(ORDER).filledShares, 5.25, "filled");
  close(position(r).shares, 5.25, "position");
  assert.match(String(tryIngest(r, fill("t3", 0.1, 0.40, 0))), /invalid or unowned fill/, "nothing beyond the budget");
}
// --- the trade can arrive before the HTTP answer ---
{
  let r;
  r = rig(venue(["t1"], async () => { assert.equal(tryIngest(r, fill("t1", 3, 0.40, 0.05)), true, "a fill before the ACK is ours"); }));
  await signal(r);
  const order = r.platform.core.order(ORDER);
  assert.equal(order.status, "CANCELLED", "the ACK names t1, already applied: done");
  assert.equal(order.reservedUsd, 0);
  close(order.filledShares, 3, "3 shares filled");
  await closeRound(r);
  assert.deepEqual(r.gateway.cancels, []);
}
console.log("fak-better-price OK");
