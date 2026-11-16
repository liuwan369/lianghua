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
import { regimePause, REGIME_PAUSE_SIGNALS, REGIME_PAUSE_VOL_BP, createStrategy, normalizeBinanceLeadConfig } from "../../dist/strategies/binance-lead.js";
import { leadOrderFields } from "../../dist/cli/platform.js";
import { leadEvent } from "../../dist/platform/polymarket.js";

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
// --- the platform's lead event keeps every signal field (live 2026-11-15:
// a field-by-field copy dropped signals300/vol300Bp, every order was unjudged) ---
{
  const d = new LeadSignalDetector(PARAMS);
  const t0 = (R - 400) * 1000;
  for (let k = 0; k <= 390; k += 1) push(d, t0 + k * 1000, 100000);
  const s = jump(d, t0 + 390_500, 100000, 100030);
  const e = leadEvent({ kind: "lead", ...s });
  for (const key of Object.keys(s)) assert.deepEqual(e[key], s[key], `kept ${key}`);
  assert.equal(e.signals300, 0); assert.ok(Number.isFinite(e.vol300Bp));
  assert.ok(!("relayRecvMs" in e), "an absent optional field stays absent");
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
// --- the switch (user 2026-11-16): off by default, the order goes out; on, a
// wild signal is skipped and the round keeps its attempt for a calm one ---
{
  assert.equal(normalizeBinanceLeadConfig({}).regimePause, false, "off by default");
  assert.throws(() => normalizeBinanceLeadConfig({ regimePause: "yes" }), /regimePause/);
  const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38);
  const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
    instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                  { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
  const ctx = now => ({ mode: "live", now, markets: [market], books: [], estimateFee: () => 0.02,
    account: { cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } } });
  const book = t => ({ kind: "book", marketId: "0xm", roundId: String(START), snapshot: { assetId: "btc", marketId: "0xm", roundId: String(START),
    sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: 0.4, ask: 0.5, sourceAt: t, expiresAt: t + 2 }, NO: { assetId: DOWN, bid: 0.4, ask: 0.52, sourceAt: t, expiresAt: t + 2 } } });
  const lead = (S, extra) => ({ kind: "lead", assetId: "btc", direction: "UP", price: 100030, refPrice: 100000, moveBp: 3,
    venue: "bybit", line: "direct", tradeId: S, tradeTimeMs: (S - 0.1) * 1000, receivedAtUnix: S, receivedAtMonoMs: 1, ...extra });
  const run = (config, extra) => {
    const st = createStrategy({ limitPremium: 0.08, ...config });
    st.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
    st.onEvent(book(START + 20), ctx(START + 20));
    return { st, actions: st.onEvent(lead(START + 21, extra), ctx(START + 21.002)) };
  };
  const wild = { signals300: 20, vol300Bp: 0.4 };
  assert.equal(run({}, wild).actions.filter(a => a.kind === "submit").length, 1, "off: a wild signal still trades");
  const on = run({ regimePause: true }, wild);
  assert.equal(on.actions.filter(a => a.kind === "submit").length, 0, "on: a wild signal is skipped");
  assert.match(on.st.exportState().rounds[0].reason, /行情太乱：前 5 分钟 20 个信号/);
  assert.equal(on.st.exportState().rounds[0].stages.length, 0, "the round keeps its attempt");
  const later = on.st.onEvent(lead(START + 40, { signals300: 3, vol300Bp: 0.4 }), ctx(START + 40.002));
  assert.equal(later.filter(a => a.kind === "submit").length, 1, "a calm signal later in the round trades");
  const vol = run({ regimePause: true }, { signals300: 2, vol300Bp: 1.2 });
  assert.match(vol.st.exportState().rounds[0].reason, /每秒波动 1.20 bp/);
  assert.equal(run({ regimePause: true }, {}).actions.filter(a => a.kind === "submit").length, 1, "no measures (after a restart): trades");
}
console.log("regime-shadow OK");
