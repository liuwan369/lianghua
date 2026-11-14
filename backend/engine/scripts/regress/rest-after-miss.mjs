// Rest after a miss (user 2026-11-14; live orders 10-26..11-13, research-1113
// missed.py section D): when the round's FAK ends short of its shares, the
// strategy rests ONE post-only GTC BUY at the FAK's limit for the remainder
// (client id :rest), cancelled restAfterMissSec after the venue accepted it.
// Off (restAfterMissSec 0) by default; restShadow (default on) then records,
// without an order, when within REST_SHADOW_SEC a frame put that side's ask at
// or under the limit (stage.restShadowFillAt).
//
// Run after `npm run build`:  node scripts/regress/rest-after-miss.mjs
import assert from "node:assert/strict";
import { createStrategy, normalizeBinanceLeadConfig, REST_SHADOW_SEC } from "../../dist/strategies/binance-lead.js";
import { leadOrderFields } from "../../dist/cli/platform.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = ({ risk = {}, ...rest } = {}) => ({ cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [],
  risk: { halted: false, availableUsd: 1000, occupiedUsd: 0, ...risk }, ...rest });
const ctx = (now, acct = account()) => ({ mode: "live", now, markets: [market], books: [], account: acct,
  estimateFee: order => order.postOnly ? 0 : 0.02 });
const book = (t, up, down) => ({ kind: "book", marketId: "0xm", roundId: ROUND,
  snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t,
    receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: 0.4, ask: up, sourceAt: t, expiresAt: t + 2 },
    NO: { assetId: DOWN, bid: 0.4, ask: down, sourceAt: t, expiresAt: t + 2 } } });
const lead = (S, direction = "UP") => ({ kind: "lead", assetId: "btc", direction, price: 100030, refPrice: 100000,
  moveBp: 3, venue: "bybit", line: "direct", tradeId: 1, tradeTimeMs: (S - 0.1) * 1000, receivedAtUnix: S, receivedAtMonoMs: 1 });
const at = (s, event, now, acct) => s.onEvent(event, ctx(now, acct));
const submits = actions => actions.filter(a => a.kind === "submit").map(a => a.order);
const cancels = actions => actions.filter(a => a.kind === "cancel").map(a => a.orderId);
const stages = s => s.exportState().rounds[0].stages;
const record = (o, status, filledShares, orderId, now) => ({ ...o, strategyId: "binance-lead", orderId, status, filledShares,
  reservedUsd: 0, reservedShares: 0, createdAt: now, updatedAt: now });
const S = START + 21;
/** A strategy whose round sent its FAK: UP, ask 0.55, limit 0.63 (limitPremium 0.08). */
const fakSent = (config = {}) => {
  const s = createStrategy({ limitPremium: 0.08, ...config });
  at(s, { kind: "timer", ts: START - 20 }, START - 20);
  at(s, book(START + 20, 0.55, 0.47), START + 20);
  const [fak] = submits(at(s, lead(S), S + 0.002));
  assert.equal(fak.price, 0.63);
  return { s, fak };
};

// --- config ---
{
  const d = normalizeBinanceLeadConfig({});
  assert.equal(d.restAfterMissSec, 0, "off by default");
  assert.equal(d.restShadow, true, "shadow on by default");
  assert.equal(normalizeBinanceLeadConfig({ restAfterMissSec: 5 }).restAfterMissSec, 5);
  for (const bad of [-1, 31, NaN, "5"]) assert.throws(() => normalizeBinanceLeadConfig({ restAfterMissSec: bad }), /restAfterMissSec/);
  assert.throws(() => normalizeBinanceLeadConfig({ restShadow: "yes" }), /restShadow/);
  assert.equal(REST_SHADOW_SEC, 5);
}

