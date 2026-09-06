import { Side } from "../models.js";

/** Shared HTTP settings (Gamma discovery + CLOB REST). */
export function httpClient(): RequestInit {
  return {
    headers: { "User-Agent": "Mozilla/5.0 (btc-5m-live)" },
    signal: AbortSignal.timeout(10_000),
  };
}

export {
  findMarket,
  parseMarket,
  isWindowLive,
  select,
  marketToken,
  type Candidate,
  type Market,
} from "./discovery.js";

import type { Market } from "./discovery.js";

/** CLOB token id for a given outcome side. */
export function token(mkt: Market, side: Side): string {
  return side === Side.Up ? mkt.upToken : mkt.downToken;
}

export { OrderBook } from "./orderbook.js";
export { Journal, r2, r4, recordTraded } from "./journal.js";
export { Engine, type EngineConfig, type ResolveResult, bookOk } from "./engine.js";
export { Executor, type SubmitResult } from "./executor.js";
export { run, type RunConfig } from "./orchestrator.js";
export { analyze, monitor } from "./analysis.js";
export * from "./feeds/index.js";
