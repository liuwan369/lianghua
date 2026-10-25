// P2-12, P3-6 and U2, all in a round's first seconds.
//
// P2-12: a round must keep the config it had 10 s before its open; a config
// published inside that window changed this round's order. A config published
// earlier (the next round exists for minutes) must still apply to it.
//
// P3-6 / U2: account_recovery_started names the markets whose orders it blocks.
// It must reset only those rounds' book in force. A settlement-time recovery
// blocks no market, and resetting every round then cost the live round its next
// trade.
//
// Drives the real compiled binance-lead strategy. Run after `npm run build`:
//   node scripts/regress/P2-12.mjs
import assert from "node:assert/strict";
import { createStrategy } from "../../dist/strategies/binance-lead.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const ctx = (now) => ({ mode: "live", now, markets: [market], books: [],
  account: { cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } },
  estimateFee: () => 0 });
const book = (t) => ({ kind: "book", marketId: "0xm", roundId: ROUND, snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND,
  sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
  YES: { assetId: UP, bid: 0.56, ask: 0.57, sourceAt: t, expiresAt: t + 2 },
  NO: { assetId: DOWN, bid: 0.44, ask: 0.45, sourceAt: t, expiresAt: t + 2 } } });
const lead = (S) => ({ kind: "lead", assetId: "btc", direction: "UP", price: 100030, refPrice: 100000, moveBp: 3,
  tradeId: Math.round(S * 1000), tradeTimeMs: S * 1000 - 100, receivedAtUnix: S, receivedAtMonoMs: 1 });
const order = (s, S) => s.onEvent(lead(S), ctx(S + 0.002)).find((a) => a.kind === "submit")?.order;
const at = (s, t) => s.onEvent({ kind: "timer", ts: t }, ctx(t));
const recovery = (s, t, marketIds) => s.onEvent({ kind: "error", strategyId: "binance-lead", code: "account_recovery_started",
  message: "account_recovery_started", ...(marketIds ? { marketIds } : {}) }, ctx(t));

// --- P2-12 bug: a config published 8 s before the open does not change this round ---
{
  const s = createStrategy({ shares: 5 });
  at(s, START - 8);                                       // round created inside the warm window
  s.updateConfig({ shares: 9 });
  s.onEvent(book(START + 20), ctx(START + 20));
  assert.equal(order(s, START + 21)?.shares, 5, "a pre-warmed round keeps the config it had");
}
// --- P2-12 review: created minutes early, a config published a minute before the open applies ---
{
  const s = createStrategy({ shares: 5 });
  at(s, START - 240); at(s, START - 60);
  s.updateConfig({ shares: 9 });
  s.onEvent(book(START + 20), ctx(START + 20));
  assert.equal(order(s, START + 21)?.shares, 9, "outside the warm window the round follows the published config");
}
// --- P2-12 control: a config published before the round exists applies to it ---
{
  const s = createStrategy({ shares: 5 });
  s.updateConfig({ shares: 9 });
  at(s, START - 8);
  s.onEvent(book(START + 20), ctx(START + 20));
  assert.equal(order(s, START + 21)?.shares, 9);
}
// --- P3-6: a recovery before the round's first book does not block its first signal ---
{
  const s = createStrategy();
  at(s, START - 8); at(s, START + 0.2);
  recovery(s, START + 0.2);
  s.onEvent(book(START + 20), ctx(START + 20));
  assert.ok(order(s, START + 21), "the first book after the recovery is the book in force");
}
// --- P3-6 control: a recovery that blocks this market drops its book in force ---
{
  const s = createStrategy();
  at(s, START - 8);
  s.onEvent(book(START + 20), ctx(START + 20));
  recovery(s, START + 20.5, ["0xm"]);
  assert.equal(order(s, START + 21), undefined, "no trade on a book seen before the recovery");
}
// --- U2: a recovery that blocks no market keeps the live round's book ---
{
  const s = createStrategy();
  at(s, START - 8);
  s.onEvent(book(START + 20), ctx(START + 20));
  recovery(s, START + 20.5, []);
  assert.ok(order(s, START + 21), "the signal right after a settlement-time recovery is traded");
}
// --- U2 edge: a recovery blocking another market leaves this one alone ---
{
  const s = createStrategy();
  at(s, START - 8);
  s.onEvent(book(START + 20), ctx(START + 20));
  recovery(s, START + 20.5, ["0xother"]);
  assert.ok(order(s, START + 21), "another market's recovery does not reset this round");
}
console.log("P2-12 OK");
