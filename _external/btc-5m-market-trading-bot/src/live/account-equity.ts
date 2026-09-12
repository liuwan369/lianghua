/** Offline equity accounting contract. It never authorizes an order. */
import { riskDayKey } from '../risk.js';

const SCALE = 1_000_000;
const CAPITAL_LIMIT = 50 * SCALE;
const DAILY_LOSS_LIMIT = 30 * SCALE;
type Mode = 'live' | 'paper';
type Row = Record<string, unknown>;

export interface EquityPosition {
  conditionId: string;
  assetId: string;
  quantityMicros: number | null;
  priceMicrousd: number | null;
  pricedAtMs: number;
  valuation: 'liquidation_bid' | 'confirmed_payout';
  complete: boolean;
}

/** The future adapter must reconcile cash and every position to this same cut. */
export interface EquitySnapshot {
  id: string;
  account: string;
  mode: Mode;
  sequence: number;
  atMs: number;
  complete: boolean;
  cashMicrousd: number | null;
  positions: EquityPosition[] | null;
}

export interface ExternalCashFlow {
  id: string;
  kind: 'deposit' | 'withdrawal';
  amountMicrousd: number;
  atMs: number;
  confirmed: boolean;
}

export interface PositionRelease {
  conditionId: string;
  assetId: string;
  fromQuantityMicros: number;
  toQuantityMicros: number;
  evidenceId: string;
}

export interface EquityReconciliation {
  snapshot: EquitySnapshot;
  previousSnapshotId: string;
  cashFlows: {
    fromMs: number;
    toMs: number;
    complete: boolean;
    items: ExternalCashFlow[];
  };
  positionReleases: PositionRelease[];
}

export type AccountEquityEvent =
  | { type: 'initialize'; opening: EquitySnapshot; current: EquityReconciliation }
  | { type: 'reconcile'; current: EquityReconciliation }
  | { type: 'rollover'; boundary: EquityReconciliation; current: EquityReconciliation };

interface EquityDay {
  riskDay: string;
  opening: EquitySnapshot;
  latest: EquitySnapshot;
  pnlMicrousd: number;
  lossLimitReached: boolean;
}

interface ClosedEquityDay extends EquityDay {
  externalNetFlowMicrousd: number;
}

export interface AccountEquityState {
  schemaVersion: 1;
  account: string;
  mode: Mode;
  riskTimezone: 'Asia/Shanghai';
  capitalLimitMicrousd: number;
  dailyLossLimitMicrousd: number;
  day: EquityDay | null;
  closedDays: ClosedEquityDay[];
  knownCashFlows: ExternalCashFlow[];
  seenSnapshotIds: string[];
  halted: boolean;
  reconciliationIssue: string | null;
}

export interface AccountEquityView {
  execution_ready: false;
  accounting_ready: boolean;
  paused: boolean;
  reason: string | null;
  risk_day: string | null;
  equity_microusd: number | null;
  daily_pnl_microusd: number | null;
  capital_limit_microusd: number;
  daily_loss_limit_microusd: number;
}

function fail(code: string): never { throw new Error(code); }
function record(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: unknown, keys: string[]): asserts value is Row {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) fail('invalid_shape');
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function unsigned(value: unknown): value is number { return integer(value) && value >= 0; }
function time(value: unknown): value is number { return unsigned(value) && value <= 8_639_999_971_200_000; }
function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) fail('amount_overflow');
  return Number(value);
}
function identity(account: string, mode: Mode): string {
  if (typeof account !== 'string' || !/^0x[0-9a-f]{40}$/i.test(account) || !['paper', 'live'].includes(mode)) fail('invalid_account');
  return account.toLowerCase();
}
function key(position: { conditionId: string; assetId: string }): string { return JSON.stringify([position.conditionId, position.assetId]); }
function dayStart(atMs: number): number { return Date.parse(`${riskDayKey(atMs / 1000)}T00:00:00Z`) - 28_800_000; }
function policy(nowMs: number, maxAgeMs: number): void {
  if (!time(nowMs) || !unsigned(maxAgeMs) || maxAgeMs === 0) fail('invalid_clock_or_freshness_policy');
}
function clone<T>(value: T): T { return structuredClone(value); }

