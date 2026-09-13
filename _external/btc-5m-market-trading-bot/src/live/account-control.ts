import { accountEquityView } from './account-equity.js';
import { availableMicrousd, prepareReservation, transitionReservation,
  type ReservationStatus } from './account-reservation.js';
import { AccountStateStore } from './account-state-store.js';
import { accountDataToEquitySnapshot } from './account-equity-adapter.js';
import { reduceAccountEquity, createAccountEquityState, type AccountEquityState } from './account-equity.js';
import type { ReservationCoordinator } from './executor.js';

export type AuthoritativeAccountReader = () => Promise<unknown>;

const SCALE = 1_000_000;

function money(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
  const micros = Math.ceil(value * SCALE - 1e-9);
  if (!Number.isSafeInteger(micros) || micros <= 0) throw new Error(`${name} is outside accounting precision`);
  return micros;
}

function feeMoney(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('fee must be finite and non-negative');
  if (value === 0) return 0;
  const micros = Math.ceil(value * SCALE - 1e-9);
  if (!Number.isSafeInteger(micros)) throw new Error('fee is outside accounting precision');
  return micros;
}

/** Live submission gate. It persists a reservation before the caller touches the network. */
export class AccountExecutionGate implements ReservationCoordinator {
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
    const result = prepareReservation(state.reservation, id, money(amountUsd, 'amount'), feeMoney(feeReserveUsd), nowMs);
    if (!result.applied) throw new Error(`reservation rejected: ${result.reason}`);
    this.store.write({ ...state, reservation: result.state });
  }

  transition(id: string, status: ReservationStatus, nowMs = Date.now()): void {
    const state = this.store.read();
    const result = transitionReservation(state.reservation, id, status, nowMs);
    if (!result.applied) throw new Error(`reservation transition rejected: ${result.reason}`);
    this.store.write({ ...state, reservation: result.state });
  }

  /** Read one account-data cut and advance persisted equity atomically. */
  async refresh(reader: AuthoritativeAccountReader, nowMs = Date.now()): Promise<void> {
    const before = this.store.read();
    if (before.equity.day === null) {
      throw new Error('account reconciliation requires an authoritative day-opening baseline');
    }
    const sequence = (before.equity.day?.latest.sequence ?? 0) + 1;
    const snapshot = accountDataToEquitySnapshot(reader ? await reader() : undefined, before.account, nowMs, sequence);
    const previous = before.equity.day.latest;
    const current = { snapshot, previousSnapshotId: previous.id,
      cashFlows: { fromMs: previous.atMs, toMs: snapshot.atMs, complete: true, items: [] },
      positionReleases: [] };
    const result = reduceAccountEquity(before.equity, { type: 'reconcile', current }, nowMs, this.maxAgeMs);
    if (!result.applied) {
      this.store.write({ ...before, equity: result.state });
      throw new Error(`account reconciliation rejected: ${result.state.reconciliationIssue ?? 'unknown'}`);
    }
    this.store.write({ ...before, equity: result.state });
  }

  /** Build an empty, fail-closed envelope for first authoritative refresh. */
  static emptyEquity(account: string, mode: 'live' | 'paper'): AccountEquityState {
    return createAccountEquityState(account, mode);
  }

  close(): void { this.store.close(); }
}
