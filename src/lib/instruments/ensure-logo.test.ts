import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketDataError } from '@/src/lib/market-data/errors';
import type { CompanyProfile } from '@/src/lib/market-data/types';
import type { InstrumentMetadata } from '@/src/lib/overview/types';

/**
 * The first-seen path: a symbol nobody has looked at, arriving from search, from
 * Stock Detail, or from being added to a portfolio or watchlist. What matters is
 * that it is resolved once, written down, and never re-asked for the wrong
 * reason.
 */

const mocks = vi.hoisted(() => ({
  getInstrumentMetadata: vi.fn(),
  getCompanyProfile: vi.fn(),
  persistInstrumentLogos: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./master', () => ({ getInstrumentMetadata: mocks.getInstrumentMetadata }));
vi.mock('@/src/lib/market-data', () => ({
  getCompanyProfileService: () => ({ getCompanyProfile: mocks.getCompanyProfile }),
}));
vi.mock('./logo-store', () => ({
  persistInstrumentLogos: mocks.persistInstrumentLogos,
  isBrokenLogoUrl: () => false,
}));

import {
  ensureInstrumentLogo,
  ensureInstrumentLogos,
  resetInstrumentLogoMemory,
} from './presentation';

/** The instrument master as it is for a symbol nobody has resolved yet. */
function master(symbol: string, logoUrl: string | null = null): Map<string, InstrumentMetadata> {
  return new Map([[symbol, {
    symbol,
    companyName: `${symbol} Corporation - Common Stock`,
    exchange: 'NASDAQ',
    assetType: 'Stock',
    currency: 'USD',
    sector: null,
    industry: null,
    websiteDomain: null,
    logoUrl,
    metadataSource: 'instrument-master',
    updatedAt: null,
  }]]);
}

function profile(symbol: string, logoUrl: string | null): CompanyProfile {
  return {
    symbol,
    name: `${symbol} Inc.`,
    description: null,
    country: null,
    employees: null,
    currency: 'USD',
    fiscalYearEnd: null,
    sector: null,
    industry: null,
    marketCapitalization: null,
    website: null,
    logoUrl,
    exchange: 'NASDAQ',
    latestQuarter: null,
  };
}

beforeEach(() => {
  mocks.getInstrumentMetadata.mockReset();
  mocks.getInstrumentMetadata.mockResolvedValue(master('AEVA'));
  mocks.getCompanyProfile.mockReset();
  mocks.persistInstrumentLogos.mockReset();
  mocks.persistInstrumentLogos.mockResolvedValue(['AEVA']);
  resetInstrumentLogoMemory();
});

describe('ensureInstrumentLogo', () => {
  it('resolves and persists a symbol seen for the first time', async () => {
    mocks.getCompanyProfile.mockResolvedValue({
      data: profile('AEVA', 'https://images.example.test/AEVA.png'),
    });

    const ensured = await ensureInstrumentLogo('aeva');

    expect(ensured.symbol).toBe('AEVA');
    expect(ensured.logoUrl).toBe('https://images.example.test/AEVA.png');
    expect(ensured.status).toBe('resolved');
    expect(mocks.persistInstrumentLogos).toHaveBeenCalledWith([
      { symbol: 'AEVA', logoUrl: 'https://images.example.test/AEVA.png', persisted: null },
    ]);
  });

  it('answers concurrent callers for one symbol with a single provider call', async () => {
    // A gate the provider waits on, so all three callers are in flight together.
    let openGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    mocks.getCompanyProfile.mockImplementation(async () => {
      await gate;
      return { data: profile('AEVA', 'https://images.example.test/AEVA.png') };
    });

    const inFlight = [
      ensureInstrumentLogo('AEVA'),
      ensureInstrumentLogo('AEVA'),
      ensureInstrumentLogo('aeva'),
    ];
    openGate!();
    const results = await Promise.all(inFlight);

    expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);
    expect(mocks.persistInstrumentLogos).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.logoUrl).toBe('https://images.example.test/AEVA.png');
    }
  });

  it('reuses the persisted logo on a cold reload without asking the provider', async () => {
    mocks.getInstrumentMetadata.mockResolvedValue(
      master('AEVA', 'https://images.example.test/AEVA.png'),
    );

    const ensured = await ensureInstrumentLogo('AEVA');

    expect(ensured.status).toBe('persisted');
    expect(ensured.logoUrl).toBe('https://images.example.test/AEVA.png');
    expect(mocks.getCompanyProfile).not.toHaveBeenCalled();
    expect(mocks.persistInstrumentLogos).not.toHaveBeenCalled();
  });

  it('does not re-ask the provider for a symbol it already resolved this session', async () => {
    mocks.getCompanyProfile.mockResolvedValue({
      data: profile('AEVA', 'https://images.example.test/AEVA.png'),
    });

    await ensureInstrumentLogo('AEVA');
    const second = await ensureInstrumentLogo('AEVA');

    expect(second.logoUrl).toBe('https://images.example.test/AEVA.png');
    expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);
  });

  describe('when the provider quota is spent', () => {
    it('defers rather than recording that the symbol has no logo', async () => {
      mocks.getCompanyProfile.mockRejectedValue(
        new MarketDataError('rate-limited', 'FMP daily limit reached', 60),
      );

      const first = await ensureInstrumentLogo('AEVA');
      expect(first.logoUrl).toBeNull();
      expect(first.status).toBe('deferred');
      expect(mocks.persistInstrumentLogos).not.toHaveBeenCalled();

      // Quota resets: the very next attempt must go back to the provider.
      mocks.getCompanyProfile.mockResolvedValue({
        data: profile('AEVA', 'https://images.example.test/AEVA.png'),
      });
      const second = await ensureInstrumentLogo('AEVA');
      expect(second.logoUrl).toBe('https://images.example.test/AEVA.png');
      expect(second.status).toBe('resolved');
      expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(2);
    });

    it('is not fooled by a profile that succeeded with the logo source down', async () => {
      /*
       * What a spent FMP quota actually looks like: the profile service asks the
       * secondary only for the logo, swallows its 429 into a reason code, and
       * returns a perfectly good profile with no logo attached.
       */
      mocks.getCompanyProfile.mockResolvedValue({
        data: profile('AEVA', null),
        reasonCode: 'PRIMARY_LOGO_MISSING; SECONDARY_RATE_LIMITED',
      });

      const first = await ensureInstrumentLogo('AEVA');
      expect(first.status).toBe('deferred');

      mocks.getCompanyProfile.mockResolvedValue({
        data: profile('AEVA', 'https://images.example.test/AEVA.png'),
        reasonCode: null,
      });
      const second = await ensureInstrumentLogo('AEVA');
      expect(second.logoUrl).toBe('https://images.example.test/AEVA.png');
      expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(2);
    });

    it('spares background renders while still letting a reader-driven add retry', async () => {
      mocks.getCompanyProfile.mockResolvedValue({
        data: profile('AEVA', null),
        reasonCode: 'PRIMARY_LOGO_MISSING; SECONDARY_RATE_LIMITED',
      });

      await ensureInstrumentLogo('AEVA');
      // A page render must not spend another call on a source that just failed.
      const render = await ensureInstrumentLogo('AEVA', { background: true });
      expect(render.status).toBe('deferred');
      expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);

      // The reader adding it to a list is an explicit act, and gets its own try.
      mocks.getCompanyProfile.mockResolvedValue({
        data: profile('AEVA', 'https://images.example.test/AEVA.png'),
        reasonCode: null,
      });
      const added = await ensureInstrumentLogo('AEVA');
      expect(added.logoUrl).toBe('https://images.example.test/AEVA.png');
      expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(2);

      // And once it resolves, background renders are no longer held back.
      resetInstrumentLogoMemory();
      mocks.getInstrumentMetadata.mockResolvedValue(
        master('AEVA', 'https://images.example.test/AEVA.png'),
      );
      const later = await ensureInstrumentLogo('AEVA', { background: true });
      expect(later.status).toBe('persisted');
    });

    it('still records a symbol both providers agree has no logo', async () => {
      mocks.getCompanyProfile.mockResolvedValue({
        data: profile('AEVA', null),
        reasonCode: 'PRIMARY_LOGO_MISSING; SECONDARY_LOGO_MISSING',
      });

      const first = await ensureInstrumentLogo('AEVA');
      await ensureInstrumentLogo('AEVA');

      expect(first.status).toBe('unavailable');
      expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);
    });

    it('never writes a null over a logo that is already stored', async () => {
      mocks.getInstrumentMetadata.mockResolvedValue(
        master('AEVA', 'https://images.example.test/AEVA.png'),
      );
      mocks.getCompanyProfile.mockResolvedValue({ data: profile('AEVA', null) });

      const ensured = await ensureInstrumentLogo('AEVA');

      expect(ensured.logoUrl).toBe('https://images.example.test/AEVA.png');
      expect(mocks.persistInstrumentLogos).not.toHaveBeenCalled();
    });
  });

  it('stops asking after a provider says the symbol simply has no logo', async () => {
    mocks.getCompanyProfile.mockResolvedValue({ data: profile('AEVA', null) });

    const first = await ensureInstrumentLogo('AEVA');
    const second = await ensureInstrumentLogo('AEVA');

    expect(first.status).toBe('unavailable');
    expect(second.status).toBe('unavailable');
    expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);
  });
});

