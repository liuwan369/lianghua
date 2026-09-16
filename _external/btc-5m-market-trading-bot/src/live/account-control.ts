import { accountEquityView } from './account-equity.js';
import { availableMicrousd, prepareReservation, transitionReservation,
  type ReservationStatus } from './account-reservation.js';
import { AccountStateStore } from './account-state-store.js';
import { accountDataToEquitySnapshot } from './account-equity-adapter.js';
import { reduceAccountEquity, createAccountEquityState, type AccountEquityState, type EquityReconciliation, type PositionRelease } from './account-equity.js';
import type { ReservationCoordinator } from './executor.js';

export type AuthoritativeAccountReader = () => Promise<unknown>;
export type AuthoritativeOpeningReader = () => Promise<{
  opening: unknown;
  current: unknown;
  cashFlows: EquityReconciliation['cashFlows'];
  positionReleases: PositionRelease[];
}>;

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

function cutTime(value: unknown, name: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as Record<string, unknown>).checked_at !== 'string') {
    throw new Error(`${name} is missing an authoritative checked_at`);
  }
  const parsed = Date.parse((value as Record<string, unknown>).checked_at as string);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} has an invalid checked_at`);
  return parsed;
}

function reconciliationEvidence(value: unknown): Pick<EquityReconciliation, 'cashFlows' | 'positionReleases'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('account reconciliation evidence is missing');
  const raw = value as Record<string, unknown>;
  if (!raw.cashFlows || typeof raw.cashFlows !== 'object' || Array.isArray(raw.cashFlows)
      || !Array.isArray(raw.positionReleases)) throw new Error('account reconciliation evidence is missing');
  return { cashFlows: raw.cashFlows as EquityReconciliation['cashFlows'], positionReleases: raw.positionReleases as PositionRelease[] };
}

/** Live submission gate. It persists a reservation before the caller touches the network. */
export class AccountExecutionGate implements ReservationCoordinator {
  private hotState: ReturnType<AccountStateStore['read']>;

  constructor(private readonly store: AccountStateStore, private readonly maxAgeMs = 30_000) {
    this.hotState = store.read();
  }

  verifyBeforeSubmission(nowMs = Date.now()): void {
    const state = this.store.read();
    const view = accountEquityView(state.equity, nowMs, this.maxAgeMs);
    if (!view.accounting_ready || view.paused) throw new Error(`accounting gate closed: ${view.reason ?? 'paused'}`);
    if (state.reservation.halted) throw new Error('accounting gate closed: daily loss limit reached');
    if (availableMicrousd(state.reservation) <= 0) throw new Error('accounting gate closed: capital reservation exhausted');
    this.store.verifyBeforeSubmission();
  }

  /**
   * Fast in-memory gate for quote, cancel/replace and hedge decisions. The
   * account reader and full disk integrity check stay on the cold refresh
   * path. A reservation itself is committed synchronously below because it
   * is the only state that must survive a process crash before the network
   * request is sent.
   */
  verifyBeforeSubmissionFast(nowMs = Date.now()): void {
    // A live market is longer than the ordinary account-read freshness TTL.
    // The fast path must not turn a slow read model into a 30-second trading
    // pause. It still enforces the Beijing-day boundary and persisted halt;
    // the next cold refresh updates equity/positions at the market boundary.
    const view = accountEquityView(this.hotState.equity, nowMs, Number.MAX_SAFE_INTEGER);
    if (!view.accounting_ready || view.paused) throw new Error(`accounting gate closed: ${view.reason ?? 'paused'}`);
    if (this.hotState.reservation.halted) throw new Error('accounting gate closed: daily loss limit reached');
    if (availableMicrousd(this.hotState.reservation) <= 0) throw new Error('accounting gate closed: capital reservation exhausted');
    this.store.verifyHot();
  }

  prepare(id: string, amountUsd: number, feeReserveUsd: number, nowMs = Date.now()): void {
    this.verifyBeforeSubmissionFast(nowMs);
    const result = prepareReservation(this.hotState.reservation, id, money(amountUsd, 'amount'), feeMoney(feeReserveUsd), nowMs);
    if (!result.applied) throw new Error(`reservation rejected: ${result.reason}`);
    this.hotState = { ...this.hotState, reservation: result.state };
    this.store.write(this.hotState);
  }

  transition(id: string, status: ReservationStatus, nowMs = Date.now()): void {
    const result = transitionReservation(this.hotState.reservation, id, status, nowMs);
    if (!result.applied) throw new Error(`reservation transition rejected: ${result.reason}`);
    this.hotState = { ...this.hotState, reservation: result.state };
    // prepare() already committed the capital reservation before the request
    // touched the network. Later lifecycle states can be coalesced; if the
    // process dies here, the durable prepared row still blocks a restart until
    // the exchange state is reconciled.
    this.store.writeHot(this.hotState);
  }

  /** Read one account-data cut and advance persisted equity atomically. */
  async refresh(reader: AuthoritativeAccountReader, nowMs = Date.now()): Promise<void> {
    this.store.flushHot();
    const before = this.store.read();
    if (before.equity.day === null) {
      throw new Error('account reconciliation requires an authoritative day-opening baseline');
    }
    const sequence = (before.equity.day?.latest.sequence ?? 0) + 1;
    const raw = reader ? await reader() : undefined;
    const cutAt = cutTime(raw, 'current');
    const evaluationNow = Math.max(nowMs, cutAt);
    const evidence = reconciliationEvidence(raw);
    const snapshot = accountDataToEquitySnapshot(raw, before.account, cutAt, sequence);
    const previous = before.equity.day.latest;
    const current = { snapshot, previousSnapshotId: previous.id,
      cashFlows: evidence.cashFlows, positionReleases: evidence.positionReleases };
    const result = reduceAccountEquity(before.equity, { type: 'reconcile', current }, evaluationNow, this.maxAgeMs);
    const latest = this.store.read();
    if (latest.equity.day?.latest.id !== before.equity.day.latest.id) {
      throw new Error('account state changed during reconciliation; retry required');
    }
    if (!result.applied) {
      this.store.write({ ...latest, equity: result.state });
      throw new Error(`account reconciliation rejected: ${result.state.reconciliationIssue ?? 'unknown'}`);
    }
    this.store.write({ ...latest, equity: result.state });
    this.hotState = this.store.read();
  }

  /**
   * Initialize an empty live account from one provider-owned atomic cut.
   * The provider must return the Beijing-day opening cut and a later current
   * cut from the same authoritative snapshot transaction. A normal reader
   * result cannot be used here because it has no atomic opening/current link.
   */
  async initialize(reader: AuthoritativeOpeningReader, nowMs = Date.now()): Promise<void> {
    this.store.flushHot();
    const before = this.store.read();
    if (before.equity.day !== null) throw new Error('account opening baseline already initialized');
    const cuts = await reader();
    if (!cuts || typeof cuts !== 'object' || !('opening' in cuts) || !('current' in cuts)) {
      throw new Error('authoritative opening cut is incomplete');
    }
    const evidence = reconciliationEvidence(cuts);
    const openingAt = cutTime(cuts.opening, 'opening');
    const currentAt = cutTime(cuts.current, 'current');
    const opening = accountDataToEquitySnapshot(cuts.opening, before.account, openingAt, 1);
    const current = accountDataToEquitySnapshot(cuts.current, before.account, currentAt, 2);
    const evaluationNow = Math.max(nowMs, currentAt);
    const result = reduceAccountEquity(before.equity, {
      type: 'initialize', opening,
      current: { snapshot: current, previousSnapshotId: opening.id,
        cashFlows: evidence.cashFlows, positionReleases: evidence.positionReleases },
    }, evaluationNow, this.maxAgeMs);
    const latest = this.store.read();
    if (latest.equity.day !== null) throw new Error('account state changed during initialization; retry required');
    if (!result.applied) {
      this.store.write({ ...latest, equity: result.state });
      throw new Error(`account opening reconciliation rejected: ${result.state.reconciliationIssue ?? 'unknown'}`);
    }
    this.store.write({ ...latest, equity: result.state });
    this.hotState = this.store.read();
  }

  /**
   * MVP bootstrap: start accounting from the first ordinary read available.
   * This intentionally ignores pre-start deposits and uses curPrice estimates;
   * it is never presented as a historical or atomic account reconciliation.
   */
  async initializeSimple(reader: () => Promise<unknown>, nowMs = Date.now()): Promise<void> {
    const before = this.store.read();
    if (before.equity.day !== null) throw new Error('account opening baseline already initialized');
    const raw = await reader();
    const checked = cutTime(raw, 'current');
    const evaluationNow = Math.max(nowMs, checked);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(checked));
    const y = parts.find(p => p.type === 'year')!.value, m = parts.find(p => p.type === 'month')!.value, d = parts.find(p => p.type === 'day')!.value;
    const openingAt = Date.parse(`${y}-${m}-${d}T00:00:00+08:00`);
    const opening = accountDataToEquitySnapshot(raw, before.account, openingAt, 1, true);
    const current = accountDataToEquitySnapshot(raw, before.account, checked, 2, true);
    const result = reduceAccountEquity(before.equity, { type: 'initialize', opening,
      current: { snapshot: current, previousSnapshotId: opening.id,
        cashFlows: { fromMs: openingAt, toMs: checked, complete: true, items: [] }, positionReleases: [] } }, evaluationNow, this.maxAgeMs);
    if (!result.applied) throw new Error(`account MVP bootstrap rejected: ${result.state.reconciliationIssue ?? 'unknown'}`);
    this.store.write({ ...this.store.read(), equity: result.state });
    this.hotState = this.store.read();
  }

  /** Build an empty, fail-closed envelope for first authoritative refresh. */
  static emptyEquity(account: string, mode: 'live' | 'paper'): AccountEquityState {
    return createAccountEquityState(account, mode);
  }

  close(): void { this.store.close(); }
}
