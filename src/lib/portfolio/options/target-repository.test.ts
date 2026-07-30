import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

vi.mock('server-only', () => ({}));
const { OptionTargetRepository } = await import('./target-repository');

describe('OptionTargetRepository', () => {
  it('uses owner-scoped RPCs and stores the server-calculated target premium', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: 'target-id', error: null })
      .mockResolvedValueOnce({ data: undefined, error: null });
    const repository = new OptionTargetRepository({ rpc } as unknown as SupabaseClient<Database>);
    await repository.upsert({
      contractSymbol: 'AAPL260821C00200000',
      side: 'long',
      mode: 'profit_percent',
      targetValue: 25,
      targetPremium: 2.51,
      estimatedFee: 1,
    });
    await repository.delete('550e8400-e29b-41d4-a716-446655440000');
    expect(rpc).toHaveBeenNthCalledWith(1, 'upsert_portfolio_option_target', expect.objectContaining({
      input_target_value: '25',
      input_target_premium: '2.51',
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'delete_portfolio_option_target', {
      target_id: '550e8400-e29b-41d4-a716-446655440000',
    });
  });
});
