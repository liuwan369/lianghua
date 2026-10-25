// P0-3, state half: every round, market, order and fill stayed in the
// state file forever (28 rounds / 100 KB after one day), and the settlement
// file kept every confirmed record. Old rounds were re-validated on every
// start, and one legacy round stopped a live start at state_open.
//
// Fix: pruneSettledHistory() deletes a round an hour after it is fully done,
// and its confirmed settlement record with it (never one without the other).
//
// Fixtures are the real live files from 2026-09-30 (wallet replaced). They hold
// the retired btc-reversal strategy's key, as the server's state file still
// does: that key is never read, and the binance-lead state is built here from
// the same real rounds, one filled attempt per traded round.
// Run after `npm run build`:  node scripts/regress/P0-3-prune.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pruneSettledHistory, settlementRecoveryCandidates } from "../../dist/cli/platform.js";
import { createStrategy, normalizeBinanceLeadConfig } from "../../dist/strategies/binance-lead.js";
import { TradingCore } from "../../dist/platform/core.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const legacy = fixture("live-state-20260930.json");
const settlements = fixture("live-settlements-20260930.json");
const lastEnd = Math.max(...legacy.markets.map((m) => m.endsAt));
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
// What cli/platform.ts does with a restored state: read only binance-lead's key.
const restores = (state) => { createStrategy({}, state.strategyStates?.["binance-lead"]); return true; };

// The binance-lead state for the same real rounds.
const config = normalizeBinanceLeadConfig({});
const leadRound = (old) => {
  const order = legacy.orders.find((o) => o.roundId === old.roundId && o.status === "FILLED");
  const direction = order?.tokenId === old.upTokenId ? "UP" : "DOWN";
  const S = old.startsAt + 30;
  return { assetId: "btc", marketId: old.marketId, roundId: old.roundId, name: old.name, startsAt: old.startsAt, endsAt: old.endsAt,
    upTokenId: old.upTokenId, downTokenId: old.downTokenId, config, status: "ended", reason: "本场已结束，处理余单与结算",
    stages: order ? [{ stage: 1, direction, tokenId: order.tokenId, clientOrderId: `binance-lead:${old.marketId}:1`, price: 0.7,
      shares: 5, createdAt: S, status: "FILLED", filledShares: 5, orderId: order.orderId, askAtSignal: 0.67,
      signal: { direction, price: 100030, refPrice: 100000, moveBp: direction === "UP" ? 3 : -3, tradeId: S, tradeTimeMs: S * 1000,
        receivedAtUnix: S, receivedAtMonoMs: 1 } }] : [] };
};
const lead = { ...legacy, strategyStates: { ...legacy.strategyStates, "binance-lead": { schemaVersion: 1, strategyId: "binance-lead",
  instanceId: "binance-lead", config, paused: false, rounds: legacy.strategyStates["btc-reversal"].rounds.map(leadRound) } } };
const leadRounds = (state) => state.strategyStates["binance-lead"].rounds;
assert.equal(leadRounds(lead).length, 28, "a day of rounds");
assert.equal(leadRounds(lead).filter((r) => r.stages.length).length, 10, "10 of them traded");
assert.ok(restores(lead) && coreAccepts(lead), "the unpruned state loads");

// --- fix: an hour after the last round, everything is done and gets deleted ---
const later = prune(lead, settlements.records, lastEnd + 3_601);
assert.equal(leadRounds(later).length, 0, "all finished rounds are deleted");
assert.equal(later.markets.length, 0, "their markets are deleted");
assert.equal(later.orders.length, 0, "their terminal orders are deleted");
assert.equal(later.fills.length, 0, "their settled fills are deleted");
assert.equal(later.cashUsd, lead.cashUsd, "cash is untouched");
assert.deepEqual(later.risk, lead.risk, "risk and daily-loss baseline are untouched");
assert.ok(restores(later), "the pruned state restores");
assert.ok(coreAccepts(later), "the real core accepts the fully pruned state");

// --- control: right after the run, the last hour of rounds is kept ---
const soon = prune(lead, settlements.records, lastEnd + 60);
const kept = leadRounds(soon).map((r) => r.roundId);
assert.ok(kept.includes("1790788500") && kept.includes("1790789100"), "the last hour is kept");
assert.ok(!kept.includes("1790687700"), "a round from a day ago is deleted");
assert.deepEqual(soon.markets.map((m) => m.roundId).sort(), [...kept].sort(), "markets go with their rounds");
assert.ok(restores(soon), "the partly pruned state restores");
assert.ok(coreAccepts(soon), "the real core accepts the partly pruned state");

