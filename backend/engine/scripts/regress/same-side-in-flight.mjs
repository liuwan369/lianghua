// REVERSAL.md 4 / STRATEGY.md 5: after a firing only the other side counts, and
// "our side" is the side of the last rung placed, filled or not. The engine took
// "our side" from FILLED rungs only (6bb607e), so while a rung was still in
// flight (~230 ms to the ACK) or resting at 0.70 unfilled:
// - the same side flickering 0.66/0.67 placed the same rung again on that side
//   (replaying 10 recorded btc days with venue latency: 240 rounds, e.g.
//   DOWN 5, DOWN 5, then UP 60 on the next reversal; DOWN 5, UP 13, UP 13, UP 13);
// - a real reversal against an unfilled rung 2 was ignored, where the backtest
//   places rung 3.
// Drives the real compiled strategy. Run after `npm run build`:
//   node scripts/regress/same-side-in-flight.mjs
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
const submits = (actions) => actions.filter((a) => a.kind === "submit").map((a) => a.order);
const cancels = (actions) => actions.filter((a) => a.kind === "cancel");
const order = (req, orderId, status, filledShares) => ({ ...req, strategyId: "btc-reversal", orderId, status, filledShares,
  reservedUsd: 0, reservedShares: 0, createdAt: START, updatedAt: START });

function start(persist) {
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 }, undefined, persist ? { persist } : {});
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.40, 0.60) }, ctx(t));       // baseline
  return s;
}

// --- 1: rung 1 in flight (signed, no ACK yet), the same side flickers back over 0.67 ---
{
  const s = start();
  let t = START + 1.84;
  const [rung1] = submits(s.onEvent({ kind: "book", snapshot: snap(t, 0.33, 0.67) }, ctx(t)));   // DOWN crosses
  assert.equal(rung1?.tokenId, DOWN);
  const inFlight = order(rung1, "0xa", "SUBMITTING", 0);
  s.onEvent({ kind: "order", order: inFlight }, ctx(t, [inFlight]));
  t = START + 1.845; s.onEvent({ kind: "book", snapshot: snap(t, 0.35, 0.66) }, ctx(t, [inFlight]));
  t = START + 1.883; const acts = s.onEvent({ kind: "book", snapshot: snap(t, 0.33, 0.67) }, ctx(t, [inFlight]));
  assert.deepEqual(submits(acts), [], "1: the same side crossing again is no reversal: no second rung 1");
  assert.deepEqual(cancels(acts), [], "1: and the working rung 1 is not cancelled");
}
// --- 2: rung 1 filled, rung 2 in flight, rung 2's side crosses again ---
{
  const s = start();
  let t = START + 1.5;
  const [rung1] = submits(s.onEvent({ kind: "book", snapshot: snap(t, 0.33, 0.67) }, ctx(t)));   // DOWN
  const filled1 = order(rung1, "0xa", "FILLED", 5);
  s.onEvent({ kind: "order", order: filled1 }, ctx(t, [filled1]));
  t += 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t, [filled1]));
  t += 1; const [rung2] = submits(s.onEvent({ kind: "book", snapshot: snap(t, 0.67, 0.33) }, ctx(t, [filled1])));  // UP
  assert.equal(rung2?.shares, 13);
  const inFlight = order(rung2, "0xb", "SUBMITTING", 0), all = [filled1, inFlight];
  s.onEvent({ kind: "order", order: inFlight }, ctx(t, all));
  t += 0.05; s.onEvent({ kind: "book", snapshot: snap(t, 0.66, 0.34) }, ctx(t, all));
  t += 0.05; const acts = s.onEvent({ kind: "book", snapshot: snap(t, 0.67, 0.33) }, ctx(t, all));
  assert.deepEqual(submits(acts), [], "2: rung 2's side crossing again places nothing");
}
// --- 3: rung 2 resting unfilled, rung 1's side crosses: that is a reversal (rung 3) ---
let saved;
{
  const s = start((st) => { saved = st; });
  let t = START + 1.5;
  const [rung1] = submits(s.onEvent({ kind: "book", snapshot: snap(t, 0.33, 0.67) }, ctx(t)));   // DOWN
  const filled1 = order(rung1, "0xa", "FILLED", 5);
  s.onEvent({ kind: "order", order: filled1 }, ctx(t, [filled1]));
  t += 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t, [filled1]));
  t += 1; const [rung2] = submits(s.onEvent({ kind: "book", snapshot: snap(t, 0.67, 0.33) }, ctx(t, [filled1])));  // UP
  const resting = order(rung2, "0xb", "OPEN", 0), all = [filled1, resting];
  s.onEvent({ kind: "order", order: resting }, ctx(t, all));
  t += 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.40, 0.60) }, ctx(t, all));
  t += 1; const acts = s.onEvent({ kind: "book", snapshot: snap(t, 0.33, 0.67) }, ctx(t, all));   // DOWN
  const [rung3] = submits(acts);
  assert.equal(rung3?.tokenId, DOWN, "3: the other side of the last rung crossing is a reversal");
  assert.equal(rung3?.shares, 60, "3: it places rung 3, as the backtest does");
  assert.deepEqual(cancels(acts), [], "3: the unfilled rung 2 keeps resting");
  // --- 4: rung 2 then ends cancelled with nothing bought; the state must still restore ---
  const st = structuredClone(saved);
  st.rounds[0].stages[1].status = "CANCELLED";
  assert.doesNotThrow(() => createStrategy(st.config, st), "4: the ladder 5 / 13 (cancelled at 0) / 60 restores");
}
console.log("same-side-in-flight OK");
