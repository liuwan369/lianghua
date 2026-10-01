// BUGS.md P2-12 and P3-6, both in the round's first seconds.
//
// P2-12: a round is created ~10 s before it starts with the config of that
// moment, but at start it re-cloned the live config, so a config published in
// that window changed this round's order size. The console promises "current
// and pre-warmed rounds keep their config".
//
// P3-6: account_recovery_started carries no marketId and invalidated every
// running round. A round whose first sample had not arrived then used its first
// AND second sample as baselines, so a crossing on the second sample was lost.
//
// Drives the real compiled strategy. Run after `npm run build`:
//   node scripts/regress/P2-12.mjs
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

// --- P2-12 bug: config published 8 s before start does not change this round ---
{
  const s = createStrategy({ stageShares: [5, 18, 54, 130], maxStages: 4 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));          // round created, frozen at [5,...]
  s.updateConfig({ stageShares: [9, 9, 9, 9] });                           // published inside the warm window
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));   // baseline
  t += 0.5; const order = submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.32) }, ctx(t)));
  assert.ok(order, "the crossing submits");
  assert.equal(order.shares, 5, "a pre-warmed round keeps the config it was created with");
}
// --- P2-12 control: a config published before the round exists applies to it ---
{
  const s = createStrategy({ stageShares: [5, 18, 54, 130], maxStages: 4 });
  s.updateConfig({ stageShares: [9, 9, 9, 9] });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));
  t += 0.5; assert.equal(submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.32) }, ctx(t))).shares, 9);
}
// --- P3-6 bug: a recovery before the first sample does not swallow the first crossing ---
{
  const s = createStrategy({ stageShares: [5, 18, 54, 130], maxStages: 4 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 0.2; s.onEvent({ kind: "timer", ts: t }, ctx(t));          // round is running, no sample yet
  s.onEvent({ kind: "error", strategyId: "btc-reversal", code: "account_recovery_started", message: "account_recovery_started" }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));   // first sample = baseline
  t += 0.5; const order = submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.32) }, ctx(t)));
  assert.ok(order, "the crossing on the second sample is traded");
}
// --- P3-6 control: a recovery after the baseline still requires a fresh baseline ---
{
  const s = createStrategy({ stageShares: [5, 18, 54, 130], maxStages: 4 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.60, 0.40) }, ctx(t));
  s.onEvent({ kind: "error", strategyId: "btc-reversal", code: "account_recovery_started", message: "account_recovery_started" }, ctx(t));
  t += 0.5; assert.equal(submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.68, 0.32) }, ctx(t))), undefined,
    "after a recovery the next sample rebuilds the baseline instead of trading a stale crossing");
}
console.log("P2-12 OK");
