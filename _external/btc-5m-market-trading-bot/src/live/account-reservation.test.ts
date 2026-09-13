import { describe, expect, it } from 'vitest';
import { availableMicrousd, createReservationState, parseReservationState, prepareReservation,
  recordDailyLoss, recordDailyLossEvent, serializeReservationState, transitionReservation } from './account-reservation.js';

describe('atomic account reservation contract', () => {
  it('reserves amount plus fee atomically within the fixed 50 dollar allocation', () => {
    const state = createReservationState();
    const first = prepareReservation(state, 'a', 49_000_000, 1_000_000, 1);
    expect(first.applied).toBe(true);
    expect(availableMicrousd(first.state)).toBe(0);
    const rejected = prepareReservation(first.state, 'b', 1, 0, 2);
    expect(rejected).toMatchObject({ applied: false, reason: 'capital_reservation_exceeded' });
    expect(rejected.state).toEqual(first.state);
  });

  it('keeps unknown and settlement-pending reservations active until explicit reconciliation', () => {
    let state = prepareReservation(createReservationState(), 'a', 10_000_000, 100_000, 1).state;
    for (const status of ['submitted', 'unknown', 'acknowledged', 'partially_filled', 'settlement_pending'] as const) {
      const result = transitionReservation(state, 'a', status, 2);
      expect(result.applied).toBe(true);
      state = result.state;
      expect(availableMicrousd(state)).toBe(39_900_000);
    }
    state = transitionReservation(state, 'a', 'reconciled', 3).state;
    expect(availableMicrousd(state)).toBe(50_000_000);
  });

  it('rejects duplicate IDs, regressions and malformed requests without mutation', () => {
    const first = prepareReservation(createReservationState(), 'a', 1_000_000, 0, 1);
    expect(prepareReservation(first.state, 'a', 1, 0, 2).reason).toBe('duplicate_reservation');
    const submitted = transitionReservation(first.state, 'a', 'submitted', 2).state;
    expect(transitionReservation(submitted, 'a', 'prepared', 3).reason).toBe('reservation_status_regression');
    expect(transitionReservation(submitted, 'a', 'acknowledged', 1).reason).toBe('reservation_time_regression');
    expect(prepareReservation(first.state, 'b', 0, 0, 2).reason).toBe('invalid_reservation_request');
    expect(first.state.reservations[0].status).toBe('prepared');
  });

  it('rejects exchange lifecycle jumps that have no submission evidence', () => {
    const state = prepareReservation(createReservationState(), 'a', 1_000_000, 0, 1).state;
    expect(transitionReservation(state, 'a', 'acknowledged', 2).reason).toBe('reservation_status_regression');
    expect(transitionReservation(state, 'a', 'partially_filled', 2).reason).toBe('reservation_status_regression');
    const submitted = transitionReservation(state, 'a', 'submitted', 2).state;
    expect(transitionReservation(submitted, 'a', 'settlement_pending', 3).reason).toBe('reservation_status_regression');
  });

  it('sticks the 30 dollar daily loss stop and preserves it through serialization', () => {
    let state = createReservationState();
    state = recordDailyLoss(state, 29_999_999).state;
    expect(state.halted).toBe(false);
    state = recordDailyLoss(state, 1).state;
    expect(state.halted).toBe(true);
    expect(prepareReservation(state, 'blocked', 1, 0, 3).reason).toBe('daily_loss_limit_reached');
    const restored = parseReservationState(JSON.parse(serializeReservationState(state)));
    expect(restored).toEqual(state);
  });

  it('deduplicates authoritative loss events across retries', () => {
    let state = createReservationState();
    state = recordDailyLossEvent(state, 'settlement-1', 10_000_000).state;
    const duplicate = recordDailyLossEvent(state, 'settlement-1', 10_000_000);
    expect(duplicate.applied).toBe(false);
    expect(duplicate.reason).toBe('duplicate_daily_loss');
    expect(duplicate.state.dailyLossMicrousd).toBe(10_000_000);
  });

  it('rejects tampered limits, duplicate records and over-allocated state', () => {
    const state = prepareReservation(createReservationState(), 'a', 1_000_000, 0, 1).state;
    expect(() => parseReservationState({ ...state, capitalLimitMicrousd: 100_000_000 })).toThrow('invalid_reservation_state');
    expect(() => parseReservationState({ ...state, dailyLossMicrousd: 30_000_000 })).toThrow('invalid_reservation_limits');
    expect(() => parseReservationState({ ...state, reservations: [...state.reservations, state.reservations[0]] })).toThrow('invalid_reservation');
    expect(() => parseReservationState({ ...state, reservations: [{ ...state.reservations[0], amountMicrousd: 50_000_001 }] })).toThrow('invalid_reservation_limits');
  });
});
