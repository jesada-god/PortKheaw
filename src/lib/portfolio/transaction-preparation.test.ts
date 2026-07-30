import { describe, expect, it, vi } from 'vitest';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { PortfolioTransaction } from './types';
import type { TransactionInput } from './validation';

vi.mock('server-only', () => ({}));

const {
  preparePortfolioTransactionForCreate,
  preparePortfolioTransactionForUpdate,
} = await import('./transaction-preparation');

const input: TransactionInput = {
  type: 'buy_to_open',
  quantity: '1',
  price: '2',
  fee: '0',
  originalCurrency: 'USD',
  occurredAt: '2026-07-30T10:00',
  underlyingSymbol: 'NVDA',
  optionKind: 'put',
  optionSide: 'long',
  strikePrice: '100',
  expirationDate: '2026-08-21',
  multiplier: '100',
  idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
};

const existing: PortfolioTransaction = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  portfolioId: '550e8400-e29b-41d4-a716-446655440002',
  type: 'buy_to_open',
  symbol: null,
  quantity: '1',
  price: '2',
  amount: null,
  broker: 'Dime',
  occurredAt: '2026-07-30',
  occurredAtTime: '2026-07-30T03:00:00.000Z',
  underlyingSymbol: 'NVDA',
  contractSymbol: 'LEGACY-123',
  optionKind: 'put',
  optionSide: 'long',
  strikePrice: '100',
  expirationDate: '2026-08-21',
  multiplier: '100',
  note: null,
  createdAt: '2026-07-30T03:00:00.000Z',
  updatedAt: '2026-07-30T03:00:00.000Z',
};

describe('portfolio transaction preparation', () => {
  it('saves Buy to Open without user-entered contract symbol or broker', async () => {
    const prepared = await preparePortfolioTransactionForCreate(input, async () => {
      throw new Error('chain unavailable');
    });

    expect(prepared.broker).toBe('');
    expect(prepared.contractSymbol).toMatch(/^UNRESOLVED-[A-F0-9]{32}$/);
  });

  it('keeps an internal ledger identity for a follow-up transaction', async () => {
    const loader = vi.fn<() => Promise<OptionsChain>>();
    const prepared = await preparePortfolioTransactionForCreate(
      { ...input, type: 'sell_to_close', contractSymbol: 'LEGACY-123' },
      loader,
    );

    expect(prepared.contractSymbol).toBe('LEGACY-123');
    expect(loader).not.toHaveBeenCalled();
  });

  it('keeps a legacy contract symbol and broker when editing an existing transaction', async () => {
    const loader = vi.fn<() => Promise<OptionsChain>>();
    const prepared = await preparePortfolioTransactionForUpdate(
      { ...input, broker: '', contractSymbol: '' },
      existing,
      loader,
    );

    expect(prepared.broker).toBe('Dime');
    expect(prepared.contractSymbol).toBe('LEGACY-123');
    expect(loader).not.toHaveBeenCalled();
  });
});
