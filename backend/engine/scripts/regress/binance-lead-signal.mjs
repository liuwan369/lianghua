// Binance lead rule 1-3 (frozen 2026-10-25, E:/pm-backup/forward-binance-agg.py
// signals()): a trade signals when it is >= thresholdBp above the 250 ms window
// low (UP) or below its high (DOWN); trades older than T - 250 ms leave the
// window, one exactly 250 ms old stays; only S in [R+15, R+265) counts; a valid
// signal leaves only itself in the window, an out-of-period one does nothing.
//
// Drives the real compiled LeadSignalDetector. Run after `npm run build`:
//   node scripts/regress/binance-lead-signal.mjs
import assert from "node:assert/strict";
import { LeadSignalDetector } from "../../dist/live/feeds/binance-trades.js";

const R = 1_800_000_000;                       // a round open (multiple of 300)
const PARAMS = { windowMs: 250, thresholdBp: 2, fromSec: 15, toSec: 265 };
let id = 0;
// A trade at `ms` after R+20 s, seen 125 ms later (unless `seen` is given).
const trade = (ms, price, seen) => {
  const tradeTimeMs = (R + 20) * 1000 + ms;
  return { t: { id: ++id, price, tradeTimeMs, receivedAtUnix: seen ?? tradeTimeMs / 1000 + 0.125, receivedAtMonoMs: ms },
    seen: seen ?? tradeTimeMs / 1000 + 0.125 };
};
const feed = (d, list) => list.map(([ms, price, seen]) => { const x = trade(ms, price, seen); return d.push(x.t, x.seen); });