function snapshot(value: unknown, account: string, mode: Mode, maxAgeMs = Number.MAX_SAFE_INTEGER): EquitySnapshot {
  exact(value, ['id', 'account', 'mode', 'sequence', 'atMs', 'complete', 'cashMicrousd', 'positions']);
  if (!text(value.id) || value.account !== account || value.mode !== mode || !unsigned(value.sequence)
      || !time(value.atMs) || value.complete !== true || !unsigned(value.cashMicrousd) || !Array.isArray(value.positions)) fail('incomplete_snapshot');
  const seen = new Set<string>();
  for (const position of value.positions) {
    exact(position, ['conditionId', 'assetId', 'quantityMicros', 'priceMicrousd', 'pricedAtMs', 'valuation', 'complete']);
    if (!text(position.conditionId) || !text(position.assetId) || !unsigned(position.quantityMicros)
        || position.complete !== true || !time(position.pricedAtMs) || position.pricedAtMs > value.atMs
        || position.quantityMicros > 0 && value.atMs - position.pricedAtMs > maxAgeMs
        || (typeof position.valuation !== 'string' || !['liquidation_bid', 'confirmed_payout'].includes(position.valuation))
        || !(position.quantityMicros === 0 && position.priceMicrousd === null || unsigned(position.priceMicrousd) && position.priceMicrousd <= SCALE)
        || position.valuation === 'confirmed_payout' && position.priceMicrousd !== null && ![0, SCALE].includes(position.priceMicrousd as number)) fail('invalid_or_stale_position_valuation');
    const positionKey = key(position as unknown as EquityPosition);
    if (seen.has(positionKey)) fail('duplicate_position');
    seen.add(positionKey);
  }
  const result = value as unknown as EquitySnapshot;
  equity(result);
  return result;
}

function equity(value: EquitySnapshot): number {
  let total = BigInt(value.cashMicrousd!);
  for (const position of value.positions!) {
    // Floor each liquidation value at one microdollar; never round equity up.
    if (position.quantityMicros! > 0) total += BigInt(position.quantityMicros!) * BigInt(position.priceMicrousd!) / BigInt(SCALE);
  }
  return safe(total);
}

function flow(value: unknown): ExternalCashFlow {
  exact(value, ['id', 'kind', 'amountMicrousd', 'atMs', 'confirmed']);
  if (!text(value.id) || (typeof value.kind !== 'string' || !['deposit', 'withdrawal'].includes(value.kind))
      || !unsigned(value.amountMicrousd) || value.amountMicrousd === 0 || !time(value.atMs) || value.confirmed !== true) fail('unconfirmed_or_invalid_external_flow');
  return value as unknown as ExternalCashFlow;
}
function sameFlow(a: ExternalCashFlow, b: ExternalCashFlow): boolean {
  return a.id === b.id && a.kind === b.kind && a.amountMicrousd === b.amountMicrousd && a.atMs === b.atMs && a.confirmed === b.confirmed;
}
function netFlows(flows: ExternalCashFlow[], fromMs: number, toMs: number): number {
  return safe(flows.filter(f => f.atMs > fromMs && f.atMs <= toMs).reduce((sum, f) =>
    sum + BigInt(f.amountMicrousd) * (f.kind === 'deposit' ? 1n : -1n), 0n));
}
function pnl(opening: EquitySnapshot, current: EquitySnapshot, flows: ExternalCashFlow[]): number {
  return safe(BigInt(equity(current)) - BigInt(equity(opening)) - BigInt(netFlows(flows, opening.atMs, current.atMs)));
}

