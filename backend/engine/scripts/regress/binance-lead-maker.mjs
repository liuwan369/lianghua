// binance-lead maker mode (makerHoldSec > 0, user 2026-10-27): the round's first
// valid signal posts a post-only GTC BUY of `shares` at that side's best bid,
// cancelled makerHoldSec after the decision; what filled is held to the close.
// Backtest E:/pm-backup/maker/maker_a_engine.py (22 days, cap 0.80, 3 s): +219.6.
//
// 1) the strategy: price = bid, post-only GTC, no 1 USD raise, cap on the bid,
//    timed cancel (once, retried after 1 s), a fill before the hold is kept,
//    a restart keeps the timed cancel, makerHoldSec 0 is the FAK rule unchanged;
// 2) the real ClobWrapper + PolymarketGateway: the venue's "invalid post-only
//    order: order crosses book" ends the order (rejected), other errors with an
//    order id stay unknown;
// 3) the real TradingPlatform/core: post -> rest -> fill 2 -> timed cancel ->
//    CANCELLED with 2 shares held, nothing blocked; a crossed post-only ends
//    REJECTED with nothing reserved.
// Run after `npm run build`:  node scripts/regress/binance-lead-maker.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { ClobClient } from "@polymarket/clob-client-v2";
import { ClobWrapper } from "../../dist/live/clob/client.js";
import { PolymarketGateway, replaysPreparedOrder } from "../../dist/platform/polymarket.js";
import { createStrategy, normalizeBinanceLeadConfig, BINANCE_LEAD_DEFAULTS } from "../../dist/strategies/binance-lead.js";
import { TradingPlatform } from "../../dist/platform/platform.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = (extra = {}) => ({ cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [],
  risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 }, ...extra });
const ctx = (now, acct = account()) => ({ mode: "live", now, markets: [market], books: [], account: acct, estimateFee: () => 0 });
// bid/ask per side; a null bid leaves the side without one.
const book = (t, [ub, ua], [db, da]) => ({ kind: "book", marketId: "0xm", roundId: ROUND,
  snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t,
    receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: ub ?? undefined, ask: ua, sourceAt: t, expiresAt: t + 2 },
    NO: { assetId: DOWN, bid: db ?? undefined, ask: da, sourceAt: t, expiresAt: t + 2 } } });
let tradeId = 0;
const lead = (S, direction = "UP") => ({ kind: "lead", assetId: "btc", direction, price: 100030, refPrice: 100000,
  moveBp: direction === "UP" ? 3 : -3, tradeId: ++tradeId, tradeTimeMs: (S - 0.125) * 1000, receivedAtUnix: S, receivedAtMonoMs: 1 });
const MAKER = { makerHoldSec: 3 };
const begin = (config = MAKER) => {
  const s = createStrategy(config);
  s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
  return s;
};
const at = (s, event, now, acct) => s.onEvent(event, ctx(now, acct));
const submits = (actions) => actions.filter(a => a.kind === "submit").map(a => a.order);
const cancels = (actions) => actions.filter(a => a.kind === "cancel");
const round = (s) => s.exportState().rounds[0];
const record = (o, status, filledShares, updatedAt, orderId = "0xmaker") => ({ ...o, strategyId: "binance-lead", orderId, status,
  filledShares, reservedUsd: 0, reservedShares: 0, createdAt: START + 21.002, updatedAt });

