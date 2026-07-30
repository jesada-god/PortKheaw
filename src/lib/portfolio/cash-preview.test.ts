import { describe, expect, it } from 'vitest';
import { estimateCashAfterTransaction } from './cash-preview';
import type { TransactionInput } from './validation';

function input(values: Partial<TransactionInput> = {}): TransactionInput {
  return {
    portfolioId: '550e8400-e29b-41d4-a716-446655440001',
    type: 'buy_to_open',
    quantity: '1',
    price: '1.94',
    fee: '0',
    originalCurrency: 'USD',
    occurredAt: '2026-01-01',
    underlyingSymbol: 'NVTS',
    optionKind: 'put',
    strikePrice: '12',
    expirationDate: '2026-08-21',
    multiplier: '100',
    idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
    ...values,
  };
}

describe('transaction cash preview', () => {
  it('treats option premium as per-share and includes contracts, multiplier and fee', () => {
    expect(estimateCashAfterTransaction(500, input())).toBe(306);
    expect(estimateCashAfterTransaction(500, input({ price: '194' }))).toBe(-18_900);
  });

  it('previews credits and THB normalization without changing the stored USD base', () => {
    expect(estimateCashAfterTransaction(100, input({ type: 'sell_to_open', price: '2', fee: '1' }))).toBe(299);
    expect(estimateCashAfterTransaction(100, input({
      type: 'deposit',
      amount: '3600',
      quantity: '',
      price: '',
      fee: '',
      originalCurrency: 'THB',
      fxRateAtTransaction: '36',
    }))).toBe(200);
  });
});