// --- FAK rejected -> one post-only GTC rest at the same limit, remaining shares ---
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  const actions = at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6);
  const [rest] = submits(actions);
  assert.ok(rest, "a rest order follows the miss");
  assert.equal(rest.clientOrderId, "binance-lead:0xm:rest");
  assert.equal(rest.tokenId, UP); assert.equal(rest.direction, "BUY");
  assert.equal(rest.price, 0.63, "the FAK's limit");
  assert.equal(rest.shares, 5);
  assert.equal(rest.timeInForce, "GTC"); assert.equal(rest.postOnly, true);
  assert.equal(stages(s).length, 2);
  assert.equal(stages(s)[1].kind, "rest");
  assert.equal(stages(s)[1].feeReserveUsd, 0, "a maker order reserves no taker fee");
  // Accepted: cancel restAfterMissSec later, once; retried after 1 s while unconfirmed.
  at(s, { kind: "order", order: record(rest, "OPEN", 0, "0xrest", S + 0.8) }, S + 0.8);
  assert.equal(stages(s)[1].cancelAt, S + 0.8 + 5, "timer starts at the venue's acceptance");
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 5.7 }, S + 5.7)), [], "not yet");
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 5.81 }, S + 5.81)), ["0xrest"], "cancel when due");
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 6.3 }, S + 6.3)), [], "no storm");
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 6.9 }, S + 6.9)), ["0xrest"], "retry after 1 s");
  at(s, { kind: "order", order: record(rest, "CANCELLED", 0, "0xrest", S + 7) }, S + 7);
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 9 }, S + 9)), []);
  // Never a third order.
  at(s, book(S + 20, 0.5, 0.5), S + 20);
  assert.deepEqual(submits(at(s, lead(S + 21, "DOWN"), S + 21.002)), []);
  assert.equal(stages(s).length, 2);
  // Restore keeps both stages.
  const back = createStrategy({}, s.exportState());
  assert.equal(back.exportState().rounds[0].stages[1].clientOrderId, "binance-lead:0xm:rest");
}

// --- partial FAK -> rest for the remainder; full fill -> none ---
{
  const { s, fak } = fakSent({ restAfterMissSec: 5, shares: 10 });
  const [rest] = submits(at(s, { kind: "order", order: record(fak, "CANCELLED", 4, "0xfak", S + 0.6) }, S + 0.6));
  assert.equal(rest.shares, 6, "the remaining 6 of 10");
}
{
  const { s, fak } = fakSent({ restAfterMissSec: 5, shares: 10 });
  assert.deepEqual(submits(at(s, { kind: "order", order: record(fak, "CANCELLED", 7, "0xfak", S + 0.6) }, S + 0.6)), [],
    "3 left is under the venue minimum 5");
}
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  assert.deepEqual(submits(at(s, { kind: "order", order: record(fak, "FILLED", 5, "0xfak", S + 0.6) }, S + 0.6)), [],
    "a filled FAK rests nothing");
}
// --- off, paused, too late, no cash ---
{
  const { s, fak } = fakSent();
  assert.deepEqual(submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6)), [], "off by default");
}
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  s.setPaused(true);
  assert.deepEqual(submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6)), [], "paused");
}
{
  const s = createStrategy({ limitPremium: 0.08, restAfterMissSec: 5, toSec: 299 });
  at(s, { kind: "timer", ts: START - 20 }, START - 20);
  at(s, book(START + 290, 0.55, 0.47), START + 290);
  const [fak] = submits(at(s, lead(START + 291), START + 291.002));
  assert.deepEqual(submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", START + 291.6) }, START + 291.6)), [],
    "under restAfterMissSec + 5 s left in the round");
}
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  assert.deepEqual(submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6,
    account({ risk: { availableUsd: 1 } }))), [], "not enough cash");
}

