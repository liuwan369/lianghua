// Retry on a reverse signal after a miss (user 2026-11-27, off by default).
//
// Today a round has one buy: a missed order (0 shares, cancelled) ends it.
// New: when the round's buy ended with 0 shares and nothing of the round is
// working, a later signal the OTHER way whose pre-move price was within
// retryReverseBp of the open line, still on the first signal's side of it (so
// the 2 bp move pulls the price back to the line), gets ONE more buy. Every
// other rule is the first buy's (window, band, maxAsk, regime, minEdge, edge
// sizing, budgets, cash). Replay 11-19..11-26
// (E:/pm-backup/live/day-1126b/retry_rules.py): pre-move 0-3 bp from the
// line, 33 rounds, won 67%, +0.24 a share.
//
// Recorded always (round.retryShadow), sent only with retryReverse on.
//
//  1  off: the shadow is recorded, no second order, the round keeps one buy
//  2  on: a reverse signal 2 bp from the line gets the retry, client id
//     :retry, on the other token, at its own ask + premium, the round's
//     entry order kind
//  3  only once a round: a later signal is skipped
//  4  same-direction signal: no retry, nothing recorded
//  5  pre-move too far (4.5 bp): no retry, recorded "too_far"; a closer
//     reverse signal later still gets it
//  6  pre-move already past the line: no retry, recorded "past_line"
//  7  a first buy that got ANY shares: no retry, nothing recorded
//  8  a first buy still resting: no retry until it ends
//  9  with exitOnReverse on and no shares (so no sell): the retry goes
// 10  the first buy's gates apply (maxAsk, toSec), recorded "gate"
// 11  restore: the retry stage survives; a :retry order only the core holds is
//     adopted, and the round then sends no other retry
// 12  a missed retry is followed by neither a rest order nor a third buy
// 13  config: off by default, retryReverseBp 3, in (0, 10], booleans checked
// 14  presign: on, the other side's limits are already among those signed
//     (the plan covers every ask up to maxAsk on both tokens)
// 15  the order log writes the retry as stage "retry"
//
// Run after `npm run build`:  node scripts/regress/retry-reverse.mjs
import assert from "node:assert/strict";
import { createStrategy, normalizeBinanceLeadConfig } from "../../dist/strategies/binance-lead.js";
import { leadOrderFields, leadExitShadowFields, leadRetryShadowFields, createLeadRetryShadowLog } from "../../dist/cli/platform.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const BASE = { limitPremium: 0.04, shares: 10, entryOrder: "gtc", restAfterMissSec: 5, maxAsk: 0.65, openLine: "mean60" };
const OPEN = 100000;
const bpPrice = (n) => OPEN * (1 + n / 1e4);
const FIRST = "binance-lead:0xm:1", RETRY = "binance-lead:0xm:retry";
const submits = actions => actions.filter(a => a.kind === "submit").map(a => a.order);

function harness(config = {}) {
  const s = createStrategy({ ...BASE, ...config });
  const orders = new Map();
  let positions = [];
  const account = () => ({ cashUsd: 1000, positions, orders: [...orders.values()], quarantinedOrderIds: [],
    risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } });
  const ctx = (now) => ({ mode: "live", now, markets: [market], books: [], account: account(), estimateFee: () => 0.02 });
  let now = START - 20;
  s.onEvent({ kind: "timer", ts: now }, ctx(now));
  const at = (sec) => { now = START + sec; };
  const tick = () => s.onEvent({ kind: "timer", ts: now }, ctx(now));
  const book = (ua, da) => s.onEvent({ kind: "book", marketId: "0xm", roundId: ROUND,
    snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND, sourceAt: now, expiresAt: now + 2, tsUnix: now, receivedAtUnix: now,
      receivedAtMonoMs: 0, marketAgeMs: 50, YES: { assetId: UP, bid: ua - 0.01, ask: ua, sourceAt: now, expiresAt: now + 2 },
      NO: { assetId: DOWN, bid: da - 0.01, ask: da, sourceAt: now, expiresAt: now + 2 } } }, ctx(now));
  let trade = 1;
  // A 2 bp signal whose pre-move price was `fromBp` off the open in the
  // signal's own sense (negative = still on the other side of the line).
  const lead = (direction, fromBp) => {
    const sign = direction === "UP" ? 1 : -1;
    return s.onEvent({ kind: "lead", assetId: "btc", direction, price: bpPrice(sign * (fromBp + 2.02)), refPrice: bpPrice(sign * fromBp),
      moveBp: sign * 2.02, venue: "bybit", line: "direct", tradeId: trade++, tradeTimeMs: (now - 0.1) * 1000,
      receivedAtUnix: now, receivedAtMonoMs: 1, openPrice: OPEN, openMean60: OPEN, vol300Bp: 0.5, signals300: 4 }, ctx(now));
  };
  const update = (sent, status, filled = 0, extra = {}) => {
    const record = { ...sent, strategyId: "binance-lead", orderId: `o-${sent.clientOrderId}`, status, filledShares: filled,
      reservedUsd: 0, reservedShares: 0, createdAt: now, updatedAt: now, httpAckAt: now, venueReplyAt: now, ...extra };
    orders.set(sent.clientOrderId, record);
    return s.onEvent({ kind: "order", order: record }, ctx(now));
  };
  const round = () => s.exportState().rounds[0];
  const hold = (tokenId, shares, costUsd) => { positions = [{ tokenId, shares, costUsd }]; };
  return { s, at, tick, book, lead, update, round, hold };
}