describe('ensureInstrumentLogos', () => {
  it('is bounded: it considers at most `limit` symbols', async () => {
    mocks.getInstrumentMetadata.mockImplementation(async (symbols: string[]) =>
      master(symbols[0]!));
    mocks.getCompanyProfile.mockImplementation(async (symbol: string) => ({
      data: profile(symbol, `https://images.example.test/${symbol}.png`),
    }));

    const ensured = await ensureInstrumentLogos(
      ['A', 'B', 'C', 'D', 'E', 'F'].map((symbol) => ({ symbol })),
      { limit: 2, concurrency: 2 },
    );

    expect([...ensured.keys()]).toEqual(['A', 'B']);
    expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(2);
  });

  it('lets one slow symbol settle without holding up the rest', async () => {
    mocks.getInstrumentMetadata.mockImplementation(async (symbols: string[]) =>
      master(symbols[0]!));
    mocks.getCompanyProfile.mockImplementation(async (symbol: string) => {
      if (symbol === 'SLOW') throw new MarketDataError('timeout', 'provider timeout');
      return { data: profile(symbol, `https://images.example.test/${symbol}.png`) };
    });

    const ensured = await ensureInstrumentLogos(
      [{ symbol: 'SLOW' }, { symbol: 'FAST' }],
      { concurrency: 2 },
    );

    expect(ensured.get('SLOW')?.status).toBe('deferred');
    expect(ensured.get('FAST')?.logoUrl).toBe('https://images.example.test/FAST.png');
  });
});