// --- 1) the strategy ---
{
  assert.equal(BINANCE_LEAD_DEFAULTS.makerHoldSec, 0, "the default stays the FAK rule");
  for (const bad of [-1, 301, "3", null, Number.NaN]) assert.throws(() => normalizeBinanceLeadConfig({ makerHoldSec: bad }), String(bad));
  assert.equal(normalizeBinanceLeadConfig({ makerHoldSec: 300 }).makerHoldSec, 300);

  const s = begin();
  at(s, book(START + 20, [0.55, 0.57], [0.43, 0.45]), START + 20);
  const [order] = submits(at(s, lead(START + 21), START + 21.002));
  assert.ok(order, "the first valid signal posts");
  assert.equal(order.tokenId, UP);
  assert.equal(order.price, 0.55, "rests at the UP best bid, not ask + premium");
  assert.equal(order.shares, 5);
  assert.equal(order.timeInForce, "GTC");
  assert.equal(order.postOnly, true);
  const stage = round(s).stages[0];
  assert.equal(stage.bidAtSignal, 0.55);
  assert.equal(stage.askAtSignal, 0.57);
  assert.ok(Math.abs(stage.cancelAt - (START + 24.002)) < 1e-9, "cancel 3 s after the decision");
  assert.match(round(s).reason, /挂/);
  // Resting; nothing to cancel before the hold is up.
  at(s, { kind: "order", order: record(order, "OPEN", 0, START + 21.3) }, START + 21.3);
  assert.match(round(s).reason, /挂在 0\.55/);
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: START + 24 }, START + 24)), [], "not before cancelAt");
  // A fill during the hold is kept; the remainder is cancelled once at cancelAt.
  at(s, { kind: "order", order: record(order, "PARTIAL", 2, START + 23) }, START + 23);
  assert.match(round(s).reason, /2\/5/);
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: START + 24.1 }, START + 24.1)), [{ kind: "cancel", orderId: "0xmaker" }]);
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: START + 24.6 }, START + 24.6)), [], "no cancel storm within 1 s");
  assert.equal(cancels(at(s, { kind: "timer", ts: START + 25.2 }, START + 25.2)).length, 1, "an unconfirmed cancel is retried");
  at(s, { kind: "order", order: record(order, "CANCELLED", 2, START + 25.4) }, START + 25.4);
  assert.match(round(s).reason, /买到 2\/5 股，持有到结算/);
  assert.deepEqual(cancels(at(s, { kind: "timer", ts: START + 27 }, START + 27)), [], "a cancelled order is left alone");
  assert.deepEqual(submits(at(s, lead(START + 40, "DOWN"), START + 40.002)), [], "one attempt per round");
  // Filled in full before the hold: nothing to cancel.
  const f = begin();
  at(f, book(START + 20, [0.55, 0.57], [0.43, 0.45]), START + 20);
  const [full] = submits(at(f, lead(START + 21), START + 21.002));
  at(f, { kind: "order", order: record(full, "FILLED", 5, START + 22) }, START + 22);
  assert.deepEqual(cancels(at(f, { kind: "timer", ts: START + 25 }, START + 25)), []);
  // No ack yet at cancelAt (no order id): nothing to cancel until it has one.
  const n = begin();
  at(n, book(START + 20, [0.55, 0.57], [0.43, 0.45]), START + 20);
  const [late] = submits(at(n, lead(START + 21), START + 21.002));
  assert.deepEqual(cancels(at(n, { kind: "timer", ts: START + 25 }, START + 25)), []);
  assert.deepEqual(cancels(at(n, { kind: "order", order: record(late, "OPEN", 0, START + 25.5) }, START + 25.5)),
    [{ kind: "cancel", orderId: "0xmaker" }], "an order acknowledged after its hold is pulled as its ack arrives");
}
{
  // DOWN signal rests at the DOWN bid.
  const s = begin();
  at(s, book(START + 100, [0.51, 0.52], [0.47, 0.49]), START + 100);
  const [order] = submits(at(s, lead(START + 100.1, "DOWN"), START + 100.102));
  assert.equal(order.tokenId, DOWN);
  assert.equal(order.price, 0.47);
  // Cheap side: a resting order is not marketable, no 1 USD raise.
  const c = begin();
  at(c, book(START + 100, [0.88, 0.9], [0.1, 0.12]), START + 100);
  const [cheap] = submits(at(c, lead(START + 100.1, "DOWN"), START + 100.102));
  assert.equal(cheap.price, 0.1);
  assert.equal(cheap.shares, 5, "5 x 0.10 rests; the 1 USD floor is for marketable orders");
}
{
  // The cap is on the bid we rest at: bid 0.81 > 0.80 waits; bid 0.80 with ask 0.82 rests.
  const s = begin();
  at(s, book(START + 20, [0.81, 0.83], [0.17, 0.19]), START + 20);
  assert.deepEqual(submits(at(s, lead(START + 21), START + 21.002)), []);
  assert.match(round(s).reason, /买价 0\.81 高于上限 0\.80/);
  assert.equal(round(s).stages.length, 0, "the round keeps its attempt");
  at(s, book(START + 22, [0.8, 0.82], [0.18, 0.2]), START + 22);
  const [order] = submits(at(s, lead(START + 23), START + 23.002));
  assert.equal(order?.price, 0.8, "bid exactly at the cap rests");
  // No bid on the signal's side: wait.
  const nb = begin();
  at(nb, book(START + 20, [null, 0.57], [0.43, 0.45]), START + 20);
  assert.deepEqual(submits(at(nb, lead(START + 21), START + 21.002)), []);
  assert.match(round(nb).reason, /没有买价/);
  assert.equal(round(nb).stages.length, 0);
}
{
  // makerHoldSec 0 is the FAK rule, unchanged.
  const s = begin({});
  at(s, book(START + 20, [0.55, 0.57], [0.43, 0.45]), START + 20);
  const [order] = submits(at(s, lead(START + 21), START + 21.002));
  assert.equal(order.timeInForce, "FAK");
  assert.equal(order.postOnly, false);
  assert.equal(order.price, 0.6);
  assert.equal(round(s).stages[0].cancelAt, undefined);
}
{
  // A restart keeps the timed cancel; the restored state is accepted.
  const s = begin();
  at(s, book(START + 20, [0.55, 0.57], [0.43, 0.45]), START + 20);
  const [order] = submits(at(s, lead(START + 21), START + 21.002));
  const resting = account({ orders: [record(order, "OPEN", 0, START + 21.3)] });
  at(s, { kind: "order", order: record(order, "OPEN", 0, START + 21.3) }, START + 21.3, resting);
  const r = createStrategy(MAKER, JSON.parse(JSON.stringify(s.exportState())));
  assert.deepEqual(cancels(r.onEvent({ kind: "timer", ts: START + 24.5 }, ctx(START + 24.5, resting))), [{ kind: "cancel", orderId: "0xmaker" }]);
  // Lost strategy state, core still has the resting order: adopted with its timed cancel.
  const lost = begin();
  const adopted = createStrategy(MAKER, JSON.parse(JSON.stringify(lost.exportState())));
  const out = adopted.onEvent({ kind: "timer", ts: START + 24.5 }, ctx(START + 24.5, resting));
  assert.equal(adopted.exportState().rounds[0].stages[0].cancelAt, START + 21.002 + 3);
  const again = cancels(out).length ? out : adopted.onEvent({ kind: "timer", ts: START + 24.6 }, ctx(START + 24.6, resting));
  assert.deepEqual(cancels(again), [{ kind: "cancel", orderId: "0xmaker" }], "an adopted maker order is still pulled");
  // A maker stage whose saved price is not its bid is damage.
  const bad = s.exportState();
  bad.rounds[0].stages[0].bidAtSignal = 0.54;
  assert.throws(() => createStrategy(MAKER, bad), /stage/);
}

