import { describe, expect, it, vi } from 'vitest';
import { beijingMidnightMs, captureMidnightBaseline, msUntilNextBeijingMidnight } from './midnight-baseline.js';

const cut = (atMs: number, token: string) => ({ wallet: '0x' + '1'.repeat(40), read_only: true,
  pagination_atomic: true, atomic_snapshot_token: token, checked_at: new Date(atMs).toISOString(),
  collateral: { available: true, complete: true, items: [], snapshot_token: token },
  positions: { available: true, complete: true, items: [], snapshot_token: token } });

describe('Beijing midnight baseline', () => {
  it('captures only a provider atomic cut inside the midnight window', async () => {
    const midnight = Date.parse('2026-09-14T00:00:00+08:00');
    const reader = vi.fn().mockResolvedValueOnce(cut(midnight, 'opening-1234'))
      .mockResolvedValueOnce(cut(midnight + 1000, 'current-1234'));
    const packet = await captureMidnightBaseline(reader, midnight + 1000, { confirmationDelayMs: 0 });
    expect(packet.riskDay).toBe('2026-09-14');
    expect(packet.currentAtMs).toBeGreaterThan(packet.openingAtMs);
  });

  it('rejects an arbitrary daytime read as an opening baseline', async () => {
    const at = Date.parse('2026-09-14T12:00:00+08:00');
    await expect(captureMidnightBaseline(() => Promise.resolve(cut(at, 'daytime-1234')), at))
      .rejects.toThrow('baseline_outside_beijing_midnight_window');
  });

  it('computes the next Beijing boundary', () => {
    const at = Date.parse('2026-09-14T12:00:00+08:00');
    expect(msUntilNextBeijingMidnight(at)).toBe(12 * 60 * 60 * 1000);
    expect(beijingMidnightMs(at)).toBe(Date.parse('2026-09-14T00:00:00+08:00'));
  });
});
