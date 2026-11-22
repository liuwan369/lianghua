// 2026-11-22: account 1 holds 680 settled losers (worth 0, the venue lists them
// for good) and 1075 closed positions, +100 a day. Every account read pulled
// them all: the engine's realtime read 72 ms CPU (pm-b 18 ms) and capped at
// 2 x 500 rows, past which recovery throws "account sections incomplete"; the
// console's reader re-read the whole history every minute.
// - heldPositions: the engine reads only rows worth something plus rows with a
//   recent event, never the whole held list;
// - PositionHistory: the console's reader reads everything once an hour and,
//   in between, only rows whose last event is recent, merged into the last full read.
// Run after `npm run build`:  node scripts/regress/position-history.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { heldPositions, PositionHistory } from "../../dist/live/account-data.js";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/data-api-v2.json", import.meta.url), "utf8"));
const W = FIX.wallet;
const held = (token, extra = {}) => ({ ...FIX.positions.data[0], token_id: token, condition_id: "c" + token, ...extra });
const closed = (token, extra = {}) => ({ ...FIX.closed.data[0], token_id: token, condition_id: "c" + token, ...extra });
const page = (data) => ({ data, pagination: { has_more: false, next_cursor: null } });

// --- the engine's realtime read ---
{
  const calls = [];
  const get = async (path, params) => {
    calls.push(params);
    if (params.filter_type === "CASH") return page([held("win", { current_value: 4.9, redeemable: true }), held("live", { current_value: 1.9 })]);
    if (params.start) return page([held("live", { current_value: 1.9 }), held("justlost", { current_value: 0, redeemable: true })]);
    return page(Array.from({ length: 1500 }, (_, i) => held("old" + i)));
  };
  const now = 1_795_360_000_000;
  const s = await heldPositions(get, W, now);
  assert.equal(s.complete, true, s.error_code);
  assert.deepEqual(s.items.map(p => p.asset).sort(), ["justlost", "live", "win"], "valued and recent rows, each once");
  assert.equal(calls.length, 2, "never the whole held list");
  assert.equal(calls.find(c => c.start).start, String(now / 1000 - 7200), "recent = the last 2 hours");
  for (const c of calls) assert.equal(c.user, W);
}
{
  // Either half failing leaves the section incomplete, never a short list.
  for (const failing of ["CASH", "start"]) {
    const get = async (path, params) => {
      if ((failing === "CASH" && params.filter_type) || (failing === "start" && params.start)) throw new Error("http_500");
      return page([held("live", { current_value: 1.9 })]);
    };
    const s = await heldPositions(get, W, 1_795_360_000_000);
    assert.equal(s.complete, false, failing);
  }
}

// --- the console's reader: full once an hour, recent rows in between ---
{
  const HOUR = 3_600_000, T0 = 1_795_360_000_000;
  let answer;
  const calls = [];
  const get = async (path, params) => { calls.push(params); return answer(params); };
  const history = new PositionHistory(W);

  answer = (p) => p.status === "CLOSED" ? page([closed("k1"), closed("k2")]) : page([held("lost1", { current_value: 0, redeemable: true }), held("win", { current_value: 5, redeemable: true })]);
  let out = await history.read(get, T0);
  assert.ok(calls.every(c => !c.start), "the first read is full");
  assert.equal(out.positions.complete, true); assert.equal(out.closed_positions.complete, true);
  assert.equal(out.positions.items.length, 2); assert.equal(out.closed_positions.items.length, 2);

  // 10 minutes later: the winner was redeemed (now closed), a new round lost, one closed.
  calls.length = 0;
  answer = (p) => p.status === "CLOSED" ? page([closed("win"), closed("k3")]) : page([held("lost2", { current_value: 0, redeemable: true })]);
  out = await history.read(get, T0 + 10 * 60_000);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.start, String((T0 + 10 * 60_000 - 3 * HOUR) / 1000), "only the last 3 hours");
  assert.deepEqual(out.positions.items.map(p => p.asset).sort(), ["lost1", "lost2"], "the redeemed winner left the held list");
  assert.deepEqual(out.closed_positions.items.map(p => p.asset).sort(), ["k1", "k2", "k3", "win"]);
  assert.equal(out.positions.complete, true); assert.equal(out.closed_positions.complete, true);

  // A failed recent read: incomplete this time, the merged history unchanged for the next.
  answer = () => { throw new Error("http_500"); };
  out = await history.read(get, T0 + 11 * 60_000);
  assert.equal(out.positions.complete, false); assert.equal(out.closed_positions.complete, false);
  answer = (p) => page([]);
  out = await history.read(get, T0 + 12 * 60_000);
  assert.equal(out.positions.items.length, 2); assert.equal(out.closed_positions.items.length, 4);

  // An hour after the last full read: full again, replacing what was merged.
  calls.length = 0;
  answer = (p) => p.status === "CLOSED" ? page([closed("k1")]) : page([]);
  out = await history.read(get, T0 + HOUR);
  assert.ok(calls.every(c => !c.start), "hourly full read");
  assert.equal(out.positions.items.length, 0); assert.equal(out.closed_positions.items.length, 1);
}
{
  // A failed full read is retried in full next time, not windowed on top of nothing.
  const calls = [];
  let fail = true;
  const get = async (path, params) => { calls.push(params); if (fail) throw new Error("http_500"); return page([]); };
  const history = new PositionHistory(W);
  const first = await history.read(get, 1_795_360_000_000);
  assert.equal(first.positions.complete, false);
  fail = false; calls.length = 0;
  await history.read(get, 1_795_360_060_000);
  assert.ok(calls.every(c => !c.start));
}
console.log("position-history OK");