function validateReleases(previous: EquitySnapshot, current: EquitySnapshot, releases: unknown): void {
  if (!Array.isArray(releases)) fail('missing_position_reconciliation');
  const next = new Map(current.positions!.map(p => [key(p), p.quantityMicros!]));
  const expected = new Map(previous.positions!.flatMap(p => p.quantityMicros! > (next.get(key(p)) ?? 0)
    ? [[key(p), { from: p.quantityMicros!, to: next.get(key(p)) ?? 0 }] as const] : []));
  const seen = new Set<string>();
  for (const release of releases) {
    exact(release, ['conditionId', 'assetId', 'fromQuantityMicros', 'toQuantityMicros', 'evidenceId']);
    if (!text(release.conditionId) || !text(release.assetId) || !text(release.evidenceId)) fail('invalid_position_release');
    const id = key(release as unknown as PositionRelease), match = expected.get(id);
    if (seen.has(id) || !match || release.fromQuantityMicros !== match.from || release.toQuantityMicros !== match.to) fail('invalid_position_release');
    seen.add(id);
  }
  if (seen.size !== expected.size) fail('unreconciled_position_reduction');
}

function applyReconciliation(state: AccountEquityState, raw: unknown, maxAgeMs: number): void {
  exact(raw, ['snapshot', 'previousSnapshotId', 'cashFlows', 'positionReleases']);
  const day = state.day!;
  const current = snapshot(raw.snapshot, state.account, state.mode, maxAgeMs);
  if (state.seenSnapshotIds.includes(current.id)) fail('duplicate_snapshot');
  if (raw.previousSnapshotId !== day.latest.id || current.sequence <= day.latest.sequence || current.atMs < day.latest.atMs) fail('out_of_order_reconciliation');
  validateReleases(day.latest, current, raw.positionReleases);
  exact(raw.cashFlows, ['fromMs', 'toMs', 'complete', 'items']);
  if (raw.cashFlows.complete !== true || raw.cashFlows.fromMs !== day.opening.atMs || raw.cashFlows.toMs !== current.atMs
      || !Array.isArray(raw.cashFlows.items)) fail('incomplete_cash_flow_window');
  const known = new Map(state.knownCashFlows.map(f => [f.id, f]));
  const included = new Set<string>();
  for (const item of raw.cashFlows.items) {
    const f = flow(item);
    if (f.atMs <= day.opening.atMs || f.atMs > current.atMs) fail('external_flow_outside_window');
    const previous = known.get(f.id);
    if (previous && !sameFlow(previous, f)) fail('cash_flow_id_conflict');
    if (!previous && f.atMs <= day.latest.atMs) fail('external_flow_predates_complete_reconciliation');
    known.set(f.id, clone(f));
    included.add(f.id);
  }
  for (const f of state.knownCashFlows) {
    if (f.atMs > day.opening.atMs && f.atMs <= current.atMs && !included.has(f.id)) fail('previous_external_flow_missing');
  }
  state.knownCashFlows = [...known.values()].sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  day.pnlMicrousd = pnl(day.opening, current, state.knownCashFlows);
  day.lossLimitReached ||= day.pnlMicrousd <= -DAILY_LOSS_LIMIT;
  day.latest = clone(current);
  state.seenSnapshotIds.push(current.id);
  state.halted ||= day.lossLimitReached;
}

function canonicalSnapshot(value: EquitySnapshot): string {
  return JSON.stringify({ id: value.id, account: value.account, mode: value.mode, sequence: value.sequence,
    atMs: value.atMs, complete: value.complete, cashMicrousd: value.cashMicrousd,
    positions: [...value.positions!].sort((a, b) => key(a).localeCompare(key(b))).map(p => ({ ...p })) });
}

export function createAccountEquityState(account: string, mode: Mode): AccountEquityState {
  return { schemaVersion: 1, account: identity(account, mode), mode, riskTimezone: 'Asia/Shanghai',
    capitalLimitMicrousd: CAPITAL_LIMIT, dailyLossLimitMicrousd: DAILY_LOSS_LIMIT, day: null,
    closedDays: [], knownCashFlows: [], seenSnapshotIds: [], halted: false, reconciliationIssue: 'opening_equity_required' };
}

