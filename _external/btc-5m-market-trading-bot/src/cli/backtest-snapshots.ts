import type { MarketBooks } from "../models.js";

export interface SnapshotRow {
  ts: string;
  slug: string;
  token_type: string;
  bid?: number;
  ask?: number;
  /** Recorded venue metadata for this token at this snapshot, never inferred. */
  tick_size?: number | string;
  tickSize?: number | string;
}

function historicalTick(row: SnapshotRow): number {
  const raw = row.tick_size ?? row.tickSize;
  const tick = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(tick) || tick <= 0 || tick >= 1 ||
    (row.tick_size != null && row.tickSize != null && Number(row.tick_size) !== Number(row.tickSize))) {
    throw new Error(`Historical maker snapshot lacks valid token tick metadata (${row.slug}, ${row.token_type}, ${row.ts}); provide recorded tick_size/tickSize. No tick default is permitted.`);
  }
  return tick;
}

function historicalTimestamp(value: string): number {
  if (typeof value !== "string") throw new Error("Invalid historical snapshot timestamp");
  const normalized = value.trim().replace(" ", "T");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(zoned);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid historical snapshot timestamp: ${value}`);
  return parsed / 1000;
}

/** Reject legacy snapshots before a missing-tick run can be reported as zero fills. */
export function snapshotsToTimeline(snapshots: SnapshotRow[]): MarketBooks[] {
  const byTs = new Map<number, Partial<Record<"up" | "down", { row: SnapshotRow; tick: number }>>>();
  for (const row of snapshots) {
    const side = row.token_type.toLowerCase();
    if (side !== "up" && side !== "down") continue;
    const tick = historicalTick(row);
    const ts = historicalTimestamp(row.ts);
    if (!byTs.has(ts)) byTs.set(ts, {});
    byTs.get(ts)![side] = { row, tick };
  }
  const out: MarketBooks[] = [];
  for (const [ts, sides] of [...byTs.entries()].sort((a, b) => a[0] - b[0])) {
    if (!sides.up || !sides.down) continue;
    const up = sides.up, down = sides.down;
    out.push({
      tsUnix: ts,
      up: { bid: up.row.bid, ask: up.row.ask, tickSize: up.tick, tsUnix: ts },
      down: { bid: down.row.bid, ask: down.row.ask, tickSize: down.tick, tsUnix: ts },
    });
  }
  return out;
}
