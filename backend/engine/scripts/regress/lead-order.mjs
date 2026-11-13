// One `lead_order` journal record per binance-lead order:
// - the strategy stamps askGoneAtUnix on the round's stage: the first book
//   frame after the signal whose ask on the stage's side is gone or above the
//   limit, watched 10 s after the decision; the other side is ignored; the
//   field is persisted (finite or absent);
// - leadOrderFields derives t_* and late_by_ms from the stage and the order;
// - createLeadOrderLog writes once per clientOrderId (lead_order:<id>), on the
//   order's terminal update after its submit returned, else at the round end;
// - a confirmed settlement names the winning token.
//
// Run after `npm run build`:  node scripts/regress/lead-order.mjs
import assert from "node:assert/strict";
import { createLeadOrderLog, leadOrderFields } from "../../dist/cli/platform.js";
import { createStrategy } from "../../dist/strategies/binance-lead.js";
import { createLiveSettlementAdapter } from "../../dist/platform/live-settlement.js";
import { TradingPlatform } from "../../dist/platform/platform.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = () => ({ cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [],
  risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } });
const ctx = now => ({ mode: "live", now, markets: [market], books: [], account: account(), estimateFee: () => 0.02 });
const book = (t, up, down, { upAt = t - 0.01, downAt = t - 0.01 } = {}) => ({ kind: "book", marketId: "0xm", roundId: ROUND,
  snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND, sourceAt: Math.max(upAt, downAt), expiresAt: t + 2, tsUnix: t,
    receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: 0.4, ask: up, sourceAt: upAt, expiresAt: t + 2 },
    NO: { assetId: DOWN, bid: 0.4, ask: down, sourceAt: downAt, expiresAt: t + 2 } } });
const S = START + 21;
const lead = { kind: "lead", assetId: "btc", direction: "UP", price: 100030, refPrice: 100000, moveBp: 3,
  openPrice: 100010, openMean60: 100000, venue: "okx", line: "tokyo", relayRecvMs: (S - 0.06) * 1000,
  tradeId: 7, tradeTimeMs: (S - 0.125) * 1000, receivedAtUnix: S, receivedAtMonoMs: 1 };
const on = (s, event, now) => s.onEvent(event, ctx(now ?? (event.kind === "book" ? event.snapshot.tsUnix : event.ts)));
/** A strategy whose round placed UP at limit 0.58 (ask 0.55). */
const placed = (config = {}) => {
  const s = createStrategy({ openLine: "mean60", ...config });
  on(s, { kind: "timer", ts: START - 20 });
  on(s, book(START + 20, 0.55, 0.47));
  const [action] = on(s, lead, S + 0.002);
  assert.equal(action?.order.price, 0.58, "limit = ask 0.55 + 0.03");
  return s;
};
const stage = s => s.exportState().rounds[0].stages[0];

// --- askGoneAtUnix: the 0.60 frame, not 0.55/0.57, not the other side ---
{
  const s = placed();
  assert.equal(stage(s).askGoneAtUnix, undefined, "no later frame: unset");
  on(s, book(S + 0.05, 0.55, 0.47));
  on(s, book(S + 0.10, 0.57, 0.99));
  on(s, book(S + 0.12, 0.58, undefined));
  assert.equal(stage(s).askGoneAtUnix, undefined, "at or under the limit, other side gone: still there");
  on(s, book(S + 0.15, 0.60, 0.47, { upAt: S + 0.14 }));
  assert.equal(stage(s).askGoneAtUnix, S + 0.15, "the frame whose ask went over the limit");
  assert.equal(stage(s).askGoneVenueAt, S + 0.14, "that side's venue time");
  on(s, book(S + 0.20, undefined, 0.47));
  assert.equal(stage(s).askGoneAtUnix, S + 0.15, "set once");
  // Restore with the field.
  const back = createStrategy({}, s.exportState());
  assert.equal(back.exportState().rounds[0].stages[0].askGoneAtUnix, S + 0.15);
  const bad = s.exportState(); bad.rounds[0].stages[0].askGoneAtUnix = "x";
  assert.throws(() => createStrategy({}, bad), /invalid persisted binance-lead stage/);
}
// A side with no ask counts as gone.
{
  const s = placed();
  on(s, book(S + 0.3, undefined, 0.47, { upAt: null }));
  assert.equal(stage(s).askGoneAtUnix, S + 0.3);
  assert.equal(stage(s).askGoneVenueAt, undefined, "no venue time on that side");
}
// More than 10 s after the decision: not set. Restore without the field.
{
  const s = placed();
  on(s, book(S + 10.5, 0.70, 0.30));
  assert.equal(stage(s).askGoneAtUnix, undefined, "watch over after 10 s");
  const back = createStrategy({}, s.exportState());
  assert.equal("askGoneAtUnix" in back.exportState().rounds[0].stages[0], false, "absent restores");
}

