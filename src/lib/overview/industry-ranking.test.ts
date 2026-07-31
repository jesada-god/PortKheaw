import { describe, expect, it } from 'vitest';
import {
  buildIndustryRanking,
  calculateMarketBreadth,
  rankIndustries,
  type IndustryQuoteCandidate,
} from './industry-ranking';
import type { OverviewPrice } from './types';

function price(
  symbol: string,
  changePercent: number | null,
  status: OverviewPrice['status'] = 'live',
): OverviewPrice {
  return {
    symbol,
    instrument: {
      symbol,
      companyName: symbol,
      exchange: 'NASDAQ',
      assetType: 'Stock',
      currency: 'USD',
      sector: 'Technology',
      industry: 'Semiconductors',
      websiteDomain: null,
      logoUrl: null,
      metadataSource: 'test-provider',
      updatedAt: '2026-07-31T14:00:00.000Z',
    },
    price: changePercent === null ? null : 100 + changePercent,
    currency: 'USD',
    change: changePercent,
    changePercent,
    session: 'REGULAR',
    sessionLabel: 'ตลาดเปิด',
    status,
    asOf: '2026-07-31T14:00:00.000Z',
    tradingDate: '2026-07-31',
    extended: null,
    freshness: {
      status: status === 'saved' ? 'stale' : 'realtime',
      asOf: '2026-07-31T14:00:00.000Z',
      maxAgeSeconds: 15,
    },
    sparkline: [],
  };
}

function candidate(
  symbol: string,
  changePercent: number | null,
  industry = 'Semiconductors',
  valid = true,
): IndustryQuoteCandidate {
  return {
    price: price(symbol, changePercent, valid ? 'live' : 'saved'),
    sector: 'Technology',
    industry,
    valid,
    volume: 1_000,
  };
}

describe('industry ranking', () => {
  it('groups every industry present in metadata instead of using a fixed category list', () => {
    const input = [
      ...Array.from({ length: 5 }, (_, index) => candidate(`S${index}`, index + 1)),
      ...Array.from({ length: 5 }, (_, index) => candidate(`B${index}`, -index, 'Biotechnology')),
      ...Array.from({ length: 5 }, (_, index) => candidate(`E${index}`, 0.5, 'Energy Equipment')),
    ];
    expect(buildIndustryRanking(input).map((group) => group.name)).toEqual([
      'Semiconductors',
      'Biotechnology',
      'Energy Equipment',
    ]);
  });

  it('requires at least five valid symbols and never counts missing data as zero percent', () => {
    const input = [
      candidate('A', 1),
      candidate('B', 2),
      candidate('C', 3),
      candidate('D', 4),
      candidate('E', null),
      candidate('F', 99, 'Semiconductors', false),
    ];
    expect(buildIndustryRanking(input)).toEqual([]);
    expect(buildIndustryRanking([...input, candidate('G', 5)])[0]).toMatchObject({
      validCount: 5,
      totalCount: 7,
      returnPercent: 3,
    });
  });

  it('uses an equal-weight average and calculates advancing breadth', () => {
    const group = buildIndustryRanking([
      candidate('A', 10),
      candidate('B', 0),
      candidate('C', -5),
      candidate('D', 5),
      candidate('E', 0),
    ])[0]!;
    expect(group.returnPercent).toBe(2);
    expect(group).toMatchObject({
      advancing: 2,
      declining: 1,
      unchanged: 2,
      breadthPercent: 40,
    });
  });

  it('excludes stale, unavailable and wrong-date candidates through the canonical verdict', () => {
    const input = [
      candidate('A', 1),
      candidate('B', 2),
      candidate('C', 3),
      candidate('D', 4),
      candidate('STALE', 100, 'Semiconductors', false),
      candidate('WRONGDATE', -100, 'Semiconductors', false),
      candidate('E', 5),
    ];
    const group = buildIndustryRanking(input)[0]!;
    expect(group.returnPercent).toBe(3);
    expect(group.validCount).toBe(5);
  });

  it('sorts gainers and losers in opposite directions with breadth then valid-count tie-breaks', () => {
    const groups = [
      {
        ...buildIndustryRanking(Array.from({ length: 5 }, (_, i) => candidate(`A${i}`, 2, 'Alpha')))[0]!,
        breadthPercent: 60,
      },
      {
        ...buildIndustryRanking(Array.from({ length: 6 }, (_, i) => candidate(`B${i}`, 2, 'Beta')))[0]!,
        breadthPercent: 80,
      },
      buildIndustryRanking(Array.from({ length: 5 }, (_, i) => candidate(`C${i}`, -3, 'Gamma')))[0]!,
    ];
    expect(rankIndustries(groups, 'gainers').map((group) => group.name)).toEqual([
      'Beta',
      'Alpha',
      'Gamma',
    ]);
    expect(rankIndustries(groups, 'losers').map((group) => group.name)).toEqual([
      'Gamma',
      'Alpha',
      'Beta',
    ]);
  });

  it('calculates market breadth only from candidates with a valid daily change', () => {
    const breadth = calculateMarketBreadth([
      candidate('A', 1),
      candidate('B', 2),
      candidate('C', -1),
      candidate('D', 0),
      candidate('BAD', 50, 'Semiconductors', false),
      candidate('MISSING', null),
    ]);
    expect(breadth).toMatchObject({
      advancing: 2,
      declining: 1,
      unchanged: 1,
      validCount: 4,
      upDownRatio: 2,
      aboveEma20Percent: null,
    });
  });
});