// --- live 2026-11-14 19:06: the venue refused the rest's cancel (matched, nothing
// resting) and the core made it UNKNOWN; the cancel was re-sent every second for
// 13 minutes. An UNKNOWN rest is re-cancelled at most every 30 s. ---
{
  const { s, fak } = fakSent({ restAfterMissSec: 3 });
  const [rest] = submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6));
  at(s, { kind: "order", order: record(rest, "PARTIAL", 3.53, "0xrest", S + 1) }, S + 1);
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 4.1 }, S + 4.1)), ["0xrest"], "due");
  const unknown = { ...record(rest, "UNKNOWN", 3.53, "0xrest", S + 4.3), error: "cancellation not confirmed" };
  at(s, { kind: "order", order: unknown }, S + 4.3);
  for (const t of [S + 5.2, S + 10, S + 20, S + 33.9]) {
    assert.deepEqual(cancels(at(s, { kind: "timer", ts: t }, t, account({ orders: [unknown] }))), [], `no cancel at +${(t - S).toFixed(1)} s`);
  }
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 34.2 }, S + 34.2, account({ orders: [unknown] }))), ["0xrest"],
    "an UNKNOWN rest is re-cancelled after 30 s");
}

// --- partial rest fill, then cancel of the remainder ---
{
  const { s, fak } = fakSent({ restAfterMissSec: 3 });
  const [rest] = submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6));
  at(s, { kind: "order", order: record(rest, "PARTIAL", 2, "0xrest", S + 1) }, S + 1);
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 4.1 }, S + 4.1)), ["0xrest"]);
  at(s, { kind: "order", order: record(rest, "CANCELLED", 2, "0xrest", S + 4.3) }, S + 4.3);
  assert.equal(stages(s)[1].filledShares, 2);
}
// A rest fully filled before its timer: nothing to cancel.
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  const [rest] = submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6));
  at(s, { kind: "order", order: record(rest, "OPEN", 0, "0xrest", S + 0.8) }, S + 0.8);
  at(s, { kind: "order", order: record(rest, "FILLED", 5, "0xrest", S + 2) }, S + 2);
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: S + 7 }, S + 7)), []);
}
// A post-only refused for crossing (the ask is back under the limit): the round is done, no third order.
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  const [rest] = submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6));
  at(s, { kind: "order", order: { ...record(rest, "REJECTED", 0, undefined, S + 0.9), error: "invalid post-only order: order crosses book" } }, S + 0.9);
  assert.equal(stages(s)[1].status, "REJECTED");
  assert.equal(stages(s).length, 2);
}

// --- restart: a persisted rest restores with its timer; past it, cancel at once ---
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  const [rest] = submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6));
  at(s, { kind: "order", order: record(rest, "OPEN", 0, "0xrest", S + 0.8) }, S + 0.8);
  const back = createStrategy({}, s.exportState());
  assert.equal(back.exportState().rounds[0].stages[1].cancelAt, S + 5.8);
  const restoredOrder = record(rest, "OPEN", 0, "0xrest", S + 0.8);
  assert.deepEqual(cancels(back.onEvent({ kind: "timer", ts: S + 30 }, ctx(S + 30, account({ orders: [restoredOrder] })))), ["0xrest"],
    "a restart after cancelAt cancels at once");
}
// adoptOrder: the core holds :1 and :rest, the strategy state lost both.
{
  const s = createStrategy({ limitPremium: 0.08, restAfterMissSec: 5 });
  at(s, { kind: "timer", ts: START - 20 }, START - 20);
  const base = { clientOrderId: "binance-lead:0xm:1", assetId: "btc", marketId: "0xm", roundId: ROUND, tokenId: UP, direction: "BUY",
    price: 0.63, shares: 5, timeInForce: "FAK", postOnly: false };
  const restOrder = { ...base, clientOrderId: "binance-lead:0xm:rest", timeInForce: "GTC", postOnly: true };
  at(s, { kind: "timer", ts: S + 2 }, S + 2, account({ orders: [record(base, "REJECTED", 0, "0xfak", S + 0.6),
    record(restOrder, "OPEN", 0, "0xrest", S + 0.8)] }));
  const st = stages(s);
  assert.equal(st.length, 2, "both adopted");
  assert.equal(st[1].kind, "rest");
  assert.equal(typeof st[1].cancelAt, "number", "an adopted rest gets its timer");
}
// A restore refuses a rest without its FAK, or a third stage.
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6));
  const three = s.exportState(); three.rounds[0].stages.push({ ...three.rounds[0].stages[1] });
  assert.throws(() => createStrategy({}, three), /invalid persisted binance-lead round/);
  const lone = s.exportState(); lone.rounds[0].stages.shift();
  assert.throws(() => createStrategy({}, lone), /invalid persisted binance-lead stage/);
}

