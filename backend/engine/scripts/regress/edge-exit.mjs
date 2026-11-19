// Size by edge and exit on the first reverse signal (user 2026-11-17), both
// off by default: off, each is only recorded; on, it acts.
// Size by edge:
// - leadFairValue: at the line it is 0.5; ahead of the line with little time
//   left near 1; behind it near 0; without openMean60 or a volatility none;
// - edgeShares: >= 0.07 -> 15, < -0.04 -> 5, else the configured shares;
// - off: the order is 10 shares, the stage records fair / edge / edgeShares;
//   on: the order carries the picked shares; the state restores either way;
// - presignPrices signs 5 / 10 / 15 at each limit when edgeSizing is on.
// Exit on the first reverse signal:
// - recorded once per round on the first opposite signal after the fill (the
//   held side's bid, shares held), never on a same-direction signal, never
//   within 0.5 s of the first fill, never in the last 5 s;
// - off: recorded with skip "off", no order;
// - on: one FAK SELL of what is held (floored to 0.01, capped by the position)
//   at bid - 0.08 on tick, client id :exit; never a second one;
// - on but paused / halted / no bid / under the venue minimum: recorded, no order;
// - the exit's order updates land on round.exit, a CREATED exit at a restart is
//   ABANDONED, and an exit only the core holds is adopted (no second sell);
// - the core accepts the SELL against the position the buy left;
// - a GTC remainder still resting is cancelled first and the sell waits until
//   it ends (it rests at or above the bid it would sell into); a FAK still
//   reporting is waited for, never cancelled, and the state restores meanwhile;
//   a wait past the last 5 s gives up; no rest order follows a round that sold;
// - a fair value of exactly 0 or 1 (the normal CDF saturates) restores;
// - an exit the core refused (order_not_submitted) is REJECTED, an abandoned
//   one ABANDONED, a CREATED one at the close ABANDONED;
// - the order log writes the exit as its own lead_order (stage exit, SELL,
//   proceeds), and the exit shadow line carries the first reverse signal;
// - settlement: a receipt with an exchange OrderFilled is a trade, never a payout.
// Run after `npm run build`:  node scripts/regress/edge-exit.mjs
import assert from "node:assert/strict";
import { createStrategy, normalizeBinanceLeadConfig, leadFairValue, edgeShares, presignPrices,
  EDGE_HIGH, EDGE_LOW, EXIT_PREMIUM } from "../../dist/strategies/binance-lead.js";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { createLeadOrderLog, leadExitShadowFields } from "../../dist/cli/platform.js";
import { receiptIsTrade } from "../../dist/platform/live-settlement.js";
import { CTF_EXCHANGE, PUSD } from "../../dist/live/contracts.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = ({ risk = {}, positions = [], ...rest } = {}) => ({ cashUsd: 1000, positions, orders: [], quarantinedOrderIds: [],
  risk: { halted: false, availableUsd: 1000, occupiedUsd: 0, ...risk }, ...rest });
const ctx = (now, acct = account()) => ({ mode: "live", now, markets: [market], books: [], account: acct, estimateFee: () => 0.02 });
const book = (t, ua, da, ub = 0.4, db = 0.4) => ({ kind: "book", marketId: "0xm", roundId: ROUND,
  snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t,
    receivedAtMonoMs: 0, marketAgeMs: 50, YES: { assetId: UP, bid: ub, ask: ua, sourceAt: t, expiresAt: t + 2 },
    NO: { assetId: DOWN, bid: db, ask: da, sourceAt: t, expiresAt: t + 2 } } });
const lead = (S, direction = "UP", extra = {}) => ({ kind: "lead", assetId: "btc", direction, price: 100030, refPrice: 100000,
  moveBp: 3, venue: "bybit", line: "direct", tradeId: Math.round(S * 1000), tradeTimeMs: (S - 0.1) * 1000, receivedAtUnix: S,
  receivedAtMonoMs: 1, openMean60: 100020, vol300Bp: 0.5, ...extra });
const at = (s, e, now, acct) => s.onEvent(e, ctx(now, acct));
const submits = actions => actions.filter(a => a.kind === "submit").map(a => a.order);
const record = (o, status, filled, orderId, now) => ({ ...o, strategyId: "binance-lead", orderId, status, filledShares: filled,
  reservedUsd: 0, reservedShares: 0, createdAt: now, updatedAt: now });
