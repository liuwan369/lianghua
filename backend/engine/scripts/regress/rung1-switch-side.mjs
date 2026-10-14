// STRATEGY.md rule 4: rung 1 not yet filled when the other side crosses is
// cancelled and placed on the other side, still as rung 1 (5 shares).
// The engine's consumedRung treated an OPEN/0-fill stage as consumed, so the
// opposite crossing placed rung 2 (13 shares) and never cancelled the old one.
//
// Drives the real compiled strategy. Run after `npm run build`:
//   node scripts/regress/rung1-switch-side.mjs
import assert from "node:assert/strict";
import { createStrategy } from "../../dist/strategies/btc-reversal.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38);
const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`,
  startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const ctx = (now, orders = []) => ({ mode: "live", now, markets: [market], books: [],
  account: { cashUsd: 1000, positions: [], orders, fills: [], risk: { availableUsd: 1000, occupiedUsd: 0 } }, estimateFee: () => 0 });
const snap = (now, up, down) => ({ assetId: "btc", marketId: "0xm", roundId: String(START), sourceAt: now, expiresAt: now + 2,
  tsUnix: now, receivedAtUnix: now, receivedAtMonoMs: 0, marketAgeMs: 50,
  YES: { assetId: UP, bid: up - 0.01, ask: up, sourceAt: now, expiresAt: now + 2 },
  NO: { assetId: DOWN, bid: down - 0.01, ask: down, sourceAt: now, expiresAt: now + 2 } });
const submitted = (actions) => actions.filter((a) => a.kind === "submit").map((a) => a.order);
const cancelled = (actions) => actions.filter((a) => a.kind === "cancel");

// --- bug: rung 1 OPEN with 0 fills, opposite crosses → should cancel + re-place rung 1 ---
{
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  // Baseline
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));
  // UP crosses → rung 1 UP 5 shares
  t += 0.5; let acts = s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.33) }, ctx(t));
  const rung1 = submitted(acts);
  assert.equal(rung1.length, 1, "rung 1 submitted");
  assert.equal(rung1[0].tokenId, UP, "rung 1 is UP");
  assert.equal(rung1[0].shares, 5, "rung 1 is 5 shares");

  // Simulate: rung 1 is OPEN on the venue, 0 filled
  const openOrder = { ...rung1[0], strategyId: "btc-reversal", orderId: "0xorder1",
    status: "OPEN", filledShares: 0, reservedUsd: 3.5, reservedShares: 0,
    createdAt: t, updatedAt: t };
  s.onEvent({ kind: "order", order: openOrder }, ctx(t, [openOrder]));

  // Price goes back below trigger
  t += 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.55, 0.46) }, ctx(t, [openOrder]));
  // DOWN crosses while rung 1 UP is still OPEN with 0 fills
  t += 0.5; acts = s.onEvent({ kind: "book", snapshot: snap(t, 0.34, 0.68) }, ctx(t, [openOrder]));

  const cancels = cancelled(acts);
  const newOrders = submitted(acts);
  assert.equal(cancels.length, 1, "the old rung 1 is cancelled");
  assert.equal(cancels[0].orderId, "0xorder1", "it cancels the right order");
  assert.equal(newOrders.length, 1, "a new rung 1 is placed");
  assert.equal(newOrders[0].tokenId, DOWN, "the new rung 1 is on the opposite side (DOWN)");
  assert.equal(newOrders[0].shares, 5, "the new rung 1 is still 5 shares, not 13");
}

// --- control: rung 1 FILLED, opposite crosses → rung 2 (13 shares), no cancel ---
{
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));
  t += 0.5; s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.33) }, ctx(t));

  const filledOrder = { clientOrderId: "btc-reversal:0xm:1", strategyId: "btc-reversal",
    orderId: "0xorder1", tokenId: UP, direction: "BUY", price: 0.70, shares: 5,
    status: "FILLED", filledShares: 5, reservedUsd: 0, reservedShares: 0,
    timeInForce: "GTC", postOnly: false, createdAt: t, updatedAt: t };
  s.onEvent({ kind: "order", order: filledOrder }, ctx(t, []));

  t += 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.55, 0.46) }, ctx(t, []));
  t += 0.5; const acts = s.onEvent({ kind: "book", snapshot: snap(t, 0.34, 0.68) }, ctx(t, []));
  const cancels = cancelled(acts);
  const newOrders = submitted(acts);
  assert.equal(cancels.length, 0, "no cancel when rung 1 is filled");
  assert.equal(newOrders.length, 1, "rung 2 is placed");
  assert.equal(newOrders[0].shares, 13, "rung 2 is 13 shares");
}

// --- control: rung 1 PARTIAL (some fills), opposite crosses → rung 2, no cancel ---
{
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));
  t += 0.5; s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.33) }, ctx(t));

  const partialOrder = { clientOrderId: "btc-reversal:0xm:1", strategyId: "btc-reversal",
    orderId: "0xorder1", tokenId: UP, direction: "BUY", price: 0.70, shares: 5,
    status: "PARTIAL", filledShares: 3, reservedUsd: 1.4, reservedShares: 0,
    timeInForce: "GTC", postOnly: false, createdAt: t, updatedAt: t };
  s.onEvent({ kind: "order", order: partialOrder }, ctx(t, [partialOrder]));

  t += 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.55, 0.46) }, ctx(t, [partialOrder]));
  t += 0.5; const acts = s.onEvent({ kind: "book", snapshot: snap(t, 0.34, 0.68) }, ctx(t, [partialOrder]));
  assert.equal(cancelled(acts).length, 0, "a partial fill means capital is committed; no cancel");
  assert.equal(submitted(acts)[0]?.shares, 13, "rung 2 after a partial rung 1");
}
console.log("rung1-switch-side OK");
