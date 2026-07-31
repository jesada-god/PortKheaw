import { describe, expect, it } from 'vitest';
import dataset from '@/src/generated/instrument-classification.json';
import {
  SIC_TAXONOMY_VERSION,
  classifySic,
  isExcludedSecurityName,
} from './classification';

const bySymbol = new Map(dataset.instruments.map((item) => [item.symbol, item]));

describe('SEC instrument classification dataset', () => {
  it('classifies required operating-company examples from verified SIC data', () => {
    expect(bySymbol.get('AAPL')).toMatchObject({
      cik: '0000320193',
      sicCode: '3571',
      industryKey: 'computer-hardware',
      verdict: 'verified',
    });
    expect(bySymbol.get('NVDA')).toMatchObject({
      sicCode: '3674',
      industryKey: 'semiconductors',
      rankingEligible: true,
    });
    expect(bySymbol.get('NVTS')).toMatchObject({ industryKey: 'semiconductors' });
    expect(bySymbol.get('RKLB')).toMatchObject({ industryKey: 'aerospace-and-defense' });
    expect(bySymbol.get('ONDS')).toMatchObject({ industryKey: 'communication-equipment' });
  });

  it('excludes ETFs and de-duplicates share classes by SEC company identity', () => {
    expect(bySymbol.get('SPY')).toMatchObject({
      assetType: 'ETF',
      verdict: 'excluded-asset',
      rankingEligible: false,
    });
    const alphabet = [bySymbol.get('GOOG'), bySymbol.get('GOOGL')];
    expect(new Set(alphabet.map((item) => item?.companyIdentity)).size).toBe(1);
    expect(alphabet.filter((item) => item?.rankingEligible)).toHaveLength(1);
    const berkshire = [bySymbol.get('BRK.A'), bySymbol.get('BRK.B')];
    expect(new Set(berkshire.map((item) => item?.companyIdentity)).size).toBe(1);
    expect(berkshire.filter((item) => item?.rankingEligible)).toHaveLength(1);
  });

  it('leaves unmatched stocks unknown instead of inferring from their name', () => {
    expect(bySymbol.get('BETR')).toMatchObject({
      cik: null,
      sicCode: null,
      industryKey: null,
      verdict: 'unknown',
      confidence: 'none',
    });
  });

  it('uses the static versioned Thai taxonomy and explicit security exclusions', () => {
    expect(dataset.taxonomyVersion).toBe(SIC_TAXONOMY_VERSION);
    expect(classifySic('3674')).toMatchObject({
      industryKey: 'semiconductors',
      industryNameTh: 'เซมิคอนดักเตอร์',
    });
    expect(classifySic('9999')).toBeNull();
    expect(isExcludedSecurityName('Example Corp Warrants')).toBe(true);
    expect(isExcludedSecurityName('Example Corp Units')).toBe(true);
    expect(isExcludedSecurityName('Example Corp Preferred Stock')).toBe(true);
    expect(isExcludedSecurityName('Example Corp American Depositary Shares')).toBe(false);
  });

  it('meets measured source and classification coverage', () => {
    expect(dataset.coverage.instrumentCount).toBe(12_506);
    expect(dataset.coverage.stockCount).toBe(6_957);
    expect(dataset.coverage.secTickerMatches).toBeGreaterThanOrEqual(6_950);
    expect(dataset.coverage.verifiedClassifications).toBeGreaterThan(4_000);
    expect(dataset.source.submissionsSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
