import { describe, expect, it } from 'vitest';
import dataset from '@/src/generated/instrument-classification.json';
import type { InstrumentClassification } from '@/src/lib/instruments/classification';
import { selectMarketBreadthUniverse } from './market-breadth-universe';

function instrument(
  symbol: string,
  overrides: Partial<InstrumentClassification> = {},
): InstrumentClassification {
  return {
    symbol,
    companyIdentity: symbol,
    companyName: symbol,
    exchange: 'NASDAQ',
    assetType: 'Stock',
    currency: 'USD',
    cik: symbol,
    sicCode: '3571',
    sicDescription: 'Electronic Computers',
    sectorKey: 'technology',
    sectorNameEn: 'Technology',
    sectorNameTh: 'เทคโนโลยี',
    industryKey: 'computer-hardware',
    industryNameEn: 'Computer Hardware',
    industryNameTh: 'ฮาร์ดแวร์คอมพิวเตอร์',
    stableSlug: 'computer-hardware',
    websiteDomain: null,
    logoUrl: null,
    metadataSource: 'test',
    taxonomyVersion: 'test',
    updatedAt: '2026-07-31T00:00:00.000Z',
    verdict: 'verified',
    confidence: 'high',
    rankingEligible: true,
    ...overrides,
  };
}

describe('market breadth universe', () => {
  it('contains at least 1,000 verified active US common stocks', () => {
    const universe = selectMarketBreadthUniverse(
      dataset.instruments as InstrumentClassification[],
    );
    expect(universe.length).toBeGreaterThanOrEqual(1_000);
    expect(new Set(universe.map((item) => item.symbol)).size).toBe(universe.length);
  });

  it('deduplicates symbols and excludes ETFs, warrants, OTC and inactive records', () => {
    const universe = selectMarketBreadthUniverse([
      instrument('AAPL'),
      instrument('aapl'),
      instrument('SPY', { assetType: 'ETF', verdict: 'excluded-asset', rankingEligible: false }),
      instrument('WARRANT', { verdict: 'excluded-entity', rankingEligible: false }),
      instrument('OTC', { exchange: 'OTC' }),
      instrument('OLD', { rankingEligible: false }),
      instrument('AMEX', { exchange: 'NYSE American' }),
    ]);
    expect(universe.map((item) => item.symbol)).toEqual(['AAPL', 'AMEX']);
  });
});
