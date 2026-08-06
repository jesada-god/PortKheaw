import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyProfile } from '@/src/lib/market-data/types';
import type { InstrumentMetadata } from '@/src/lib/overview/types';

const mocks = vi.hoisted(() => ({
  getInstrumentMetadata: vi.fn(),
  getCompanyProfile: vi.fn(),
  persistInstrumentLogos: vi.fn(),
  brokenUrls: new Set<string>(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./master', () => ({
  getInstrumentMetadata: mocks.getInstrumentMetadata,
}));
vi.mock('@/src/lib/market-data', () => ({
  getCompanyProfileService: () => ({
    getCompanyProfile: mocks.getCompanyProfile,
  }),
}));
vi.mock('./logo-store', () => ({
  persistInstrumentLogos: mocks.persistInstrumentLogos,
  isBrokenLogoUrl: (url: string | null | undefined) =>
    Boolean(url) && mocks.brokenUrls.has(url as string),
}));

import {
  getInstrumentPresentationMetadata,
  resetInstrumentLogoMemory,
  resolveInstrumentPresentationMetadata,
} from './presentation';

function instrument(
  symbol: string,
  logoUrl: string | null = `https://master.example.test/${symbol}.png`,
): InstrumentMetadata {
  return {
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
  };
}

function profile(symbol: string, logoUrl: string | null = `https://profiles.example.test/${symbol}.png`): CompanyProfile {
  return {
    symbol,
    name: `${symbol} Company`,
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
  mocks.getCompanyProfile.mockReset();
  mocks.persistInstrumentLogos.mockReset();
  mocks.persistInstrumentLogos.mockResolvedValue([]);
  mocks.brokenUrls.clear();
  resetInstrumentLogoMemory();
});

describe('resolveInstrumentPresentationMetadata', () => {
  it('keeps the persisted logo when a provider offers a different one', () => {
    const resolved = resolveInstrumentPresentationMetadata(
      instrument('NVDA'),
      profile('NVDA'),
    );
    expect(resolved.logoUrl).toBe('https://master.example.test/NVDA.png');
    expect(resolved.companyName).toBe('NVDA Company');
  });

  it('fills an empty logo from the provider', () => {
    const resolved = resolveInstrumentPresentationMetadata(
      instrument('NVDA', null),
      profile('NVDA'),
    );
    expect(resolved.logoUrl).toBe('https://profiles.example.test/NVDA.png');
  });

  it('never overwrites a working logo with null or an empty string', () => {
    for (const providerLogo of [null, '']) {
      const resolved = resolveInstrumentPresentationMetadata(
        instrument('NVDA'),
        profile('NVDA', providerLogo),
      );
      expect(resolved.logoUrl).toBe('https://master.example.test/NVDA.png');
    }
    const withoutProfile = resolveInstrumentPresentationMetadata(instrument('NVDA'), null);
    expect(withoutProfile.logoUrl).toBe('https://master.example.test/NVDA.png');
  });
});

describe('getInstrumentPresentationMetadata', () => {
  it('reuses a persisted logo without asking a provider at all', async () => {
    mocks.getInstrumentMetadata.mockResolvedValue(new Map([['NVDA', instrument('NVDA')]]));

    const resolved = await getInstrumentPresentationMetadata(['NVDA']);

    expect(resolved.get('NVDA')?.logoUrl).toBe('https://master.example.test/NVDA.png');
    expect(mocks.getCompanyProfile).not.toHaveBeenCalled();
    // Nothing was resolved, so nothing is written: a read is not a write.
    expect(mocks.persistInstrumentLogos).not.toHaveBeenCalled();
  });

  it('resolves a missing logo once, persists it, and reuses it on the next render', async () => {
    const master = new Map([['ONDS', instrument('ONDS', null)]]);
    mocks.getInstrumentMetadata.mockImplementation(async () => new Map(master));
    mocks.getCompanyProfile.mockResolvedValue({ data: profile('ONDS') });
    mocks.persistInstrumentLogos.mockImplementation(async (writes: Array<{ symbol: string; logoUrl: string }>) => {
      for (const write of writes) master.set(write.symbol, instrument(write.symbol, write.logoUrl));
      return writes.map((write) => write.symbol);
    });

    const first = await getInstrumentPresentationMetadata(['ONDS']);
    expect(first.get('ONDS')?.logoUrl).toBe('https://profiles.example.test/ONDS.png');
    expect(mocks.persistInstrumentLogos).toHaveBeenCalledWith([
      { symbol: 'ONDS', logoUrl: 'https://profiles.example.test/ONDS.png', persisted: null },
    ]);

    const second = await getInstrumentPresentationMetadata(['ONDS']);
    expect(second.get('ONDS')?.logoUrl).toBe('https://profiles.example.test/ONDS.png');
    // The whole point of persisting: the second render costs no provider request.
    expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);
  });

  it('asks a provider once for a symbol that has no logo anywhere', async () => {
    mocks.getInstrumentMetadata.mockResolvedValue(new Map([['XYZ', instrument('XYZ', null)]]));
    mocks.getCompanyProfile.mockResolvedValue({ data: profile('XYZ', null) });

    const first = await getInstrumentPresentationMetadata(['XYZ']);
    const second = await getInstrumentPresentationMetadata(['XYZ']);

    expect(first.get('XYZ')?.logoUrl).toBeNull();
    expect(second.get('XYZ')?.logoUrl).toBeNull();
    expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);
    // Nothing resolved, so nothing is written — an empty write is still a write.
    expect(mocks.persistInstrumentLogos).not.toHaveBeenCalled();
  });

  it('isolates a provider failure and still retries that symbol next time', async () => {
    mocks.getInstrumentMetadata.mockResolvedValue(new Map([
      ['NVDA', instrument('NVDA', null)],
      ['ONDS', instrument('ONDS', null)],
    ]));
    mocks.getCompanyProfile.mockImplementation(async (symbol: string) => {
      if (symbol === 'ONDS') throw new Error('provider timeout');
      return { data: profile(symbol) };
    });

    const resolved = await getInstrumentPresentationMetadata(['NVDA', 'ONDS']);
    expect(resolved.get('NVDA')?.logoUrl).toBe('https://profiles.example.test/NVDA.png');
    expect(resolved.get('ONDS')?.logoUrl).toBeNull();

    /*
     * An outage is not evidence that the company has no logo, so the symbol is
     * not written off — but a page render does not retry it immediately either,
     * or a busy site would spend the provider's daily quota on an outage. The
     * next render inside the deferral window costs nothing.
     */
    await getInstrumentPresentationMetadata(['ONDS']);
    expect(mocks.getCompanyProfile.mock.calls.filter(([symbol]) => symbol === 'ONDS'))
      .toHaveLength(1);
    expect(resolved.get('ONDS')?.logoUrl).toBeNull();
  });

  it('drops a URL reported broken, falls through, and does not store it again', async () => {
    mocks.brokenUrls.add('https://master.example.test/RKLB.png');
    mocks.getInstrumentMetadata.mockResolvedValue(new Map([['RKLB', instrument('RKLB')]]));
    mocks.getCompanyProfile.mockResolvedValue({
      data: profile('RKLB', 'https://master.example.test/RKLB.png'),
    });

    const resolved = await getInstrumentPresentationMetadata(['RKLB']);

    expect(resolved.get('RKLB')?.logoUrl).toBeNull();
    expect(mocks.persistInstrumentLogos).not.toHaveBeenCalled();
    // One attempt, not a retry loop: the failure is remembered until its TTL.
    await getInstrumentPresentationMetadata(['RKLB']);
    expect(mocks.getCompanyProfile).toHaveBeenCalledTimes(1);
  });

  it('uses the bundled mark for an overview proxy instead of a provider logo', async () => {
    mocks.getInstrumentMetadata.mockResolvedValue(new Map([
      ['SPY', instrument('SPY')],
      ['BTC-USD', instrument('BTC-USD', null)],
    ]));

    const resolved = await getInstrumentPresentationMetadata(['SPY', 'BTC-USD']);

    expect(resolved.get('SPY')?.logoUrl).toBe('/market-logos/spy.svg');
    expect(resolved.get('BTC-USD')?.logoUrl).toBe('/market-logos/btc.svg');
    expect(mocks.getCompanyProfile).not.toHaveBeenCalled();
  });
});