// --- leadOrderFields: derived times and late_by_ms ---
const s = placed();
on(s, book(S + 0.15, 0.60, 0.47, { upAt: S + 0.14 }));
const clientOrderId = "binance-lead:0xm:1";
const indexed = s.stageFor(clientOrderId);
assert.ok(indexed, "stageFor finds the round's stage");
const order = (status, extra = {}) => ({ clientOrderId, strategyId: "binance-lead", assetId: "btc", marketId: "0xm", roundId: ROUND,
  tokenId: UP, direction: "BUY", price: 0.58, shares: 5, timeInForce: "FAK", postOnly: false, orderId: "0xorder",
  status, filledShares: 0, reservedUsd: 0, reservedShares: 0, createdAt: S + 0.002, updatedAt: S + 0.3,
  postSentAt: S + 0.004, ...extra });
{
  const f = leadOrderFields(indexed.round, indexed.stage, order("CANCELLED", { httpAckAt: S + 0.204, venueStatus: "canceled" }), []);
  assert.equal(f.client_order_id, clientOrderId);
  assert.equal(f.market_id, "0xm");
  assert.equal(f.round_start, START);
  assert.equal(f.venue, "okx"); assert.equal(f.line, "tokyo");
  assert.equal(f.relay_recv_ms, (S - 0.06) * 1000);
  assert.equal(f.open_line, "mean60"); assert.equal(f.open_value, 100000);
  assert.ok(Math.abs(f.band_bp - Math.log(100030 / 100000) * 1e4) < 1e-9, "band from the open line used");
  assert.ok(Math.abs(f.sec_since_open - 21) < 1e-9);
  assert.equal(f.ask_at_signal, 0.55); assert.equal(f.limit_price, 0.58);
  assert.equal(f.avg_fill_price, null); assert.equal(f.fee_usd, null);
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-3, `${label}: ${a} vs ${b}`);
  near(f.t_signal_ms, 125, "t_signal"); near(f.t_decide_ms, 2, "t_decide"); near(f.t_post_ms, 2, "t_post");
  near(f.t_ack_ms, 200, "t_ack"); near(f.t_total_ms, 329, "t_total");
  near(f.ask_gone_after_trade_ms, 275, "ask gone after trade");
  near(f.late_by_ms, 54, "ACK 54 ms after the ask went");
  near(f.ask_gone_venue_ms, (S + 0.14) * 1000, "venue time");
}
{
  const fills = [{ tradeId: "t1", orderId: "0xorder", tokenId: UP, direction: "BUY", price: 0.56, shares: 3, feeUsd: 0.03, isMaker: false, ts: S + 0.2 },
    { tradeId: "t2", orderId: "0xorder", tokenId: UP, direction: "BUY", price: 0.58, shares: 2, feeUsd: 0.02, isMaker: false, ts: S + 0.2 }];
  const f = leadOrderFields(indexed.round, indexed.stage, order("FILLED", { httpAckAt: S + 0.204, filledShares: 5 }), fills);
  assert.equal(f.late_by_ms, null, "a full fill is not late");
  assert.ok(Math.abs(f.avg_fill_price - 0.568) < 1e-9);
  assert.ok(Math.abs(f.fee_usd - 0.05) < 1e-9);
  const noAck = leadOrderFields(indexed.round, indexed.stage, order("UNKNOWN"), []);
  assert.equal(noAck.ack_ms, null); assert.equal(noAck.t_ack_ms, null); assert.equal(noAck.late_by_ms, null);
}

