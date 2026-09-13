import { createHash } from 'node:crypto';

export type BaselineSection = {
  available: boolean; complete: boolean; items: unknown[]; checked_at: string;
  source: string; snapshot_token?: string;
};

export type CompositeAccountRead = {
  wallet: string; checked_at: string; source: string; snapshot_token?: string;
  collateral: BaselineSection; positions: BaselineSection;
  cashFlows: BaselineSection; transfers: BaselineSection;
};

export type BaselineCut = {
  wallet: string; opening: CompositeAccountRead; current: CompositeAccountRead;
  token: string; source: string; skew_ms: number; opening_day: string;
};

const SHANGHAI = 'Asia/Shanghai';
const isoMs = (v: string) => { const n = Date.parse(v); if (!Number.isFinite(n)) throw new Error('invalid_checked_at'); return n; };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function dayOf(ms: number): string { return new Intl.DateTimeFormat('en-CA', { timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
function dayStart(ms: number): number { const p = new Intl.DateTimeFormat('en-US', { timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)); const y = Number(p.find(x => x.type === 'year')!.value), m = Number(p.find(x => x.type === 'month')!.value), d = Number(p.find(x => x.type === 'day')!.value); return Date.parse(`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00+08:00`); }

function validateRead(r: CompositeAccountRead, wallet: string): void {
  if (!r || r.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('account_mismatch');
  isoMs(r.checked_at);
  for (const name of ['collateral', 'positions', 'cashFlows', 'transfers'] as const) {
    const s = r[name]; if (!s || s.available !== true || s.complete !== true || !Array.isArray(s.items) || !s.source) throw new Error(`incomplete_${name}`);
    isoMs(s.checked_at);
  }
}

/** Builds an auditable opening/current cut from two stable ordinary-reader reads. */
export async function buildCompositeAccountBaseline(read: () => Promise<CompositeAccountRead>, wallet: string, nowMs = Date.now(), openingWindowMs = 5 * 60_000): Promise<BaselineCut> {
  const a = await read(); const b = await read(); validateRead(a, wallet); validateRead(b, wallet);
  if (digest(a) !== digest(b)) throw new Error('account_read_not_stable');
  const openingMs = isoMs(a.checked_at); const currentMs = isoMs(b.checked_at);
  if (currentMs < openingMs || currentMs > nowMs + 5_000) throw new Error('account_time_order');
  const start = dayStart(nowMs);
  if (openingMs < start || openingMs > start + openingWindowMs) throw new Error('opening_outside_beijing_day_start_window');
  const skew = Math.max(...[a.checked_at, a.collateral.checked_at, a.positions.checked_at, a.cashFlows.checked_at, a.transfers.checked_at].map(isoMs)) - Math.min(...[a.checked_at, a.collateral.checked_at, a.positions.checked_at, a.cashFlows.checked_at, a.transfers.checked_at].map(isoMs));
  const sources = new Set([a.source, a.collateral.source, a.positions.source, a.cashFlows.source, a.transfers.source]);
  return { wallet, opening: a, current: b, token: a.snapshot_token ?? digest(a), source: [...sources].join('+'), skew_ms: skew, opening_day: dayOf(openingMs) };
}
