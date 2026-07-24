// @vitest-environment jsdom

import React, { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyProfile, Quote } from '@/src/lib/market-data/types';
import { StockDetailClient } from './StockDetailClient';

vi.stubGlobal('React', React);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/app/watchlist/actions', () => ({
  addWatchlistItemAction: vi.fn(),
  removeWatchlistItemAction: vi.fn(),
}));

const quote: Quote = {
  symbol: 'RKLB',
  price: 51.23,
  open: 50,
  high: 52,
  low: 49,
  previousClose: 50.5,
  change: 0.73,
  changePercent: 1.45,
  volume: 1_000_000,
  latestTradingDay: '2026-07-17',
  currency: 'USD',
};
const profile: CompanyProfile = {
  symbol: 'RKLB',
  name: 'Rocket Lab USA, Inc.',
  description: null,
  exchange: 'NASDAQ',
  currency: 'USD',
  country: 'USA',
  sector: 'Industrials',
  industry: 'Aerospace & Defense',
  website: 'https://www.rocketlabusa.com/',
  marketCapitalization: 20_000_000_000,
  employees: 2_100,
  fiscalYearEnd: 'December',
  latestQuarter: '2026-06-30',
};

const props: React.ComponentProps<typeof StockDetailClient> = {
  symbol: 'RKLB',
  quoteResource: {
    data: quote,
    freshness: {
      status: 'end-of-day',
      asOf: null,
      maxAgeSeconds: 86_400,
    },
    provider: 'alpha-vantage',
    reason: null,
    error: null,
    fallbackLabel: null,
  },
  profileResource: {
    data: profile,
    freshness: {
      status: 'cached',
      asOf: '2026-06-30T00:00:00.000Z',
      cachedAt: '2026-07-20T04:00:00.000Z',
      maxAgeSeconds: 86_400,
    },
    provider: 'alpha-vantage',
    reason: null,
    error: null,
  },
  overviewResource: {
    data: {
      markets: [{
        marketType: 'Equity',
        region: 'United States',
        primaryExchanges: ['NASDAQ'],
        localOpen: '09:30',
        localClose: '16:00',
        currentStatus: 'closed',
        notes: null,
      }],
    },
    freshness: {
      status: 'cached',
      asOf: '2026-07-20T04:00:00.000Z',
      maxAgeSeconds: 60,
    },
    provider: 'alpha-vantage',
    reason: null,
    error: null,
  },
  instrumentName: 'Rocket Lab USA, Inc.',
  instrumentCurrency: 'USD',
  instrumentExchange: 'NASDAQ',
  initialHistory: {
    data: null,
    meta: {
      provider: null,
      timestamp: '2026-07-20T06:00:00.000Z',
      freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
    },
  },
  fxQuote: null,
  evaluatedAt: '2026-07-20T06:00:00.000Z',
  providerConfigured: true,
  initialWatched: true,
  technicalIndicatorsEnabled: false,
  advancedChartTypesEnabled: false,
  extendedIndicatorsEnabled: false,
  supportResistanceEnabled: false,
  keyStatisticsEnabled: false,
  fairValueEnabled: true,
};

const unavailableFairValue = {
  status: 'unavailable',
  failureKind: 'provider-unavailable',
  symbol: 'RKLB',
  currency: 'USD',
  provider: 'alpha-vantage',
  reason: 'Provider has no complete financial statements for RKLB.',
  missingFields: ['historicalFinancials>=3Periods'],
  missingInputs: ['historicalFinancials>=3Periods'],
  staleInputs: [],
  asOf: '2026-07-17',
  calculatedAt: '2026-07-20T06:00:00.000Z',
  methodologyVersion: 'nexora-fv-v2',
  limitations: ['No data is fabricated.'],
};
const originalTimeZone = process.env.TZ;

function initialMarkup(): string {
  return renderToString(<StockDetailClient {...props} />);
}

beforeEach(() => {
  vi.stubGlobal('React', React);
});

afterEach(() => {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Stock Detail hydration regression', () => {
  it('produces identical RKLB server/client initial markup across host time zones', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const serverMarkup = initialMarkup();
      process.env.TZ = 'America/New_York';
      const clientInitialMarkup = initialMarkup();

      expect(clientInitialMarkup).toBe(serverMarkup);
      expect(serverMarkup).toContain('ข้อมูล ณ 17 ก.ค. 2569');
      expect(serverMarkup).not.toContain('17 ก.ค. 2569 00:00');
      expect(serverMarkup).toContain('Loading Fair Value…');
      expect(serverMarkup).toContain('December');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('hydrates RKLB without a React mismatch and then shows the unavailable reason', async () => {
    const recoverable: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: unavailableFairValue,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const container = document.createElement('div');
    document.body.append(container);

    process.env.TZ = 'UTC';
    container.innerHTML = initialMarkup();
    process.env.TZ = 'America/New_York';
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(
        container,
        <StockDetailClient {...props} />,
        { onRecoverableError: (error) => recoverable.push(error) },
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Provider data unavailable');
      expect(container.textContent).toContain(
        'Provider has no complete financial statements for RKLB.',
      );
    });

    expect(recoverable).toEqual([]);
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(
      /hydration|did not match|server rendered HTML/i,
    );

    await act(async () => root?.unmount());
    container.remove();
  });
});
