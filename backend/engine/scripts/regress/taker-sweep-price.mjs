// A taker FAK that sweeps two levels is reported with the LAST level's price
// (2026-10-30 live: "Up BUY 5.170455 @0.44" = 2.5 @0.43 + 2.670455 @0.44 via
// two Down bids at 0.57 / 0.56, i.e. minted). Booked at 0.44 it spent 2.275 of
// a 2.25 budget and the core refused it ("invalid or unowned fill"): the run
// stopped with the order UNKNOWN. The fill must be priced by its legs, and the
// core must accept it within the budget.
// Run after `npm run build`:  node scripts/regress/taker-sweep-price.mjs
import assert from "node:assert/strict";
import { parseAuthenticatedTrade, parseUserMessage } from "../../dist/live/feeds/user.js";
import { TradingCore } from "../../dist/platform/core.js";

const UP = "111", DOWN = "222", OURS = "0xours";
const opts = { conditionId: "0xm", upToken: UP, downToken: DOWN, isOurOrder: id => id === OURS, orderDirection: () => "BUY" };
// The venue's row, prices and sizes exactly as read on 10-30 (ids replaced).
const row = { id: "t-sweep", status: "CONFIRMED", trader_side: "TAKER", taker_order_id: OURS, market: "0xm", asset_id: UP, side: "BUY",
  price: "0.44", size: "5.170455", match_time: "1793352023", fee_rate_bps: "0",
  maker_orders: [
    { order_id: "0xm1", asset_id: DOWN, side: "BUY", price: "0.57", matched_amount: "2.5" },
    { order_id: "0xm2", asset_id: DOWN, side: "BUY", price: "0.5600000748936043", matched_amount: "2.670455" },
  ] };

for (const [name, events] of [["account read", parseAuthenticatedTrade(row, opts, new Set())],
  ["user channel", parseUserMessage({ ...row, event_type: "trade" }, opts, new Map(), new Set())]]) {
  assert.equal(events.length, 1, name);
  const { fill } = events[0];
  assert.ok(Math.abs(fill.price * fill.shares - 2.25) < 1e-6, `${name}: priced by its legs, 2.25 USDC spent (got ${fill.price * fill.shares})`);
  assert.ok(fill.price < 0.44 && fill.price > 0.43, `${name}: average between the two levels (${fill.price})`);
}

// Same-token legs (no mint) and a single level: unchanged.
const plain = { ...row, id: "t-plain", price: "0.40", size: "5", maker_orders: [{ order_id: "0xm3", asset_id: UP, side: "SELL", price: "0.40", matched_amount: "5" }] };
assert.equal(parseAuthenticatedTrade(plain, opts, new Set())[0].fill.price, 0.4);
// Legs that do not add up to the size: keep the reported price.
const partial = { ...row, id: "t-odd", maker_orders: [row.maker_orders[0]] };
assert.equal(parseAuthenticatedTrade(partial, opts, new Set())[0].fill.price, 0.44);

// The core: the reported 0.44 is refused (as live), the legs-priced fill booked.
const now = 1793352023;
const core = () => {
  const c = new TradingCore({ account: { accountId: "0xa", at: now, cashAt: now, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 }],
    limits: { capitalUsd: 200, dailyLossUsd: null, maxOrderUsd: 50, maxOpenOrders: 2 }, adapters: { gateway: { mode: "live" } }, now: () => now });
  c["state"].orders.push({ orderId: OURS, clientOrderId: "c1", strategyId: "s", tokenId: UP, marketId: "0xm", roundId: "1", assetId: "btc",
    direction: "BUY", price: 0.45, shares: 5, filledShares: 0, reservedUsd: 2.3375, reservedShares: 0, timeInForce: "FAK",
    status: "OPEN", venueStatus: "matched", createdAt: now });
  return c;
};
const book = (c, price) => c.applyFill({ tradeId: "t-sweep", orderId: OURS, tokenId: UP, direction: "BUY", shares: 5.170455, price,
  feeUsd: 0, ts: now, status: "CONFIRMED" });
assert.throws(() => book(core(), 0.44), /invalid or unowned fill/, "the row's last-level price overspends the budget");
const ok = core();
const [{ fill }] = parseAuthenticatedTrade(row, opts, new Set());
assert.equal(book(ok, fill.price), true, "the legs-priced fill is booked");
assert.equal(ok.orders()[0].filledShares, 5.170455);
console.log("taker-sweep-price OK");
