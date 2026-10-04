#!/usr/bin/env node
// Backfill the paper simulator from recorded market history.
//
// Reads data/market-history/<asset>/<date>.jsonl.gz (multi-member gzip; the
// recordedBook format in market-recorder.ts: t,a,m,r,q,ue,de,ub,ua,db,da,ual,dal,
// plus trade rows k:"t",tok,p,s,side), rebuilds a SimBook for each frame (and
// feeds each trade print) and drives the same ReversalSim the live
// collector uses, writing the same data/sim/<asset>.jsonl lines. The simulator
// dedupes by roundId, so replaying days the live sim already wrote is a no-op,
// and a round is only written once a later record shows it ended (the round
// still in progress at the end of the data is left for a later run).
//
// Recordings do not carry CLOB token ids, so synthetic consistent ids per market
// `${m}:up` / `${m}:down` are used (the simulator only needs the pair to be
// stable and distinct). sourceAt = ue/de; expiresAt = min(roundEnd, min(ue,de)+2);
// marketAgeMs = (t - min(ue,de)) * 1000; the replay clock is each frame's t.
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { ReversalSim, simLevels, type SimBook, type SimTrade } from "../sim/reversal-sim.js";

const WINDOW_SEC = 300;

export interface SimReplayOptions {
  historyDir: string;
  simDir: string;
  assets?: string[];
  dates?: string[];
  retentionDays: number;
}

export function parseSimReplayOptions(argv: string[]): SimReplayOptions | undefined {
  const options: SimReplayOptions = { historyDir: "data/market-history", simDir: "data/sim", retentionDays: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: sim-replay [--history-dir path] [--sim-dir path] [--assets btc,eth] [--dates 2026-10-01,2026-10-02] [--retention-days 10]");
      return undefined;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--history-dir") options.historyDir = value;
    else if (arg === "--sim-dir") options.simDir = value;
    else if (arg === "--assets") options.assets = value.split(",").map(a => a.trim().toLowerCase()).filter(Boolean);
    else if (arg === "--dates") options.dates = value.split(",").map(d => d.trim()).filter(Boolean);
    else if (arg === "--retention-days") options.retentionDays = Number(value);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) throw new Error("--retention-days must be positive");
  return options;
}

/** Rebuild a SimBook from one recorded line. Best prices are always usable. */
export function simBookFromRecord(record: Record<string, unknown>): SimBook | undefined {
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const marketId = typeof record.m === "string" ? record.m : undefined;
  const roundId = typeof record.r === "string" ? record.r : undefined;
  if (!marketId || !roundId || !/^\d+$/.test(roundId)) return undefined;
  const startsAt = Number(roundId);
  if (!Number.isSafeInteger(startsAt) || startsAt % WINDOW_SEC !== 0) return undefined;
  const ue = num(record.ue), de = num(record.de);
  const youngest = Math.min(ue ?? Infinity, de ?? Infinity);
  const expiresAt = Number.isFinite(youngest)
    ? Math.min(startsAt + WINDOW_SEC, youngest + 2) : startsAt + WINDOW_SEC;
  return { marketId, roundId, upTokenId: `${marketId}:up`, downTokenId: `${marketId}:down`,
    upAsk: num(record.ua), upBid: num(record.ub), downAsk: num(record.da), downBid: num(record.db),
    upAskLevels: simLevels(record.ual), downAskLevels: simLevels(record.dal),
    upSourceAt: ue, downSourceAt: de, expiresAt, sequence: num(record.q) };
}

/** A recorded trade row (k "t": tok u|d, p, s, side) as a SimTrade. */
export function simTradeFromRecord(record: Record<string, unknown>): SimTrade | undefined {
  const { m, r, tok, p, s, side } = record;
  if (typeof m !== "string" || typeof r !== "string" || (tok !== "u" && tok !== "d")
    || typeof p !== "number" || typeof s !== "number" || !(s > 0) || typeof side !== "string") return undefined;
  return { marketId: m, roundId: r, dir: tok === "u" ? "UP" : "DOWN", price: p, shares: s, side };
}

async function replayFile(sim: ReversalSim, asset: string, path: string): Promise<void> {
  // The current day's file is still being appended, so its last gzip member is
  // usually incomplete. Treat that as end-of-data for this file (Z_SYNC_FLUSH
  // between members lets zlib read every finished one), and never let one bad
  // file stop the other coins.
  const gunzip = createGunzip();
  gunzip.on("error", () => { /* truncated trailing member: stop this file */ });
  const source = createReadStream(path);
  source.on("error", () => { /* unreadable file: skip it */ });
  const lines = createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line); } catch { continue; }
      const t = typeof record.t === "number" ? record.t : undefined;
      if (record.k === "t") {
        const trade = simTradeFromRecord(record);
        if (trade && t !== undefined) try { sim.observeTrade(asset, trade, t); } catch { sim.dropped += 1; }
        continue;
      }
      const book = simBookFromRecord(record);
      if (!book || t === undefined) continue;
      try { sim.observe(asset, book, t); } catch { sim.dropped += 1; }
    }
  } catch { /* a truncated final member surfaces here: the finished rounds are kept */ }
}

export async function runSimReplay(options: SimReplayOptions): Promise<{ files: number; rounds: number }> {
  const sim = new ReversalSim(options.simDir, { retentionDays: options.retentionDays });
  let files = 0;
  let assets: string[];
  try { assets = options.assets ?? readdirSync(options.historyDir); } catch { assets = []; }
  for (const asset of assets) {
    const dir = join(options.historyDir, asset);
    if (!existsSync(dir)) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const days = names.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(name)
      && (!options.dates || options.dates.includes(name.slice(0, 10)))).sort();
    for (const name of days) {
      await replayFile(sim, asset, join(dir, name));
      files += 1;
    }
  }
  sim.flush();
  return { files, rounds: sim.wroteRounds };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseSimReplayOptions(process.argv.slice(2));
    if (options) {
      const result = await runSimReplay(options);
      console.log(JSON.stringify({ kind: "sim_replay_done", ...result }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "sim replay failed"); process.exitCode = 1;
  }
}
