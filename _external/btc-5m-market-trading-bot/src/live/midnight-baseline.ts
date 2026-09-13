import { riskDayKey } from '../risk.js';

export interface MidnightBaselineOptions {
  /** Allowed distance from Beijing 00:00 for the opening observation. */
  windowMs?: number;
  /** Delay between opening and the current confirmation read. */
  confirmationDelayMs?: number;
}

export interface MidnightBaselinePacket {
  opening: unknown;
  current: unknown;
  cashFlows: { fromMs: number; toMs: number; complete: boolean; items: unknown[] };
  positionReleases: unknown[];
  riskDay: string;
  openingAtMs: number;
  currentAtMs: number;
  source: 'provider-atomic-midnight-window';
}

type Reader = () => Promise<unknown>;
type Row = Record<string, unknown>;

function row(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function checkedAt(value: unknown): number {
  if (!row(value) || typeof value.checked_at !== 'string') throw new Error('baseline_checked_at_missing');
  const at = Date.parse(value.checked_at);
  if (!Number.isSafeInteger(at) || at < 0) throw new Error('baseline_checked_at_invalid');
  return at;
}

function dayStartMs(atMs: number): number {
  return Date.parse(`${riskDayKey(atMs / 1000)}T00:00:00Z`) - 28_800_000;
}

function completeAtomicCut(value: unknown): number {
  if (!row(value) || value.read_only !== true || value.pagination_atomic !== true
      || typeof value.atomic_snapshot_token !== 'string' || value.atomic_snapshot_token.length < 8) {
    throw new Error('baseline_requires_provider_atomic_cut');
  }
  const at = checkedAt(value);
  const sections = ['collateral', 'positions', 'open_orders', 'trades', 'closed_positions', 'activity'];
  for (const name of sections) {
    const section = value[name];
    if (section === undefined) continue;
    if (!row(section) || section.available !== true || section.complete !== true
        || section.snapshot_token !== value.atomic_snapshot_token) throw new Error(`baseline_${name}_incomplete`);
  }
  return at;
}

/** Return the exact Beijing midnight represented by a checked timestamp. */
export function beijingMidnightMs(atMs: number): number {
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error('baseline_time_invalid');
  return dayStartMs(atMs);
}

/** Capture an opening cut only in a bounded window around Beijing 00:00. */
export async function captureMidnightBaseline(
  reader: Reader,
  nowMs = Date.now(),
  options: MidnightBaselineOptions = {},
): Promise<MidnightBaselinePacket> {
  const windowMs = options.windowMs ?? 30_000;
  const delayMs = options.confirmationDelayMs ?? 250;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 300_000) throw new Error('baseline_window_invalid');
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000) throw new Error('baseline_delay_invalid');
  const opening = await reader();
  const openingAtMs = completeAtomicCut(opening);
  const target = dayStartMs(openingAtMs);
  if (Math.abs(openingAtMs - target) > windowMs) throw new Error('baseline_outside_beijing_midnight_window');
  if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
  const current = await reader();
  const currentAtMs = completeAtomicCut(current);
  if (currentAtMs <= openingAtMs) throw new Error('baseline_current_not_after_opening');
  if (currentAtMs > nowMs + windowMs + delayMs + 5_000) throw new Error('baseline_current_in_future');
  const riskDay = riskDayKey(openingAtMs / 1000);
  return {
    opening, current, riskDay, openingAtMs, currentAtMs,
    cashFlows: { fromMs: openingAtMs, toMs: currentAtMs, complete: true, items: [] },
    positionReleases: [], source: 'provider-atomic-midnight-window',
  };
}

/** Milliseconds until the next Beijing midnight, used by a service scheduler. */
export function msUntilNextBeijingMidnight(nowMs = Date.now()): number {
  const next = dayStartMs(nowMs) + 86_400_000;
  return Math.max(0, next - nowMs);
}