// A first UP buy that rests 5 s and is cancelled with 0 shares, then the
// book turns: DOWN's ask 0.31.
function missedUp(h) {
  h.at(40); h.book(0.40, 0.61);
  const [first] = submits(h.lead("UP", 3));
  assert.equal(first?.clientOrderId, FIRST, "precondition: the round's first buy");
  h.update(first, "OPEN");
  h.at(46); h.update(first, "CANCELLED");
  h.at(60); h.book(0.70, 0.31);
  return first;
}

// 1 off: recorded, nothing sent.
{
  const h = harness();
  missedUp(h);
  assert.deepEqual(submits(h.lead("DOWN", -2)), [], "off: no second order");
  const shadow = h.round().retryShadow;
  assert.ok(shadow, "the shadow is recorded with the switch off");
  assert.equal(shadow.direction, "DOWN");
  assert.equal(shadow.sent, false);
  assert.equal(shadow.skip, "off");
  assert.ok(Math.abs(shadow.preBp + 2) < 0.01, `pre-move distance ${shadow.preBp}`);
  assert.equal(shadow.ask, 0.31, "the reverse side's ask then");
  assert.equal(h.round().stages.length, 1, "the round keeps its one buy");
}
// 2 on: the retry goes out on the other token. 3 once. 12 no rest after it.
{
  const h = harness({ retryReverse: true });
  missedUp(h);
  const [retry, ...more] = submits(h.lead("DOWN", -2));
  assert.equal(more.length, 0);
  assert.equal(retry?.clientOrderId, RETRY, "client id :retry");
  assert.equal(retry.tokenId, DOWN);
  assert.equal(retry.price, 0.35, "its own limit: DOWN's ask 0.31 + 0.04");
  assert.equal(retry.shares, 10);
  assert.equal(retry.timeInForce, "GTC");
  assert.equal(retry.postOnly, false, "the round's entry order kind");
  const stage = h.round().stages[1];
  assert.equal(stage.kind, "retry");
  assert.equal(stage.direction, "DOWN");
  assert.equal(h.round().retryShadow.sent, true);
  h.update(retry, "OPEN");
  h.at(66);
  const cancels = h.tick().filter(a => a.kind === "cancel");
  assert.deepEqual(cancels.map(c => c.orderId), [`o-${RETRY}`], "the retry rests restAfterMissSec, then is cancelled");
  h.update(retry, "CANCELLED");
  h.at(80); h.book(0.40, 0.61);
  assert.deepEqual(submits(h.lead("UP", -2)), [], "a third signal: no third buy");
  assert.deepEqual(submits(h.lead("DOWN", -2)), [], "nor another reverse one");
  h.at(81);
  assert.deepEqual(submits(h.tick()), [], "no rest after the retry");
  assert.equal(h.round().stages.length, 2);
}
// 4 same direction: no retry, nothing recorded.
{
  const h = harness({ retryReverse: true });
  missedUp(h);
  h.book(0.40, 0.61);
  assert.deepEqual(submits(h.lead("UP", -2)), [], "same direction: no retry");
  assert.equal(h.round().retryShadow, undefined);
}
// 5 too far; a closer one later still gets it.
{
  const h = harness({ retryReverse: true });
  missedUp(h);
  assert.deepEqual(submits(h.lead("DOWN", -4.5)), [], "4.5 bp off: no retry");
  assert.equal(h.round().retryShadow.skip, "too_far");
  h.at(70); h.book(0.70, 0.31);
  assert.equal(submits(h.lead("DOWN", -1.5)).length, 1, "a closer reverse signal later does");
  assert.equal(h.round().retryShadow.sent, true, "the shadow is the one that was acted on");
}
// 6 already past the line.
{
  const h = harness({ retryReverse: true });
  missedUp(h);
  assert.deepEqual(submits(h.lead("DOWN", 0.5)), [], "already past the line: no retry");
  assert.equal(h.round().retryShadow.skip, "past_line");
}
// 7 a first buy with ANY shares.
{
  const h = harness({ retryReverse: true });
  h.at(40); h.book(0.40, 0.61);
  const [first] = submits(h.lead("UP", 3));
  h.update(first, "OPEN");
  h.at(46); h.update(first, "CANCELLED", 0.93);
  h.at(60); h.book(0.70, 0.31);
  assert.deepEqual(submits(h.lead("DOWN", -2)), [], "held shares: no retry");
  assert.equal(h.round().retryShadow, undefined, "a held round is not recorded here");
}
// 8 the first buy still resting.
{
  const h = harness({ retryReverse: true, restAfterMissSec: 30 });
  h.at(40); h.book(0.40, 0.61);
  const [first] = submits(h.lead("UP", 3));
  h.update(first, "OPEN");
  h.at(50); h.book(0.70, 0.31);
  assert.deepEqual(submits(h.lead("DOWN", -2)), [], "first buy still resting: no retry");
  assert.equal(h.round().retryShadow, undefined, "nothing recorded while it works");
}
// 9 exitOnReverse on, no shares so no sell: the retry goes.
{
  const h = harness({ retryReverse: true, exitOnReverse: true });
  missedUp(h);
  assert.equal(h.round().exit, undefined, "precondition: no exit");
  assert.equal(submits(h.lead("DOWN", -2)).length, 1);
}
// 10 the first buy's gates apply.
{
  const h = harness({ retryReverse: true });
  missedUp(h);
  h.book(0.30, 0.71);
  assert.deepEqual(submits(h.lead("DOWN", -2)), [], "DOWN's ask 0.71 over maxAsk 0.65: no retry");
  assert.equal(h.round().retryShadow.skip, "gate");
  assert.match(h.round().retryShadow.reason, /上限/);
  // ...and a later signal that passes the gates still gets it.
  h.at(70); h.book(0.70, 0.31);
  assert.equal(submits(h.lead("DOWN", -2)).length, 1, "a gate-blocked reverse signal does not use the retry up");
}
{
  const h = harness({ retryReverse: true, toSec: 100 });
  missedUp(h);
  h.at(120); h.book(0.70, 0.31);
  assert.deepEqual(submits(h.lead("DOWN", -2)), [], "past toSec: no retry");
}
// 11 restore and adoption.
{
  const h = harness({ retryReverse: true });
  missedUp(h);
  const [retry] = submits(h.lead("DOWN", -2));
  const state = h.s.exportState();
  const again = createStrategy({ ...BASE, retryReverse: true }, state);
  assert.equal(again.exportState().rounds[0].stages[1].kind, "retry", "the retry stage is restored");
  assert.equal(again.stageFor(RETRY)?.stage.direction, "DOWN");
  // The state saved before the retry; the core holds the :retry order.
  const before = structuredClone(state);
  before.rounds[0].stages = before.rounds[0].stages.slice(0, 1);
  delete before.rounds[0].retryShadow;
  const adopted = createStrategy({ ...BASE, retryReverse: true }, before);
  const orphan = { ...retry, strategyId: "binance-lead", orderId: "o-retry", status: "OPEN", filledShares: 0,
    reservedUsd: 3.5, reservedShares: 0, createdAt: START + 60, updatedAt: START + 60 };
  const ctx = { mode: "live", now: START + 61, markets: [market], books: [], estimateFee: () => 0.02,
    account: { cashUsd: 1000, positions: [], orders: [orphan], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } } };
  adopted.onEvent({ kind: "order", order: orphan }, ctx);
  const r = adopted.exportState().rounds[0];
  assert.equal(r.stages.length, 2, "the orphan retry is adopted");
  assert.equal(r.stages[1].kind, "retry");
  assert.equal(r.stages[1].direction, "DOWN");
  assert.equal(r.retryShadow?.sent, true, "the round knows its retry was sent");
  // A missing first stage is not invented: a :retry orphan alone is not adopted.
  const empty = structuredClone(state);
  empty.rounds[0].stages = [];
  delete empty.rounds[0].retryShadow;
  const lone = createStrategy({ ...BASE, retryReverse: true }, empty);
  lone.onEvent({ kind: "order", order: orphan }, { ...ctx });
  assert.equal(lone.exportState().rounds[0].stages.length, 0, "a retry without the round's first buy is not adopted");
}
// 16 after a FILLED retry, the round holds the retry's side: the exit (and its
// shadow) judge reverse signals against THAT side and sell THAT token. Before
// this, stages[0] (the first buy, 0 shares, the other side) was taken as "the buy".
{
  const h = harness({ retryReverse: true, exitOnReverse: true });
  missedUp(h);
  const [retry] = submits(h.lead("DOWN", -2));
  h.update(retry, "FILLED", 10);
  h.hold(DOWN, 10, 3.5);
  h.at(90); h.book(0.30, 0.60);
  // An UP signal is the reverse of what we now hold (DOWN): the exit fires on it.
  const actions = h.lead("UP", 1);
  const sells = submits(actions).filter(o => o.direction === "SELL");
  assert.equal(sells.length, 1, "the held DOWN shares are sold on an UP signal");
  assert.equal(sells[0].tokenId, DOWN, "the sell is of the token held, not the first buy's");
  assert.equal(h.round().exitFirst.shares, 10);
  assert.equal(h.round().exitFirst.bid, 0.59, "DOWN's bid, the held side's");
}
{
  // A DOWN signal is the same side as the held retry: no exit on it.
  const h = harness({ retryReverse: true, exitOnReverse: true });
  missedUp(h);
  const [retry] = submits(h.lead("DOWN", -2));
  h.update(retry, "FILLED", 10);
  h.at(90); h.book(0.30, 0.60);
  assert.deepEqual(submits(h.lead("DOWN", 1)).filter(o => o.direction === "SELL"), [], "same side as held: no exit");
  assert.equal(h.round().exitFirst, undefined);
}
{
  // The exit shadow line names the held side and token.
  const h = harness({ retryReverse: true });
  missedUp(h);
  const [retry] = submits(h.lead("DOWN", -2));
  h.update(retry, "FILLED", 10);
  const fields = leadExitShadowFields(h.round());
  assert.equal(fields.direction, "DOWN");
  assert.equal(fields.token_id, DOWN);
  assert.equal(fields.held_shares, 10);
}
// 17 the journal line: one lead_retry_shadow per round with a judged reverse
// signal, written at the round's end (after its result is known), the switch's
// state and what the retry got.
{
  const h = harness();
  missedUp(h);
  h.lead("DOWN", -2);
  const f = leadRetryShadowFields(h.round());
  assert.equal(f.market_id, "0xm");
  assert.equal(f.round_start, START);
  assert.equal(f.first_direction, "UP");
  assert.equal(f.direction, "DOWN");
  assert.equal(f.token_id, DOWN, "the token the retry buys (joins the round's winner)");
  assert.ok(Math.abs(f.pre_bp + 2) < 0.01);
  assert.equal(f.ask, 0.31);
  assert.equal(f.sent, false);
  assert.equal(f.skip, "off");
  assert.equal(f.sec_since_open, 60);
  assert.equal(f.retry_status, null, "nothing sent");
  assert.equal(f.limit_premium, 0.04, "the shadow is scored at ask + the round's premium");
  assert.equal(f.config_shares, 10);
  // A round without a judged reverse signal writes nothing.
  const quiet = harness();
  missedUp(quiet);
  assert.equal(leadRetryShadowFields(quiet.round()), undefined);
  // Sent: what it filled.
  const on = harness({ retryReverse: true });
  missedUp(on);
  const [retry] = submits(on.lead("DOWN", -2));
  on.update(retry, "FILLED", 10);
  const g = leadRetryShadowFields(on.round());
  assert.equal(g.sent, true);
  assert.equal(g.retry_status, "FILLED");
  assert.equal(g.retry_filled, 10);
  assert.equal(g.retry_price, 0.35);
  assert.equal(g.retry_client_order_id, RETRY);
  // The log writes it once, at the round's end, only for rounds this run watched.
  const lines = [];
  const log = createLeadRetryShadowLog(() => [h.round()], (fields, id) => lines.push([id, fields]), START - 10);
  log.observe(START + 200);
  assert.equal(lines.length, 0, "not before the round ends");
  log.observe(START + 301); log.observe(START + 302);
  assert.equal(lines.length, 1, "once");
  assert.equal(lines[0][0], "lead_retry_shadow:0xm");
  const late = [];
  createLeadRetryShadowLog(() => [h.round()], (fields, id) => late.push(id), START + 400).observe(START + 401);
  assert.equal(late.length, 0, "a round that ended before this run started is not rewritten");
}
// 18 review B1: the core marks the first buy CANCELLED while a fill may still
// land (reconciliationPending). No retry until that is settled; a late fill then
// means the round holds shares and gets no retry at all.
{
  const h = harness({ retryReverse: true });
  h.at(40); h.book(0.40, 0.61);
  const [first] = submits(h.lead("UP", 3));
  h.update(first, "OPEN");
  h.at(46); h.update(first, "CANCELLED", 0, { reconciliationPending: true, reservedUsd: 4.4 });
  h.at(60); h.book(0.70, 0.31);
  assert.deepEqual(submits(h.lead("DOWN", -2)), [], "a cancel still reconciling: no retry");
  assert.equal(h.round().retryShadow, undefined, "not judged yet");
  // Settled with nothing filled: the next reverse signal gets the retry.
  h.update(first, "CANCELLED", 0, { reconciliationPending: false, reservedUsd: 0 });
  h.at(62); h.book(0.70, 0.31);
  assert.equal(submits(h.lead("DOWN", -2)).length, 1, "settled at 0 shares: the retry goes");
}
{
  // The late fill lands after the retry went out (the race the check narrows but
  // a venue can still produce): the state must restore, holding both sides.
  const h = harness({ retryReverse: true });
  missedUp(h);
  const [retry] = submits(h.lead("DOWN", -2));
  h.update(retry, "FILLED", 10);
  h.at(70); h.update({ ...retry, clientOrderId: FIRST, tokenId: UP, price: 0.44 }, "CANCELLED", 3);
  const state = h.s.exportState();
  assert.equal(state.rounds[0].stages[0].filledShares, 3, "precondition: the first buy got a late fill");
  assert.doesNotThrow(() => createStrategy({ ...BASE, retryReverse: true }, state), "a late fill on the first buy still restores");
}
// 19 review B2: with exitOnReverse, a GTC retry's resting remainder is pulled
// before the sell (it would keep buying the side about to be sold).
{
  const h = harness({ retryReverse: true, exitOnReverse: true, restAfterMissSec: 30 });
  missedUp(h);
  const [retry] = submits(h.lead("DOWN", -2));
  h.update(retry, "PARTIAL", 4);
  h.hold(DOWN, 4, 1.4);
  h.at(70); h.book(0.30, 0.60);
  const actions = h.lead("UP", 1);
  assert.deepEqual(actions.filter(a => a.kind === "cancel").map(a => a.orderId), [`o-${RETRY}`], "the retry's remainder is cancelled");
  assert.deepEqual(submits(actions).filter(o => o.direction === "SELL"), [], "the sell waits for it");
  assert.equal(h.round().exitFirst.waiting, true);
}
// 20 adoption reads the order's own time in force (a FAK retry gets no timed cancel).
{
  const h = harness({ retryReverse: true });
  missedUp(h);
  const state = h.s.exportState();
  const adopted = createStrategy({ ...BASE, retryReverse: true }, state);
  const orphan = { strategyId: "binance-lead", clientOrderId: RETRY, orderId: "o-retry", assetId: "btc", marketId: "0xm", roundId: ROUND,
    tokenId: DOWN, direction: "BUY", price: 0.35, shares: 10, timeInForce: "FAK", postOnly: false, status: "OPEN", filledShares: 0,
    reservedUsd: 3.5, reservedShares: 0, createdAt: START + 60, updatedAt: START + 60 };
  adopted.onEvent({ kind: "order", order: orphan }, { mode: "live", now: START + 61, markets: [market], books: [], estimateFee: () => 0.02,
    account: { cashUsd: 1000, positions: [], orders: [orphan], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } } });
  assert.equal(adopted.exportState().rounds[0].stages[1].cancelAt, undefined, "a FAK retry has no timed cancel");
}
// 13 config.
{
  const d = normalizeBinanceLeadConfig({});
  assert.equal(d.retryReverse, false, "off by default");
  assert.equal(d.retryReverseBp, 3);
  for (const bad of [0, -1, 10.5, "3", null]) {
    assert.throws(() => normalizeBinanceLeadConfig({ retryReverseBp: bad }), /retryReverseBp/, `retryReverseBp ${bad}`);
  }
  assert.doesNotThrow(() => normalizeBinanceLeadConfig({ retryReverseBp: 10 }));
  assert.throws(() => normalizeBinanceLeadConfig({ retryReverse: "yes" }), /retryReverse/);
}
// 15 the order log.
{
  const h = harness({ retryReverse: true });
  missedUp(h);
  submits(h.lead("DOWN", -2));
  const indexed = h.s.stageFor(RETRY);
  const fields = leadOrderFields(indexed.round, indexed.stage, undefined, []);
  assert.equal(fields.stage, "retry");
  assert.equal(fields.direction, "DOWN");
  assert.equal(fields.parent_client_order_id, FIRST, "the retry names the buy it followed");
}
console.log("retry-reverse OK");