/** Strict structural and financial validation; authenticity belongs to the adapter. */
export function parseAccountEquityState(value: unknown, account: string, mode: Mode): AccountEquityState {
  const expected = identity(account, mode);
  exact(value, ['schemaVersion', 'account', 'mode', 'riskTimezone', 'capitalLimitMicrousd', 'dailyLossLimitMicrousd',
    'day', 'closedDays', 'knownCashFlows', 'seenSnapshotIds', 'halted', 'reconciliationIssue']);
  if (value.schemaVersion !== 1 || value.account !== expected || value.mode !== mode || value.riskTimezone !== 'Asia/Shanghai'
      || value.capitalLimitMicrousd !== CAPITAL_LIMIT || value.dailyLossLimitMicrousd !== DAILY_LOSS_LIMIT
      || !Array.isArray(value.closedDays) || !Array.isArray(value.knownCashFlows) || !Array.isArray(value.seenSnapshotIds)
      || typeof value.halted !== 'boolean' || !(value.reconciliationIssue === null || text(value.reconciliationIssue))) fail('invalid_equity_state');
  const state = value as unknown as AccountEquityState;
  const ids = new Set<string>();
  for (const id of state.seenSnapshotIds) { if (!text(id) || ids.has(id)) fail('invalid_snapshot_history'); ids.add(id); }
  const flows = new Set<string>();
  for (const item of state.knownCashFlows) { const f = flow(item); if (flows.has(f.id)) fail('duplicate_persisted_flow'); flows.add(f.id); }
  if (state.day === null) {
    if (state.closedDays.length || flows.size || ids.size || state.halted || state.reconciliationIssue === null) fail('invalid_empty_equity_state');
    return clone(state);
  }
  let previous: EquityDay | null = null;
  for (const [index, raw] of [...state.closedDays, state.day].entries()) {
    const closed = index < state.closedDays.length;
    exact(raw, ['riskDay', 'opening', 'latest', 'pnlMicrousd', 'lossLimitReached', ...(closed ? ['externalNetFlowMicrousd'] : [])]);
    // Persisted opening/boundary marks must be at their own observation cut.
    // The current latest mark is checked against the caller's live freshness
    // policy by accountEquityView, so it remains eligible to age after restart.
    const opening = snapshot(raw.opening, expected, mode, 0);
    const latest = snapshot(raw.latest, expected, mode, closed ? 0 : Number.MAX_SAFE_INTEGER);
    if (opening.atMs !== dayStart(opening.atMs) || raw.riskDay !== riskDayKey(opening.atMs / 1000)
        || !ids.has(opening.id) || !ids.has(latest.id) || latest.id === opening.id || latest.atMs < opening.atMs || latest.sequence <= opening.sequence
        || raw.pnlMicrousd !== pnl(opening, latest, state.knownCashFlows) || typeof raw.lossLimitReached !== 'boolean'
        || (raw.pnlMicrousd as number) <= -DAILY_LOSS_LIMIT && !raw.lossLimitReached
        || raw.lossLimitReached && !state.halted) fail('invalid_equity_day');
    if (closed) {
      const day = raw as unknown as ClosedEquityDay;
      if (latest.atMs !== opening.atMs + 86_400_000
          || day.externalNetFlowMicrousd !== netFlows(state.knownCashFlows, opening.atMs, latest.atMs)) fail('invalid_closed_equity_day');
    } else if (riskDayKey(latest.atMs / 1000) !== raw.riskDay) fail('invalid_current_risk_day');
    if (previous && canonicalSnapshot(opening) !== canonicalSnapshot(previous.latest)) fail('broken_day_continuity');
    if ((raw.pnlMicrousd as number) <= -DAILY_LOSS_LIMIT && !state.halted) fail('lost_daily_loss_stop');
    previous = raw as unknown as EquityDay;
  }
  const first = state.closedDays[0]?.opening ?? state.day.opening;
  if (state.knownCashFlows.some(f => f.atMs <= first.atMs || f.atMs > state.day!.latest.atMs)) fail('persisted_flow_outside_history');
  return clone(state);
}

