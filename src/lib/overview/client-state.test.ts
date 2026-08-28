import { describe, expect, it } from 'vitest';
import { applyOverviewSectionUpdate } from './client-state';
import type { OverviewDashboardData } from './types';

const base = {
  generatedAt: 'old',
  serviceStatus: { level: 'ready', label: 'ready', checkedAt: 'old', affected: [] },
  portfolio: {
    authenticated: false,
    portfolioCount: 0,
    totalPortfolioCount: 0,
    portfolioName: null,
    summary: null,
    baseCurrency: 'USD',
    targetValueUsd: null,
    targetDate: null,
    valuedAt: null,
    todayExchangeDate: null,
    coverage: null,
    portfolios: [],
  },
  usdThbRate: null,
  indices: [],
  industries: [],
  watchlist: [],
  breadth: null,
  industryData: {
    state: 'refreshing',
    classificationUpdatedAt: '2026-07-31T00:00:00.000Z',
    quotesUpdatedAt: null,
    candidateCount: 0,
    completedCount: 0,
    deadlineReached: false,
  },
  newsContext: { portfolioSymbols: [], watchlistSymbols: [], industryNames: [] },
  limitations: [],
} satisfies OverviewDashboardData;

describe('overview section retry isolation', () => {
  it('updates only the requested section and preserves last-good siblings', () => {
    const indices = [{ symbol: 'SPY' }] as OverviewDashboardData['indices'];
    const current = { ...base, indices };
    const next = applyOverviewSectionUpdate(current, 'breadth', {
      advancing: 2,
      declining: 1,
      unchanged: 0,
      validCount: 3,
      universeCount: 3,
      returnedCount: 3,
      failedCount: 0,
      staleCount: 0,
      upDownRatio: 2,
      breadthPercent: 2 / 3 * 100,
      coveragePercent: 100,
      aboveEma20Percent: null,
      updatedAt: 'new',
      evaluatedAt: 'new',
      durationMs: 10,
      tradingDate: '2026-07-31',
      session: 'regular',
      source: 'alpaca-multi-snapshot',
      feed: 'delayed_sip',
      status: 'partial',
      universeDescription: 'test',
    }, 'new');
    expect(next.indices).toBe(indices);
    expect(next.breadth?.validCount).toBe(3);
    expect(next.generatedAt).toBe('new');
  });

  it('hydrates Industry and Breadth together without reloading sibling sections', () => {
    const indices = [{ symbol: 'SPY' }] as OverviewDashboardData['indices'];
    const industries = (
      [{ slug: 'semiconductors', name: 'Semiconductors' }]
    ) as OverviewDashboardData['industries'];
    const next = applyOverviewSectionUpdate(
      { ...base, indices },
      'industries',
      industries,
      'new',
      {
        breadth: {
          advancing: 8,
          declining: 3,
          unchanged: 1,
          validCount: 12,
          universeCount: 12,
          returnedCount: 12,
          failedCount: 0,
          staleCount: 0,
          upDownRatio: 8 / 3,
          breadthPercent: 8 / 12 * 100,
          coveragePercent: 100,
          aboveEma20Percent: null,
          updatedAt: 'new',
          evaluatedAt: 'new',
          durationMs: 10,
          tradingDate: '2026-07-31',
          session: 'regular',
          source: 'alpaca-multi-snapshot',
          feed: 'delayed_sip',
          status: 'partial',
          universeDescription: 'test',
        },
        industryData: {
          ...base.industryData,
          state: 'ready',
          quotesUpdatedAt: 'new',
          candidateCount: 285,
          completedCount: 282,
        },
      },
    );
    expect(next.indices).toBe(indices);
    expect(next.industries).toBe(industries);
    expect(next.breadth?.validCount).toBe(12);
    expect(next.industryData).toMatchObject({
      state: 'ready',
      quotesUpdatedAt: 'new',
      completedCount: 282,
    });
  });
});
