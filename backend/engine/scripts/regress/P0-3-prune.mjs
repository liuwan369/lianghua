// P0-3, state half: every round, market, order and fill stayed in the
// state file forever (28 rounds / 100 KB after one day), and the settlement
// file kept every confirmed record. Old rounds were re-validated on every
// start: a legacy round (1790687700, sized by an older rule) stopped batch 2's
// first live start at state_open.
//
// Fix: pruneSettledHistory() deletes a round an hour after it is fully done,
// and its confirmed settlement record with it (never one without the other).
//
// Fixtures are the real live files from 2026-09-30 with the wallet replaced.
// Run after `npm run build`:  node scripts/regress/P0-3-prune.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pruneSettledHistory } from "../../dist/cli/platform.js";
import { createStrategy } from "../../dist/strategies/btc-reversal.js";
import { TradingCore } from "../../dist/platform/core.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const live = fixture("live-state-20260930.json");
const settlements = fixture("live-settlements-20260930.json");
const lastEnd = Math.max(...live.markets.map((m) => m.endsAt));
const restores = (state) => { const st = state.strategyStates["btc-reversal"];
  try { createStrategy(st.config, st); return true; } catch { return false; } };
const prune = (state, records, now) => pruneSettledHistory(state, records, now).state;
// The real core must accept the pruned state exactly as a restart would load it.
const coreAccepts = (state) => {
  const instruments = (state.markets ?? []).flatMap((m) => m.instruments);
  new TradingCore({ restored: state, instruments, adapters: { gateway: { mode: state.mode } },
    limits: { capitalUsd: 10, dailyLossUsd: 10, maxOrderUsd: 5, maxOpenOrders: 2 },
    account: { accountId: state.accountId, at: state.accountAt, cashAt: state.cashAt, cashUsd: state.cashUsd,
      positions: state.positions, openOrders: [], complete: true } });
  return true;
};

// --- bug: the real file still restores all of its history, legacy round included ---
assert.equal(live.strategyStates["btc-reversal"].rounds.length, 28, "fixture holds a day of rounds");
assert.ok(!restores(live), "the strict size rule rejects the unpruned legacy round 1790687700");

// --- fix: an hour after the last round, everything is done and gets deleted ---
const later = prune(live, settlements.records, lastEnd + 3_601);
assert.equal(later.strategyStates["btc-reversal"].rounds.length, 0, "all finished rounds are deleted");
assert.equal(later.markets.length, 0, "their markets are deleted");
assert.equal(later.orders.length, 0, "their terminal orders are deleted");
assert.equal(later.fills.length, 0, "their settled fills are deleted");
assert.equal(later.cashUsd, live.cashUsd, "cash is untouched");
assert.deepEqual(later.risk, live.risk, "risk and daily-loss baseline are untouched");
assert.ok(restores(later), "the pruned real file restores under the strict rule");
assert.ok(coreAccepts(later), "the real core accepts the fully pruned state");

// --- control: right after the run, the last hour of rounds is kept ---
const soon = prune(live, settlements.records, lastEnd + 60);
const kept = soon.strategyStates["btc-reversal"].rounds.map((r) => r.roundId);
assert.ok(kept.includes("1790788500") && kept.includes("1790789100"), "the last hour is kept");
assert.ok(!kept.includes("1790687700"), "the legacy round from a day ago is deleted");
assert.ok(restores(soon), "the partly pruned real file restores");
assert.ok(coreAccepts(soon), "the real core accepts the partly pruned state");

// --- edge: nothing that can still matter is ever deleted ---
{
  const traded = live.markets.find((m) => m.roundId === "1790788500");
  const noRecords = Object.fromEntries(Object.entries(settlements.records)
    .filter(([, r]) => r.roundId !== "1790788500"));
  const unsettled = prune(live, noRecords, lastEnd + 3_601);
  assert.ok(unsettled.markets.some((m) => m.id === traded.id), "a traded round without a confirmed settlement is kept");
  assert.ok(unsettled.fills.some((f) => f.roundId === "1790788500"), "and so are its fills");

  const token = live.orders.find((o) => o.roundId === "1790788500").tokenId;
  const held = prune({ ...live, positions: [{ tokenId: token, shares: 5, costUsd: 3.5, realizedPnlUsd: 0 }] },
    settlements.records, lastEnd + 3_601);
  assert.ok(held.markets.some((m) => m.id === traded.id), "a round with a position still held is kept");

  const open = prune({ ...live, orders: live.orders.map((o) => o.tokenId === token
    ? { ...o, status: "OPEN" } : o) }, settlements.records, lastEnd + 3_601);
  assert.ok(open.markets.some((m) => m.id === traded.id), "a round with a live order is kept");

  const pending = prune({ ...live, orders: live.orders.map((o) => o.tokenId === token
    ? { ...o, reconciliationPending: true } : o) }, settlements.records, lastEnd + 3_601);
  assert.ok(pending.markets.some((m) => m.id === traded.id), "a round with an unreconciled order is kept");
}

// --- settlement file: a record goes only with its pruned round; failed ones stay ---
{
  const { settlementRecords: left } = pruneSettledHistory(live, settlements.records, lastEnd + 60);
  const keptRounds = new Set(soon.markets.map((m) => m.roundId));
  for (const r of Object.values(left)) {
    if (r.status === "confirmed" && live.markets.some((m) => m.roundId === r.roundId)) {
      assert.ok(keptRounds.has(r.roundId), `confirmed record ${r.roundId} survives only with its round`);
    }
  }
  assert.ok(!Object.values(left).some((r) => r.roundId === "1790687700"), "the pruned legacy round's record is gone");
  assert.ok(!Object.values(left).some((r) => r.roundId === "1790323200"),
    "a confirmed record whose round is no longer in the state (09-26) is gone");
  assert.ok(Object.values(left).every((r) => r.status !== "confirmed" || keptRounds.has(r.roundId)),
    "every confirmed record left belongs to a kept round");
  assert.ok(Object.values(left).some((r) => r.roundId === "1790788500"), "a kept round keeps its record");
  assert.equal(Object.values(left).filter((r) => r.status === "failed").length, 3, "failed records stay");
}
console.log("P0-3-prune OK");
