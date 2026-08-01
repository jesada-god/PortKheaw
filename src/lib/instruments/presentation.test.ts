import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyProfile } from '@/src/lib/market-data/types';
import type { InstrumentMetadata } from '@/src/lib/overview/types';

const mocks = vi.hoisted(() => ({
  getInstrumentMetadata: vi.fn(),
  getCompanyProfile: vi.fn(),
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

import {
  getInstrumentPresentationMetadata,
  resolveInstrumentPresentationMetadata,
} from './presentation';

function instrument(symbol: string): InstrumentMetadata {
  return {
    symbol,
    companyName: symbol,
    exchange: 'NASDAQ',
    assetType: 'Stock',
    currency: 'USD',
    sector: null,
    industry: null,
    websiteDomain: null,
    logoUrl: `https://master.example.test/${symbol}.png`,
    metadataSource: 'instrument-master',
    updatedAt: null,
  };
}

function profile(symbol: string): CompanyProfile {
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
    logoUrl: `https://profiles.example.test/${symbol}.png`,
    exchange: 'NASDAQ',
    latestQuarter: null,
  };
}

beforeEach(() => {
  mocks.getInstrumentMetadata.mockReset();
  mocks.getCompanyProfile.mockReset();
});

describe('instrument presentation metadata', () => {
  it('prefers the same company profile identity used by Stock Detail', () => {
    const resolved = resolveInstrumentPresentationMetadata(
      instrument('NVDA'),
      profile('NVDA'),
    );
    expect(resolved.companyName).toBe('NVDA Company');
    expect(resolved.logoUrl).toBe('https://profiles.example.test/NVDA.png');
  });

  it('isolates a failed logo lookup to one symbol', async () => {
    mocks.getInstrumentMetadata.mockResolvedValue(new Map([
      ['NVDA', instrument('NVDA')],
      ['ONDS', instrument('ONDS')],
    ]));
    mocks.getCompanyProfile.mockImplementation(async (symbol: string) => {
      if (symbol === 'ONDS') throw new Error('provider timeout');
      return { data: profile(symbol) };
    });

    const resolved = await getInstrumentPresentationMetadata(['NVDA', 'ONDS']);
    expect(resolved.get('NVDA')?.logoUrl)
      .toBe('https://profiles.example.test/NVDA.png');
    expect(resolved.get('ONDS')?.logoUrl)
      .toBe('https://master.example.test/ONDS.png');
  });
});
