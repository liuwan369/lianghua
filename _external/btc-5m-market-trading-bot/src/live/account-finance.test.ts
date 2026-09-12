import { describe, it, expect } from 'vitest';
import { AccountFinanceReader, accountRiskContract, balanceOccupancy, receiptEvidence } from './account-finance.js';
import { PUSD } from './contracts.js';
import type { Section } from './account-data.js';

const wallet = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`, tx = `0x${'a'.repeat(64)}`;
const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2)}`;
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const log = (token: string = PUSD, to = wallet, logIndex = '0x0') => ({ transactionHash: tx, blockNumber: '0x10', logIndex,
  address: token, topics: [transferTopic, topic(other), topic(to)], data: `0x${(2_000_000).toString(16).padStart(64, '0')}` });
const receipt = (logs = [log()]) => ({ transactionHash: tx, blockNumber: '0x10', blockHash: `0x${'b'.repeat(64)}`, status: '0x1', logs });
const section = (items: Record<string, unknown>[] = []): Section => ({ available: true, complete: true, items, pages: 1, source: 'test', checked_at: new Date().toISOString() });

describe('account cash evidence', () => {
  it('deducts only unmatched BUY notional and refuses to claim spendable balance', () => {
    const result = balanceOccupancy({ ...section(), value: 10 }, section([
      { side: 'BUY', original_size: '10', size_matched: '4', price: '0.5' },
      { side: 'SELL', original_size: '9', size_matched: '0', price: '0.9' },
    ]), section([{ asset: 'up', conditionId: 'market', size: '4', avgPrice: '0.25' }]));
    expect(result.open_buy_notional).toBe(3);
    expect(result.balance_after_open_buy_notional).toBe(7);
    expect(result).toMatchObject({ complete: false, spendable_balance: null });
    expect(result.observed).toMatchObject({ position_cost_usd: 1, capital_occupied_estimate_usd: 4,
      capital_headroom_estimate_usd: 46, open_buy_count: 1, position_count: 1, estimate_inputs_complete: true });
    expect(balanceOccupancy({ ...section(), value: 10 }, section([{side:'BUY'}]), section([{ size: 'unknown' }])).available).toBe(false);
  });
  it('publishes the bounded 50/30 requirements without claiming an execution gate', () => {
    expect(accountRiskContract()).toMatchObject({ capital_limit_usd: 50, daily_loss_limit_usd: 30,
      risk_timezone: 'Asia/Shanghai', read_only: true, execution_ready: false });
    expect(accountRiskContract().required_before_execution).toContain('atomic_pre_submission_gate');
  });
  it('keeps unknown cash and missing or partial positions distinct from zero', () => {
    const missingCash = balanceOccupancy(section(), section(), section());
    expect(missingCash).toMatchObject({ available: false, spendable_balance: null, balance_after_open_buy_notional: null });
    expect(missingCash.observed).toMatchObject({ collateral_balance_usd: null, position_cost_usd: 0,
      capital_occupied_estimate_usd: 0, estimate_inputs_complete: false });
    const omittedPositions = balanceOccupancy({ ...section(), value: 0 }, section());
    expect(omittedPositions.observed).toMatchObject({ position_cost_usd: null, position_count: null,
      capital_occupied_estimate_usd: null, capital_headroom_estimate_usd: null, estimate_inputs_complete: false });
    const partialPositions = balanceOccupancy({ ...section(), value: 0 }, section(), { ...section(), complete: false });
    expect(partialPositions.observed.position_cost_usd).toBeNull();
    expect(balanceOccupancy({ ...section(), value: 0 }, section(), section()).observed.estimate_inputs_complete).toBe(true);
  });
  it('aggregates every market and retains redeemable holdings until cash is reconciled', () => {
    const result = balanceOccupancy({ ...section(), value: 2 }, section([
      { id: 'live', side: 'BUY', original_size: 10, size_matched: 2, price: 0.5 },
      { id: 'matched', status: 'MATCHED', side: 'BUY', original_size: 2, size_matched: 2, price: 0.5 },
    ]), section([
      { asset: 'up', conditionId: 'first', size: 20, avgPrice: 0.5, redeemable: false },
      { asset: 'down', conditionId: 'second', size: 100, avgPrice: 0.4, redeemable: true },
      { asset: 'zero', conditionId: 'second', size: 0 },
    ]));
    expect(result.observed).toMatchObject({ position_cost_usd: 50, position_count: 2,
      capital_occupied_estimate_usd: 54, capital_headroom_estimate_usd: -4, cash_shortfall_estimate_usd: 2 });
    expect(result.spendable_balance).toBeNull();
    expect(result.unaccounted).toContain('matched_trades_pending_chain_confirmation');
  });
  it('rejects duplicate positions and orders, corrupt quantities and overflowing totals', () => {
    const position = { asset: 'up', conditionId: 'market', size: 4, avgPrice: 0.25 };
    const order = { id: 'a', side: 'BUY', original_size: 10, size_matched: 0, price: 0.5 };
    expect(balanceOccupancy({ ...section(), value: 10 }, section([order, order]), section()).open_buy_notional).toBeNull();
    expect(balanceOccupancy({ ...section(), value: 10 }, section(), section([position, position])).observed.position_cost_usd).toBeNull();
    for (const patch of [{ size: -1 }, { size: 'invalid', initialValue: 0 }, { avgPrice: null }, { size: 1e308 }]) {
      expect(balanceOccupancy({ ...section(), value: 10 }, section(), section([{ ...position, ...patch }])).observed.position_cost_usd).toBeNull();
    }
    for (const value of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
      expect(balanceOccupancy({ ...section(), value }, section(), section()).observed.collateral_balance_usd).toBeNull();
    }
    for (const patch of [{ original_size: -1 }, { size_matched: 11 }, { price: 1.01 }, { original_size: Infinity }]) {
      expect(balanceOccupancy({ ...section(), value: 10 }, section([{ ...order, ...patch }]), section()).open_buy_notional).toBeNull();
    }
  });
  it('reports source times without presenting a fresh overall timestamp as an atomic observation', () => {
    const result = balanceOccupancy({ ...section(), value: 10, checked_at: '2026-09-13T00:00:00Z' },
      { ...section(), checked_at: '2026-09-13T00:00:02Z' }, { ...section(), checked_at: '2026-09-13T00:00:04Z' });
    expect(result.observed.source_skew_ms).toBe(4000);
    expect(result.complete).toBe(false);
    const invalid = balanceOccupancy({ ...section(), value: 10, checked_at: 'invalid' }, section(), section());
    expect(invalid.observed).toMatchObject({ source_skew_ms: null, estimate_inputs_complete: false });
  });
  it('accepts confirmed wallet token transfers and rejects unconfirmed or duplicate logs', () => {
    expect((receiptEvidence(receipt(), wallet, tx, 20).transfers as unknown[])).toHaveLength(1);
    expect(receiptEvidence(receipt([log(other, wallet, '0x1'), log(PUSD,other, '0x2')]), wallet, tx, 20)).toBeDefined();
  });
  it('rejects receipts below confirmation depth, failed transactions and duplicate events', () => {
    expect(() => receiptEvidence(receipt(), wallet, tx, 15)).toThrow('receipt_unconfirmed');
    expect(() => receiptEvidence({...receipt(),status:'0x0'}, wallet, tx, 20)).toThrow();
    expect(() => receiptEvidence(receipt([log(),log()]), wallet, tx, 20)).toThrow('receipt_duplicate_log');
    expect(receiptEvidence(receipt([log(other)]),wallet,tx,20).transfers).toEqual([]);
  });
  it('verifies reward amount against the wallet receipt, not the activity label', async () => {
    const rpc = async (method: string) => method === 'eth_blockNumber' ? '0x30' : receipt();
    const reader = new AccountFinanceReader(wallet);
    const activity = section([{type:'REWARD',transactionHash:tx,usdcSize:2,timestamp:100}]);
    const result = await reader.read(rpc,section(),activity);
    expect(result.rewards.items[0].verified).toBe(true);
    expect(result.reconciliation.wallet_net_profit).toBeNull();
    expect(result.fees.available).toBe(false);
    const mismatch = await new AccountFinanceReader(wallet).read(rpc,section(),section([{...activity.items[0],usdcSize:3}]));
    expect(mismatch.rewards.items[0].verified).toBe(false);
  });
});