// --- 2) the real client + gateway: which replies end a post-only order ---
const T = "1".repeat(77);
const signerAccount = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
const signer = createWalletClient({ account: signerAccount, chain: polygon, transport: http("http://127.0.0.1:9") });
const creds = { key: "k", passphrase: "p", secret: randomBytes(32).toString("base64url") };
const sdk = new ClobClient({ host: "https://clob.polymarket.com", chain: 137, signer, creds, signatureType: 0, funderAddress: signerAccount.address });
sdk.tickSizes[T] = "0.01";
const wrapper = new ClobWrapper(sdk, signerAccount.address, signerAccount.address, creds, 0);
wrapper.negRiskByToken.set(T, false);
wrapper.requestTimeoutMs = 200;
const gateway = new PolymarketGateway(wrapper);
let hash, sentBody;
const realFetch = globalThis.fetch;
async function post(reply, { postOnly = true, timeInForce = "GTC" } = {}) {
  globalThis.fetch = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    const [status, body] = reply();
    return new Response(JSON.stringify(body), { status });
  };
  try {
    return await gateway.submit({ tokenId: T, price: 0.55, shares: 5, direction: "BUY", timeInForce, postOnly },
      { tokenId: T, marketId: "0xm", tickSize: 0.01, minOrderSize: 5 }, prepared => { hash = prepared.orderHash; });
  } finally { globalThis.fetch = realFetch; }
}
const CROSSED = "invalid post-only order: order crosses book";
{
  const ack = await post(() => [400, { error: CROSSED, orderID: hash }]);
  assert.equal(sentBody.postOnly, true, "the signed POST carries postOnly");
  assert.equal(sentBody.orderType, "GTC");
  assert.equal(ack.status, "rejected", "crossed post-only with an order id: it never rested");
  assert.equal(ack.error, CROSSED);
  assert.equal((await post(() => [400, { error: CROSSED }])).status, "rejected");
  assert.equal((await post(() => [200, { success: true, errorMsg: "", orderID: hash, status: "live" }])).status, "accepted");
  assert.equal((await post(() => [400, { error: "order couldn't be placed", orderID: hash }])).status, "unknown",
    "any other error with an order id still needs reconciliation");
  assert.equal((await post(() => [400, { error: CROSSED, orderID: hash, tradeIDs: ["t1"] }])).status, "unknown",
    "words alone are not proof: a named trade is not a refusal");
  assert.equal((await post(() => [400, { error: CROSSED, orderID: hash }], { postOnly: false })).status, "unknown",
    "the crossing words only end a post-only order");
}
// Recovery never replays a post-only order's signature.
assert.equal(replaysPreparedOrder({ prepared: { orderHash: "0x1" }, status: "UNKNOWN", timeInForce: "GTC", postOnly: true },
  undefined, { endsAt: START + 300 }, START + 30), false);
