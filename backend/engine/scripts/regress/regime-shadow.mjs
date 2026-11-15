// Shadow regime pause (user 2026-11-15, records only): each lead signal carries
// its venue's signals and the std of 1 s log returns (bp) over the 300 s before
// it; a round's order whose signal had more than REGIME_PAUSE_SIGNALS signals
// or a std above REGIME_PAUSE_VOL_BP is journalled regime_pause true. Nothing
// is skipped.
// - no 300 s of history: both absent, regime_pause null;
// - a calm 6 min, then a signal: 0 signals before, std ~0;
// - 13 earlier signals in the 300 s: signals300 13 -> pause "signals";
// - a 300 s of 1.5 bp swings each second: vol300Bp > 0.89 -> pause "vol";
// - signals older than 300 s drop out of the count.
// Run after `npm run build`:  node scripts/regress/regime-shadow.mjs
import assert from "node:assert/strict";
import { LeadSignalDetector } from "../../dist/live/feeds/binance-trades.js";
import { regimePause, REGIME_PAUSE_SIGNALS, REGIME_PAUSE_VOL_BP } from "../../dist/strategies/binance-lead.js";
import { leadOrderFields } from "../../dist/cli/platform.js";

const R = 1_800_000_000;
const PARAMS = { windowMs: 250, thresholdBp: 2, fromSec: 0, toSec: 300 };
let id = 0;
const push = (d, ms, price) => d.push({ id: ++id, price, tradeTimeMs: ms, venue: "bybit", line: "direct",
  receivedAtUnix: ms / 1000, receivedAtMonoMs: 0 }, ms / 1000);
// A signal at ms: a reference trade 100 ms before at `from`, then `to`.
const jump = (d, ms, from, to) => { push(d, ms - 100, from); return push(d, ms, to); };
const close = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);
assert.equal(REGIME_PAUSE_SIGNALS, 12); assert.equal(REGIME_PAUSE_VOL_BP, 0.89);

// --- no history: absent ---
{
  const d = new LeadSignalDetector(PARAMS);
  push(d, R * 1000, 100000);
  const s = push(d, R * 1000 + 100, 100030);
  assert.equal(s.direction, "UP");
  assert.equal(s.signals300, undefined); assert.equal(s.vol300Bp, undefined);
  assert.deepEqual(regimePause(s), { pause: false, reason: null });
}
// --- calm 6 minutes, then a signal ---
{
  const d = new LeadSignalDetector(PARAMS);
  const t0 = (R - 400) * 1000;
  for (let k = 0; k <= 390; k += 1) push(d, t0 + k * 1000, 100000);
  const s = jump(d, t0 + 390_500, 100000, 100030);
  assert.ok(s, "the jump signals");
  assert.equal(s.signals300, 0);
  close(s.vol300Bp, 0, "a flat price has no std");
  assert.equal(regimePause(s).pause, false);
}
// --- 13 earlier signals in the 300 s: pause on signals ---
{
  const d = new LeadSignalDetector(PARAMS);
  const t0 = (R - 400) * 1000;
  let p = 100000;
  for (let k = 0; k <= 390; k += 1) {
    push(d, t0 + k * 1000, p);
    if (k >= 100 && k < 113) { const q = p * Math.exp(3e-4); assert.ok(jump(d, t0 + k * 1000 + 500, p, q), `signal at ${k}`); p = q; }
  }
  const s = jump(d, t0 + 390_500, p, p * Math.exp(3e-4));
  assert.equal(s.signals300, 13, "the 13 signals 278..290 s before");
  assert.deepEqual(regimePause(s), { pause: true, reason: "signals" });
  // 300 s later they have dropped out.
  for (let k = 391; k <= 690; k += 1) push(d, t0 + k * 1000, p);
  const later = jump(d, t0 + 690_500, p, p * Math.exp(6e-4));
  assert.equal(later.signals300, 1, "only the signal at 390.5 s is within the 300 s before 690.5 s");
}
// --- 1.5 bp swings every second: pause on vol ---
{
  const d = new LeadSignalDetector({ ...PARAMS, thresholdBp: 50 });   // no signals from the swings
  const t0 = (R - 400) * 1000;
  for (let k = 0; k <= 390; k += 1) push(d, t0 + k * 1000, 100000 * Math.exp((k % 2 ? 1.5 : 0) * 1e-4));
  d.update(PARAMS);
  const s = jump(d, t0 + 390_500, 100000, 100000 * Math.exp(5e-4));
  assert.ok(s.vol300Bp > 0.89 && s.vol300Bp < 1.6, `std of ±1.5 bp: ${s.vol300Bp}`);
  assert.deepEqual(regimePause(s), { pause: true, reason: "vol" });
}
// --- journal: the round's order carries the shadow decision ---
{
  const signal = { direction: "UP", price: 1, refPrice: 1, moveBp: 2, venue: "bybit", line: "direct", tradeId: 1,
    tradeTimeMs: R * 1000 + 40_000, receivedAtUnix: R + 40, receivedAtMonoMs: 0, signals300: 20, vol300Bp: 0.4 };
  const stage = { direction: "UP", tokenId: "u", clientOrderId: "binance-lead:0xm:1", price: 0.5, shares: 5, createdAt: R + 40,
    status: "FILLED", filledShares: 5, signal, askAtSignal: 0.45 };
  const round = { marketId: "0xm", roundId: String(R), startsAt: R, stages: [stage],
    config: { openLine: "mean60", restAfterMissSec: 0, restShadow: true } };
  const f = leadOrderFields(round, stage, undefined, []);
  assert.deepEqual([f.signals300, f.vol300_bp, f.regime_pause, f.regime_reason], [20, 0.4, true, "signals"]);
  const old = leadOrderFields(round, { ...stage, signal: { ...signal, signals300: undefined, vol300Bp: undefined } }, undefined, []);
  assert.equal(old.regime_pause, null, "a signal without the measures is not judged");
}
console.log("regime-shadow OK");
