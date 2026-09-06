#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { analyze, monitor } from "../live/analysis.js";
import { findMarket } from "../live/discovery.js";
import { runBtcFeed } from "../live/feeds/btc.js";
import { FeedQueue, nowUnix } from "../live/feeds/index.js";
import { runPolymarketFeed } from "../live/feeds/polymarket.js";
import { approve, preflight, settle, wrap } from "../live/onchain.js";
import { run, type RunConfig } from "../live/orchestrator.js";

const program = new Command();
program
  .name("btc-5m-live")
  .description("Pure TypeScript Polymarket BTC 5m maker")
  .version("0.3.0");

program
  .command("run")
  .description("Run the live/paper maker")
  .option("--live", "Place REAL orders (default: paper)", process.env.LIVE === "true")
  .option("--paper", "Paper mode (default; explicit alias for run without --live)")
  .option(
    "--order-usd <n>",
    "Max USD per order",
    process.env.MAX_ORDER_USD ?? "2",
  )
  .option(
    "--pair-cost-max <n>",
    "最高双边配对成本（0.90-1.00）",
    process.env.PAIR_COST_MAX ?? "0.99",
  )
  .option(
    "--max-orders <n>",
    "Kill-switch order count",
    process.env.MAX_ORDERS ?? "200",
  )
  .option("--max-total-usd <n>", "Max cumulative notional", process.env.MAX_TOTAL_USD)
  .option("--skip-preflight", "Skip wallet preflight on --live")
  .option(
    "--heartbeat-ms <n>",
    "Liveness heartbeat ms",
    process.env.HEARTBEAT_MS ?? "50",
  )
  .option(
    "--btc-move-bps <n>",
    "BTC-lead refeed throttle (0 = every tick)",
    process.env.BTC_MOVE_BPS ?? "0",
  )
  .option(
    "--book-poll-hz <n>",
    "REST /prices backstop Hz (0 = off)",
    process.env.BOOK_POLL_HZ ?? "0",
  )
  .option("--no-oracle", "Disable RTDS Chainlink oracle")
  .option("--passive-budget", "Use passive-budget preset")
  .option(
    "--defensive-cancel-bps <n>",
    "Adverse-move cancel threshold",
    process.env.DEFENSIVE_CANCEL_BPS ?? "0",
  )
  .option("--maker-life-sec <n>", "Resting bid lifetime", "15")
  .option("--decision-interval-ms <n>", "Min ms between decisions", "0")
  .option("--log-file <path>", "JSONL log", "paper_log.jsonl")
  .option(
    "--traded-file <path>",
    "Traded conditionIds log",
    "traded_conditions.jsonl",
  )
  .option("--duration-min <n>", "Stop after N minutes (0 = forever)", "0")
  .action(async (opts) => {
    const live = !!opts.live && !opts.paper;
    const maxTotalUsd = opts.maxTotalUsd
      ? parseFloat(opts.maxTotalUsd)
      : undefined;
    if (live && maxTotalUsd == null) {
      console.warn(
        "live: no MAX_TOTAL_USD — defaulting session cap to $10 (override with --max-total-usd or env)",
      );
    }
    const durationMin = parseFloat(opts.durationMin);
    if (!Number.isFinite(durationMin) || durationMin < 0 || (durationMin !== 0 && durationMin < 0.1)) {
      throw new Error("--duration-min must be 0 (forever) or at least 0.1 minutes");
    }
    const cfg: RunConfig = {
      live,
      engine: {
        passiveBudget: !!opts.passiveBudget,
        pairCostMax: parseFloat(opts.pairCostMax),
        makerLifeSec: parseFloat(opts.makerLifeSec),
        decisionIntervalMs: parseFloat(opts.decisionIntervalMs),
        defensiveCancelBps: parseFloat(opts.defensiveCancelBps),
      },
      orderUsd: parseFloat(opts.orderUsd),
      maxOrders: parseInt(opts.maxOrders, 10),
      maxTotalUsd: maxTotalUsd ?? (live ? 10 : undefined),
      heartbeatMs: parseInt(opts.heartbeatMs, 10),
      btcMoveBps: parseFloat(opts.btcMoveBps),
      bookPollHz: parseFloat(opts.bookPollHz),
      oracle: !opts.noOracle,
      logPath: opts.logFile,
      tradedPath: opts.tradedFile,
      durationMin,
      preflight: !opts.skipPreflight,
    };
    await run(cfg);
    // Feed clients use network handles that may take a while to close after
    // the orchestrator reaches its duration limit. This CLI invocation is a
    // single run, so exit only after the orchestrator has cancelled orders and
    // flushed its synchronous journal. Without this, the dashboard sees a
    // finished run as still running and blocks the next start.
    if (durationMin > 0) process.exit(0);
  });

