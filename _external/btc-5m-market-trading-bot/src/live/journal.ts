import { appendFileSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { MakerEvent } from "../live-maker.js";
import { Side } from "../models.js";
import type { Market } from "./discovery.js";
import { nowUnix } from "./feeds/index.js";

export function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function r4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function ensureLogFile(path: string): void {
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
}

/** Append-only JSONL journal of engine events. */
export class Journal {
  private fd: number;
  private sessionId: string;

  constructor(path: string, sessionId: string) {
    ensureLogFile(path);
    this.fd = openSync(path, "a");
    this.sessionId = sessionId;
  }

  static open(path: string, sessionId: string): Journal {
    return new Journal(path, sessionId);
  }

  log(
    event: string,
    mkt: Market | undefined,
    engineTs: number | undefined,
    fields: Record<string, unknown> = {},
  ): void {
    const secInto =
      engineTs != null && mkt != null ? engineTs - mkt.start : undefined;
    const rec: Record<string, unknown> = {
      event,
      session_id: this.sessionId,
      recv_ts: nowUnix(),
      engine_ts: engineTs ?? null,
      sec_into_market: secInto ?? null,
      market_slug: mkt?.slug ?? null,
      market_start: mkt?.start ?? null,
      market_end: mkt?.end ?? null,
      conditionId: mkt?.conditionId ?? null,
      ...fields,
    };
    writeSync(this.fd, `${JSON.stringify(rec)}\n`);
  }

  logEvent(ev: MakerEvent, mkt: Market | undefined, ts: number): void {
    switch (ev.kind) {
      case "quote":
        this.log("quote", mkt, ts, {
          side: Side.asStr(ev.side),
          price: r4(ev.price),
          shares: r2(ev.shares),
        });
        break;
      case "taker":
        this.log("taker", mkt, ts, {
          side: Side.asStr(ev.side),
          price: r4(ev.price),
          shares: r2(ev.shares),
        });
        break;
      case "fill":
        this.log("fill", mkt, ts, {
          side: Side.asStr(ev.side),
          price: r4(ev.price),
          shares: r2(ev.shares),
          is_maker: ev.isMaker,
          fee: r4(ev.fee),
        });
        break;
      case "cancel":
        this.log("cancel", mkt, ts, {
          side: Side.asStr(ev.side),
          price: r4(ev.price),
        });
        break;
    }
  }
}

export function recordTraded(path: string, conditionId: string): void {
  if (!conditionId) return;
  ensureLogFile(path);
  appendFileSync(path, `${JSON.stringify({ conditionId })}\n`);
}
