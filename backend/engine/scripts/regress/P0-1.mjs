// P0-1: the strategy wrote stage shapes its own restore() then refused
// ("invalid persisted ... stage"), so the engine could not start again until
// the state file was hand-edited. Whatever a round goes through, the state the
// strategy itself persists must restore; corrupt state must still be refused.
//
// Drives the real compiled binance-lead strategy through every way its one
// stage can end. Run after `npm run build`:  node scripts/regress/P0-1.mjs
import assert from "node:assert/strict";
import { createStrategy } from "../../dist/strategies/binance-lead.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const ctx = (now) => ({ mode: "live", now, markets: [market], books: [],
  account: { cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } },
  estimateFee: () => 0.02 });
const book = (t, up, down) => ({ kind: "book", marketId: "0xm", roundId: ROUND, snapshot: { assetId: "btc", marketId: "0xm",
  roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
  YES: { assetId: UP, bid: up - 0.01, ask: up, sourceAt: t, expiresAt: t + 2 },
  NO: { assetId: DOWN, bid: down - 0.01, ask: down, sourceAt: t, expiresAt: t + 2 } } });
const lead = (S, direction) => ({ kind: "lead", assetId: "btc", direction, price: 100030, refPrice: 100000,
  moveBp: direction === "UP" ? 3 : -3, tradeId: 7, tradeTimeMs: S * 1000 - 100, receivedAtUnix: S, receivedAtMonoMs: 1 });
const restores = (st) => { try { createStrategy(st.config, JSON.parse(JSON.stringify(st))); return true; } catch { return false; } };

// One placed round, then `finish` drives it to an outcome; returns the persisted state.
const drive = (finish, direction = "UP") => {
  let saved;
  const s = createStrategy({}, undefined, { persist: (st) => { saved = st; } });
  s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
  s.onEvent(book(START + 20, 0.57, 0.45), ctx(START + 20));
  const order = s.onEvent(lead(START + 21, direction), ctx(START + 21.002)).find((a) => a.kind === "submit")?.order;
  assert.ok(order, "the signal places");
  const record = (status, filledShares) => ({ ...order, strategyId: "binance-lead", orderId: "0xorder", status, filledShares,
    reservedUsd: 0, reservedShares: 0, createdAt: START + 21.1, updatedAt: START + 21.3 });
  finish(s, record);
  return saved;
};
const outcomes = {
  created: () => {},
  rejected: (s) => s.onEvent({ kind: "error", strategyId: "binance-lead", clientOrderId: "binance-lead:0xm:1",
    code: "order_not_submitted", message: "rejected" }, ctx(START + 21.1)),
  cancelledUnfilled: (s, record) => s.onEvent({ kind: "order", order: record("CANCELLED", 0) }, ctx(START + 21.3)),
  partial: (s, record) => s.onEvent({ kind: "order", order: record("CANCELLED", 2) }, ctx(START + 21.3)),
  filled: (s, record) => s.onEvent({ kind: "order", order: record("FILLED", 5) }, ctx(START + 21.3)),
  unknown: (s, record) => s.onEvent({ kind: "order", order: record("UNKNOWN", 0) }, ctx(START + 21.3)),
  abandoned: (s, record) => {
    s.onEvent({ kind: "order", order: record("UNKNOWN", 0) }, ctx(START + 21.3));
    s.onEvent({ kind: "error", strategyId: "binance-lead", clientOrderId: "binance-lead:0xm:1", code: "order_abandoned",
      message: "no venue order" }, ctx(START + 400));
  },
  endedAfterFill: (s, record) => {
    s.onEvent({ kind: "order", order: record("FILLED", 5) }, ctx(START + 21.3));
    s.onEvent({ kind: "timer", ts: START + 301 }, ctx(START + 301));
  },
};
for (const [name, finish] of Object.entries(outcomes)) {
  for (const direction of ["UP", "DOWN"]) {
    const saved = drive(finish, direction);
    assert.equal(saved.rounds[0].stages.length, 1, `${name}: one stage`);
    assert.ok(restores(saved), `${name} ${direction}: the strategy's own persisted state restores`);
  }
}
// A restored CREATED intent is ABANDONED, and that state restores again.
{
  const first = drive(outcomes.created);
  let again;
  createStrategy({}, JSON.parse(JSON.stringify(first)), { persist: (st) => { again = st; } })
    .onEvent({ kind: "timer", ts: START + 22 }, ctx(START + 22));
  assert.equal(again.rounds[0].stages[0].status, "ABANDONED");
  assert.ok(restores(again), "the restart's own state restores on the next restart");
}
// --- control: corrupt state is still refused ---
{
  const good = drive(outcomes.filled);
  const corrupt = (edit) => { const st = JSON.parse(JSON.stringify(good)); edit(st); return st; };
  assert.ok(!restores(corrupt((st) => { st.rounds[0].stages[0].tokenId = DOWN; })), "UP stage on the DOWN token");
  assert.ok(!restores(corrupt((st) => { st.rounds[0].stages[0].shares = 6; })), "size other than the round's config");
  assert.ok(!restores(corrupt((st) => { st.rounds[0].stages[0].price = 0.61; })), "limit above ask + premium");
  // More than placed is a BUY below its limit (2026-10-26: 5.25 of 5); the core bounds it by the budget.
  assert.ok(restores(corrupt((st) => { st.rounds[0].stages[0].filledShares = 5.25; })), "a better price bought more shares");
  assert.ok(!restores(corrupt((st) => { st.rounds[0].stages[0].filledShares = -1; })), "negative fill");
  assert.ok(!restores(corrupt((st) => { st.rounds[0].stages[0].clientOrderId = "binance-lead:0xother:1"; })), "foreign client id");
  assert.ok(!restores(corrupt((st) => { st.rounds[0].stages.push({ ...st.rounds[0].stages[0] }); })), "two attempts in a round");
  assert.ok(!restores(corrupt((st) => { delete st.rounds[0].stages[0].signal; })), "stage without its signal");
}
console.log("P0-1 OK");
