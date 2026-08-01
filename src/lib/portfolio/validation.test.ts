import { describe, expect, it } from 'vitest';
import { portfolioTransactionSchema } from './validation';

const base = {
  portfolioId: '550e8400-e29b-41d4-a716-446655440001',
  occurredAt: '2026-01-01',
  timezone: 'Asia/Bangkok',
  note: '',
  idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
};
describe('portfolio transaction validation', () => {
  it.each(['-1', '0', 'NaN', '1.123456789'])('rejects invalid numeric input %s', (quantity) => {
    expect(portfolioTransactionSchema.safeParse({ ...base, type: 'acquisition', symbol: 'AAPL', quantity, price: '10' }).success).toBe(false);
  });
  it('accepts 8 decimal places and rejects future dates', () => {
    expect(portfolioTransactionSchema.safeParse({ ...base, type: 'acquisition', symbol: 'BTC', quantity: '0.00000001', price: '1.00000001' }).success).toBe(true);
    expect(portfolioTransactionSchema.safeParse({ ...base, type: 'deposit', amount: '1', occurredAt: '2999-01-01' }).success).toBe(false);
  });

  it('accepts fees, broker, time, initial positions and signed cash adjustments', () => {
    expect(portfolioTransactionSchema.safeParse({
      ...base, type: 'initial_position', symbol: 'VOO', quantity: '2', price: '500',
      amount: '75', fee: '0', broker: 'Example Broker', occurredAt: '2026-01-01T10:30',
    }).success).toBe(true);
    expect(portfolioTransactionSchema.safeParse({ ...base, type: 'adjustment', amount: '-2.50' }).success).toBe(true);
  });

  it('validates the complete option identity and THB normalization metadata', () => {
    const option = {
      ...base,
      type: 'buy_to_open',
      underlyingSymbol: 'NVDA',
      contractSymbol: 'NVDA260821P00100000',
      optionKind: 'put',
      optionSide: 'long',
      strikePrice: '100',
      expirationDate: '2026-08-21',
      quantity: '1',
      multiplier: '100',
      price: '2',
      fee: '1',
      originalCurrency: 'THB',
      fxRateAtTransaction: '35.5',
    };
    expect(portfolioTransactionSchema.safeParse(option).success).toBe(true);
    expect(portfolioTransactionSchema.safeParse({ ...option, fxRateAtTransaction: '' }).success).toBe(false);
    expect(portfolioTransactionSchema.safeParse({ ...option, contractSymbol: 'bad symbol' }).success).toBe(false);
  });

  it('accepts Buy to Open without user-entered contract symbol or broker', () => {
    expect(portfolioTransactionSchema.safeParse({
      ...base,
      type: 'buy_to_open',
      underlyingSymbol: 'NVDA',
      optionKind: 'call',
      strikePrice: '120',
      expirationDate: '2026-08-21',
      quantity: '1',
      multiplier: '100',
      price: '2',
      fee: '0',
      originalCurrency: 'USD',
    }).success).toBe(true);
  });
});