// --- shadow: off, a miss records when the ask came back, no order ---
{
  const { s, fak } = fakSent();
  assert.deepEqual(submits(at(s, { kind: "order", order: { ...record(fak, "REJECTED", 0, "0xfak", S + 0.6), venueReplyAt: S + 0.6 } }, S + 0.6)), []);
  at(s, book(S + 1.0, 0.66, 0.40), S + 1.0);
  assert.equal(stages(s)[0].restShadowFillAt, undefined, "over the limit: not yet");
  at(s, book(S + 2.5, 0.62, 0.40), S + 2.5);
  assert.equal(stages(s)[0].restShadowFillAt, S + 2.5, "the first frame at or under the limit");
  at(s, book(S + 3.0, 0.60, 0.40), S + 3.0);
  assert.equal(stages(s)[0].restShadowFillAt, S + 2.5, "set once");
  const fields = leadOrderFields(s.exportState().rounds[0], stages(s)[0], { ...record(fak, "REJECTED", 0, "0xfak", S + 0.6), venueReplyAt: S + 0.6 }, []);
  assert.equal(fields.rest_mode, "shadow");
  assert.equal(fields.rest_shadow_fill_ms, (S + 2.5) * 1000);
  assert.equal(fields.stage, "fak");
}
{
  const { s, fak } = fakSent();
  at(s, { kind: "order", order: { ...record(fak, "REJECTED", 0, "0xfak", S + 0.6), venueReplyAt: S + 0.6 } }, S + 0.6);
  at(s, book(S + 0.6 + REST_SHADOW_SEC + 0.1, 0.50, 0.40), S + 6);
  assert.equal(stages(s)[0].restShadowFillAt, undefined, "after the shadow window: not recorded");
}
{
  const { s, fak } = fakSent({ restShadow: false });
  at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6);
  at(s, book(S + 2, 0.5, 0.4), S + 2);
  assert.equal(stages(s)[0].restShadowFillAt, undefined, "shadow off");
}
{
  const { s, fak } = fakSent();
  at(s, { kind: "order", order: record(fak, "FILLED", 5, "0xfak", S + 0.6) }, S + 0.6);
  at(s, book(S + 2, 0.5, 0.4), S + 2);
  assert.equal(stages(s)[0].restShadowFillAt, undefined, "a filled FAK has no shadow");
}
// lead_order of a live rest order.
{
  const { s, fak } = fakSent({ restAfterMissSec: 5 });
  const [rest] = submits(at(s, { kind: "order", order: record(fak, "REJECTED", 0, "0xfak", S + 0.6) }, S + 0.6));
  at(s, { kind: "order", order: { ...record(rest, "OPEN", 0, "0xrest", S + 0.8), httpAckAt: S + 0.8 } }, S + 0.8);
  const order = { ...record(rest, "CANCELLED", 2, "0xrest", S + 6), httpAckAt: S + 0.8 };
  at(s, { kind: "order", order }, S + 6);
  const r = s.exportState().rounds[0];
  const f = leadOrderFields(r, r.stages[1], order, [{ tradeId: "t", orderId: "0xrest", tokenId: UP, price: 0.63, shares: 2, feeUsd: 0, status: "CONFIRMED", ts: S + 3 }]);
  assert.equal(f.stage, "rest");
  assert.equal(f.rest_mode, "live");
  assert.equal(f.parent_client_order_id, "binance-lead:0xm:1");
  assert.equal(f.filled_shares, 2);
  assert.equal(f.fee_usd, 0, "a maker fill pays no fee");
  assert.equal(f.late_by_ms, null, "late_by is the FAK's measure");
}
console.log("rest-after-miss OK");
