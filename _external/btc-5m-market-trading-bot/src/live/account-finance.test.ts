import { describe, it, expect } from 'vitest';
import { AccountFinanceReader, balanceOccupancy, receiptEvidence } from './account-finance.js';
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
    ]));
    expect(result.open_buy_notional).toBe(3);
    expect(result.balance_after_open_buy_notional).toBe(7);
    expect(result.spendable_balance).toBeNull();
    expect(balanceOccupancy({ ...section(), value: 10 }, section([{side:'BUY'}])).available).toBe(false);
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
