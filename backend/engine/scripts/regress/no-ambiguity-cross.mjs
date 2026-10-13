// A crossing is a side's ask going from below the trigger to at or above it,
// nothing else (STRATEGY.md rule 5, same as scripts/backtest.py).
// The old "both above the trigger" ambiguity path resolved a later frame by
// "ask >= trigger" alone, so a side that never was below the line counted as
// a crossing. At trigger 0.67 such frames sum >= 1.34 and rule 2 skips them;
// a trigger below 0.525 reaches it, so the test uses 0.50.
//
// Drives the real compiled strategy. Run after `npm run build`:
//   node scripts/regress/no-ambiguity-cross.mjs
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
const config = { triggerPrice: 0.50, confirmationPrice: 0.70, maxBuyPrice: 0.70, stageShares: [5, 13, 60], maxStages: 3 };

// --- bug: up never was below 0.50, yet counted as crossing after a "both above" frame ---
{
  const s = createStrategy(config);
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.51, 0.51) }, ctx(t));       // baseline, both above
  t += 0.5; assert.equal(submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.53, 0.51) }, ctx(t))), undefined);
  t += 0.5; const order = submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.56, 0.44) }, ctx(t)));
  assert.equal(order, undefined, "a side that never was below the trigger is not a crossing");
}
// --- control: a plain crossing from below still trades ---
{
  const s = createStrategy(config);
  let t = START - 8; s.onEvent({ kind: "timer", ts: t }, ctx(t));
  t = START + 1; s.onEvent({ kind: "book", snapshot: snap(t, 0.45, 0.55) }, ctx(t));
  t += 0.5; const order = submitted(s.onEvent({ kind: "book", snapshot: snap(t, 0.52, 0.48) }, ctx(t)));
  assert.ok(order, "up 0.45 -> 0.52 crosses 0.50 and trades");
  assert.equal(order.tokenId, UP);
}
console.log("no-ambiguity-cross OK");