assert.equal(replaysPreparedOrder({ prepared: { orderHash: "0x1" }, status: "UNKNOWN", timeInForce: "GTC", postOnly: false },
  undefined, { endsAt: START + 300 }, START + 30), true, "a plain GTC still replays");

// --- 3) the real platform/core: post -> rest -> partial fill -> timed cancel ---
async function platformRun(ack) {
  let now = START - 20;
  const calls = { submit: [], cancel: [] };
  const fake = { mode: "live", durableIdentity: true,
    async submit(request, _instrument, prepared) {
      calls.submit.push(request);
      prepared({ orderHash: "0xhash", signedPayload: { sig: "s" }, preparedAt: now });
      return { ...ack, orderId: "0xhash" };
    },
    async cancel(id) { calls.cancel.push({ id, at: now }); return true; } };
  const platform = new TradingPlatform({ account: { accountId: "t", at: START - 60, cashAt: START - 60, cashUsd: 100, positions: [],
    openOrders: [], complete: true }, instruments: market.instruments,
    limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, now: () => now,
    adapters: { gateway: fake, estimateFee: () => 0 } });
  platform.ingest({ kind: "market", market });
  platform.attach(createStrategy(MAKER));
  platform.ingest({ kind: "timer", ts: now });
  now = START + 20;
  const side = (tokenId, bid, ask) => ({ assetId: tokenId, bid, ask, bidSize: 100, askSize: 100, sourceAt: now, expiresAt: now + 2 });
  platform.ingest({ kind: "book", marketId: "0xm", roundId: ROUND, snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND,
    sourceAt: now, expiresAt: now + 2, tsUnix: now, receivedAtUnix: now, receivedAtMonoMs: performance.now(), marketAgeMs: 40,
    YES: side(UP, 0.55, 0.57), NO: side(DOWN, 0.43, 0.45) } });
  now = START + 21.002;
  platform.ingest(lead(START + 21));
  await platform.idle();
  return { platform, calls, tick: async (t) => { now = t; platform.ingest({ kind: "timer", ts: t }); await platform.idle(); },
    fill: async (t, shares) => { now = t; platform.ingest({ kind: "fill", marketId: "0xm", roundId: ROUND, assetId: "btc",
      fill: { tradeId: "tr1", orderId: "0xhash", marketId: "0xm", roundId: ROUND, assetId: "btc", tokenId: UP, direction: "BUY",
        price: 0.55, shares, feeUsd: 0, ts: t, isMaker: true, status: "MATCHED" } }); await platform.idle(); } };
}
{
  const run = await platformRun({ status: "accepted", venueStatus: "live" });
  assert.equal(run.calls.submit.length, 1);
  const sent = run.calls.submit[0];
  assert.deepEqual([sent.timeInForce, sent.postOnly, sent.price, sent.shares], ["GTC", true, 0.55, 5]);
  assert.equal(run.platform.core.orders()[0].status, "OPEN", "resting");
  await run.fill(START + 22.5, 2);
  assert.equal(run.platform.core.orders()[0].status, "PARTIAL");
  await run.tick(START + 23.5);
  assert.equal(run.calls.cancel.length, 0, "not before the hold is up");
  await run.tick(START + 24.1);
  assert.equal(run.calls.cancel.length, 1, "the timed cancel reached the venue");
  assert.equal(run.calls.cancel[0].id, "0xhash");
  const order = run.platform.core.orders()[0];
  assert.equal(order.status, "CANCELLED");
  assert.equal(order.filledShares, 2, "the fill before the cancel is kept");
  const position = run.platform.core.snapshot().positions.find(p => p.tokenId === UP);
  assert.equal(position?.shares, 2, "2 shares held to the close");
  const risk = run.platform.core.risk();
  assert.equal(risk.halted, false);
  assert.deepEqual(risk.blockedMarketIds ?? [], [], "a confirmed cancel blocks nothing");
  await run.tick(START + 26);
  assert.equal(run.calls.cancel.length, 1, "no second cancel");
}
{
  // A match just before the cancel, reported after it (maker review 2026-10-27):
  // the order UPDATE (status live) skips the trade queue and lands first. It must
  // not release the reservation, or the trade behind it is "unowned" and lost.
  const run = await platformRun({ status: "accepted", venueStatus: "live" });
  await run.fill(START + 22.5, 2);
  await run.tick(START + 24.1);
  assert.equal(run.platform.core.orders()[0].status, "CANCELLED");
  assert.equal(run.platform.core.observeVenueStatus("0xhash", "live", { source: "user_ws", observedAt: START + 24.3 }), false,
    "a resting status after a confirmed cancel is ignored");
  const held = run.platform.core.orders()[0];
  assert.ok(held.reservedUsd > 1e-8 && held.reconciliationPending === true, "the cancel's reservation is kept for the raced trade");
  const now = START + 24.4;
  run.platform.ingest({ kind: "fill", marketId: "0xm", roundId: ROUND, assetId: "btc",
    fill: { tradeId: "tr2", orderId: "0xhash", marketId: "0xm", roundId: ROUND, assetId: "btc", tokenId: UP, direction: "BUY",
      price: 0.55, shares: 1, feeUsd: 0, ts: now, isMaker: true, status: "MATCHED" } });
  await run.platform.idle();
  assert.equal(run.platform.core.orders()[0].filledShares, 3, "the raced trade is booked");
  assert.equal(run.platform.core.snapshot().positions.find(p => p.tokenId === UP)?.shares, 3);
}
{
  // A maker bid above 0.99 (tick 0.001 near the close) is skipped: a restart
  // must never meet a stage it rejects (maker review 2026-10-27).
  const s = begin({ makerHoldSec: 3, maxAsk: 0.999 });
  const fine = { ...market, instruments: market.instruments.map(i => ({ ...i, tickSize: 0.001 })) };
  s.onEvent(book(START + 20, [0.995, 0.997], [0.003, 0.005]), { ...ctx(START + 20), markets: [fine] });
  assert.deepEqual(submits(s.onEvent(lead(START + 21), { ...ctx(START + 21.002), markets: [fine] })), []);
  assert.match(round(s).reason, /高于最高限价/);
  assert.doesNotThrow(() => createStrategy({ makerHoldSec: 3, maxAsk: 0.999 }, s.exportState()));
}
{
  const run = await platformRun({ status: "rejected", error: CROSSED });
  const order = run.platform.core.orders()[0];
  assert.equal(order.status, "REJECTED", "a crossed post-only ends at once");
  assert.equal(order.reservedUsd, 0);
  const risk = run.platform.core.risk();
  assert.equal(risk.halted, false);
  assert.equal(risk.reconciliationRequired, false);
  await run.tick(START + 25);
  assert.equal(run.calls.cancel.length, 0, "nothing to cancel");
}
console.log("binance-lead-maker OK");
