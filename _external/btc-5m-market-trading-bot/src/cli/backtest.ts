#!/usr/bin/env node
/**
 * Historical maker backtest CLI — simplified TypeScript port.
 * Full 30GB snapshot backtest requires external data in ../data/.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
  type StrategyConfig,
  LOCKED_CONFIG_ID,
  isLockedProduction,
  stableLive,
  targetClone,
} from "../config.js";
import { Inventory } from "../inventory.js";
import {
  decisionBucketTs,
  polymarketFillFee,
  Side,
  type Fill,
  type MarketBooks,
  type MarketResult,
} from "../models.js";
import { PairCostMarketMaker } from "../strategy.js";
import { snapshotsToTimeline, type SnapshotRow } from "./backtest-snapshots.js";

const program = new Command();
program
  .name("btc-5m-backtest")
  .description("MAKER pair-cost historical backtest")
  .version("0.3.0");

program
  .option(
    "--mode <mode>",
    "trader | full | realistic",
    "trader",
  )
  .option("--target-clone", "Use target_clone preset")
  .option("--stable-live", "Use locked stable_live preset")
  .option("--data-dir <path>", "Snapshot data dir", "../data")
  .option("--dates <csv>", "Comma-separated UTC dates YYYY-MM-DD")
  .option("--maker-life-sec <n>", "Maker order life (realistic mode)", "15")
  .action((opts) => {
    let cfg: StrategyConfig;
    if (opts.stableLive) cfg = stableLive();
    else if (opts.targetClone || opts.mode === "trader") cfg = targetClone();
    else cfg = stableLive();

    const presetName = opts.stableLive
      ? "stable_live"
      : opts.targetClone || opts.mode === "trader"
        ? "target_clone"
        : LOCKED_CONFIG_ID;
    console.log("preset:", presetName);
    console.log("locked:", isLockedProduction(cfg));

    const dataDir = opts.dataDir as string;
    if (!existsSync(dataDir)) {
      console.error(
        `No data at ${dataDir} — backtest needs external snapshot JSON (~30GB).`,
      );
      console.error("Live/paper trading needs NO backtest data.");
      process.exit(1);
    }

    const dates = opts.dates
      ? (opts.dates as string).split(",").map((d) => d.trim())
      : listDailyFiles(dataDir);

    if (dates.length === 0) {
      console.error("No daily snapshot files found.");
      process.exit(1);
    }

    const realistic = opts.mode === "realistic";
    const makerLife = parseFloat(opts.makerLifeSec);

    let totalPnl = 0;
    let totalFees = 0;
    let totalMarkets = 0;
    let totalFills = 0;
    let wins = 0;

    for (const date of dates.slice(0, 31)) {
      const path = join(dataDir, `${date}.json`);
      if (!existsSync(path)) continue;
      const day = runDailyFile(path, cfg, realistic, makerLife);
      totalPnl += day.pnl;
      totalFees += day.fees;
      totalMarkets += day.markets;
      totalFills += day.fills;
      wins += day.wins;
      console.log(
        `${date}: mkts=${day.markets} fills=${day.fills} pnl=$${day.pnl.toFixed(2)} fees=$${day.fees.toFixed(2)}`,
      );
    }

    console.log("\n=== SUMMARY ===");
    console.log(`markets: ${totalMarkets}`);
    console.log(`fills: ${totalFills}`);
    console.log(
      `net pnl: $${totalPnl.toFixed(2)} | fees: $${totalFees.toFixed(2)} | gross: $${(totalPnl + totalFees).toFixed(2)}`,
    );
    console.log(
      `win rate: ${totalMarkets ? ((100 * wins) / totalMarkets).toFixed(1) : 0}%`,
    );
    console.log(
      `avg pnl/mkt: $${totalMarkets ? (totalPnl / totalMarkets).toFixed(2) : 0}`,
    );
  });

function listDailyFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(".json", ""))
      .sort();
  } catch {
    return [];
  }
}

interface DayResult {
  markets: number;
  fills: number;
  pnl: number;
  fees: number;
  wins: number;
}

function parseDailyFile(raw: string): MarketDataEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) return parsed as MarketDataEntry[];
  if (
    parsed &&
    typeof parsed === "object" &&
    "markets" in parsed &&
    Array.isArray((parsed as { markets: unknown }).markets)
  ) {
    return (parsed as { markets: MarketDataEntry[] }).markets;
  }
  return [];
}

function runDailyFile(
  path: string,
  cfg: StrategyConfig,
  realistic: boolean,
  makerLifeSec: number,
): DayResult {
  const raw = readFileSync(path, "utf8");
  const entries = parseDailyFile(raw);
  let markets = 0;
  let fills = 0;
  let pnl = 0;
  let fees = 0;
  let wins = 0;

  for (const entry of entries) {
    const timeline = snapshotsToTimeline(entry.snapshots);
    if (timeline.length === 0) continue;
    const start = entry.window.start_unix;
    const end = entry.window.end_unix;
    const strat = new PairCostMarketMaker({ ...cfg });
    const result = realistic
      ? runMarketRealistic(
          entry.market.slug,
          start,
          end,
          timeline,
          strat,
          makerLifeSec,
        )
      : runMarketOptimistic(
          entry.market.slug,
          start,
          end,
          timeline,
          strat,
        );
    markets += 1;
    fills += result.fills.length;
    pnl += result.pnl;
    fees += result.fees;
    if (result.pnl > 0) wins += 1;
  }

  return { markets, fills, pnl, fees, wins };
}

interface MarketDataEntry {
  market: { slug: string };
  window: { start_unix: number; end_unix: number };
  snapshots: SnapshotRow[];
}

function inferWinner(timeline: MarketBooks[], endUnix: number): Side {
  const last = timeline.filter((b) => b.tsUnix >= endUnix - 15);
  const slice = last.length ? last : timeline.slice(-5);
  if (!slice.length) return Side.Up;
  const b = slice[slice.length - 1]!;
  if ((b.up.ask ?? 0) >= 0.85) return Side.Up;
  if ((b.down.ask ?? 0) >= 0.85) return Side.Down;
  const um = (b.up.bid != null && b.up.ask != null
    ? (b.up.bid + b.up.ask) / 2
    : 0.5)!;
  return um >= 0.5 ? Side.Up : Side.Down;
}

function emptyMarketResult(
  slug: string,
  startUnix: number,
  endUnix: number,
): MarketResult {
  return {
    slug,
    startUnix,
    endUnix,
    fills: [],
    totalCost: 0,
    payout: 0,
    pnl: 0,
    fees: 0,
    pairCost: 0,
    rewardsScore: 0,
  };
}

function runMarketOptimistic(
  slug: string,
  startUnix: number,
  endUnix: number,
  timeline: MarketBooks[],
  strat: PairCostMarketMaker,
): MarketResult {
  strat.onMarketStart(startUnix);
  if (!strat.risk.canTrade(strat.config)) {
    return emptyMarketResult(slug, startUnix, endUnix);
  }
  const inv = new Inventory();
  const interval = strat.config.fillIntervalSec;
  const seen = new Set<number>();

  for (const books of timeline) {
    if (books.tsUnix < startUnix + strat.config.startDelaySec) continue;
    if (books.tsUnix > endUnix - strat.config.stopBeforeEndSec) continue;
    const bucket = decisionBucketTs(books.tsUnix, interval);
    if (seen.has(bucket)) continue;
    seen.add(bucket);

    const side = strat.chooseSide(
      inv,
      books,
      books.tsUnix,
      startUnix,
      endUnix,
      undefined,
    );
    if (!side) continue;
    const fill = strat.buildFill(side, inv, books, books.tsUnix, endUnix);
    if (!fill) continue;
    inv.execute(fill);
    strat.recordFill(inv);
  }

  return settleResult(slug, startUnix, endUnix, inv, strat, timeline);
}

function runMarketRealistic(
  slug: string,
  startUnix: number,
  endUnix: number,
  timeline: MarketBooks[],
  strat: PairCostMarketMaker,
  makerLifeSec: number,
): MarketResult {
  strat.onMarketStart(startUnix);
  if (!strat.risk.canTrade(strat.config)) {
    return emptyMarketResult(slug, startUnix, endUnix);
  }
  const inv = new Inventory();
  const interval = strat.config.fillIntervalSec;
  const seen = new Set<number>();
  type Pending = { side: Side; price: number; shares: number; lifeEnd: number };
  let pending: Pending[] = [];

  for (const books of timeline) {
    // Realize resting maker fills: ask trades down to our bid (matches live-maker).
    const still: Pending[] = [];
    for (const q of pending) {
      const ask = q.side === Side.Up ? books.up.ask : books.down.ask;
      const hit = ask != null && ask > 0 && ask < 1 && ask <= q.price;
      if (hit) {
        const f: Fill = {
          side: q.side,
          shares: q.shares,
          price: q.price,
          tsUnix: books.tsUnix,
          isMaker: true,
        };
        inv.execute(f);
        strat.recordFill(inv);
      } else if (books.tsUnix <= q.lifeEnd) {
        still.push(q);
      }
    }
    pending = still;

    if (books.tsUnix < startUnix + strat.config.startDelaySec) continue;
    if (books.tsUnix > endUnix - strat.config.stopBeforeEndSec) continue;
    const bucket = decisionBucketTs(books.tsUnix, interval);
    if (seen.has(bucket)) continue;
    seen.add(bucket);

    const side = strat.chooseSide(
      inv,
      books,
      books.tsUnix,
      startUnix,
      endUnix,
      undefined,
    );
    if (!side) continue;
    const fill = strat.buildFill(side, inv, books, books.tsUnix, endUnix);
    if (!fill) continue;

    if (fill.isMaker) {
      pending.push({
        side: fill.side,
        price: fill.price,
        shares: fill.shares,
        lifeEnd: books.tsUnix + makerLifeSec,
      });
    } else {
      inv.execute(fill);
      strat.recordFill(inv);
    }
  }

  return settleResult(slug, startUnix, endUnix, inv, strat, timeline);
}

function settleResult(
  slug: string,
  startUnix: number,
  endUnix: number,
  inv: Inventory,
  strat: PairCostMarketMaker,
  timeline: MarketBooks[],
): MarketResult {
  const winner = inferWinner(timeline, endUnix);
  const payout = inv.payoutIfWinner(winner);
  const cost = inv.totalCost();
  let fees = 0;
  for (const f of inv.fills) {
    fees += polymarketFillFee(
      f.shares,
      f.price,
      f.isMaker,
      strat.config.takerFeeRate,
      strat.config.makerFeeRate,
      strat.config.feeExponent,
    );
  }
  const pnl = payout - cost - fees;
  strat.onMarketEnd(pnl, startUnix);
  return {
    slug,
    startUnix,
    endUnix,
    fills: inv.fills,
    winner,
    totalCost: cost,
    payout,
    pnl,
    fees,
    pairCost: inv.pairCost(),
    rewardsScore: 0,
  };
}

program.parse();
