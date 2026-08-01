import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

vi.mock('server-only', () => ({}));
const { PortfolioRepository } = await import('./repository');

describe('PortfolioRepository ledger mutations', () => {
  it('routes stock and option events through the same owner-scoped ledger RPC', async () => {
    const builder = {
      update: vi.fn(),
      eq: vi.fn(),
      like: vi.fn(),
    };
    builder.update.mockReturnValue(builder);
    builder.eq.mockReturnValue(builder);
    builder.like.mockResolvedValue({ data: null, error: null });
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: 'transaction-id', error: null })
      .mockResolvedValueOnce({ data: undefined, error: null });
    const repository = new PortfolioRepository({
      rpc,
      from: vi.fn().mockReturnValue(builder),
    } as unknown as SupabaseClient<Database>);
    await repository.create({
      portfolioId: '11111111-1111-4111-8111-111111111111',
      type: 'buy_to_open',
      quantity: '1',
      price: '2',
      fee: '0',
      originalCurrency: 'USD',
      occurredAt: '2026-07-30T10:00',
      timezone: 'Asia/Bangkok',
      underlyingSymbol: 'NVTS',
      contractSymbol: 'NVTS260821P00012000',
      optionKind: 'put',
      optionSide: 'long',
      strikePrice: '12',
      expirationDate: '2026-08-21',
      multiplier: '100',
      idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
    });
    await repository.delete('550e8400-e29b-41d4-a716-446655440000');
    expect(rpc).toHaveBeenNthCalledWith(1, 'create_portfolio_ledger_transaction', expect.objectContaining({
      input_portfolio_id: '11111111-1111-4111-8111-111111111111',
      input_type: 'buy_to_open',
      input_contract_symbol: 'NVTS260821P00012000',
      input_multiplier: '100',
      input_fee: '0',
      input_occurred_at: '2026-07-30T03:00:00.000Z',
    }));
    expect(builder.update).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenNthCalledWith(2, 'delete_portfolio_ledger_transaction', {
      transaction_id: '550e8400-e29b-41d4-a716-446655440000',
    });
  });
});