export function accountEquityView(state: AccountEquityState, nowMs: number, maxAgeMs: number): AccountEquityView {
  policy(nowMs, maxAgeMs);
  state = parseAccountEquityState(state, state.account, state.mode);
  const latest = state.day?.latest;
  const reason = state.reconciliationIssue ?? (!latest ? 'opening_equity_required'
    : nowMs < latest.atMs ? 'clock_before_reconciliation'
      : riskDayKey(nowMs / 1000) !== state.day!.riskDay ? 'day_rollover_required'
        : nowMs - latest.atMs > maxAgeMs ? 'stale_reconciliation'
          : latest.positions!.some(p => p.quantityMicros! > 0 && nowMs - p.pricedAtMs > maxAgeMs) ? 'stale_position_valuation' : null);
  return { execution_ready: false, accounting_ready: reason === null, paused: state.halted || reason !== null,
    reason: state.halted ? 'daily_loss_limit_reached' : reason, risk_day: state.day?.riskDay ?? null,
    equity_microusd: reason === null ? equity(latest!) : null, daily_pnl_microusd: reason === null ? state.day!.pnlMicrousd : null,
    capital_limit_microusd: CAPITAL_LIMIT, daily_loss_limit_microusd: DAILY_LOSS_LIMIT };
}

/** Invalid inputs pause accounting but preserve the last reconciled day and losses. */
export function reduceAccountEquity(state: AccountEquityState, event: unknown, nowMs: number, maxAgeMs: number): {
  state: AccountEquityState; view: AccountEquityView; applied: boolean;
} {
  policy(nowMs, maxAgeMs);
  const previous = parseAccountEquityState(state, state.account, state.mode);
  const next = clone(previous);
  let applied = false;
  try {
    if (!record(event) || !['initialize', 'reconcile', 'rollover'].includes(String(event.type))) fail('invalid_equity_event');
    exact(event, ['type', 'current', ...(event.type === 'initialize' ? ['opening'] : event.type === 'rollover' ? ['boundary'] : [])]);
    exact(event.current, ['snapshot', 'previousSnapshotId', 'cashFlows', 'positionReleases']);
    const current = snapshot(event.current.snapshot, next.account, next.mode, maxAgeMs);
    if (current.atMs > nowMs || nowMs - current.atMs > maxAgeMs) fail('stale_or_future_reconciliation');
    if (event.type === 'initialize') {
      if (next.day !== null) fail('opening_already_initialized');
      const opening = snapshot(event.opening, next.account, next.mode, maxAgeMs);
      if (opening.atMs !== dayStart(opening.atMs) || riskDayKey(opening.atMs / 1000) !== riskDayKey(current.atMs / 1000)) fail('missing_day_opening');
      next.day = { riskDay: riskDayKey(opening.atMs / 1000), opening: clone(opening), latest: clone(opening), pnlMicrousd: 0, lossLimitReached: false };
      next.seenSnapshotIds.push(opening.id);
    } else if (next.day === null) fail('opening_equity_required');
    if (event.type === 'rollover') {
      exact(event.boundary, ['snapshot', 'previousSnapshotId', 'cashFlows', 'positionReleases']);
      const boundary = snapshot(event.boundary.snapshot, next.account, next.mode, maxAgeMs);
      if (boundary.atMs !== next.day!.opening.atMs + 86_400_000
          || riskDayKey(boundary.atMs / 1000) !== riskDayKey(current.atMs / 1000)) fail('missing_day_boundary');
      applyReconciliation(next, event.boundary, maxAgeMs);
      next.closedDays.push({ ...clone(next.day!), externalNetFlowMicrousd: netFlows(next.knownCashFlows, next.day!.opening.atMs, boundary.atMs) });
      next.day = { riskDay: riskDayKey(boundary.atMs / 1000), opening: clone(boundary), latest: clone(boundary), pnlMicrousd: 0, lossLimitReached: false };
    }
    if (riskDayKey(current.atMs / 1000) !== next.day!.riskDay) fail('day_rollover_required');
    applyReconciliation(next, event.current, maxAgeMs);
    next.reconciliationIssue = null;
    parseAccountEquityState(next, next.account, next.mode);
    applied = true;
  } catch (error) {
    previous.reconciliationIssue = error instanceof Error ? error.message : 'invalid_equity_event';
    return { state: previous, view: accountEquityView(previous, nowMs, maxAgeMs), applied: false };
  }
  return { state: next, view: accountEquityView(next, nowMs, maxAgeMs), applied };
}

export function serializeAccountEquityState(state: AccountEquityState): string {
  return JSON.stringify(parseAccountEquityState(state, state.account, state.mode));
}
