// @vitest-environment jsdom

import React, { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyProfile, Quote } from '@/src/lib/market-data/types';
import { StockDetailClient } from './StockDetailClient';
import { clearAnalystTargetClientCacheForTests } from '@/src/components/analytics/analyst-target/AnalystTargetSection';

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
  extendedQuote: null,
  providerConfigured: true,
  initialWatched: true,
  technicalIndicatorsEnabled: false,
  advancedChartTypesEnabled: false,
  extendedIndicatorsEnabled: false,
  supportResistanceEnabled: false,
  keyStatisticsEnabled: false,
  analystConsensusEnabled: true,
  marketSignal: {
    status: 'available',
    signal: 'bullish',
    score: 37,
    confidence: 'High',
    confidencePct: 85,
    timeframe: '1D',
    calculatedAt: '2026-07-19T00:00:00.000Z',
    latestCandleAt: '2026-07-18',
    source: 'yahoo-finance-chart',
    freshness: { status: 'end-of-day', asOf: '2026-07-18T20:00:00.000Z', maxAgeSeconds: 21_600 },
    dataPoints: { received: 260, finalized: 259 },
    components: {
      trend: { score: 0.8, weight: 30, coverage: 1, factorsUsed: 6 },
      momentum: { score: 0.5, weight: 25, coverage: 1, factorsUsed: 3 },
      volume: { score: 0.4, weight: 20, coverage: 0.67, factorsUsed: 2 },
      structure: { score: 0.2, weight: 25, coverage: 0.67, factorsUsed: 2 },
    },
    reasons: [{ id: 'price-ema20', polarity: 'positive', text: 'ราคาอยู่เหนือ EMA20', impact: 1 }],
    indicators: {
      close: 51.23,
      ema20: 50,
      ema50: 48,
      ema200: 35,
      rsi14: 62,
      macd: 1.2,
      macdSignal: 1,
      macdHistogram: 0.2,
      relativeVolume20: 1.4,
      obvTrend: 'rising',
      adx14: 28,
      plusDi14: 31,
      minusDi14: 18,
      nearestSupport: 48,
      nearestResistance: 55,
    },
  },
};

const unavailableConsensus = {
  status: 'not-entitled',
  symbol: 'RKLB',
  currency: 'USD',
  currentPrice: 51.23,
  currentPriceAsOf: '2026-07-17T20:00:00.000Z',
  targetPrice: null,
  medianTarget: null,
  lowTarget: null,
  highTarget: null,
  analystCount: null,
  upsideDownsidePct: null,
  provider: null,
  providerLabel: null,
  lastUpdated: null,
  coverage: [
    {
      provider: 'finnhub',
      providerLabel: 'Finnhub',
      endpoint: 'stock/price-target',
      status: 'not-entitled',
      message: 'Finnhub: API plan ปัจจุบันไม่รองรับ Price Target',
      checkedAt: '2026-07-20T06:00:00.000Z',
    },
    {
      provider: 'alpha-vantage',
      providerLabel: 'Alpha Vantage',
      endpoint: 'OVERVIEW',
      status: 'unavailable',
      message: 'Alpha Vantage: ไม่พบ Analyst Target',
      checkedAt: '2026-07-20T06:00:00.000Z',
    },
  ],
  cachedAt: null,
  stale: false,
};

const availableConsensus = {
  ...unavailableConsensus,
  status: 'available',
  targetPrice: 55,
  medianTarget: 55,
  lowTarget: 50,
  highTarget: 60,
  analystCount: 18,
  upsideDownsidePct: 7.36,
  provider: 'finnhub',
  providerLabel: 'Finnhub',
  lastUpdated: '2026-07-18T00:00:00.000Z',
  cachedAt: '2026-07-20T06:00:00.000Z',
  coverage: [{
    provider: 'finnhub',
    providerLabel: 'Finnhub',
    endpoint: 'stock/price-target',
    status: 'available',
    message: 'Finnhub: ใช้งานได้',
    checkedAt: '2026-07-20T06:00:00.000Z',
  }],
};
const originalTimeZone = process.env.TZ;

