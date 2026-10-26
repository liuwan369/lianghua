// Review C (2026-10-26) of the FAK accounting fixes: five ways a FAK could
// lose a fill or hold a reservation forever. Real TradingPlatform/TradingCore
// with a stub gateway; recovery rules through the exported helpers.
//
// F1  A POST that timed out, reset or got a 5xx was never answered, yet it
//     carried httpAckAt, so the "FAK the venue never heard of" rule ended it on
//     the first recovery pass; a late real fill was then refused.
// F2  A fill reversed as FAILED left the FAK UNKNOWN with its reservation for
//     good: recovery counted the FAILED leg as "has a fill" and would not end it.
// F3  The new day's start at a restore was valued at cost, while equity is
//     marked: a held position opened the day with a fake gain or loss.
// F5  A no-match error text was trusted even when the same reply named a
//     trade or an amount made: a filled FAK would be released as REJECTED.
// F6  A matched FAK ended once the trades its answer listed arrived; another
//     leg of the same order arriving later was refused as unowned.
//
// Run after `npm run build`:  node scripts/regress/fak-review-c.mjs
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { abandonsMissingFak } from "../../dist/platform/polymarket.js";
import { fakMatchedNothing } from "../../dist/live/clob/client.js";

const T = "1".repeat(77), DOWN = "2".repeat(77), START = 1_800_000_000;
const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: T, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
function rig(ack, { now = START + 21, restored, cash = 100, positions = [] } = {}) {
  const clock = { now };
  const platform = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: cash, positions, openOrders: [], complete: true },
    instruments: market.instruments, limits: { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null }, restored,
    now: () => clock.now,
    adapters: { gateway: { mode: "live", durableIdentity: true, async submit(request, instrument, prepared) {
      prepared({ orderHash: "0xhash", signedPayload: { sig: "s" }, preparedAt: clock.now });
      return { ...ack, orderId: ack.status === "rejected" && !ack.orderId ? undefined : "0xhash" }; },
      async cancel() { return true; } }, estimateFee: () => 0.05 } });
  platform.ingest({ kind: "market", market });
  return { platform, clock };
}
const submit = (platform) => platform.core.submit({ clientOrderId: "binance-lead:0xm:1", strategyId: "binance-lead", tokenId: T,
  direction: "BUY", price: 0.42, shares: 5, timeInForce: "FAK", postOnly: false });
const fill = (extra = {}) => ({ tradeId: "t1", orderId: "0xhash", marketId: "0xm", roundId: String(START), tokenId: T, direction: "BUY",
  price: 0.40, shares: 2, feeUsd: 0.01, ts: START + 21.3, status: "CONFIRMED", feeSource: "reported", ...extra });

// --- F1: an unanswered POST is not "answered", so the fast FAK rule never ends it ---
for (const [name, ack] of [
  ["timeout", { status: "unknown", error: "CLOB POST /order timed out", failurePhase: "post" }],
  ["5xx", { status: "unknown", error: "CLOB POST /order failed (502)", failurePhase: "post" }],
]) {
  const { platform } = rig(ack);
  const order = await submit(platform);
  assert.equal(order.status, "UNKNOWN", `${name}: unknown`);
  const evidence = { missing: true, open: false, tradeScanned: true, hasFill: false, hasPosition: false, accountAt: START + 25 };
  assert.equal(abandonsMissingFak(order, evidence, START + 26), false, `${name}: an unanswered POST keeps the 5-minute wait`);
}
{
  const { platform } = rig({ status: "unknown", error: "no orders found to match with FAK order." }); // answered, kept for recovery
  const order = await submit(platform);
  const evidence = { missing: true, open: false, tradeScanned: true, hasFill: false, hasPosition: false, accountAt: START + 25 };
  assert.equal(abandonsMissingFak(order, evidence, START + 26), true, "an answered POST the venue never knew ends at once");
}