// --- a FAK the venue rejected keeps the time of the venue's reply ---
// Live 2026-11-13: a FAK BUY answered 400 "no orders found to match with FAK
// order" after 508 ms got ack_ms null, so t_ack/t_total/late_by were null for
// exactly the missed orders. The reply is real: the core stamps venueReplyAt
// and lead_order takes ack_ms from it. Real TradingPlatform, the ack the real
// gateway returns for that reply (fak-no-match.mjs checks that mapping).
{
  const clock = { now: S + 0.002 };
  const NO_MATCH = "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.";
  const platform = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, now: () => clock.now,
    adapters: { gateway: { mode: "live", durableIdentity: true, async submit(_request, _instrument, prepared) {
      prepared({ orderHash: "0xorder", signedPayload: { sig: "s" }, preparedAt: S + 0.003 });
      clock.now = S + 0.204;
      return { status: "rejected", orderId: "0xorder", error: NO_MATCH, postSentAt: S + 0.004,
        postLatencyMs: 199.7, ackLatencyMs: 200, totalLatencyMs: 202 }; }, async cancel() { return true; } },
    estimateFee: () => 0.05 } });
  platform.ingest({ kind: "market", market });
  const lines = [];
  const log = createLeadOrderLog(id => s.stageFor(id), fields => lines.push(fields));
  platform.subscribe(event => log.observe(event, clock.now));
  const rejected = await platform.core.submit({ clientOrderId, strategyId: "binance-lead", assetId: "btc", marketId: "0xm", roundId: ROUND,
    tokenId: UP, direction: "BUY", price: 0.58, shares: 5, timeInForce: "FAK", postOnly: false });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(lines.length, 1, "REJECTED is terminal: one record");
  const f = lines[0];
  const near = (a, b, label) => assert.ok(typeof a === "number" && Math.abs(a - b) < 1e-3, `${label}: ${a} vs ${b}`);
  near(f.ack_ms, (S + 0.204) * 1000, "ack_ms");
  near(f.t_ack_ms, 200, "t_ack"); near(f.t_total_ms, 329, "t_total");
  near(f.late_by_ms, 54, "the ask went 54 ms before the reply");
  assert.equal(rejected.venueReplyAt, S + 0.204, "the venue's reply time");
  assert.equal(rejected.httpAckAt, undefined, "a rejection is not an ACK: the UNKNOWN rules keep their input");
}
{
  // Replies that never came carry no venueReplyAt: refused before the POST
  // (feed not ready) and a POST that timed out.
  const rig = async ack => {
    const platform = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: 100, positions: [], openOrders: [], complete: true },
      instruments: market.instruments, limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, now: () => S + 0.3,
      adapters: { gateway: { mode: "live", durableIdentity: true, async submit(_request, _instrument, prepared) {
        prepared({ orderHash: "0xorder", signedPayload: { sig: "s" }, preparedAt: S + 0.003 }); return ack; }, async cancel() { return true; } },
      estimateFee: () => 0.05 } });
    platform.ingest({ kind: "market", market });
    return platform.core.submit({ clientOrderId, strategyId: "binance-lead", assetId: "btc", marketId: "0xm", roundId: ROUND,
      tokenId: UP, direction: "BUY", price: 0.58, shares: 5, timeInForce: "FAK", postOnly: false });
  };
  assert.equal((await rig({ status: "rejected", error: "authenticated feed is not ready" })).venueReplyAt, undefined, "no POST");
  assert.equal((await rig({ status: "rejected", error: "sign", failurePhase: "signing" })).venueReplyAt, undefined, "signing failed");
  const timedOut = await rig({ status: "unknown", error: "timed out", failurePhase: "post", postSentAt: S + 0.004 });
  assert.equal(timedOut.venueReplyAt, undefined, "a timed-out POST had no reply");
  assert.equal((await rig({ status: "accepted", orderId: "0xorder", postSentAt: S + 0.004 })).venueReplyAt, S + 0.3, "an ACK is a reply");
}
{
  // An old record with only httpAckAt still gives ack_ms.
  const f = leadOrderFields(indexed.round, indexed.stage, order("CANCELLED", { httpAckAt: S + 0.204 }), []);
  assert.ok(Math.abs(f.ack_ms - (S + 0.204) * 1000) < 1e-6);
  const g = leadOrderFields(indexed.round, indexed.stage, order("CANCELLED", { httpAckAt: S + 0.5, venueReplyAt: S + 0.204 }), []);
  assert.ok(Math.abs(g.ack_ms - (S + 0.204) * 1000) < 1e-6, "venueReplyAt first");
}