const S = START + 60;
const close = (a, b, m, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${m}: ${a} vs ${b}`);

// --- fair value and the edge tiers ---
{
  close(leadFairValue({ price: 100000, openMean60: 100000, vol300Bp: 0.5, direction: "UP" }, 200), 0.5, "at the line");
  assert.ok(leadFairValue({ price: 100100, openMean60: 100000, vol300Bp: 0.5, direction: "UP" }, 60) > 0.95, "10 bp ahead, 60 s left");
  assert.ok(leadFairValue({ price: 100100, openMean60: 100000, vol300Bp: 0.5, direction: "DOWN" }, 60) < 0.05, "the other side");
  assert.equal(leadFairValue({ price: 100000, vol300Bp: 0.5, direction: "UP" }, 200), undefined, "no open mean");
  assert.equal(leadFairValue({ price: 100000, openMean60: 100000, direction: "UP" }, 200), undefined, "no volatility");
  assert.equal(edgeShares(EDGE_HIGH, 10), 15); assert.equal(edgeShares(EDGE_HIGH - 1e-9, 10), 10);
  assert.equal(edgeShares(EDGE_LOW, 10), 10); assert.equal(edgeShares(EDGE_LOW - 1e-9, 10), 5);
  assert.equal(edgeShares(undefined, 10), 10, "no edge: configured");
  const d = normalizeBinanceLeadConfig({});
  assert.equal(d.edgeSizing, false); assert.equal(d.exitOnReverse, false);
  assert.throws(() => normalizeBinanceLeadConfig({ edgeSizing: "on" }), /edgeSizing/);
  assert.throws(() => normalizeBinanceLeadConfig({ exitOnReverse: 1 }), /exitOnReverse/);
}
// A round with a signal 3 bp ahead of the line, 240 s left, ask 0.55 (limit 0.63).
const placed = (config, extra, direction = "UP") => {
  const s = createStrategy({ limitPremium: 0.08, shares: 10, entryOrder: "gtc", restAfterMissSec: 4, ...config });
  at(s, { kind: "timer", ts: START - 20 }, START - 20);
  at(s, book(S - 1, 0.55, 0.47), S - 1);
  const [buy] = submits(at(s, lead(S, direction, extra), S + 0.002));
  return { s, buy };
};
{
  const off = placed({});
  assert.equal(off.buy.shares, 10, "edgeSizing off: the configured shares");
  const st = off.s.exportState().rounds[0].stages[0];
  assert.ok(st.fair > 0.5 && st.fair < 1, `fair recorded: ${st.fair}`);
  close(st.edge, st.fair - 0.63 - 0.07 * 0.63 * 0.37, "edge = fair - limit - fee");
  assert.ok([5, 10, 15].includes(st.edgeShares), "the shares it would pick are recorded");
  // Far ahead and late: a big edge picks 15 when on.
  const hi = placed({ edgeSizing: true }, { price: 100200, openMean60: 100000, vol300Bp: 0.3 });
  const hst = hi.s.exportState().rounds[0].stages[0];
  assert.ok(hst.edge >= EDGE_HIGH, `big edge ${hst.edge}`);
  assert.equal(hi.buy.shares, 15, "edgeSizing on: 15 shares");
  // Behind the line: a low edge picks 5.
  const lo = placed({ edgeSizing: true }, { price: 99980, openMean60: 100000, vol300Bp: 0.3 });
  assert.equal(lo.buy.shares, 5, "edgeSizing on, behind the line: 5 shares");
  // 15 shares over the round budget: falls back to the configured 10, not skipped.
  const capped = placed({ edgeSizing: true, roundBudgetUsd: 8 }, { price: 100200, openMean60: 100000, vol300Bp: 0.3 });
  assert.equal(capped.buy?.shares, 10, "over budget at 15: 10");
  const tight = placed({ edgeSizing: true, roundBudgetUsd: 3 }, { price: 100200, openMean60: 100000, vol300Bp: 0.3 });
  assert.equal(tight.buy, undefined, "10 does not fit either: no order");
  // Restores with any tier.
  for (const r of [hi, lo, off]) assert.doesNotThrow(() => createStrategy({}, r.s.exportState()), "restores");
  // Presign covers the tiers.
  const plan = presignPrices({ maxAsk: 0.8, limitPremium: 0.08, shares: 10, edgeSizing: true }, 0.01);
  assert.deepEqual(plan.find(p => p.price === 0.63).sizes, [5, 10, 15]);
  assert.deepEqual(presignPrices({ maxAsk: 0.8, limitPremium: 0.08, shares: 10 }, 0.01).find(p => p.price === 0.63).sizes, [10]);
}
// --- exit on the first reverse signal ---
const filled = (config) => {
  const r = placed(config);
  at(r.s, { kind: "order", order: { ...record(r.buy, "FILLED", 10, "0xb", S + 0.6), httpAckAt: S + 0.6 } }, S + 0.6);
  at(r.s, book(S + 1, 0.60, 0.42, 0.58, 0.40), S + 1);
  return r;
};
const held = account({ positions: [{ tokenId: UP, shares: 10, costUsd: 6.3, realizedPnlUsd: 0 }] });
{
  const r = filled({});
  assert.deepEqual(submits(at(r.s, lead(S + 0.8, "DOWN"), S + 0.8, held)), [], "within 0.5 s of the fill: nothing");
  assert.equal(r.s.exportState().rounds[0].exitFirst, undefined);
  assert.deepEqual(submits(at(r.s, lead(S + 5, "UP"), S + 5, held)), [], "same direction: nothing");
  assert.deepEqual(submits(at(r.s, lead(S + 10, "DOWN"), S + 10, held)), [], "off: no sell");
  const ef = r.s.exportState().rounds[0].exitFirst;
  assert.deepEqual([ef.at, ef.bid, ef.shares, ef.sent, ef.skip], [S + 10, 0.58, 10, false, "off"], "recorded with the bid");
  // Where BTC stood against the open line then, signed for the held side
  // (UP held, DOWN signal at 100030 vs the 60 s mean 100020: +1.0 bp ours).
  close(ef.leadBp, Math.log(100030 / 100020) * 1e4, "lead over the open line, held side +");
  at(r.s, book(S + 11, 0.70, 0.32, 0.68, 0.30), S + 11);
  at(r.s, lead(S + 20, "DOWN"), S + 20, held);
  assert.equal(r.s.exportState().rounds[0].exitFirst.at, S + 10, "only the first is recorded");
}
{
  const r = filled({ exitOnReverse: true });
  const [sell] = submits(at(r.s, lead(S + 10, "DOWN"), S + 10, held));
  assert.ok(sell, "on: a sell");
  assert.deepEqual([sell.direction, sell.tokenId, sell.shares, sell.timeInForce, sell.postOnly, sell.clientOrderId],
    ["SELL", UP, 10, "FAK", false, "binance-lead:0xm:exit"]);
  close(sell.price, 0.58 - EXIT_PREMIUM, "bid - 0.08");
  assert.deepEqual(submits(at(r.s, lead(S + 20, "DOWN"), S + 20, held)), [], "never a second sell");
  // Its updates land on round.exit; nothing is bought again.
  at(r.s, { kind: "order", order: record(sell, "FILLED", 10, "0xs", S + 10.7) }, S + 10.7, held);
  const ex = r.s.exportState().rounds[0].exit;
  assert.deepEqual([ex.status, ex.filledShares, ex.orderId], ["FILLED", 10, "0xs"]);
  assert.equal(r.s.exportState().rounds[0].reason, "反向信号，已卖出 10/10 股", "the round says it sold");
  assert.equal(r.s.exportState().rounds[0].stages.length, 1, "the sell is not a stage");
  assert.deepEqual(submits(at(r.s, lead(S + 30, "UP"), S + 30, held)), [], "no new buy after selling");
  assert.doesNotThrow(() => createStrategy({}, r.s.exportState()), "restores with the exit");
}
{
  // Fewer shares in the position than the round thinks: sell the position.
  const r = filled({ exitOnReverse: true });
  const part = account({ positions: [{ tokenId: UP, shares: 7.456, costUsd: 4.7, realizedPnlUsd: 0 }] });
  const [sell] = submits(at(r.s, lead(S + 10, "DOWN"), S + 10, part));
  assert.equal(sell.shares, 7.45, "the position, floored to 0.01");
  // Under the venue minimum: recorded, not sold.
  const t = filled({ exitOnReverse: true });
  const tiny = account({ positions: [{ tokenId: UP, shares: 4, costUsd: 2.5, realizedPnlUsd: 0 }] });
  assert.deepEqual(submits(at(t.s, lead(S + 10, "DOWN"), S + 10, tiny)), []);
  assert.equal(t.s.exportState().rounds[0].exitFirst.skip, "below_min_size");
}
for (const [label, acct, skip] of [
  ["halted", account({ positions: held.positions, risk: { halted: true, reason: "unknown order requires reconciliation" } }), "halted"],
  ["daily loss halt still sells", account({ positions: held.positions, risk: { halted: true, reason: "daily loss limit" } }), undefined],
  ["market blocked", account({ positions: held.positions, risk: { blockedMarketIds: ["0xm"] } }), undefined]]) {
  const r = filled({ exitOnReverse: true });
  const out = submits(at(r.s, lead(S + 10, "DOWN"), S + 10, acct));
  assert.equal(out.length, skip || label === "market blocked" ? 0 : 1, label);
  assert.equal(r.s.exportState().rounds[0].exitFirst.skip, skip, label);
}
{
  // A blocked market waits: the sell goes once the block clears, or is given up at the close.
  const r = filled({ exitOnReverse: true });
  const blocked = account({ positions: held.positions, risk: { blockedMarketIds: ["0xm"] } });
  at(r.s, lead(S + 10, "DOWN"), S + 10, blocked);
  assert.equal(r.s.exportState().rounds[0].exitFirst.waiting, true);
  assert.equal(submits(at(r.s, book(S + 12, 0.60, 0.42, 0.56, 0.40), S + 12, held)).length, 1, "sent once the block clears");
  const g = filled({ exitOnReverse: true });
  at(g.s, lead(S + 10, "DOWN"), S + 10, blocked);
  at(g.s, { kind: "timer", ts: START + 296 }, START + 296, blocked);
  assert.equal(g.s.exportState().rounds[0].exitFirst.skip, "market_blocked", "given up at the close");
}
{
  // Paused, and a frame without the held side's bid.
  const r = filled({ exitOnReverse: true }); r.s.setPaused(true);
  assert.deepEqual(submits(at(r.s, lead(S + 10, "DOWN"), S + 10, held)), []);
  assert.equal(r.s.exportState().rounds[0].exitFirst.skip, "paused");
  const n = filled({ exitOnReverse: true });
  at(n.s, book(S + 2, 0.60, 0.42, null, 0.40), S + 2);
  assert.deepEqual(submits(at(n.s, lead(S + 10, "DOWN"), S + 10, held)), []);
  assert.equal(n.s.exportState().rounds[0].exitFirst.waiting, true, "no bid: waits for one");
  at(n.s, { kind: "timer", ts: START + 296 }, START + 296, held);
  assert.equal(n.s.exportState().rounds[0].exitFirst.skip, "no_bid", "still none in the last 5 s: given up");
  // In the last 5 s: nothing.
  const l = filled({ exitOnReverse: true });
  assert.deepEqual(submits(at(l.s, lead(START + 296, "DOWN"), START + 296, held)), []);
  assert.equal(l.s.exportState().rounds[0].exitFirst, undefined);
}
{
  // Restart: a CREATED exit is abandoned, never sent late.
  const r = filled({ exitOnReverse: true });
  at(r.s, lead(S + 10, "DOWN"), S + 10, held);
  const back = createStrategy({}, r.s.exportState());
  assert.equal(back.exportState().rounds[0].exit.status, "ABANDONED");
  assert.deepEqual(submits(back.onEvent(lead(S + 20, "DOWN"), ctx(S + 20, held))), [], "and not sent again");
  // An exit only the core holds (state lost before the strategy saved it) is adopted.
  const g = filled({ exitOnReverse: true });
  const ghost = { clientOrderId: "binance-lead:0xm:exit", assetId: "btc", marketId: "0xm", roundId: ROUND, tokenId: UP,
    direction: "SELL", price: 0.5, shares: 10, timeInForce: "FAK", postOnly: false };
  at(g.s, { kind: "order", order: record(ghost, "OPEN", 0, "0xs", S + 9) }, S + 9, held);
  assert.equal(g.s.exportState().rounds[0].exit.orderId, "0xs", "adopted");
  assert.deepEqual(submits(at(g.s, lead(S + 10, "DOWN"), S + 10, held)), [], "no second sell");
}
{
  // The core takes the strategy's SELL against the position its buy left.
  const now = { t: START + 60 };
  const gateway = { mode: "live", async submit(req) { return { status: "accepted", orderId: req.direction === "BUY" ? "0xb" : "0xs" }; },
    async cancel() { return true; } };
  const p = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null },
    now: () => now.t, adapters: { gateway, estimateFee: () => 0 } });
  p.ingest({ kind: "market", market });
  await p.core.submit({ clientOrderId: "binance-lead:0xm:1", strategyId: "binance-lead", tokenId: UP, direction: "BUY",
    price: 0.63, shares: 10, timeInForce: "GTC", postOnly: false });
  p.core.applyFill({ tradeId: "t1", orderId: "0xb", tokenId: UP, direction: "BUY", price: 0.6, shares: 10, feeUsd: 0.17, ts: now.t, status: "CONFIRMED", isMaker: false });
  const sell = await p.core.submit({ clientOrderId: "binance-lead:0xm:exit", strategyId: "binance-lead", tokenId: UP, direction: "SELL",
    price: 0.5, shares: 10, timeInForce: "FAK", postOnly: false });
  assert.equal(sell.status, "OPEN", "the core accepts the sell");
  p.core.applyFill({ tradeId: "t2", orderId: "0xs", tokenId: UP, direction: "SELL", price: 0.58, shares: 10, feeUsd: 0.17, ts: now.t + 1, status: "CONFIRMED", isMaker: false });
  const pos = p.core.snapshot().positions.find(x => x.tokenId === UP);
  close(pos.shares, 0, "flat after the sell");
  close(p.core.snapshot().cashUsd, 100 - 6 - 0.17 + 5.8 - 0.17, "cash: bought 6.17, sold 5.63");
}
{
  // A GTC filled in part, its remainder resting: cancel it first, sell once it ended.
  const r = placed({ exitOnReverse: true });
  at(r.s, { kind: "order", order: { ...record(r.buy, "PARTIAL", 6, "0xb", S + 0.6), httpAckAt: S + 0.6 } }, S + 0.6);
  at(r.s, book(S + 1, 0.60, 0.42, 0.58, 0.40), S + 1);
  const six = account({ positions: [{ tokenId: UP, shares: 6, costUsd: 3.8, realizedPnlUsd: 0 }] });
  const out = at(r.s, lead(S + 10, "DOWN"), S + 10, six);
  assert.deepEqual(submits(out), [], "no sell while the remainder rests (it may be the bid)");
  assert.deepEqual(out.filter(a => a.kind === "cancel").map(a => a.orderId), ["0xb"], "the resting remainder is cancelled");
  assert.equal(r.s.exportState().rounds[0].exitFirst.waiting, true);
  assert.doesNotThrow(() => createStrategy({}, r.s.exportState()), "restores while waiting");
  assert.deepEqual(submits(at(r.s, book(S + 10.2, 0.60, 0.42, 0.57, 0.40), S + 10.2, six)), [], "still resting: still waiting");
  // The cancel lands with one more share filled: sell all 7 at the bid now.
  const seven = account({ positions: [{ tokenId: UP, shares: 7, costUsd: 4.4, realizedPnlUsd: 0 }] });
  const sold = submits(at(r.s, { kind: "order", order: { ...record(r.buy, "CANCELLED", 7, "0xb", S + 10.4), httpAckAt: S + 0.6 } }, S + 10.4, seven));
  assert.deepEqual(sold.map(o => [o.direction, o.shares, o.price]), [["SELL", 7, 0.49]], "sold at the bid then (0.57) - 0.08");
  const ef = r.s.exportState().rounds[0].exitFirst;
  assert.deepEqual([ef.waiting, ef.sent, ef.bid], [undefined, true, 0.58], "the record keeps the signal's bid");
  assert.deepEqual(submits(at(r.s, lead(S + 20, "DOWN"), S + 20, seven)), [], "never a second sell");
}
{
  // A rest order still being accepted (no orderId yet) at the signal: cancelled the moment its id arrives.
  const s = createStrategy({ limitPremium: 0.08, shares: 10, entryOrder: "fak", restAfterMissSec: 20, exitOnReverse: true });
  at(s, { kind: "timer", ts: START - 20 }, START - 20);
  at(s, book(S - 1, 0.55, 0.47), S - 1);
  const [fak] = submits(at(s, lead(S), S + 0.002));
  const [rest] = submits(at(s, { kind: "order", order: { ...record(fak, "CANCELLED", 4, "0xb", S + 0.3), httpAckAt: S + 0.3 } }, S + 0.3));
  assert.equal(rest?.clientOrderId, "binance-lead:0xm:rest", "a rest order for the other 6 was placed after the miss");
  at(s, book(S + 0.5, 0.60, 0.42, 0.58, 0.40), S + 0.5);
  const six = account({ positions: [{ tokenId: UP, shares: 4, costUsd: 2.5, realizedPnlUsd: 0 }] });
  // The reverse signal arrives before the rest order's id is back.
  const out = at(s, lead(S + 1, "DOWN"), S + 1, six);
  assert.deepEqual(out.filter(a => a.kind === "cancel"), [], "nothing to cancel yet (no id)");
  assert.equal(s.exportState().rounds[0].stages[1].cancelAt, S + 1, "its hold already ends now");
  // Its id arrives: the working-rounds path cancels it at once, not 20 s later.
  const now = S + 1.5;
  const c = s.onEvent({ kind: "order", order: record(rest, "OPEN", 0, "0xr", now) }, ctx(now, six));
  assert.deepEqual(c.filter(a => a.kind === "cancel").map(a => a.orderId), ["0xr"], "cancelled as soon as the id is known");
}
{
  // A FAK filled in part, still reporting (PARTIAL): never cancelled, waited for; restores meanwhile.
  const s = createStrategy({ limitPremium: 0.08, shares: 10, entryOrder: "fak", restAfterMissSec: 0, exitOnReverse: true });
  at(s, { kind: "timer", ts: START - 20 }, START - 20);
  at(s, book(S - 1, 0.55, 0.47), S - 1);
  const [buy] = submits(at(s, lead(S), S + 0.002));
  at(s, { kind: "order", order: { ...record(buy, "PARTIAL", 6, "0xb", S + 0.3), httpAckAt: S + 0.3 } }, S + 0.3);
  at(s, book(S + 1, 0.60, 0.42, 0.58, 0.40), S + 1);
  const six = account({ positions: [{ tokenId: UP, shares: 6, costUsd: 3.8, realizedPnlUsd: 0 }] });
  const out = at(s, lead(S + 1.5, "DOWN"), S + 1.5, six);
  assert.deepEqual(out.filter(a => a.kind === "submit" || a.kind === "cancel"), [], "no cancel of a FAK, no sell yet");
  assert.equal(s.exportState().rounds[0].stages[0].cancelAt, undefined, "a FAK gets no hold");
  assert.doesNotThrow(() => createStrategy({}, s.exportState()), "restores");
  const sold = submits(at(s, { kind: "order", order: { ...record(buy, "CANCELLED", 6, "0xb", S + 1.7), httpAckAt: S + 0.3 } }, S + 1.7, six));
  assert.deepEqual(sold.map(o => [o.direction, o.shares]), [["SELL", 6]], "sold once the FAK ended");
  // Still working 5 s before the close: given up.
  const w = createStrategy({ limitPremium: 0.08, shares: 10, entryOrder: "fak", restAfterMissSec: 0, exitOnReverse: true });
  at(w, { kind: "timer", ts: START - 20 }, START - 20);
  at(w, book(S - 1, 0.55, 0.47), S - 1);
  const [b2] = submits(at(w, lead(S), S + 0.002));
  at(w, { kind: "order", order: { ...record(b2, "PARTIAL", 6, "0xb", S + 0.3), httpAckAt: S + 0.3 } }, S + 0.3);
  at(w, book(S + 1, 0.60, 0.42, 0.58, 0.40), S + 1);
  at(w, lead(S + 1.5, "DOWN"), S + 1.5, six);
  assert.deepEqual(submits(at(w, { kind: "timer", ts: START + 296 }, START + 296, six)), []);
  const wf = w.exportState().rounds[0].exitFirst;
  assert.deepEqual([wf.waiting, wf.sent, wf.skip], [undefined, false, "buy_working"], "given up in the last 5 s");
}
{
  // A skipped exit (under the venue minimum once the FAK ended) still blocks the rest order.
  const s = createStrategy({ limitPremium: 0.08, shares: 10, entryOrder: "fak", restAfterMissSec: 4, exitOnReverse: true });
  at(s, { kind: "timer", ts: START - 20 }, START - 20);
  at(s, book(S - 1, 0.55, 0.47), S - 1);
  const [buy] = submits(at(s, lead(S), S + 0.002));
  at(s, { kind: "order", order: { ...record(buy, "PARTIAL", 3, "0xb", S + 0.3), httpAckAt: S + 0.3 } }, S + 0.3);
  at(s, book(S + 1, 0.60, 0.42, 0.58, 0.40), S + 1);
  const three = account({ positions: [{ tokenId: UP, shares: 3, costUsd: 1.9, realizedPnlUsd: 0 }] });
  at(s, lead(S + 1.5, "DOWN"), S + 1.5, three);
  const out = submits(at(s, { kind: "order", order: { ...record(buy, "CANCELLED", 3, "0xb", S + 1.6), httpAckAt: S + 0.3 } }, S + 1.6, three));
  assert.deepEqual(out, [], "no sell (3 < 5) and no rest BUY");
  assert.equal(s.exportState().rounds[0].exitFirst.skip, "below_min_size");
  assert.equal(s.exportState().rounds[0].stages.length, 1);
}
{
  // Waiting without a bid (a feed reset cleared the book): waits, sells on the next frame's bid.
  const r = filled({ exitOnReverse: true });
  const blocked = account({ positions: held.positions, risk: { blockedMarketIds: ["0xm"] } });
  at(r.s, lead(S + 10, "DOWN"), S + 10, blocked);
  at(r.s, { kind: "error", code: "market_feed_unhealthy", message: "market_feed_unhealthy", ts: S + 11 }, S + 11, held);
  assert.equal(r.s.exportState().rounds[0].exitFirst.waiting, true, "no bid: still waiting");
  const sold = submits(at(r.s, book(S + 12, 0.60, 0.42, 0.48, 0.40), S + 12, held));
  assert.deepEqual(sold.map(o => [o.direction, o.price]), [["SELL", 0.4]], "this frame's bid 0.48 - 0.08");
  // Account recovery (halted 账户恢复中) waits too; a hard halt gives up.
  const a = filled({ exitOnReverse: true });
  const recovering = account({ positions: held.positions, risk: { halted: true, reason: "账户恢复中", blockedMarketIds: ["0xm"] } });
  at(a.s, lead(S + 10, "DOWN"), S + 10, recovering);
  at(a.s, book(S + 11, 0.60, 0.42, 0.55, 0.40), S + 11, account({ positions: held.positions, risk: { halted: true, reason: "账户恢复中" } }));
  assert.equal(a.s.exportState().rounds[0].exitFirst.waiting, true, "recovering: still waiting");
  assert.equal(submits(at(a.s, book(S + 12, 0.60, 0.42, 0.55, 0.40), S + 12, held)).length, 1, "sold after the recovery");
  const h = filled({ exitOnReverse: true });
  at(h.s, lead(S + 10, "DOWN"), S + 10, blocked);
  at(h.s, book(S + 11, 0.60, 0.42, 0.55, 0.40), S + 11,
    account({ positions: held.positions, risk: { halted: true, reason: "unknown order requires reconciliation" } }));
  assert.equal(h.s.exportState().rounds[0].exitFirst.skip, "halted", "a hard halt gives up");
  // A restart while waiting gives it up (its signal is gone), never sells late.
  const w = filled({ exitOnReverse: true });
  at(w.s, lead(S + 10, "DOWN"), S + 10, blocked);
  const back = createStrategy({}, w.s.exportState());
  const wf = back.exportState().rounds[0].exitFirst;
  assert.deepEqual([wf.waiting, wf.skip, wf.sent], [undefined, "restart", false]);
  assert.deepEqual(submits(back.onEvent(book(S + 20, 0.60, 0.42, 0.55, 0.40), ctx(S + 20, held))), [], "not sent after the restart");
  // An adopted exit marks the record sent.
  const g = filled({ exitOnReverse: true });
  at(g.s, lead(S + 10, "DOWN"), S + 10, blocked);
  const ghost = { clientOrderId: "binance-lead:0xm:exit", assetId: "btc", marketId: "0xm", roundId: ROUND, tokenId: UP,
    direction: "SELL", price: 0.5, shares: 10, timeInForce: "FAK", postOnly: false };
  const adopted = createStrategy({}, g.s.exportState());
  adopted.onEvent({ kind: "order", order: record(ghost, "FILLED", 10, "0xs", S + 11) }, ctx(S + 11, held));
  const af = adopted.exportState().rounds[0].exitFirst;
  assert.deepEqual([af.sent, af.waiting, af.skip], [true, undefined, undefined], "adopted: sent");
}
{
  // The normal CDF saturates: a fair value of exactly 0 or 1 is recorded and restores.
  const r = placed({}, { price: 100600, openMean60: 100000, vol300Bp: 0.3 });
  const st = r.s.exportState().rounds[0].stages[0];
  assert.equal(st.fair, 1, "60 bp ahead with a calm 5 minutes: 1");
  assert.doesNotThrow(() => createStrategy({}, r.s.exportState()), "fair 1 restores");
  const d = placed({}, { price: 99400, openMean60: 100000, vol300Bp: 0.3 });
  assert.equal(d.s.exportState().rounds[0].stages[0].fair, 0, "60 bp behind: 0");
  assert.doesNotThrow(() => createStrategy({}, d.s.exportState()), "fair 0 restores");
}
{
  // Refused before the core recorded it; abandoned; still CREATED at the close.
  const r = filled({ exitOnReverse: true });
  at(r.s, lead(S + 10, "DOWN"), S + 10, held);
  at(r.s, { kind: "error", code: "order_not_submitted", message: "market reconciliation in progress",
    clientOrderId: "binance-lead:0xm:exit", ts: S + 10.01 }, S + 10.01, held);
  const ex = r.s.exportState().rounds[0].exit;
  assert.deepEqual([ex.status, ex.error], ["REJECTED", "market reconciliation in progress"]);
  // The journal still gets the refused sell's line.
  const refused = [];
  const rlog = createLeadOrderLog(id => r.s.stageFor(id), (fields, eventId) => refused.push({ fields, eventId }), id => r.s.exitFor(id));
  rlog.observe({ kind: "error", code: "order_not_submitted", message: "market reconciliation in progress",
    clientOrderId: "binance-lead:0xm:exit", ts: S + 10.01 }, S + 10.01);
  assert.deepEqual(refused.map(x => [x.eventId, x.fields.stage, x.fields.status]), [["lead_order:binance-lead:0xm:exit", "exit", "REJECTED"]]);
  assert.equal(r.s.exportState().rounds[0].reason, "反向信号卖单没成交，持有到结算");
  const a = filled({ exitOnReverse: true });
  const [sell] = submits(at(a.s, lead(S + 10, "DOWN"), S + 10, held));
  at(a.s, { kind: "order", order: record(sell, "UNKNOWN", 0, "0xs", S + 10.2) }, S + 10.2, held);
  at(a.s, { kind: "error", code: "order_abandoned", message: "absent from the venue", clientOrderId: sell.clientOrderId, ts: S + 20 }, S + 20, held);
  assert.equal(a.s.exportState().rounds[0].exit.status, "ABANDONED");
  const c = filled({ exitOnReverse: true });
  at(c.s, lead(S + 10, "DOWN"), S + 10, held);
  at(c.s, { kind: "timer", ts: START + 301 }, START + 301, held);
  assert.equal(c.s.exportState().rounds[0].exit.status, "ABANDONED", "CREATED at the close: abandoned");
}
{
  // No rest order once the round decided to sell (a FAK filled in part, its miss reported after the reverse signal).
  const s = createStrategy({ limitPremium: 0.08, shares: 10, entryOrder: "fak", restAfterMissSec: 4, exitOnReverse: true });
  at(s, { kind: "timer", ts: START - 20 }, START - 20);
  at(s, book(S - 1, 0.55, 0.47), S - 1);
  const [buy] = submits(at(s, lead(S), S + 0.002));
  at(s, { kind: "order", order: { ...record(buy, "PARTIAL", 6, "0xb", S + 0.3), httpAckAt: S + 0.3 } }, S + 0.3);
  at(s, book(S + 1, 0.60, 0.42, 0.58, 0.40), S + 1);
  const six = account({ positions: [{ tokenId: UP, shares: 6, costUsd: 3.8, realizedPnlUsd: 0 }] });
  assert.equal(submits(at(s, lead(S + 1.5, "DOWN"), S + 1.5, six)).length, 0, "waits for the FAK");
  const late = submits(at(s, { kind: "order", order: { ...record(buy, "CANCELLED", 6, "0xb", S + 1.6), httpAckAt: S + 0.3 } }, S + 1.6, six));
  assert.deepEqual(late.map(o => [o.direction, o.timeInForce]), [["SELL", "FAK"]], "the sell, and no rest order");
  assert.equal(s.exportState().rounds[0].stages.length, 1, "no rest stage");
}
{
  // The order log: the exit is its own lead_order; the shadow line carries the first signal.
  const r = filled({ exitOnReverse: true });
  const lines = [];
  const log = createLeadOrderLog(id => r.s.stageFor(id), (fields, eventId) => lines.push({ fields, eventId }), id => r.s.exitFor(id));
  const [sell] = submits(at(r.s, lead(S + 10, "DOWN"), S + 10, held));
  // The core reports the open order, its fill, then the FILLED update.
  const open = { ...record(sell, "OPEN", 0, "0xs", S + 10.6), httpAckAt: S + 10.6 };
  log.observe({ kind: "order", order: open }, S + 10.6);
  const fill = { tradeId: "t2", orderId: "0xs", tokenId: UP, direction: "SELL", price: 0.57, shares: 10, feeUsd: 0.17, ts: S + 10.7, status: "CONFIRMED", isMaker: false };
  log.observe({ kind: "fill", fill }, S + 10.7);
  assert.equal(lines.length, 0, "waits for the terminal update");
  const update = { ...record(sell, "FILLED", 10, "0xs", S + 10.7), httpAckAt: S + 10.6 };
  at(r.s, { kind: "order", order: update }, S + 10.7, held);
  log.observe({ kind: "order", order: update }, S + 10.7);
  assert.equal(lines.length, 1);
  const f = lines[0].fields;
  assert.equal(lines[0].eventId, "lead_order:binance-lead:0xm:exit");
  assert.deepEqual([f.stage, f.side, f.status, f.filled_shares, f.limit_price, f.bid_at_signal, f.sec_since_open],
    ["exit", "SELL", "FILLED", 10, 0.5, 0.58, 70]);
  close(f.proceeds_usd, 5.7 - 0.17, "proceeds less the fee");
  at(r.s, { kind: "timer", ts: START + 301 }, START + 301, held);
  const shadow = leadExitShadowFields(r.s.exportState().rounds[0]);
  assert.deepEqual([shadow.first_triggered, shadow.first_bid, shadow.first_sent, shadow.first_skip, shadow.exit_status, shadow.exit_filled],
    [true, 0.58, true, null, "FILLED", 10]);
  const off = filled({});
  at(off.s, lead(S + 10, "DOWN"), S + 10, held);
  const o = leadExitShadowFields(off.s.exportState().rounds[0]);
  assert.deepEqual([o.first_triggered, o.first_sent, o.first_skip, o.exit_status], [true, false, "off", null]);
  close(o.first_lead_bp, Math.log(100030 / 100020) * 1e4, "the shadow line carries the lead");
  // DOWN held: the same price is 1 bp against us; no open line: null.
  const dn = placed({}, {}, "DOWN");
  at(dn.s, { kind: "order", order: { ...record(dn.buy, "FILLED", 10, "0xd", S + 0.6), httpAckAt: S + 0.6 } }, S + 0.6);
  at(dn.s, book(S + 1, 0.60, 0.42, 0.58, 0.40), S + 1);
  at(dn.s, lead(S + 10, "UP"), S + 10, account({ positions: [{ tokenId: DOWN, shares: 10, costUsd: 6.3, realizedPnlUsd: 0 }] }));
  close(dn.s.exportState().rounds[0].exitFirst.leadBp, -Math.log(100030 / 100020) * 1e4, "held DOWN: signed the other way");
  const nl = filled({});
  at(nl.s, lead(S + 10, "DOWN", { openMean60: undefined }), S + 10, held);
  assert.equal(nl.s.exportState().rounds[0].exitFirst.leadBp, undefined, "no open line: no lead");
  assert.equal(leadExitShadowFields(nl.s.exportState().rounds[0]).first_lead_bp, null);
  // A state saved before the field restores.
  const old = filled({});
  at(old.s, lead(S + 10, "DOWN"), S + 10, held);
  const saved = old.s.exportState(); delete saved.rounds[0].exitFirst.leadBp;
  assert.doesNotThrow(() => createStrategy({ ...normalizeBinanceLeadConfig({}), exitOnReverse: false }, saved), "an older exit record restores");
}
{
  // Settlement: a sale's receipt (exchange OrderFilled) is never a redemption payout.
  const filledTopic = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";
  assert.equal(receiptIsTrade([{ address: CTF_EXCHANGE.toLowerCase(), topics: [filledTopic] }, { address: PUSD, topics: ["0xdd"] }]), true);
  assert.equal(receiptIsTrade([{ address: PUSD, topics: ["0xdd"] }]), false, "a redemption: pUSD only");
  assert.equal(receiptIsTrade([{ address: "0x" + "ab".repeat(20), topics: [filledTopic] }]), false, "OrderFilled from another contract");
}
console.log("edge-exit OK");
process.exit(0);
