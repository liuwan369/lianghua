/** Deterministic pre-submission reservation contract. It never sends orders. */

const CAPITAL_LIMIT = 50_000_000;
const DAILY_LOSS_LIMIT = 30_000_000;

export type ReservationStatus = 'prepared' | 'submitted' | 'unknown' | 'acknowledged'
  | 'partially_filled' | 'settlement_pending' | 'reconciled';

export interface Reservation {
  id: string;
  amountMicrousd: number;
  feeReserveMicrousd: number;
  status: ReservationStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ReservationState {
  schemaVersion: 1;
  capitalLimitMicrousd: number;
  dailyLossLimitMicrousd: number;
  dailyLossMicrousd: number;
  halted: boolean;
  reservations: Reservation[];
}

export interface ReservationResult {
  state: ReservationState;
  applied: boolean;
  reason: string | null;
}

const statuses: ReservationStatus[] = ['prepared', 'submitted', 'unknown', 'acknowledged',
  'partially_filled', 'settlement_pending', 'reconciled'];
const active = (status: ReservationStatus) => status !== 'reconciled';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const positive = (value: unknown): value is number => integer(value) && value > 0;
const time = (value: unknown): value is number => integer(value) && value >= 0 && value <= 8_639_999_971_200_000;
const clone = <T>(value: T): T => structuredClone(value);

function validStatus(value: unknown): value is ReservationStatus {
  return typeof value === 'string' && statuses.includes(value as ReservationStatus);
}

function validate(state: ReservationState): ReservationState {
  if (!state || state.schemaVersion !== 1 || state.capitalLimitMicrousd !== CAPITAL_LIMIT
      || state.dailyLossLimitMicrousd !== DAILY_LOSS_LIMIT || !integer(state.dailyLossMicrousd)
      || state.dailyLossMicrousd < 0 || typeof state.halted !== 'boolean' || !Array.isArray(state.reservations)) {
    throw new Error('invalid_reservation_state');
  }
  const ids = new Set<string>();
  let activeTotal = 0n;
  for (const item of state.reservations) {
    if (!item || typeof item.id !== 'string' || item.id.length < 1 || item.id.length > 256 || ids.has(item.id)
        || !positive(item.amountMicrousd) || !integer(item.feeReserveMicrousd) || item.feeReserveMicrousd < 0
        || !time(item.createdAtMs) || !time(item.updatedAtMs) || item.updatedAtMs < item.createdAtMs
        || !validStatus(item.status)) throw new Error('invalid_reservation');
    ids.add(item.id);
    if (active(item.status)) activeTotal += BigInt(item.amountMicrousd) + BigInt(item.feeReserveMicrousd);
  }
  if (activeTotal > BigInt(CAPITAL_LIMIT)
      || state.halted && state.dailyLossMicrousd < DAILY_LOSS_LIMIT
      || !state.halted && state.dailyLossMicrousd >= DAILY_LOSS_LIMIT) {
    throw new Error('invalid_reservation_limits');
  }
  return clone(state);
}

export function createReservationState(): ReservationState {
  return { schemaVersion: 1, capitalLimitMicrousd: CAPITAL_LIMIT, dailyLossLimitMicrousd: DAILY_LOSS_LIMIT,
    dailyLossMicrousd: 0, halted: false, reservations: [] };
}

export function availableMicrousd(state: ReservationState): number {
  const checked = validate(state);
  const used = checked.reservations.filter(item => active(item.status)).reduce((sum, item) =>
    sum + item.amountMicrousd + item.feeReserveMicrousd, 0);
  return CAPITAL_LIMIT - used;
}

export function prepareReservation(state: ReservationState, id: string, amountMicrousd: number,
  feeReserveMicrousd: number, nowMs: number): ReservationResult {
  const previous = validate(state);
  if (previous.halted) return { state: previous, applied: false, reason: 'daily_loss_limit_reached' };
  if (typeof id !== 'string' || id.length < 1 || id.length > 256 || !positive(amountMicrousd)
      || !integer(feeReserveMicrousd) || feeReserveMicrousd < 0 || !time(nowMs)) {
    return { state: previous, applied: false, reason: 'invalid_reservation_request' };
  }
  if (previous.reservations.some(item => item.id === id)) return { state: previous, applied: false, reason: 'duplicate_reservation' };
  if (BigInt(amountMicrousd) + BigInt(feeReserveMicrousd) > BigInt(availableMicrousd(previous))) {
    return { state: previous, applied: false, reason: 'capital_reservation_exceeded' };
  }
  const next = clone(previous);
  next.reservations.push({ id, amountMicrousd, feeReserveMicrousd, status: 'prepared', createdAtMs: nowMs, updatedAtMs: nowMs });
  return { state: validate(next), applied: true, reason: null };
}

export function transitionReservation(state: ReservationState, id: string, status: ReservationStatus,
  nowMs: number): ReservationResult {
  const previous = validate(state);
  if (!validStatus(status) || !time(nowMs)) return { state: previous, applied: false, reason: 'invalid_reservation_transition' };
  const index = previous.reservations.findIndex(item => item.id === id);
  if (index < 0) return { state: previous, applied: false, reason: 'unknown_reservation' };
  const item = previous.reservations[index];
  if (nowMs < item.updatedAtMs) return { state: previous, applied: false, reason: 'reservation_time_regression' };
  if (item.status === 'reconciled') return status === 'reconciled'
    ? { state: previous, applied: true, reason: null } : { state: previous, applied: false, reason: 'reservation_already_reconciled' };
  if (status !== item.status && (status === 'prepared' || statuses.indexOf(status) < statuses.indexOf(item.status))) {
    return { state: previous, applied: false, reason: 'reservation_status_regression' };
  }
  const next = clone(previous);
  next.reservations[index] = { ...item, status, updatedAtMs: nowMs };
  return { state: validate(next), applied: true, reason: null };
}

export function recordDailyLoss(state: ReservationState, lossMicrousd: number): ReservationResult {
  const previous = validate(state);
  if (!positive(lossMicrousd)) return { state: previous, applied: false, reason: 'invalid_daily_loss' };
  const next = clone(previous);
  const total = BigInt(next.dailyLossMicrousd) + BigInt(lossMicrousd);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return { state: previous, applied: false, reason: 'daily_loss_overflow' };
  next.dailyLossMicrousd = Number(total);
  if (next.dailyLossMicrousd >= DAILY_LOSS_LIMIT) next.halted = true;
  return { state: validate(next), applied: true, reason: null };
}

export function serializeReservationState(state: ReservationState): string {
  return JSON.stringify(validate(state));
}

export function parseReservationState(value: unknown): ReservationState {
  return validate(value as ReservationState);
}
