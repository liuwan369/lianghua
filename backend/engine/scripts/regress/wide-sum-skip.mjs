// STRATEGY.md rule 2: a frame whose two asks sum to more than 1.05 is a thin
// book (a wide spread the price jumps across) and must not be used to judge a
// crossing. Such a frame is skipped; the baseline stays and the next clean
// frame (sum <= 1.05) judges. Matches the backtest (scripts/backtest.py
// "if ua + da > WIDE_SUM: return # the starting point stays").
//
// Drives the real compiled strategy. Run after `npm run build`:
//   node scripts/regress/wide-sum-skip.mjs
import assert from "node:assert/strict";
import { createStrategy } from "../../dist/strategies/btc-reversal.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38);
const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`,
  startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const ctx = (now) => ({ mode: "live", now, markets: [market], books: [],
  account: { cashUsd: 1000, positions: [], orders: [], fills: [], risk: { availableUsd: 1000, occupiedUsd: 0 } }, estimateFee: () => 0 });
const snap = (now, up, down) => ({ assetId: "btc", marketId: "0xm", roundId: String(START), sourceAt: now, expiresAt: now + 2,
  tsUnix: now, receivedAtUnix: now, receivedAtMonoMs: 0, marketAgeMs: 50,
  YES: { assetId: UP, bid: up - 0.01, ask: up, sourceAt: now, expiresAt: now + 2 },
  NO: { assetId: DOWN, bid: down - 0.01, ask: down, sourceAt: now, expiresAt: now + 2 } });
const submitted = (actions) => actions.find((a) => a.kind === "submit")?.order;

// --- bug: a crossing seen only on a thin-book frame (sum > 1.05) is traded ---
{
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));        // baseline, sum 1.00
  t += 0.5; const order = submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.40) }, ctx(t))); // sum 1.08
  assert.equal(order, undefined, "a crossing on a thin-book frame (sum 1.08) is not traded");
}
// --- a real crossing right after a thin frame is not lost: the next clean
// frame still judges it against the unchanged baseline ---
{
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));        // baseline
  t += 0.5; assert.equal(submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.40) }, ctx(t))), undefined); // thin, skipped
  t += 0.5; const order = submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.31) }, ctx(t)));            // clean, sum 0.99
  assert.ok(order, "the clean frame after a thin one still trades the crossing");
  assert.equal(order.tokenId, UP, "it trades the side that crossed");
  assert.equal(order.shares, 5, "rung 1 is 5 shares");
}
// --- a thin first frame does not become the baseline: the next clean frame does ---
{
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; assert.equal(submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.40) }, ctx(t))), undefined); // thin first frame
  t += 0.5; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));            // first clean frame = baseline
  t += 0.5; const order = submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.31) }, ctx(t)));
  assert.ok(order, "a thin first frame is not a baseline; the crossing after the real baseline trades");
}
// --- boundary: sum just over 1.05 is skipped, sum just under 1.05 is traded ---
{
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));        // baseline
  t += 0.5; assert.equal(submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.38) }, ctx(t))), undefined, "sum 1.06 is thin"); // 1.06
  t += 0.5; assert.ok(submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.36) }, ctx(t))), "sum 1.04 is clean and trades");    // 1.04
}
console.log("wide-sum-skip OK");
