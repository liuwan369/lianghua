// Binance lead strategy rules 4-7 (frozen 2026-10-25, E:/pm-backup/forward-binance-agg.py
// trade()): the round's first valid signal whose book in force is two-sided and
// was fresh on arrival gets one FAK BUY of 5 on the signal's side at ask + 0.03
// (on tick, <= 0.99); a stale/one-sided book waits for the next signal; one
// attempt per round; only rounds discovered before the open are traded.
//
// Drives the real compiled strategy (and once the real TradingPlatform/core
// with a fake gateway). Run after `npm run build`:
//   node scripts/regress/binance-lead-strategy.mjs
import assert from "node:assert/strict";
import { createStrategy, leadLimitPrice, normalizeBinanceLeadConfig, BINANCE_LEAD_DEFAULTS }
  from "../../dist/strategies/binance-lead.js";
import { TradingPlatform } from "../../dist/platform/platform.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = ({ risk = {}, ...rest } = {}) => ({ cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [],
  risk: { halted: false, availableUsd: 1000, occupiedUsd: 0, ...risk }, ...rest });
const ctx = (now, acct = account(), markets = [market]) => ({ mode: "live", now, markets, books: [], account: acct, estimateFee: () => 0.02 });
const book = (t, up, down, { age = 50, upAt = t, downAt = t, id = "0xm", round = ROUND } = {}) => ({ kind: "book", marketId: id, roundId: round,
  snapshot: { assetId: "btc", marketId: id, roundId: round, sourceAt: Math.max(upAt, downAt), expiresAt: t + 2, tsUnix: t,
    receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: age,
    YES: { assetId: UP, bid: up == null ? 0.5 : up - 0.01, ask: up, sourceAt: upAt, expiresAt: t + 2 },
    NO: { assetId: DOWN, bid: down == null ? 0.5 : down - 0.01, ask: down, sourceAt: downAt, expiresAt: t + 2 } } });
let tradeId = 0;
const lead = (S, direction = "UP", extra = {}) => ({ kind: "lead", assetId: "btc", direction, price: 100030, refPrice: 100000,
  moveBp: direction === "UP" ? 3 : -3, tradeId: ++tradeId, tradeTimeMs: (S - 0.125) * 1000, receivedAtUnix: S,
  receivedAtMonoMs: 1234.5, ...extra });
const submits = (actions) => actions.filter(a => a.kind === "submit").map(a => a.order);
const begin = (config = {}, options = {}) => {
  const s = createStrategy(config, undefined, options);
  s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
  return s;
};
// Event at its own time (book: t, lead: S + 2 ms processing, order: its updatedAt).
const on = (s, event, acct) => {
  const now = event.kind === "lead" ? event.receivedAtUnix + 0.002 : event.kind === "book" ? event.snapshot.tsUnix
    : event.kind === "order" ? event.order.updatedAt : event.ts;
  assert.ok(Number.isFinite(now), "every test event has a clock");
  return s.onEvent(event, ctx(now, acct));
};
const round = (s) => s.exportState().rounds[0];
const orderRecord = (o, status, filledShares, orderId = "0xorder", at = START + 21.3) => ({ ...o, strategyId: "binance-lead",
  orderId, status, filledShares, reservedUsd: 0, reservedShares: 0, createdAt: at, updatedAt: at });