function initialMarkup(): string {
  return renderToString(<StockDetailClient {...props} />);
}

beforeEach(() => {
  clearAnalystTargetClientCacheForTests();
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
      // The primary row carries the session's trading date only; the full
      // provider timestamp now lives behind the ⓘ control. A date-only quote is
      // rendered from `latestTradingDay` verbatim, so no host time zone can
      // shift it and server/client markup stays identical.
      expect(serverMarkup).toContain('17/07');
      expect(serverMarkup).not.toContain('17 ก.ค. 2569 00:00');
      expect(serverMarkup).not.toContain('Loading Analyst Consensus');
      expect(serverMarkup).not.toContain('Target Price');
      expect(serverMarkup).not.toContain('Market Signal');
      expect(serverMarkup).toContain('Open');
      expect(serverMarkup).toContain('High');
      expect(serverMarkup).toContain('Low');
      expect(serverMarkup).toContain('Prev Close');
      expect(serverMarkup).toContain('50.5');
      expect(serverMarkup).toContain('December');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('shows an em dash when accepted quote data has no previous close', () => {
    const markup = renderToString(
      <StockDetailClient
        {...props}
        quoteResource={{
          ...props.quoteResource,
          data: props.quoteResource.data
            ? { ...props.quoteResource.data, previousClose: null }
            : null,
        }}
      />,
    );
    const host = document.createElement('div');
    host.innerHTML = markup;
    const label = [...host.querySelectorAll('p')]
      .find((item) => item.textContent?.includes('Prev Close'));
    expect(label?.parentElement?.textContent).toContain('—');
  });

  it('hydrates RKLB without a React mismatch and hides unavailable provider internals', async () => {
    const recoverable: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: unavailableConsensus,
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
    const financials = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Financials');
    await act(async () => financials?.click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain('ยังไม่มีราคาเป้าหมายสำหรับหุ้นนี้');
    });
    expect(container.textContent).not.toMatch(/Finnhub|API plan|not-entitled|403|429/);
    expect(container.querySelector('section[aria-label="Technical Outlook"]')).not.toBeNull();

    expect(recoverable).toEqual([]);
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(
      /hydration|did not match|server rendered HTML/i,
    );

    await act(async () => root?.unmount());
    container.remove();
  });

  it('orders independent Target Price, Market Signal, and financial metrics cards', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: availableConsensus,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const container = document.createElement('div');
    document.body.append(container);
    container.innerHTML = initialMarkup();

    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(container, <StockDetailClient {...props} />);
    });
    const financials = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Financials');
    await act(async () => financials?.click());
    await vi.waitFor(() => {
      expect(container.textContent).toContain('$55.00');
      expect(container.textContent).toContain('Technical Outlook · Market Signal');
    });

    const targetCard = container.querySelector('section[aria-label="Target Price"]');
    const signalCard = container.querySelector('section[aria-label="Technical Outlook"]');
    expect(targetCard).not.toBeNull();
    expect(signalCard).not.toBeNull();
    expect(targetCard).not.toBe(signalCard);
    expect(targetCard?.compareDocumentPosition(signalCard!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(targetCard?.textContent).toContain('$55.00');
    expect(targetCard?.textContent).not.toContain('Score: +37');
    expect(signalCard?.textContent).toContain('Score: +37');
    expect(signalCard?.textContent).not.toContain('$55.00');

    const detailsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="รายละเอียดราคาเป้าหมาย"]',
    );
    expect(detailsButton).not.toBeNull();
    await act(async () => detailsButton?.click());

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Median Target');
    expect(dialog?.textContent).toContain('Analyst Count');
    expect(dialog?.textContent).not.toContain('ชื่อสถาบันรายตัว');

    await act(async () => root?.unmount());
    container.remove();
  });
});
