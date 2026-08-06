import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The four first-seen flows, at the seam where the bug actually was: the
 * mutation that creates the row must resolve the logo and hand it back, and no
 * page may pass a hardcoded null in its place.
 */

const mocks = vi.hoisted(() => ({
  ensureInstrumentLogo: vi.fn(),
  add: vi.fn(),
  create: vi.fn(),
  getUser: vi.fn(),
  revalidatePath: vi.fn(),
  instrumentStatus: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/src/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock('@/src/lib/instruments/status', () => ({
  getInstrumentStatus: mocks.instrumentStatus,
}));
vi.mock('@/src/lib/instruments/presentation', () => ({
  ensureInstrumentLogo: mocks.ensureInstrumentLogo,
}));
vi.mock('@/src/lib/watchlist/repository', () => ({
  WatchlistRepository: class { add = mocks.add; },
}));
vi.mock('@/src/lib/portfolio/repository', () => ({
  PortfolioRepository: class { create = mocks.create; },
}));
vi.mock('@/src/lib/portfolio/transaction-preparation', () => ({
  preparePortfolioTransactionForCreate: async (input: unknown) => input,
  preparePortfolioTransactionForUpdate: async (input: unknown) => input,
}));

import { addWatchlistItemAction } from '@/app/watchlist/actions';
import { createPortfolioTransactionAction } from '@/app/portfolio/actions';

const LOGO = 'https://images.example.test/AEVA.png';

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner' } } });
  mocks.instrumentStatus.mockResolvedValue('active');
  mocks.add.mockResolvedValue({ id: 'row', symbol: 'AEVA' });
  mocks.create.mockResolvedValue(undefined);
  mocks.ensureInstrumentLogo.mockResolvedValue({
    symbol: 'AEVA', logoUrl: LOGO, companyName: 'Aeva Inc.', status: 'resolved',
  });
});

describe('adding a symbol to the watchlist', () => {
  it('resolves the logo in the same mutation and returns it', async () => {
    const result = await addWatchlistItemAction('aeva');

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ logoUrl: LOGO });
    expect(mocks.ensureInstrumentLogo).toHaveBeenCalledWith('AEVA');
    expect(mocks.ensureInstrumentLogo).toHaveBeenCalledTimes(1);
  });

  it('still creates the row when no logo can be resolved right now', async () => {
    mocks.ensureInstrumentLogo.mockResolvedValue({
      symbol: 'AEVA', logoUrl: null, companyName: null, status: 'deferred',
    });

    const result = await addWatchlistItemAction('AEVA');

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ logoUrl: null });
    expect(mocks.add).toHaveBeenCalled();
  });
});

describe('opening a position in a portfolio', () => {
  const transaction = {
    portfolioId: '11111111-1111-4111-8111-111111111111',
    type: 'acquisition',
    symbol: 'AEVA',
    quantity: '10',
    price: '12.5',
    fee: '0',
    occurredAt: '2026-08-06T10:00',
    timezone: 'Asia/Bangkok',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
  };

  it('returns the logo it resolved for the newly opened symbol', async () => {
    const result = await createPortfolioTransactionAction(transaction);

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ symbol: 'AEVA', logoUrl: LOGO });
    expect(mocks.ensureInstrumentLogo).toHaveBeenCalledWith('AEVA');
  });

  it('does not resolve a logo for a ledger row that opens nothing', async () => {
    await createPortfolioTransactionAction({
      ...transaction,
      type: 'deposit',
      symbol: '',
      quantity: '',
      price: '',
      amount: '100',
    });

    expect(mocks.ensureInstrumentLogo).not.toHaveBeenCalled();
  });
});
