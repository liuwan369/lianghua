import { expect, it } from 'vitest';
import { eventLabel } from './live-data';

it('distinguishes a verified zero payout from unknown or pending settlement', () => {
  expect(eventLabel({event:'settlement',state:'confirmed',payout_verified:true,credited_usd:5})).toBe('结算到账 $5.00');
  expect(eventLabel({event:'settlement',state:'confirmed',payout_verified:true,credited_usd:0})).toBe('结算到账 $0.00');
  expect(eventLabel({event:'settlement',state:'confirmed',payout_verified:false,credited_usd:5})).toBe('结算结束 · 未记录到账');
  expect(eventLabel({event:'settlement',state:'pending',payout_verified:true,credited_usd:5})).toBe('结算等待确认');
  expect(eventLabel({event:'settlement',state:'confirmed',payout_verified:true,credited_usd:-1})).toBe('结算结束 · 未记录到账');
});
