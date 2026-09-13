import { describe, expect, it } from 'vitest';
import { buildCompositeAccountBaseline, type CompositeAccountRead } from './composite-account-baseline.js';

const section = (token: string, source = 'reader'): any => ({ available: true, complete: true, items: [], checked_at: '2026-09-13T16:00:00.000Z', source, snapshot_token: token });
const read = (token = 'cut-12345678'): CompositeAccountRead => ({ wallet: '0xabc', checked_at: '2026-09-13T16:00:00.000Z', source: 'reader', snapshot_token: token, collateral: section(token), positions: section(token), cashFlows: section(token), transfers: section(token) });
const now = Date.parse('2026-09-14T00:20:00+08:00');

describe('composite account baseline', () => {
  it('requires two stable complete reads and emits token/source/skew cut', async () => {
    const cut = await buildCompositeAccountBaseline(async () => read(), '0xABC', now);
    expect(cut).toMatchObject({ wallet: '0xABC', token: 'cut-12345678', opening_day: '2026-09-14', skew_ms: 0 });
    expect(cut.source).toContain('reader');
  });
  it('rejects unstable reads and incomplete transfer evidence', async () => {
    let n = 0; await expect(buildCompositeAccountBaseline(async () => read(`cut-${++n}abcdefgh`), '0xabc', now)).rejects.toThrow('account_read_not_stable');
    const bad = read(); bad.transfers.complete = false;
    await expect(buildCompositeAccountBaseline(async () => bad, '0xabc', now)).rejects.toThrow('incomplete_transfers');
  });
  it('does not invent midnight: opening outside Beijing start window is rejected', async () => {
    const late = read(); late.checked_at = '2026-09-13T16:10:00.000Z';
    await expect(buildCompositeAccountBaseline(async () => late, '0xabc', now)).rejects.toThrow('opening_outside_beijing_day_start_window');
  });
});
