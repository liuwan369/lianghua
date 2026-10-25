// cli/platform.ts runs binance-lead, the only built-in strategy:
// - --strategy accepts only binance-lead and needs --strategy-config;
// - the config file must say strategyId binance-lead; the control plane's run
//   settings (durationMinutes/maxRounds/mode) are stripped, everything else is
//   checked by normalizeBinanceLeadConfig;
// - the old --reference-feed flag is gone;
// - every lead signal journals one line with the round and what the strategy did.
//
// Run after `npm run build`:  node scripts/regress/cli-binance-lead.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leadJournalFields, parsePlatformOptions, readStrategyConfig, resolveStrategyLimits, STRATEGY_ID }
  from "../../dist/cli/platform.js";
import { createStrategy } from "../../dist/strategies/binance-lead.js";

const dir = mkdtempSync(join(tmpdir(), "cli-lead-"));
const file = (name, value) => { const path = join(dir, name); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); return path; };
const saved = (config, extra = {}) => ({ schemaVersion: 1, strategyId: "binance-lead", savedRevision: 4, savedAt: null, config, ...extra });
try {
  assert.equal(STRATEGY_ID, "binance-lead");

  // --- options ---
  const base = ["--live", "--state-file", join(dir, "state.json")];
  const options = parsePlatformOptions([...base, "--strategy", "binance-lead", "--strategy-config", join(dir, "c.json")]);
  assert.equal(options.strategy, "binance-lead");
  assert.equal("referenceFeed" in options, false, "no reference feed option");
  assert.throws(() => parsePlatformOptions([...base, "--strategy", "btc-reversal", "--strategy-config", join(dir, "c.json")]),
    /unknown built-in strategy; the only one is binance-lead/);
  assert.throws(() => parsePlatformOptions([...base, "--strategy", "binance-lead"]), /--strategy requires --strategy-config/);
  assert.throws(() => parsePlatformOptions([...base, "--strategy-config", join(dir, "c.json")]), /--strategy requires --strategy-config/);
  assert.throws(() => parsePlatformOptions([...base, "--reference-feed"]), /unknown option '--reference-feed'/);

  // --- config file ---
  const read = readStrategyConfig(file("ok.json", saved({ assetId: "btc", shares: 7, thresholdBp: 2.5,
    durationMinutes: 30, maxRounds: 3, mode: "live", roundBudgetUsd: null, totalBudgetUsd: 50, dailyLossUsd: 10 })));
  assert.equal(read.config.shares, 7);
  assert.equal(read.config.thresholdBp, 2.5);
  assert.equal(read.config.windowMs, 250, "defaults fill what the file leaves out");
  assert.equal(read.config.revision, "4", "the saved revision is the config revision");
  assert.equal(read.savedRevision, "4");
  assert.equal(read.dailyLossUsd, 10);
  for (const key of ["durationMinutes", "maxRounds", "mode", "roundBudgetUsd"]) assert.equal(key in read.config, false, `${key} stripped`);
  assert.deepEqual(resolveStrategyLimits({ capitalUsd: 100, dailyLossUsd: 20, maxOrderUsd: 100, maxOpenOrders: 5 }, read.config),
    { capitalUsd: 50, dailyLossUsd: 10, maxOrderUsd: 50, maxOpenOrders: 5 }, "a config can only tighten the run's ceilings");
  assert.throws(() => readStrategyConfig(file("old.json", saved({ assetId: "btc" }, { strategyId: "btc-reversal" }))),
    /strategy configuration needs strategyId binance-lead and config/);
  assert.throws(() => readStrategyConfig(file("noconfig.json", { strategyId: "binance-lead" })), /needs strategyId binance-lead and config/);
  assert.throws(() => readStrategyConfig(file("bad.json", "{")), /--strategy-config must refer to a readable JSON file/);
  assert.throws(() => readStrategyConfig(join(dir, "missing.json")), /--strategy-config must refer to a readable JSON file/);
  assert.throws(() => readStrategyConfig(file("range.json", saved({ fromSec: 270, toSec: 265 }))),
    /invalid strategy configuration: fromSec\/toSec/);
  // A reversal config saved under the new id: its fields are not this strategy's, and its defaults apply.
  const stray = readStrategyConfig(file("stray.json", saved({ triggerPrice: 0.67, stageShares: [5, 13, 60] })));
  assert.equal(stray.config.shares, 5);

  // --- journal line per lead signal, from the real strategy's round ---
  const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
  const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
    instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                  { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
  const ctx = (now) => ({ mode: "live", now, markets: [market], books: [], estimateFee: () => 0,
    account: { cashUsd: 100, positions: [], orders: [], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 100, occupiedUsd: 0 } } });
  const book = (t, downAsk) => ({ kind: "book", marketId: "0xm", roundId: ROUND, snapshot: { assetId: "btc", marketId: "0xm",
    roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: 0.56, ask: 0.57, sourceAt: t, expiresAt: t + 2 },
    NO: { assetId: DOWN, bid: 0.44, ask: downAsk, sourceAt: t, expiresAt: t + 2 } } });
  const lead = (S, tradeId) => ({ kind: "lead", assetId: "btc", direction: "UP", price: 100030, refPrice: 100000, moveBp: 2.9996,
    tradeId, tradeTimeMs: S * 1000 - 100, receivedAtUnix: S, receivedAtMonoMs: 5 });
  const s = createStrategy();
  s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
  s.onEvent(book(START + 20, undefined), ctx(START + 20));               // one-sided: the first signal is skipped
  const first = lead(START + 21, 41);
  s.onEvent(first, ctx(START + 21));
  const skipped = leadJournalFields(first, s.roundAt(first.receivedAtUnix), false);
  assert.equal(skipped.outcome, "skipped");
  assert.equal(skipped.reason, "当前盘口一边没有卖价，等下一个信号");
  assert.equal(skipped.attempted, false);
  assert.equal(skipped.client_order_id, null);
  s.onEvent(book(START + 22, 0.45), ctx(START + 22));
  const second = lead(START + 23, 42);
  s.onEvent(second, ctx(START + 23));
  assert.deepEqual(leadJournalFields(second, s.roundAt(second.receivedAtUnix), false), { asset_id: "btc", direction: "UP",
    price: 100030, ref_price: 100000, move_bp: 2.9996, trade_id: 42, trade_time_ms: (START + 23) * 1000 - 100,
    received_at: START + 23, received_at_mono_ms: 5, market_id: "0xm", round_id: ROUND, round_status: "running",
    outcome: "order_submitted", reason: "已下单（FAK），等待成交回报", attempted: true, client_order_id: "binance-lead:0xm:1",
    token_id: UP, limit_price: 0.6, ask_at_signal: 0.57, shares: 5 });
  const third = lead(START + 24, 43);
  s.onEvent(third, ctx(START + 24));
  const after = leadJournalFields(third, s.roundAt(third.receivedAtUnix), false);
  assert.equal(after.outcome, "skipped", "a later signal in an attempted round placed nothing");
  assert.equal(after.attempted, true);
  assert.equal(after.client_order_id, null, "the round's order belongs to the signal that placed it");
  const stopping = leadJournalFields(third, s.roundAt(third.receivedAtUnix), true);
  assert.equal(stopping.outcome, "stopping");
  const between = lead(START + 400, 44);
  assert.equal(leadJournalFields(between, s.roundAt(between.receivedAtUnix), false).outcome, "no_round");
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("cli-binance-lead OK");
