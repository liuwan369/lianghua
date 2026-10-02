// P1-12: the CLOB heartbeat ran every 25 s, but once an account sends
// heartbeats the venue cancels ALL its open orders when 10 s pass without one.
// Live run 131143 lost two resting orders exactly 14.0 s after a heartbeat.
// A single failed heartbeat must also be retried at once, not left to the next
// period, or one network blip still crosses the 10 s line.
//
// Uses the real ClobWrapper.startHeartbeat on a stub SDK client and counts
// heartbeats over simulated time.
//
// Run after `npm run build`:  node scripts/regress/P1-12.mjs
import assert from "node:assert/strict";
import { ClobWrapper } from "../../dist/live/clob/client.js";

const VENUE_TIMEOUT_MS = 10_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run the real heartbeat for `runMs` of wall time scaled down by `scale`, and
// return the largest gap between successful heartbeats in venue milliseconds.
async function largestGap({ failAt = new Set(), errorAt = new Set(), hangAt = new Set(), scale = 20, runMs = 60_000 } = {}) {
  const sent = [];
  const ok = [];
  let calls = 0;
  const wrapper = Object.create(ClobWrapper.prototype);
  wrapper.client = {
    postHeartbeat: async (id) => {
      const n = calls++;
      sent.push(id);
      if (failAt.has(n)) throw new Error("network blip");
      // A half-open socket: the request never settles.
      if (hangAt.has(n)) return new Promise(() => {});
      // The SDK hands an HTTP failure back as { error } without throwing.
      if (errorAt.has(n)) return { error: "upstream 503", status: 503 };
      ok.push(Date.now());
      return { heartbeat_id: `hb${n}` };
    },
  };
  const warn = console.warn; console.warn = () => {};
  // Scale time: intervals in the real code are venue ms; run them 100x faster.
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (fn, ms, ...rest) => realSetInterval(fn, ms / scale, ...rest);
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, (ms ?? 0) / scale, ...rest);
  const started = Date.now();
  try {
    wrapper.startHeartbeat();
    await new Promise((resolve) => realSetTimeout(resolve, runMs / scale));
  } finally {
    wrapper.stopHeartbeat();
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    console.warn = warn;
  }
  const points = [started, ...ok];
  let gap = 0;
  for (let i = 1; i < points.length; i++) gap = Math.max(gap, (points[i] - points[i - 1]) * scale);
  return { gap, sent, calls };
}

// --- bug: steady state must keep every gap under the venue's 10 s timeout ---
const steady = await largestGap();
assert.ok(steady.gap < VENUE_TIMEOUT_MS * 0.8,
  `heartbeat gap must stay well under 10 s; got ${Math.round(steady.gap)} ms`);

// --- edge: one failed heartbeat is retried at once, so the gap still holds ---
const blip = await largestGap({ failAt: new Set([2]) });
assert.ok(blip.gap < VENUE_TIMEOUT_MS * 0.8,
  `one failed heartbeat must not open a 10 s gap; got ${Math.round(blip.gap)} ms`);

// --- edge: an HTTP error the SDK returns (not throws) is also retried at once ---
const httpError = await largestGap({ errorAt: new Set([2]) });
assert.ok(httpError.gap < VENUE_TIMEOUT_MS * 0.8,
  `a returned { error } must be retried; got ${Math.round(httpError.gap)} ms`);

// --- edge: a request that never returns times out; beats keep flowing ---
const hung = await largestGap({ hangAt: new Set([2]) });
assert.ok(hung.gap < VENUE_TIMEOUT_MS * 0.8,
  `a hung request must not stop later heartbeats; got ${Math.round(hung.gap)} ms`);
assert.ok(hung.calls > 8, `beats must continue after a hang; got ${hung.calls} calls in 60 s`);

// --- control: the id chain is kept (each heartbeat sends the last id it got) ---
assert.equal(steady.sent[0], undefined, "first heartbeat has no id");
assert.equal(steady.sent[1], "hb0", "second heartbeat sends the id from the first");
await sleep(0);
console.log(`P1-12: steady gap ${Math.round(steady.gap)} ms, failure ${Math.round(blip.gap)} ms, `
  + `hang ${Math.round(hung.gap)} ms`);
console.log("P1-12 OK");