// --- one round, one attempt: the first valid signal on a fresh book ---
{
  const s = begin();
  on(s, book(START + 20, 0.57, 0.45));
  const [order] = submits(on(s, lead(START + 21, "UP")));
  assert.ok(order, "the first valid signal places");
  assert.equal(order.tokenId, UP, "UP signal buys the UP token");
  assert.equal(order.price, 0.6, "limit = ask 0.57 + 0.03");
  assert.equal(order.shares, 5);
  assert.equal(order.timeInForce, "FAK");
  assert.equal(order.postOnly, false);
  assert.equal(order.direction, "BUY");
  assert.equal(order.clientOrderId, `binance-lead:0xm:1`);
  const stage = round(s).stages[0];
  assert.equal(stage.status, "CREATED");
  assert.equal(stage.askAtSignal, 0.57);
  assert.equal(stage.signal.direction, "UP");
  assert.equal(stage.signal.receivedAtUnix, START + 21);
  assert.equal(stage.feeReserveUsd, 0.02);
  // Filled or not, the round is done.
  on(s, { kind: "order", order: orderRecord(order, "CANCELLED", 0) });
  assert.equal(round(s).stages[0].status, "CANCELLED");
  assert.equal(round(s).reason, "本场已尝试，未成交");
  on(s, book(START + 30, 0.57, 0.45));
  assert.deepEqual(submits(on(s, lead(START + 31, "DOWN"))), [], "no second attempt after an unfilled FAK");
  assert.equal(round(s).stages.length, 1);
}
// --- DOWN buys the DOWN token at the DOWN ask ---
{
  const s = begin();
  on(s, book(START + 100, 0.52, 0.49));
  const [order] = submits(on(s, lead(START + 100.1, "DOWN")));
  assert.equal(order.tokenId, DOWN);
  assert.equal(order.price, 0.52, "0.49 + 0.03");
}
// --- the first valid signal on a stale book waits for the next one ---
{
  const s = begin();
  on(s, book(START + 20, 0.57, 0.45, { age: 2001 }));
  assert.deepEqual(submits(on(s, lead(START + 21))), [], "marketAgeMs 2001 > 2000 was not fresh on arrival");
  assert.match(round(s).reason, /不新鲜/);
  assert.equal(round(s).stages.length, 0, "a skipped signal does not use the round's attempt");
  on(s, book(START + 22, 0.60, 0.42, { age: 2000 }));     // exactly 2000 ms is fresh
  const [order] = submits(on(s, lead(START + 23)));
  assert.equal(order?.price, 0.63, "the next signal on a fresh book places at the book in force");
  // Arrival freshness only: the book is not required to be unexpired at S.
  const late = begin();
  on(late, book(START + 40, 0.57, 0.45));
  assert.equal(submits(on(late, lead(START + 50))).length, 1, "a book fresh on arrival still counts 10 s later");
}
// --- skew > 1.5 s, asks sum > 1.05, one side without an ask: no order ---
{
  for (const [frame, why] of [
    [book(START + 20, 0.57, 0.45, { upAt: START + 20, downAt: START + 18.4 }), /时间差/],
    [book(START + 20, 0.60, 0.46), /之和/],
    [book(START + 20, 0.57, undefined), /一边没有卖价/],
    [book(START + 20, 0.57, 1), /一边没有卖价/],
  ]) {
    const s = begin();
    on(s, frame);
    assert.deepEqual(submits(on(s, lead(START + 21))), [], String(why));
    assert.match(round(s).reason, why);
  }
  // The newest frame decides: a fresh two-sided frame followed by a one-sided one.
  const s = begin();
  on(s, book(START + 20, 0.57, 0.45));
  on(s, book(START + 20.5, 0.57, undefined));
  assert.deepEqual(submits(on(s, lead(START + 21))), [], "the one-sided latest frame is in force");
  // Exactly 1.5 s apart and a sum of exactly 1.05 are fresh.
  const edge = begin();
  on(edge, book(START + 20, 0.60, 0.45, { upAt: START + 20, downAt: START + 18.5 }));
  assert.equal(submits(on(edge, lead(START + 21))).length, 1);
  // No frame yet in this round.
  const none = begin();
  assert.deepEqual(submits(on(none, lead(START + 21))), []);
  assert.match(round(none).reason, /没有当前盘口/);
}
// --- another round's book never becomes this round's book in force ---
{
  const s = begin();
  on(s, book(START + 20, 0.57, 0.45, { id: "0xother", round: String(START + 300) }));
  assert.deepEqual(submits(on(s, lead(START + 21))), []);
}
// --- feed unhealthy / account recovery clears the book in force ---
{
  const s = begin();
  on(s, book(START + 20, 0.57, 0.45));
  s.onEvent({ kind: "error", strategyId: "binance-lead", marketId: "0xm", code: "market_feed_unhealthy",
    message: "market_feed_unhealthy:incomplete_book" }, ctx(START + 20.5));
  assert.deepEqual(submits(on(s, lead(START + 21))), [], "the live one-sided path: incomplete_book clears it");
  on(s, book(START + 22, 0.57, 0.45));
  s.onEvent({ kind: "error", strategyId: "binance-lead", code: "account_recovery_started", message: "account_recovery_started",
    marketIds: ["0xm"] }, ctx(START + 22.5));
  assert.deepEqual(submits(on(s, lead(START + 23))), []);
  on(s, book(START + 24, 0.57, 0.45));
  assert.equal(submits(on(s, lead(START + 25))).length, 1, "a new frame restores it");
}
// --- the valid period [R+15, R+265) is enforced here too ---
{
  const s = begin();
  on(s, book(START + 10, 0.57, 0.45));
  assert.deepEqual(submits(on(s, lead(START + 14.99))), []);
  on(s, book(START + 264, 0.57, 0.45));
  assert.deepEqual(submits(on(s, lead(START + 265))), []);
  assert.equal(submits(on(s, lead(START + 264.99))).length, 1);
}
// --- limit price: ask + premium on tick, at most 0.99 ---
{
  assert.equal(leadLimitPrice(0.57, 0.03, 0.01), 0.6);
  assert.equal(leadLimitPrice(0.97, 0.03, 0.01), 0.99, "1.00 is capped at 0.99");
  assert.equal(leadLimitPrice(0.555, 0.03, 0.001), 0.585);
  assert.equal(leadLimitPrice(0.555, 0.03, 0.01), 0.58, "rounded down: never pays above ask + premium");
  for (let c = 1; c <= 96; c++) {
    const ask = c / 100, p = leadLimitPrice(ask, 0.03, 0.01);
    assert.ok(Math.abs(p * 100 - Math.round(p * 100)) < 1e-9 && p <= 0.99 && p <= ask + 0.03 + 1e-12, `ask ${ask}`);
    assert.equal(p, Math.min(0.99, Number((ask + 0.03).toFixed(2))), `ask ${ask}`);
  }
  // The 0.99 cap only binds with an ask cap raised above the default 0.80.
  const s = begin({ maxAsk: 0.98 });
  on(s, book(START + 20, 0.98, 0.03));
  assert.equal(submits(on(s, lead(START + 21)))[0].price, 0.99);
  // An ask above 0.99 (tick 0.001) cannot be bought at the 0.99 cap: no order,
  // and the round keeps its one attempt for a later signal (review 10-25).
  const fine = { ...market, instruments: market.instruments.map(i => ({ ...i, tickSize: 0.001 })) };
  const high = createStrategy({ maxAsk: 0.999 });
  high.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20, account(), [fine]));
  high.onEvent(book(START + 20, 0.995, 0.006), ctx(START + 20, account(), [fine]));
  assert.deepEqual(submits(high.onEvent(lead(START + 21), ctx(START + 21.002, account(), [fine]))), []);
  assert.equal(high.exportState().rounds[0].stages.length, 0, "the attempt is not used");
  assert.match(high.exportState().rounds[0].reason, /0\.99/);
  high.onEvent(book(START + 22, 0.98, 0.03), ctx(START + 22, account(), [fine]));
  assert.equal(submits(high.onEvent(lead(START + 23), ctx(START + 23.002, account(), [fine])))[0].price, 0.99);
}
// --- ask cap (user 2026-10-26): a side asking above maxAsk (0.80) is not bought,
// and the round keeps its one attempt for a later signal. Backtest: fills above
// 0.9 made +0.004 a share, t 0.15 ---
{
  assert.equal(BINANCE_LEAD_DEFAULTS.maxAsk, 0.8);
  const s = begin();
  on(s, book(START + 20, 0.81, 0.20));
  assert.deepEqual(submits(on(s, lead(START + 21, "UP"))), [], "ask 0.81 > 0.80: no order");
  assert.equal(round(s).reason, "卖价 0.81 高于上限 0.80，等下一个信号");
  assert.equal(round(s).stages.length, 0, "the round's attempt is not used");
  assert.equal(s.getStatus().currentRound.attempted, false);
  on(s, book(START + 30, 0.42, 0.60));
  const [order] = submits(on(s, lead(START + 31, "DOWN")));
  assert.ok(order, "a later signal on a 0.60 ask places");
  assert.equal(order.tokenId, DOWN);
  assert.equal(order.price, 0.63, "0.60 + 0.03");
  // Exactly at the cap places.
  const edge = begin();
  on(edge, book(START + 20, 0.80, 0.21));
  assert.equal(submits(on(edge, lead(START + 21, "UP")))[0]?.price, 0.83, "ask 0.80 = cap: places at 0.83");
  // The cap is configurable.
  const raised = begin({ maxAsk: 0.9 });
  on(raised, book(START + 20, 0.85, 0.17));
  assert.equal(submits(on(raised, lead(START + 21, "UP")))[0]?.price, 0.88, "maxAsk 0.90 lets a 0.85 ask through");
  // A state saved before maxAsk existed restores with the default.
  const old = JSON.parse(JSON.stringify(begin().exportState()));
  delete old.config.maxAsk; delete old.rounds[0].config.maxAsk;
  const r = createStrategy({}, old);
  assert.equal(r.exportState().config.maxAsk, 0.8);
  assert.equal(r.exportState().rounds[0].config.maxAsk, 0.8, "the restored round gets the default cap");
  r.onEvent({ kind: "timer", ts: START - 15 }, ctx(START - 15));
  on(r, book(START + 20, 0.85, 0.17));
  assert.deepEqual(submits(on(r, lead(START + 21, "UP"))), [], "and applies it");
}
// --- the venue's 1 USD minimum for a marketable BUY (2026-10-26 live: 5 @ 0.13 = 0.65
// was "invalid amount for a marketable BUY order ($0.65), min size: 1") ---
{
  const s = begin();
  on(s, book(START + 20, 0.89, 0.10));
  const [order] = submits(on(s, lead(START + 21, "DOWN")));
  assert.ok(order, "a cheap side still trades");
  assert.equal(order.price, 0.13, "limit = ask 0.10 + 0.03");
  assert.ok(order.shares * order.price >= 1 - 1e-9, `the order is worth at least 1 USD: ${order.shares} x ${order.price}`);
  assert.equal(order.shares, 8, "the fewest whole shares that reach 1 USD at the limit (8 x 0.13 = 1.04)");
  // The restored state accepts the larger stage.
  assert.doesNotThrow(() => createStrategy({}, JSON.parse(JSON.stringify(s.exportState()))));
  // Above the minimum the configured size is kept.
  const t = begin();
  on(t, book(START + 20, 0.57, 0.45));
  assert.equal(submits(on(t, lead(START + 21)))[0].shares, 5, "5 x 0.60 = 3.00: the configured 5");
  // At exactly 1 USD (5 x 0.20) nothing changes.
  const u = begin();
  on(u, book(START + 20, 0.80, 0.17));
  assert.equal(submits(on(u, lead(START + 21, "DOWN")))[0].shares, 5, "5 x 0.20 = 1.00");
  // A round budget too small for the raised size skips the round rather than send a rejected order.
  const v = begin({ roundBudgetUsd: 0.9 });
  on(v, book(START + 20, 0.89, 0.10));
  assert.deepEqual(submits(on(v, lead(START + 21, "DOWN"))), [], "1.04 + fee is over a 0.90 round budget");
  assert.match(round(v).reason, /单场预算/);
}
// --- a round discovered after its open is not traded ---
{
  const s = createStrategy();
  s.onEvent({ kind: "timer", ts: START + 1 }, ctx(START + 1));
  on(s, book(START + 20, 0.57, 0.45));
  assert.deepEqual(submits(on(s, lead(START + 21))), []);
  assert.equal(round(s).status, "waiting_next_round");
  // Exactly at the open is still "before".
  const atOpen = createStrategy();
  atOpen.onEvent({ kind: "timer", ts: START }, ctx(START));
  on(atOpen, book(START + 20, 0.57, 0.45));
  assert.equal(submits(on(atOpen, lead(START + 21))).length, 1);
}
// --- paused, halted, blocked market: no order, and the attempt is not used ---
{
  const s = begin();
  s.setPaused(true);
  on(s, book(START + 20, 0.57, 0.45));
  assert.deepEqual(submits(on(s, lead(START + 21))), []);
  assert.equal(round(s).reason, "已暂停新增交易");
  s.setPaused(false);
  assert.equal(submits(on(s, lead(START + 22))).length, 1, "after resume the next signal places on the tracked book");
  for (const risk of [{ halted: true, reason: "daily loss limit" }, { blockedMarketIds: ["0xm"] }]) {
    const h = begin();
    on(h, book(START + 20, 0.57, 0.45));
    assert.deepEqual(submits(on(h, lead(START + 21), account({ risk }))), [], JSON.stringify(risk));
    assert.equal(round(h).stages.length, 0);
  }
}
// --- budget checks ---
{
  const cases = [
    [{ roundBudgetUsd: 3 }, account(), /单场预算/],                      // 5 × 0.60 + 0.02 > 3
    [{ totalBudgetUsd: 10 }, account({ risk: { occupiedUsd: 8 } }), /总资金预算/],
    [{}, account({ risk: { availableUsd: 3 } }), /可用余额/],
    [{ roundBudgetUsd: 5 }, account({ positions: [{ tokenId: DOWN, shares: 5, costUsd: 2.5, realizedPnlUsd: 0 }] }), /单场预算/],
  ];
  for (const [config, acct, why] of cases) {
    const s = begin(config);
    on(s, book(START + 20, 0.57, 0.45));
    assert.deepEqual(submits(on(s, lead(START + 21), acct)), [], String(why));
    assert.match(round(s).reason, why);
  }
  const ok = begin({ roundBudgetUsd: 3.02 });
  on(ok, book(START + 20, 0.57, 0.45));
  const [order] = submits(on(ok, lead(START + 21)));
  assert.equal(order.roundBudgetUsd, 3.02, "the round cap goes to the core with the order");
}
// --- order_not_submitted: rejected, no retry in the round ---
{
  const s = begin();
  on(s, book(START + 20, 0.57, 0.45));
  const [order] = submits(on(s, lead(START + 21)));
  s.onEvent({ kind: "error", strategyId: "binance-lead", clientOrderId: order.clientOrderId, code: "order_not_submitted",
    message: "insufficient cash or capital" }, ctx(START + 21.1));
  assert.equal(round(s).stages[0].status, "REJECTED");
  on(s, book(START + 22, 0.57, 0.45));
  assert.deepEqual(submits(on(s, lead(START + 23))), []);
}
// --- restart: a CREATED intent is ABANDONED, never replayed, round stays attempted ---
{
  const saved = [];
  const s = begin({}, { persist: state => saved.push(state) });
  on(s, book(START + 20, 0.57, 0.45));
  assert.equal(submits(on(s, lead(START + 21))).length, 1);
  const state = s.exportState();
  assert.equal(state.rounds[0].stages[0].status, "CREATED");
  assert.equal(saved.at(-1).rounds[0].stages[0].status, "CREATED", "the intent was persisted before the submit returned");
  const persisted = [];
  const r = createStrategy({}, JSON.parse(JSON.stringify(state)), { persist: st => persisted.push(st) });
  assert.equal(r.exportState().rounds[0].stages[0].status, "ABANDONED");
  assert.equal(r.exportState().rounds[0].latest, undefined, "the old book is not restored");
  const actions = r.onEvent(book(START + 22, 0.57, 0.45), ctx(START + 22));
  assert.deepEqual(submits(actions), [], "nothing is replayed");
  assert.equal(persisted.at(-1)?.rounds[0].stages[0].status, "ABANDONED", "the abandonment is saved");
  assert.deepEqual(submits(on(r, lead(START + 23))), [], "the round already had its attempt");
  // Invalid restored stage shapes are refused.
  const bad = JSON.parse(JSON.stringify(state));
  bad.rounds[0].stages[0].price = 0.7;                                  // above ask 0.57 + 0.03
  assert.throws(() => createStrategy({}, bad));
  const two = JSON.parse(JSON.stringify(state));
  two.rounds[0].stages.push({ ...two.rounds[0].stages[0] });
  assert.throws(() => createStrategy({}, two));
}
// --- crash before the stage was saved: the core's order is the round's attempt (review 10-25) ---
// The core persists the signed order (.intent) before POST but the strategy
// state only on the next flush. After a crash in between, the restored core
// holds the order and the strategy has no stage: the order must count as the
// round's attempt (no second order), and later events must not throw on it.
{
  const s = begin();
  const lost = s.exportState();                                         // saved before the signal
  on(s, book(START + 20, 0.57, 0.45));
  const [order] = submits(on(s, lead(START + 21, "UP")));
  const pending = { ...orderRecord(order, "UNKNOWN", 0), reconciliationPending: true };
  const acct = account({ orders: [pending] });
  const r = createStrategy({}, JSON.parse(JSON.stringify(lost)));
  r.onEvent(book(START + 30, 0.6, 0.42), ctx(START + 30, acct));
  assert.deepEqual(submits(r.onEvent(lead(START + 31, "DOWN"), ctx(START + 31.002, acct))), [],
    "the restored core order is this round's attempt");
  const stage = r.exportState().rounds[0].stages[0];
  assert.ok(stage, "the order is adopted as the round's stage");
  assert.equal(stage.direction, "UP");
  assert.equal(stage.price, order.price);
  assert.equal(stage.status, "UNKNOWN");
  // Later rounds keep trading: no strategy_callback_failed loop.
  const next = { ...market, id: "0xn", roundId: String(START + 300), name: `btc-updown-5m-${START + 300}`,
    startsAt: START + 300, endsAt: START + 600, instruments: market.instruments.map(i => ({ ...i, marketId: "0xn" })) };
  r.onEvent({ kind: "timer", ts: START + 290 }, ctx(START + 290, acct, [market, next]));
  r.onEvent(book(START + 320, 0.57, 0.45, { id: "0xn", round: String(START + 300) }), ctx(START + 320, acct, [market, next]));
  const [later] = submits(r.onEvent(lead(START + 321), ctx(START + 321.002, acct, [market, next])));
  assert.equal(later?.clientOrderId, "binance-lead:0xn:1", "the next round places its own order");
  // A core order that disagrees with an existing stage is recorded, not thrown.
  const odd = createStrategy();
  odd.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
  odd.onEvent(book(START + 20, 0.57, 0.45), ctx(START + 20));
  const [mine] = submits(odd.onEvent(lead(START + 21), ctx(START + 21.002)));
  const other = account({ orders: [{ ...orderRecord(mine, "OPEN", 0), price: 0.66 }] });
  assert.doesNotThrow(() => odd.onEvent({ kind: "timer", ts: START + 22 }, ctx(START + 22, other)));
  assert.match(odd.exportState().rounds[0].stages[0].error ?? "", /不一致/);
}
// --- close: an unfilled remainder is cancelled, a filled order is not ---
{
  const s = begin();
  on(s, book(START + 20, 0.57, 0.45));
  const [order] = submits(on(s, lead(START + 21)));
  on(s, { kind: "order", order: orderRecord(order, "PARTIAL", 2) });
  assert.match(round(s).reason, /买到 2\/5/);
  const closing = s.onEvent({ kind: "timer", ts: START + 300 }, ctx(START + 300));
  assert.deepEqual(closing.filter(a => a.kind === "cancel"), [{ kind: "cancel", orderId: "0xorder" }]);
  assert.equal(round(s).status, "ended");
  assert.deepEqual(s.onEvent({ kind: "timer", ts: START + 300.5 }, ctx(START + 300.5)), [], "no cancel storm within 1 s");
  assert.equal(s.onEvent({ kind: "timer", ts: START + 301.5 }, ctx(START + 301.5)).length, 1, "an unconfirmed cancel is retried");
  const f = begin();
  on(f, book(START + 20, 0.57, 0.45));
  const [filled] = submits(on(f, lead(START + 21)));
  on(f, { kind: "order", order: orderRecord(filled, "FILLED", 5) });
  assert.deepEqual(f.onEvent({ kind: "timer", ts: START + 300 }, ctx(START + 300)), []);
  // An intent never handed to the execution layer is abandoned at the close.
  const c = begin();
  on(c, book(START + 20, 0.57, 0.45));
  submits(on(c, lead(START + 21)));
  c.onEvent({ kind: "timer", ts: START + 300 }, ctx(START + 300));
  assert.equal(round(c).stages[0].status, "ABANDONED");
}
// --- config freeze: changes follow until 10 s before the open, then the round keeps its copy ---
{
  const s = begin();
  s.updateConfig({ shares: 7 });                                   // 20 s before: follows
  assert.equal(round(s).config.shares, 7);
  s.onEvent({ kind: "timer", ts: START - 9 }, ctx(START - 9));
  s.updateConfig({ shares: 9, limitPremium: 0.05 });              // 9 s before: frozen
  assert.equal(round(s).config.shares, 7);
  assert.equal(s.exportState().config.shares, 9, "the saved config is the next round's");
  on(s, book(START + 20, 0.57, 0.45));
  const [order] = submits(on(s, lead(START + 21)));
  assert.equal(order.shares, 7);
  assert.equal(order.price, 0.6, "the frozen premium 0.03, not 0.05");
  assert.equal(s.activeRoundConfig(START + 21).shares, 7);
}
// --- another asset's lead is ignored; status shape ---
{
  const s = begin();
  on(s, book(START + 20, 0.57, 0.45));
  assert.deepEqual(submits(on(s, lead(START + 21, "UP", { assetId: "eth" }))), []);
  const status = s.getStatus();
  assert.equal(status.currentRound.marketId, "0xm");
  assert.equal(status.currentRound.isRunning, true);
  assert.equal(status.currentRound.attempted, false);
}
// --- config normalisation ---
{
  assert.deepEqual({ ...normalizeBinanceLeadConfig({}) }, { ...BINANCE_LEAD_DEFAULTS });
  assert.equal(BINANCE_LEAD_DEFAULTS.shares, 5);
  assert.equal(BINANCE_LEAD_DEFAULTS.thresholdBp, 2);
  assert.equal(BINANCE_LEAD_DEFAULTS.windowMs, 250);
  assert.equal(BINANCE_LEAD_DEFAULTS.limitPremium, 0.03);
  assert.equal(BINANCE_LEAD_DEFAULTS.fromSec, 15);
  assert.equal(BINANCE_LEAD_DEFAULTS.toSec, 265);
  for (const bad of [{ fromSec: 265, toSec: 15 }, { toSec: 301 }, { fromSec: -1 }, { shares: 0 }, { thresholdBp: 0 },
    { windowMs: 0 }, { limitPremium: 1 }, { limitPremium: -0.01 }, { maxQuoteAgeSeconds: 0 }, { roundBudgetUsd: 0 },
    { dailyLossUsd: 0 }, { instanceId: "a b" }, { maxAsk: 0 }, { maxAsk: 1 }, { maxAsk: -0.1 }, { maxAsk: "0.8" }]) {
    assert.throws(() => normalizeBinanceLeadConfig(bad), JSON.stringify(bad));
  }
  assert.equal(normalizeBinanceLeadConfig({ maxAsk: 0.99 }).maxAsk, 0.99);
  assert.equal(normalizeBinanceLeadConfig({ maxAsk: 0.01 }).maxAsk, 0.01);
}
// --- through the real platform: FAK reaches the gateway with the lead's receive time as trigger ---
{
  let now = START - 20;
  const calls = [];
  const gateway = { mode: "live", durableIdentity: false,
    async submit(request, instrument, prepared, timing) { calls.push({ request, timing }); return { status: "accepted", orderId: "0xvenue" }; },
    async cancel() { return true; } };
  const platform = new TradingPlatform({ account: { accountId: "t", at: START - 60, cashAt: START - 60, cashUsd: 100, positions: [],
    openOrders: [], complete: true }, instruments: market.instruments,
    limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, now: () => now,
    adapters: { gateway, estimateFee: () => 0.05 } });
  platform.ingest({ kind: "market", market });
  const strategy = createStrategy();
  platform.attach(strategy);
  platform.ingest({ kind: "timer", ts: now });
  now = START + 20;
  const side = (tokenId, ask) => ({ assetId: tokenId, bid: ask - 0.01, ask, bidSize: 100, askSize: 100, sourceAt: now, expiresAt: now + 2 });
  platform.ingest({ kind: "book", marketId: "0xm", roundId: ROUND, snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND,
    sourceAt: now, expiresAt: now + 2, tsUnix: now, receivedAtUnix: now, receivedAtMonoMs: performance.now(), marketAgeMs: 40,
    YES: side(UP, 0.57), NO: side(DOWN, 0.45) } });
  now = START + 21.002;
  const signal = lead(START + 21, "UP", { receivedAtMonoMs: performance.now() - 3 });
  platform.ingest(signal);
  await platform.idle();
  assert.equal(calls.length, 1, "the lead event reached the strategy and its order the gateway");
  assert.equal(calls[0].request.timeInForce, "FAK");
  assert.equal(calls[0].request.price, 0.6);
  assert.equal(calls[0].request.strategyId, "binance-lead");
  assert.equal(calls[0].timing?.triggerReceivedAtMonoMs, signal.receivedAtMonoMs, "trigger = the trade's receive time");
  assert.ok(calls[0].timing.decisionAtMonoMs >= signal.receivedAtMonoMs);
  assert.equal(platform.core.orders()[0].status, "OPEN");
}
console.log("binance-lead-strategy OK");
