// P0-1: after a REJECTED (or 0-fill CANCELLED) stage, the strategy sizes
// and directs the next stage by CONSUMED rungs (rejected ones don't count), but
// restore() validates by array index and forbids two adjacent same-direction
// stages. So a real persisted ladder throws "invalid persisted reversal stage"
// / "invalid persisted reversal round" on every later start, and the engine
// cannot start until the state file is hand-edited.
//
// Uses the real compiled createStrategy. Run after `npm run build`:
//   node scripts/regress/P0-1.mjs
import assert from "node:assert/strict";
import { createStrategy } from "../../dist/strategies/btc-reversal.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38);
const CFG = { instanceId: "btc-reversal", assetId: "btc", revision: "1", triggerPrice: 0.67,
  confirmationPrice: 0.70, maxBuyPrice: 0.70, stageShares: [5, 18, 54, 130], maxStages: 4,
  maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 };
const stage = (n, dir, shares, status, filled = 0) => ({ stage: n, direction: dir,
  tokenId: dir === "UP" ? UP : DOWN, clientOrderId: `btc-reversal:0xm:${n}`, price: 0.70,
  shares, createdAt: START + n, trigger: "crossing", status, filledShares: filled });
const round = (stages, lastDir, cfg = CFG) => ({ assetId: "btc", marketId: "0xm", roundId: String(START),
  name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300, upTokenId: UP, downTokenId: DOWN,
  status: "running", config: cfg, stages, lastStageDirection: lastDir, confirmationCount: 0,
  firstSampleSeen: true, rebuildingReference: false, pendingAmbiguity: false });
const state = (rounds) => ({ schemaVersion: 1, strategyId: "btc-reversal", instanceId: "btc-reversal",
  paused: false, config: rounds[0].config, rounds });
const restores = (st) => { try { createStrategy(st.config, st); return true; } catch { return false; } };

// --- bug A: rejected stage 1, retry same direction as stage 2 with the same size ---
{
  // Real sequence: UP crosses -> stage1 UP 5 REJECTED; UP crosses again ->
  // stage2 UP 5 (consumed rungs still 0, so size = stageShares[0] = 5).
  const st = state([round([stage(1, "UP", 5, "REJECTED"), stage(2, "UP", 5, "FILLED", 5)], "UP")]);
  assert.ok(restores(st), "A: a rejected-then-retried ladder must restore");
}
// --- bug B: 0-fill CANCELLED stage 1, retry opposite direction stage 2, size 5 ---
{
  const st = state([round([stage(1, "UP", 5, "CANCELLED", 0), stage(2, "DOWN", 5, "FILLED", 5)], "DOWN")]);
  assert.ok(restores(st), "B: a 0-fill-cancelled-then-retried ladder must restore");
}
// --- bug C: one rejected rung plus a full ladder exceeds maxStages by count ---
{
  const cfg = { ...CFG, stageShares: [5, 18], maxStages: 2 };
  const st = state([round([stage(1, "UP", 5, "REJECTED"), stage(2, "UP", 5, "FILLED", 5),
    stage(3, "DOWN", 18, "FILLED", 18)], "DOWN", cfg)]);
  assert.ok(restores(st), "C: a rejected rung plus a full ladder must restore (count > maxStages)");
}
// --- control 1: a normal ladder [5 then 18] must still restore ---
{
  const st = state([round([stage(1, "UP", 5, "FILLED", 5), stage(2, "DOWN", 18, "FILLED", 18)], "DOWN")]);
  assert.ok(restores(st), "control1: a normal alternating ladder restores");
}
// --- control 2: genuinely corrupt state must STILL be rejected ---
{
  // Two adjacent LIVE (consumed) UP stages is impossible — the strategy never
  // places two consumed same-direction rungs in a row. Must still throw.
  const bad = state([round([stage(1, "UP", 5, "FILLED", 5), stage(2, "UP", 18, "FILLED", 18)], "UP")]);
  assert.ok(!restores(bad), "control2: two consecutive consumed same-direction stages must be rejected");
}
// --- control 3: wrong size for the consumed rung must be rejected ---
{
  // stage1 filled (consumes rung 0 -> next size must be stageShares[1]=18), but
  // stage2 says 54. Corrupt.
  const bad = state([round([stage(1, "UP", 5, "FILLED", 5), stage(2, "DOWN", 54, "FILLED", 54)], "DOWN")]);
  assert.ok(!restores(bad), "control3: a stage sized off the wrong consumed rung must be rejected");
}
// --- driven: run the REAL strategy through submit -> reject -> retry, then
// restore its own exported state. This proves the persisted shape the strategy
// actually produces round-trips, not just hand-built states. ---
{
  const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`,
    startsAt: START, endsAt: START + 300,
    instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                  { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
  let saved;
  const s = createStrategy({ stageShares: [5, 18, 54, 130], maxStages: 4 }, undefined, { persist: (st) => { saved = st; } });
  const ctx = (now) => ({ mode: "live", now, markets: [market], books: [],
    account: { cashUsd: 1000, positions: [], orders: [], fills: [], risk: { availableUsd: 1000, occupiedUsd: 0 } }, estimateFee: () => 0 });
  const snap = (now, up, down) => ({ assetId: "btc", marketId: "0xm", roundId: String(START), sourceAt: now, expiresAt: now + 2,
    tsUnix: now, receivedAtUnix: now, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: up - 0.01, ask: up, sourceAt: now, expiresAt: now + 2 },
    NO: { assetId: DOWN, bid: down - 0.01, ask: down, sourceAt: now, expiresAt: now + 2 } });
  let t = START - 5; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));        // baseline
  t += 0.5; const a1 = s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.32) }, ctx(t));  // UP crosses -> stage 1
  const o1 = a1.find((x) => x.kind === "submit")?.order;
  assert.ok(o1 && o1.shares === 5, "driven: stage 1 is 5 shares");
  t += 0.1; s.onEvent({ kind: "error", strategyId: "btc-reversal", clientOrderId: o1.clientOrderId, code: "order_not_submitted", message: "rejected" }, ctx(t));
  t += 0.5; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));             // back below
  t += 0.5; const a2 = s.onEvent({ kind: "book", snapshot: snap(t, 0.69, 0.31) }, ctx(t));  // UP crosses again -> stage 2
  const o2 = a2.find((x) => x.kind === "submit")?.order;
  assert.ok(o2 && o2.shares === 5, "driven: retry after a reject is still 5 shares (consumed rungs = 0)");
  const r = saved.rounds[0];
  assert.deepEqual(r.stages.map((x) => [x.status, x.direction, x.shares]),
    [["REJECTED", "UP", 5], ["CREATED", "UP", 5]], "driven: persisted stages are [REJECTED UP 5, CREATED UP 5]");
  assert.ok(restores(saved), "driven: the strategy's own persisted state restores");
  console.log("PASS driven: real reject->retry state round-trips through restore");
}
console.log("P0-1 OK");
