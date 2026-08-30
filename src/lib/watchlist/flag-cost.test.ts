import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHAT_CHANGED_CARD, PROVED BEHAVIOURALLY: off means the load never happens.
 *
 * ===========================================================================
 * WHY A SOURCE SCAN IS NOT ENOUGH FOR THIS ONE
 * ===========================================================================
 * `phase2-flags.test.ts` checks the SHAPE — that the guard sits before the
 * call. That catches the obvious regression and misses the interesting one: a
 * `Promise.all` further up the file that starts the same work eagerly, a
 * loader that got hoisted into a shared batch, a helper that now reads bars for
 * everybody and hands the card a slice. In every one of those the guard is
 * still textually above the call and the reader still pays.
 *
 * So this one mounts the real `loadWatchlistView` with every collaborator
 * stubbed, turns the flag off, and asserts the bar loader was NOT CALLED. That
 * is the claim the rollout doc makes on this flag's behalf, and it is the only
 * form of it that stays true when the code around it moves.
 *
 * The watchlist is deliberately EMPTY. Nothing here is testing what the rows
 * look like — the row builders have their own tests — and an empty list keeps
 * every other loader trivial so the one call being counted is unambiguous.
 */

const loadWhatChanged = vi.fn(async () => ({ items: [], limit: 3 }));

vi.mock('./what-changed-service', () => ({ loadWhatChanged }));
vi.mock('@/src/lib/instruments/presentation', () => ({
  getInstrumentPresentationMetadata: vi.fn(async () => new Map()),
}));
vi.mock('@/src/lib/overview/service', () => ({
  loadOverviewPrice: vi.fn(async () => null),
  mapWithConcurrency: vi.fn(async () => []),
}));
vi.mock('@/src/lib/upcoming/service', () => ({
  loadUpcomingEarnings: vi.fn(async () => []),
  upcomingEarningsSymbols: vi.fn(() => []),
}));
vi.mock('@/src/lib/market-data/daily-snapshot', () => ({
  loadDailySnapshots: vi.fn(async () => new Map()),
}));
vi.mock('@/src/lib/analytics/market-signal/entitled-service', () => ({
  loadEntitledMarketSignal: vi.fn(async () => null),
}));

const { loadWatchlistView } = await import('./service');

const WATCHLIST = {
  id: 'list-1',
  name: 'รายการหลัก',
  items: [],
} as unknown as Parameters<typeof loadWatchlistView>[0]['watchlist'];

function viewInput() {
  return {
    client: {} as unknown as Parameters<typeof loadWatchlistView>[0]['client'],
    watchlist: WATCHLIST,
    tier: 'basic' as const,
    now: new Date('2026-08-30T14:00:00.000Z'),
  } as Parameters<typeof loadWatchlistView>[0];
}

beforeEach(() => {
  loadWhatChanged.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('WHAT_CHANGED_CARD gates the cost, not just the pixels', () => {
  it('does not read daily bars when the flag is unset', async () => {
    const original = process.env.WHAT_CHANGED_CARD;
    try {
      delete process.env.WHAT_CHANGED_CARD;
      const view = await loadWatchlistView(viewInput());
      expect(loadWhatChanged).not.toHaveBeenCalled();
      // And the payload carries no section for a client to find.
      expect(view.whatChanged).toBeNull();
    } finally {
      if (original === undefined) delete process.env.WHAT_CHANGED_CARD;
      else process.env.WHAT_CHANGED_CARD = original;
    }
  });

  it('does not read daily bars when the flag is explicitly false', async () => {
    vi.stubEnv('WHAT_CHANGED_CARD', 'false');
    const view = await loadWatchlistView(viewInput());
    expect(loadWhatChanged).not.toHaveBeenCalled();
    expect(view.whatChanged).toBeNull();
  });

  /*
   * The positive case is what makes the two above mean something. Without it
   * they would pass just as well against a `loadWhatChanged` that had been
   * deleted, or a flag that was wired to nothing at all.
   */
  it('reads daily bars once when the flag is on', async () => {
    vi.stubEnv('WHAT_CHANGED_CARD', 'true');
    const view = await loadWatchlistView(viewInput());
    expect(loadWhatChanged).toHaveBeenCalledTimes(1);
    expect(view.whatChanged).not.toBeNull();
  });
});
