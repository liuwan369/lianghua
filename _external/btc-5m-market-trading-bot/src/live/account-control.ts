import { accountEquityView } from './account-equity.js';
import { availableMicrousd, prepareReservation, transitionReservation,
  type ReservationStatus } from './account-reservation.js';
import { AccountStateStore } from './account-state-store.js';

const SCALE = 1_000_000;

function money(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
  const micros = Math.ceil(value * SCALE - 1e-9);
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error(`${name} is outside accounting precision`);
  return micros;
}

/** Live submission gate. It persists a reservation before the caller touches the network. */
export class AccountExecutionGate {
  constructor(private readonly store: AccountStateStore, private readonly maxAgeMs = 30_000) {}

  verifyBeforeSubmission(): void {
    const state = this.store.read();
    const view = accountEquityView(state.equity, Date.now(), this.maxAgeMs);
    if (!view.accounting_ready || view.paused) throw new Error(`accounting gate closed: ${view.reason ?? 'paused'}`);
    if (availableMicrousd(state.reservation) <= 0) throw new Error('accounting gate closed: capital reservation exhausted');
    this.store.verifyBeforeSubmission();
  }

  prepare(id: string, amountUsd: number, feeReserveUsd: number, nowMs = Date.now()): void {
    this.verifyBeforeSubmission();
    const state = this.store.read();
    const result = prepareReservation(state.reservation, id, money(amountUsd, 'amount'), money(feeReserveUsd, 'fee'), nowMs);
    if (!result.applied) throw new Error(`reservation rejected: ${result.reason}`);
    this.store.write({ ...state, reservation: result.state });
  }

  transition(id: string, status: ReservationStatus, nowMs = Date.now()): void {
    const state = this.store.read();
    const result = transitionReservation(state.reservation, id, status, nowMs);
    if (!result.applied) throw new Error(`reservation transition rejected: ${result.reason}`);
    this.store.write({ ...state, reservation: result.state });
  }
}