// --- edge: nothing that can still matter is ever deleted ---
{
  const traded = lead.markets.find((m) => m.roundId === "1790788500");
  const noRecords = Object.fromEntries(Object.entries(settlements.records)
    .filter(([, r]) => r.roundId !== "1790788500"));
  const unsettled = prune(lead, noRecords, lastEnd + 3_601);
  assert.ok(unsettled.markets.some((m) => m.id === traded.id), "a traded round without a confirmed settlement is kept");
  assert.ok(unsettled.fills.some((f) => f.roundId === "1790788500"), "and so are its fills");
  assert.ok(leadRounds(unsettled).some((r) => r.roundId === "1790788500"), "and its strategy round");

  const token = lead.orders.find((o) => o.roundId === "1790788500").tokenId;
  const held = prune({ ...lead, positions: [{ tokenId: token, shares: 5, costUsd: 3.5, realizedPnlUsd: 0 }] },
    settlements.records, lastEnd + 3_601);
  assert.ok(held.markets.some((m) => m.id === traded.id), "a round with a position still held is kept");

  const open = prune({ ...lead, orders: lead.orders.map((o) => o.tokenId === token
    ? { ...o, status: "OPEN" } : o) }, settlements.records, lastEnd + 3_601);
  assert.ok(open.markets.some((m) => m.id === traded.id), "a round with a live order is kept");

  const pending = prune({ ...lead, orders: lead.orders.map((o) => o.tokenId === token
    ? { ...o, reconciliationPending: true } : o) }, settlements.records, lastEnd + 3_601);
  assert.ok(pending.markets.some((m) => m.id === traded.id), "a round with an unreconciled order is kept");

  // A stage still on its way to the venue keeps the round, even with no order record yet.
  const quiet = lead.markets.find((m) => m.roundId === "1790788800");
  const inFlight = structuredClone(lead);
  const round = leadRounds(inFlight).find((r) => r.roundId === "1790788800");
  round.stages = [{ ...leadRounds(lead).find((r) => r.stages.length).stages[0], tokenId: round.upTokenId, direction: "UP",
    clientOrderId: `binance-lead:${round.marketId}:1`, status: "SUBMITTING", filledShares: 0, orderId: undefined }];
  round.stages[0].signal = { ...round.stages[0].signal, direction: "UP", moveBp: 3 };
  assert.ok(prune(inFlight, settlements.records, lastEnd + 3_601).markets.some((m) => m.id === quiet.id),
    "a round whose attempt is still SUBMITTING is kept");
}

// --- settlement file: a record goes only with its pruned round; failed ones stay ---
{
  const { settlementRecords: left } = pruneSettledHistory(lead, settlements.records, lastEnd + 60);
  const keptRounds = new Set(soon.markets.map((m) => m.roundId));
  for (const r of Object.values(left)) {
    if (r.status === "confirmed" && lead.markets.some((m) => m.roundId === r.roundId)) {
      assert.ok(keptRounds.has(r.roundId), `confirmed record ${r.roundId} survives only with its round`);
    }
  }
  assert.ok(!Object.values(left).some((r) => r.roundId === "1790687700"), "the pruned round's record is gone");
  assert.ok(!Object.values(left).some((r) => r.roundId === "1790323200"),
    "a confirmed record whose round is no longer in the state (09-26) is gone");
  assert.ok(Object.values(left).every((r) => r.status !== "confirmed" || keptRounds.has(r.roundId)),
    "every confirmed record left belongs to a kept round");
  assert.ok(Object.values(left).some((r) => r.roundId === "1790788500"), "a kept round keeps its record");
  assert.equal(Object.values(left).filter((r) => r.status === "failed").length, 3, "failed records stay");
}

// --- settlement recovery reads the binance-lead rounds ---
{
  const leadState = lead.strategyStates["binance-lead"];
  const unconfirmed = { records: Object.fromEntries(Object.entries(settlements.records)
    .filter(([, r]) => r.roundId !== "1790788500")) };
  const candidates = settlementRecoveryCandidates(leadState, unconfirmed, lastEnd + 60);
  assert.deepEqual(candidates.map((c) => c.roundId), ["1790788500"], "the traded round without a confirmed record");
  assert.deepEqual(settlementRecoveryCandidates(leadState, settlements, lastEnd + 60), [], "every traded round confirmed");
}

// --- the server's old file: only the retired btc-reversal key ---
{
  assert.deepEqual(Object.keys(legacy.strategyStates), ["btc-reversal"]);
  assert.ok(restores(legacy), "binance-lead starts fresh: the old key is not read");
  const pruned = prune(legacy, settlements.records, lastEnd + 3_601);
  assert.equal(pruned.markets.length, 0, "its markets are judged by the account's own orders, fills and records");
  assert.equal(pruned.orders.length, 0);
  assert.equal(pruned.fills.length, 0);
  assert.deepEqual(pruned.strategyStates, legacy.strategyStates, "the old key is left exactly as it was");
  assert.ok(coreAccepts(pruned), "the real core accepts it");
  const partly = prune(legacy, settlements.records, lastEnd + 60);
  assert.deepEqual(partly.markets.map((m) => m.roundId).sort(), [...kept].sort(), "the same rounds are kept as with lead state");
  assert.ok(restores(partly) && coreAccepts(partly));
  assert.deepEqual(settlementRecoveryCandidates(undefined, settlements, lastEnd + 60), [], "no strategy state, no candidates");
}
console.log("P0-3-prune OK");
