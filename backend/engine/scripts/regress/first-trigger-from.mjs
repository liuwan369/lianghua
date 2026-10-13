// STRATEGY.md rule 3 (operator 2026-10-13, experiment): with firstTriggerFromSec
// N, a round whose FIRST crossing comes before N seconds after the open is not
// traded at all; a round whose first crossing is at or after N trades as usual.
// It is not "no orders before N": a crossing before N voids the whole round,
// later crossings included (the rule scripts/backtest.py --first-after tested).
//
// Drives the real compiled strategy. Run after `npm run build`:
//   node scripts/regress/first-trigger-from.mjs
import assert from "node:assert/strict";
import { createStrategy, normalizeBtcReversalConfig } from "../../dist/strategies/btc-reversal.js";

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
const config = { stageShares: [5, 13, 60], maxStages: 3, firstTriggerFromSec: 60 };
// Fresh frames every second keep the baseline alive between the given asks.
const drive = (s, from, to, up, down) => {
  let order;
  for (let t = START + from; t <= START + to + 1e-9; t += 1) order = submitted(s.onEvent({ kind: "book", snapshot: snap(t, up, down) }, ctx(t))) ?? order;
  return order;
};
const begin = () => { const s = createStrategy(config); const t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t)); return s; };

// --- a first crossing before 60 s voids the round, later crossings too ---
{
  const s = begin();
  drive(s, 1, 20, 0.60, 0.41);
  assert.equal(drive(s, 21, 21, 0.68, 0.33), undefined, "the first crossing at 21 s is not traded");
  drive(s, 22, 70, 0.60, 0.41);
  assert.equal(drive(s, 71, 71, 0.33, 0.68), undefined, "a later crossing at 71 s is not traded either");
  drive(s, 72, 80, 0.60, 0.41);
  assert.equal(drive(s, 81, 81, 0.68, 0.33), undefined);
  const round = s.exportState().rounds[0];
  assert.equal(round.stages.length, 0, "nothing was placed in the voided round");
  assert.equal(round.status, "waiting_next_round");
}
// --- a first crossing at or after 60 s trades as usual, hedges included ---
{
  const s = begin();
  drive(s, 1, 64, 0.60, 0.41);
  const first = drive(s, 65, 65, 0.68, 0.33);
  assert.ok(first, "the first crossing at 65 s is traded");
  assert.equal([first.tokenId, first.shares].join(), [UP, 5].join());
  drive(s, 66, 90, 0.60, 0.41);
  const hedge = drive(s, 91, 91, 0.33, 0.68);
  assert.ok(hedge, "the reversal after it is hedged");
  assert.equal([hedge.tokenId, hedge.shares].join(), [DOWN, 13].join());
}
// --- exactly at N counts as at or after ---
{
  const s = begin();
  drive(s, 1, 59, 0.60, 0.41);
  assert.ok(drive(s, 60, 60, 0.68, 0.33), "a first crossing at exactly 60 s is traded");
}
// --- 0 (the default) trades from the open, as before ---
{
  const s = createStrategy({ stageShares: [5, 13, 60], maxStages: 3 });
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  drive(s, 1, 4, 0.60, 0.41);
  assert.ok(drive(s, 5, 5, 0.68, 0.33), "with no limit a crossing at 5 s is traded");
}
// --- the voided round stays voided across a restart ---
{
  const s = begin();
  drive(s, 1, 20, 0.60, 0.41);
  drive(s, 21, 21, 0.68, 0.33);
  const restored = createStrategy({}, s.exportState());
  drive(restored, 22, 70, 0.60, 0.41);
  assert.equal(drive(restored, 71, 71, 0.68, 0.33), undefined, "restored, the round is still not traded");
}
// --- config: default 0, a value in [0, 300), older configs without it load ---
{
  assert.equal(normalizeBtcReversalConfig({}).firstTriggerFromSec, 0);
  assert.equal(normalizeBtcReversalConfig({ firstTriggerFromSec: 60 }).firstTriggerFromSec, 60);
  for (const bad of [-1, 300, Number.NaN, "60"]) {
    assert.throws(() => normalizeBtcReversalConfig({ firstTriggerFromSec: bad }), `${bad} is rejected`);
  }
}
console.log("first-trigger-from OK");
