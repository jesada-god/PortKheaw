import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { OptionTarget } from './types';

vi.mock('server-only', () => ({}));
const { OptionTargetRepository } = await import('./target-repository');

describe('OptionTargetRepository', () => {
  it('uses owner-scoped RPCs and stores the server-calculated target premium', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: 'target-id', error: null })
      .mockResolvedValueOnce({ data: undefined, error: null });
    const repository = new OptionTargetRepository({ rpc } as unknown as SupabaseClient<Database>);
    await repository.upsert({
      portfolioId: '11111111-1111-4111-8111-111111111111',
      contractSymbol: 'AAPL260821C00200000',
      side: 'long',
      mode: 'profit_percent',
      targetValue: 25,
      targetPremium: 2.51,
      estimatedFee: 1,
    });
    await repository.delete('550e8400-e29b-41d4-a716-446655440000');
    expect(rpc).toHaveBeenNthCalledWith(1, 'upsert_portfolio_option_target', expect.objectContaining({
      input_portfolio_id: '11111111-1111-4111-8111-111111111111',
      input_target_value: '25',
      input_target_premium: '2.51',
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, 'delete_portfolio_option_target', {
      target_id: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('keeps a legacy target identity while using a safe user-facing notification label', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const repository = new OptionTargetRepository({ rpc } as unknown as SupabaseClient<Database>);
    const target = {
      id: 'target-id',
      contractSymbol: 'LEGACY-C307F481-B34C-4FE3-97',
      targetPremium: 2.75,
    } as OptionTarget;

    await repository.evaluate(target, 2.75, '2026-07-31T00:00:00.000Z', 'NVTS PUT $12');

    expect(rpc).toHaveBeenCalledWith('evaluate_portfolio_option_target', expect.objectContaining({
      target_id: 'target-id',
      observed_premium: 2.75,
      notification_title: 'ออปชัน NVTS PUT $12 ถึงเป้าหมายแล้ว',
    }));
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('LEGACY-');
    expect(target.contractSymbol).toBe('LEGACY-C307F481-B34C-4FE3-97');
  });
});