// --- F2: a FAILED leg is not a fill: recovery ends the FAK and frees its reservation ---
{
  const { platform } = rig({ status: "accepted", venueStatus: "matched", tradeIds: ["t1"] });
  await submit(platform);
  platform.core.applyFill(fill({ status: "MATCHED" }));
  platform.core.applyFill(fill({ status: "FAILED" }));
  let order = platform.core.orders()[0];
  assert.equal(order.status, "UNKNOWN", "a failed trade sends the order to reconciliation");
  assert.equal(platform.core.quarantineUnknown("0xhash", "order detail returned not found; venue outcome pending"), true);
  assert.equal(platform.core.abandonUnknown("0xhash", "complete account and trade reads confirmed no open order, position, or fill after timeout"), true,
    "a FAILED leg does not count as a fill: the order can end");
  assert.equal(platform.core.orders().length, 0, "abandoned");
  assert.equal(platform.core.risk().unresolvedOrderCount, 0, "nothing left to reconcile");
  assert.ok(Math.abs(platform.core.view().cashUsd - 100) < 1e-9, "cash back where it was");
}

// --- F3: the new day's start at a restore is valued like equity (marked), not at cost ---
{
  const old = rig({ status: "rejected" }, { now: START - 10 * 86400, cash: 209.53 });
  const stale = old.platform.core.snapshot();
  const position = { tokenId: T, shares: 10, costUsd: 5, realizedPnlUsd: 0, markPrice: 0.10 };
  const { platform } = rig({ status: "rejected" }, { restored: stale, cash: 160, positions: [position] });
  // As live: the start-up read reaches the ledger through account recovery.
  platform.core.reconcile({ accountId: "t", at: START + 1, cashAt: START + 1, cashUsd: 160, positions: [position], openOrders: [], complete: true });
  const risk = platform.core.risk();
  assert.ok(Math.abs(risk.baselineEquityUsd - risk.equityUsd) < 1e-9,
    `the day opens at the marked equity: baseline ${risk.baselineEquityUsd} vs equity ${risk.equityUsd}`);
  assert.ok(Math.abs(risk.dailyPnlUsd) < 1e-9, "no fake gain or loss at the open");
}

// --- F5: a no-match text with a trade or an amount is not proof the FAK matched nothing ---
const NO_MATCH = "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.";
assert.equal(fakMatchedNothing({ error: NO_MATCH, orderID: "0xhash" }, NO_MATCH), true, "the live 400: matched nothing");
assert.equal(fakMatchedNothing({ success: false, errorMsg: NO_MATCH, makingAmount: "2.1", takingAmount: "5.25", tradeIDs: ["t1"] }, NO_MATCH), false,
  "the same text with a trade id and amounts: not a kill");
assert.equal(fakMatchedNothing({ success: false, errorMsg: NO_MATCH, makingAmount: "0", takingAmount: "0", tradeIDs: ["t1"] }, NO_MATCH), false,
  "a trade id alone: not a kill");
assert.equal(fakMatchedNothing({ success: false, errorMsg: NO_MATCH, makingAmount: "2.1" }, NO_MATCH), false, "an amount made: not a kill");
{
  // The core keeps such an order: UNKNOWN with its reservation, never REJECTED.
  const { platform } = rig({ status: "unknown", error: NO_MATCH, tradeIds: ["t1"] });
  const order = await submit(platform);
  assert.equal(order.status, "UNKNOWN", "a reply naming a trade keeps the order");
  assert.ok(order.reservedUsd > 2, "and its reservation");
}

// --- F6: a later leg of a matched FAK is still taken after its listed trades arrived ---
{
  const { platform } = rig({ status: "accepted", venueStatus: "matched", tradeIds: ["t1"] });
  await submit(platform);
  platform.core.applyFill(fill({ shares: 2, price: 0.40 }));
  assert.doesNotThrow(() => platform.core.applyFill(fill({ tradeId: "t9", shares: 1, price: 0.40 })),
    "another leg of the same order is ours");
  const order = platform.core.orders()[0];
  assert.equal(order.filledShares, 3, "both legs booked");
  assert.ok(Math.abs(platform.core.view().cashUsd - (100 - 3 * 0.40 - 0.02)) < 1e-9, "both legs paid");
  assert.equal(order.reservedUsd, 0, "nothing reserved for the void rest");
}
console.log("fak-review-c OK");
