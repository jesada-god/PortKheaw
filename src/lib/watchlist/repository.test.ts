import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

vi.mock('server-only', () => ({}));

const { WatchlistRepository } = await import('./repository');

function clientWith(from: ReturnType<typeof vi.fn>, rpcData = 'watchlist-1') {
  return {
    rpc: vi.fn().mockResolvedValue({ data: rpcData, error: null }),
    from,
  } as unknown as SupabaseClient<Database>;
}

describe('WatchlistRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates/loads the default watchlist and its persisted items', async () => {
    const watchlistQuery = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'watchlist-1', name: 'รายการโปรด', created_at: '2026-07-18T00:00:00.000Z' },
        error: null,
      }),
    };
    const itemQuery = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({
        data: [{ id: 'item-1', symbol: 'AAPL', created_at: '2026-07-18T00:00:00.000Z', pinned: false }],
        error: null,
      }),
    };
    const from = vi.fn((table: string) => table === 'watchlists' ? watchlistQuery : itemQuery);
    const repo = new WatchlistRepository(clientWith(from));

    await expect(repo.getDefault()).resolves.toEqual({
      id: 'watchlist-1', name: 'รายการโปรด', createdAt: '2026-07-18T00:00:00.000Z',
      items: [{ id: 'item-1', symbol: 'AAPL', createdAt: '2026-07-18T00:00:00.000Z', pinned: false }],
    });
  });

  it('supports create and surfaces the database duplicate constraint', async () => {
    const insertQuery = {
      insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(),
      single: vi.fn()
        .mockResolvedValueOnce({ data: { id: 'item-1', symbol: 'AAPL', created_at: '2026-07-18T00:00:00.000Z', pinned: false }, error: null })
        .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key' } }),
    };
    const repo = new WatchlistRepository(clientWith(vi.fn(() => insertQuery)));
    await expect(repo.add('AAPL')).resolves.toMatchObject({ symbol: 'AAPL' });
    await expect(repo.add('AAPL')).rejects.toMatchObject({ code: '23505' });
    expect(insertQuery.insert).toHaveBeenCalledWith({ watchlist_id: 'watchlist-1', symbol: 'AAPL' });
  });

  it('scopes item removal to the caller default watchlist', async () => {
    const deleteQuery = {
      delete: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 'item-1' }], error: null }),
    };
    const repo = new WatchlistRepository(clientWith(vi.fn(() => deleteQuery)));

    await expect(repo.remove('AAPL')).resolves.toBe(true);
    expect(deleteQuery.eq).toHaveBeenNthCalledWith(1, 'watchlist_id', 'watchlist-1');
    expect(deleteQuery.eq).toHaveBeenNthCalledWith(2, 'symbol', 'AAPL');
  });

  /*
   * Renaming and deleting a LIST no longer touch the tables from here. Both
   * rules they have to respect — names unique per account, and never delete the
   * last one — are enforced inside `security definer` functions that lock and
   * count, so the repository's whole job is to pass the id through. Asserting
   * the RPC name and arguments is asserting exactly that.
   */
  it('routes list rename and delete through the guarded functions', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const repo = new WatchlistRepository({
      rpc, from: vi.fn(),
    } as unknown as SupabaseClient<Database>);

    await expect(repo.rename('watchlist-2', 'ติดตาม')).resolves.toBeUndefined();
    await expect(repo.delete('watchlist-2')).resolves.toBeUndefined();

    expect(rpc).toHaveBeenNthCalledWith(1, 'rename_watchlist', {
      target_watchlist_id: 'watchlist-2', input_name: 'ติดตาม',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'delete_watchlist', {
      target_watchlist_id: 'watchlist-2',
    });
  });

  it('surfaces the last-list refusal instead of swallowing it', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null, error: { code: '23514', message: 'Cannot delete the only watchlist' },
    });
    const repo = new WatchlistRepository({
      rpc, from: vi.fn(),
    } as unknown as SupabaseClient<Database>);
    await expect(repo.delete('watchlist-1')).rejects.toMatchObject({ code: '23514' });
  });

  it('does not hide an RLS authorization failure', async () => {
    const insertQuery = {
      insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'row-level security policy' } }),
    };
    const repo = new WatchlistRepository(clientWith(vi.fn(() => insertQuery)));
    await expect(repo.add('MSFT')).rejects.toMatchObject({ code: '42501' });
  });
});