// --- the 250 ms boundary: exactly 250 ms old stays, 251 ms old is gone ---
{
  let d = new LeadSignalDetector(PARAMS);
  const [, s] = feed(d, [[0, 100000], [250, 100030]]);
  assert.equal(s?.direction, "UP", "a trade exactly 250 ms old is still in the window");
  assert.equal(s.refPrice, 100000);
  d = new LeadSignalDetector(PARAMS);
  assert.deepEqual(feed(d, [[0, 100000], [251, 100030]]), [undefined, undefined], "251 ms old has left the window");
}
// --- 2 bp: the threshold itself signals (>=), just under does not ---
{
  // BTC prices: ln(100020.00/100000) = 1.9998 bp < 2, ln(100020.01/100000) = 2.0008 bp.
  assert.equal(feed(new LeadSignalDetector(PARAMS), [[0, 100000], [10, 100020]])[1], undefined);
  const up = feed(new LeadSignalDetector(PARAMS), [[0, 100000], [10, 100020.01]])[1];
  assert.equal(up?.direction, "UP");
  assert.ok(Math.abs(up.moveBp - Math.log(100020.01 / 100000) * 1e4) < 1e-9 && up.moveBp > 0);
  // Exact equality: pick a pair whose ln is exactly representable as bp / 1e4.
  let low = 100000, price, bp;
  for (let p = 100020.0; p < 100021; p += 0.01) {
    const v = Math.log(p / low);
    if ((v * 1e4) / 1e4 === v) { price = p; bp = v * 1e4; break; }
  }
  assert.ok(price, "found an exactly representable threshold");
  const exact = feed(new LeadSignalDetector({ ...PARAMS, thresholdBp: bp }), [[0, low], [10, price]])[1];
  assert.equal(exact?.direction, "UP", "ln(p/low) == threshold signals");
  const above = feed(new LeadSignalDetector({ ...PARAMS, thresholdBp: bp * (1 + 1e-12) }), [[0, low], [10, price]])[1];
  assert.equal(above, undefined, "a threshold just above the move does not signal");
}
// --- DOWN against the window high ---
{
  const [, , s] = feed(new LeadSignalDetector(PARAMS), [[0, 100010], [50, 100000], [100, 99989]]);
  assert.equal(s?.direction, "DOWN");
  assert.equal(s.refPrice, 100010, "measured from the window high");
  assert.ok(s.moveBp <= -2 && Math.abs(s.moveBp - Math.log(99989 / 100010) * 1e4) < 1e-9);
  assert.equal(s.price, 99989);
  assert.equal(s.tradeId, id);
}
// --- out of the valid period: no output and the window is NOT cleared ---
{
  const d = new LeadSignalDetector(PARAMS);
  // seen at R+14.8 and R+14.9: before fromSec; then R+15.0 exactly is valid.
  const out = feed(d, [[0, 100000, R + 14.8], [100, 100030, R + 14.9], [200, 100030, R + 15]]);
  assert.equal(out[1], undefined, "a move seen before R+15 is not a signal");
  assert.equal(out[2]?.refPrice, 100000, "the earlier low was kept: the invalid move did not clear the window");
  // toSec: R+265 is out, R+264.999 in.
  const e = new LeadSignalDetector(PARAMS);
  assert.deepEqual(feed(e, [[0, 100000, R + 264.9], [10, 100030, R + 265]]), [undefined, undefined]);
  assert.equal(feed(e, [[20, 100060, R + 264.999]])[0]?.refPrice, 100000, "R+264.999 is valid, window still holds the low");
  // The period is per round: R+300+15 is valid in the next round.
  assert.equal(feed(new LeadSignalDetector(PARAMS), [[0, 100000, R + 315], [10, 100030, R + 315.01]])[1]?.direction, "UP");
}
// --- a valid signal leaves only itself in the window ---
{
  const d = new LeadSignalDetector(PARAMS);
  const out = feed(d, [[0, 100000], [50, 100030], [100, 100031], [150, 100009]]);
  assert.equal(out[1]?.direction, "UP");
  assert.equal(out[2], undefined, "100031 vs the cleared window (100030) is no move; without the clear it was 3.1 bp");
  assert.equal(out[3]?.direction, "DOWN", "the high after the clear is 100031");
  assert.equal(out[3].refPrice, 100031);
}
// --- update(): takes effect from the next trade ---
{
  const d = new LeadSignalDetector(PARAMS);
  d.update({ ...PARAMS, thresholdBp: 3 });
  assert.equal(feed(d, [[0, 100000], [10, 100025]])[1], undefined, "2.5 bp is under the new 3 bp");
  assert.equal(feed(d, [[20, 100031]])[0]?.direction, "UP", "3.1 bp signals");
  const w = new LeadSignalDetector(PARAMS);
  feed(w, [[0, 100000]]);
  w.update({ ...PARAMS, windowMs: 100 });
  assert.equal(feed(w, [[150, 100030]])[0], undefined, "the 150 ms old low has left a 100 ms window");
  assert.throws(() => w.update({ ...PARAMS, fromSec: 265, toSec: 15 }));
  assert.throws(() => new LeadSignalDetector({ ...PARAMS, windowMs: 0 }));
}
// --- the monotonic queues equal the plain Python-style deque on random tape ---
{
  const naive = (params) => {
    let win = [];
    return (t, seen) => {
      while (win.length && win[0].tradeTimeMs < t.tradeTimeMs - params.windowMs) win.shift();
      win.push(t);
      const open = Math.floor(seen / 300) * 300;
      if (!(seen >= open + params.fromSec && seen < open + params.toSec)) return undefined;
      const lo = Math.min(...win.map(x => x.price)), hi = Math.max(...win.map(x => x.price));
      const thr = params.thresholdBp / 1e4;
      let out;
      if (Math.log(t.price / lo) >= thr) out = ["UP", lo];
      else if (Math.log(t.price / hi) <= -thr) out = ["DOWN", hi];
      else return undefined;
      win = [t];
      return out;
    };
  };
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const d = new LeadSignalDetector(PARAMS), n = naive(PARAMS);
  let ms = (R + 10) * 1000, price = 100000, signals = 0;
  for (let i = 0; i < 200_000; i++) {
    ms += Math.floor(rand() * 40);                           // bursts of equal times included
    price = Math.round((price + (rand() - 0.5) * 12) * 100) / 100;
    const t = { id: i + 1, price, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.125, receivedAtMonoMs: 0 };
    const a = d.push(t, t.receivedAtUnix), b = n(t, t.receivedAtUnix);
    assert.deepEqual(a ? [a.direction, a.refPrice] : undefined, b, `trade ${i}`);
    if (a) signals += 1;
  }
  assert.ok(signals > 100, `random tape produced signals (${signals})`);
}
console.log("binance-lead-signal OK");