program
  .command("preflight")
  .description("Read-only wallet pre-flight")
  .option("--address <addr>", "Wallet address override")
  .action(async (opts) => {
    await preflight(opts.address);
  });

program
  .command("approve")
  .description("pUSD → CTF Exchange V2 approval (EOA wallets)")
  .option("--broadcast", "Send transaction")
  .action(async (opts) => {
    await approve(!!opts.broadcast);
  });

program
  .command("wrap")
  .description("Wrap USDC.e → pUSD via CollateralOnramp (API-only path)")
  .option("--amount-usd <n>", "USDC.e amount to wrap", "10")
  .option("--broadcast", "Send transaction")
  .action(async (opts) => {
    await wrap(parseFloat(opts.amountUsd), !!opts.broadcast);
  });

program
  .command("settle")
  .description("Redeem resolved positions")
  .option("--condition-id <id>", "conditionId (repeatable)", collect, [])
  .option("--from-log <path>", "JSONL of traded conditionIds")
  .option("--broadcast", "Send transaction")
  .action(async (opts) => {
    await settle(
      opts.conditionId as string[],
      opts.fromLog,
      !!opts.broadcast,
    );
  });

program
  .command("analyze [log]")
  .description("Analyze a JSONL log")
  .action((log = "paper_log.jsonl") => {
    analyze(log);
  });

program
  .command("monitor [log]")
  .description("Live monitor + alerts")
  .option("--interval <n>", "Poll interval sec", "10")
  .option("--once", "Single pass")
  .option("--loss-floor <n>", "Alert PnL floor", "-25")
  .option("--stale-sec <n>", "Stale alert threshold", "120")
  .action(async (log = "paper_log.jsonl", opts) => {
    await monitor(
      log,
      parseFloat(opts.interval),
      !!opts.once,
      parseFloat(opts.lossFloor),
      parseFloat(opts.staleSec),
    );
  });

program
  .command("feeds-dump")
  .description("Print live feed data (read-only)")
  .option("--seconds <n>", "Duration", "20")
  .action(async (opts) => {
    const queue = new FeedQueue();
    const btc = runBtcFeed((ev) => queue.push(ev));
    const mkt = await findMarket(nowUnix());
    let pm: { stop: () => void } | undefined;
    if (mkt) {
      pm = runPolymarketFeed(
        (ev) => queue.push(ev),
        mkt.upToken,
        mkt.downToken,
        nowUnix() + parseInt(opts.seconds, 10),
      );
      console.log("market:", mkt.slug);
    }
    const end = Date.now() + parseInt(opts.seconds, 10) * 1000;
    while (Date.now() < end) {
      const ev = await queue.pop(50);
      if (ev) console.log(JSON.stringify(ev));
    }
    btc.stop();
    pm?.stop();
  });

program
  .command("maker-hedge")
  .description(
    "Maker-confirm-hedge loop (delegates to `run` — full hedge port pending)",
  )
  .option("--paper", "Paper mode")
  .option("--continuous", "Continuous inventory mode")
  .option("--fair-value", "Fair-value mode")
  .allowUnknownOption()
  .action(async (opts) => {
    const paper = opts.paper !== false && process.env.LIVE !== "true";
    if (!paper) {
      console.warn(
        "maker-hedge full loop not ported — falling back to `run` orchestrator.",
      );
    } else {
      console.warn(
        "maker-hedge: using `run` orchestrator (target_clone). Full hedge loop not yet ported.",
      );
    }
    const cfg: RunConfig = {
      live: !paper,
      engine: {
        passiveBudget: false,
        makerLifeSec: 15,
        decisionIntervalMs: 0,
        defensiveCancelBps: 0,
      },
      orderUsd: 2,
      maxOrders: 200,
      heartbeatMs: 50,
      btcMoveBps: 0,
      bookPollHz: 0,
      oracle: true,
      logPath: "paper_log.jsonl",
      tradedPath: "traded_conditions.jsonl",
      durationMin: 0,
    };
    await run(cfg);
  });

function collect(val: string, memo: string[]): string[] {
  memo.push(val);
  return memo;
}

program.parse();