// --- createLeadOrderLog: once per clientOrderId ---
{
  const lines = [];
  const log = createLeadOrderLog(id => s.stageFor(id), (fields, eventId) => lines.push({ fields, eventId }));
  log.observe({ kind: "order", order: order("SUBMITTING") }, S + 0.004);
  // The FAK's fill beats its HTTP reply: FILLED without httpAckAt waits.
  log.observe({ kind: "fill", fill: { tradeId: "t1", orderId: "0xorder", tokenId: UP, direction: "BUY", price: 0.58, shares: 5,
    feeUsd: 0.05, isMaker: false, ts: S + 0.1 } }, S + 0.1);
  log.observe({ kind: "order", order: order("FILLED", { filledShares: 5 }) }, S + 0.1);
  assert.equal(lines.length, 0, "terminal before the submit returned: wait for the ACK");
  log.observe({ kind: "order", order: order("FILLED", { filledShares: 5, httpAckAt: S + 0.2, totalLatencyMs: 198 }) }, S + 0.2);
  log.observe({ kind: "order", order: order("FILLED", { filledShares: 5, httpAckAt: S + 0.2, totalLatencyMs: 198 }) }, S + 0.3);
  log.observe({ kind: "timer", ts: START + 400 }, START + 400);
  log.flush();
  assert.equal(lines.length, 1, "two terminal updates, one record");
  assert.equal(lines[0].eventId, `lead_order:${clientOrderId}`);
  assert.equal(lines[0].fields.status, "FILLED");
  assert.equal(lines[0].fields.avg_fill_price, 0.58);
  assert.ok(Math.abs(lines[0].fields.ack_ms - (S + 0.2) * 1000) < 1e-6);
}
{
  // Still UNKNOWN at the round's end: written then, status as is.
  const lines = [];
  const log = createLeadOrderLog(id => s.stageFor(id), (fields, eventId) => lines.push({ fields, eventId }));
  log.observe({ kind: "order", order: order("UNKNOWN") }, S + 1);
  log.observe({ kind: "timer", ts: START + 299 }, START + 299);
  assert.equal(lines.length, 0);
  log.observe({ kind: "timer", ts: START + 300 }, START + 300);
  assert.equal(lines.length, 1); assert.equal(lines[0].fields.status, "UNKNOWN");
  log.observe({ kind: "order", order: order("CANCELLED", { httpAckAt: S + 0.2 }) }, START + 301);
  assert.equal(lines.length, 1, "a later terminal update does not write again");
}
{
  // Another strategy's order is not a lead order.
  const lines = [];
  const log = createLeadOrderLog(id => s.stageFor(id), fields => lines.push(fields));
  log.observe({ kind: "order", order: { ...order("REJECTED"), strategyId: "other" } }, S + 1);
  log.flush();
  assert.equal(lines.length, 0);
}

// --- a confirmed settlement names the winning token ---
{
  const tokenIds = ["111", "222"], wallet = "0x" + "a1".repeat(20), marketId = "0x" + "ab".repeat(32);
  const backend = { wallet, market: async () => ({ tokenIds, denominator: 1n, numerators: [0n, 1n], negRisk: false }),
    balances: async () => ({ balances: [5_000_000n, 0n], cash: 10_000_000n, block: 100n }),
    externalPayout: async () => undefined };
  const settle = await createLiveSettlementAdapter({ backend, restore: { schemaVersion: 1, wallet, records: {} }, persist: () => {} });
  const result = await settle({ marketId, roundId: ROUND, assetId: "btc", tokenIds });
  assert.equal(result.state, "confirmed");
  assert.equal(result.payoutProof, "zero_payout", "only the losing token held");
  assert.equal(result.winningTokenId, "222");
}
console.log("lead-order: ok");
