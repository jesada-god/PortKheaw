// @vitest-environment jsdom

import React, { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyProfile, Quote } from '@/src/lib/market-data/types';
import { StockDetailClient } from './StockDetailClient';
import { clearAnalystTargetClientCacheForTests } from '@/src/components/analytics/analyst-target/AnalystTargetSection';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';

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
  instrumentLogoUrl: null,
  instrumentAssetType: 'Stock',
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
    symbol: 'RKLB',
    state: 'BULLISH',
    bias: 'bullish',
    score: 37,
    confidence: 72,
    confidenceLabel: 'Medium',
    evidenceAgreement: 72,
    evidenceAgreementLabel: 'Medium',
    timeframe: '1D',
    calculatedAt: '2026-07-19T00:00:00.000Z',
    latestCandleAt: '2026-07-18',
    source: 'yahoo-finance-chart',
    freshness: { status: 'end-of-day', asOf: '2026-07-18T20:00:00.000Z', maxAgeSeconds: 21_600 },
    dataPoints: { received: 260, finalized: 259 },
    scoreBreakdown: {
      emaTrend: { points: 15, maxPoints: 30, normalizedScore: 0.5, coverage: 1, factorsUsed: 4, available: true },
      momentum: { points: 10, maxPoints: 25, normalizedScore: 0.4, coverage: 1, factorsUsed: 3, available: true },
      trendStrength: { points: 5, maxPoints: 15, normalizedScore: 0.3333, coverage: 1, factorsUsed: 1, available: true },
      volume: { points: 4, maxPoints: 15, normalizedScore: 0.2667, coverage: 1, factorsUsed: 2, available: true },
      priceStructure: { points: 3, maxPoints: 15, normalizedScore: 0.2, coverage: 1, factorsUsed: 2, available: true },
    },
    reasons: [{ id: 'price-ema20', polarity: 'positive', text: 'ราคาอยู่เหนือ EMA20', impact: 1 }],
    warnings: [],
    flags: [],
    metrics: {
      close: 51.23,
      ema20: 50,
      ema50: 48,
      ema200: 35,
      ema20SlopePct: 0.8,
      ema50SlopePct: 0.5,
      ema200SlopePct: 0.2,
      emaCompressionRatio: 0.3,
      rsi14: 62,
      macd: 1.2,
      macdSignal: 1,
      macdHistogram: 0.2,
      histogramExpanding: true,
      adx14: 28,
      plusDi14: 31,
      minusDi14: 18,
      relativeVolume20: 1.4,
      obvTrend: 'rising',
      bollingerUpper: 54,
      bollingerMiddle: 50,
      bollingerLower: 46,
      keltnerUpper: 53,
      keltnerMiddle: 50,
      keltnerLower: 47,
      squeezeOn: false,
      atr14: 2,
      ema20DeviationPct: 2.46,
      atrNormalizedDistance: 0.615,
      nearestSupport: 48,
      nearestResistance: 55,
      divergence: null,
    },
    confidenceBreakdown: { completeness: 100, agreement: 80, evidenceStrength: 37, volumeConfirmation: 27, regimeClarity: 62, conflictPenalty: 0 },
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
  return renderToString(stockDetailTree());
}

function stockDetailTree() {
  return (
    <EntitlementProvider tier="elite" authenticated trialOffer="used">
      <StockDetailClient {...props} />
    </EntitlementProvider>
  );
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
      expect(serverMarkup).toContain('ราคาเปิด');
      expect(serverMarkup).toContain('สูงสุดวันนี้');
      expect(serverMarkup).toContain('ต่ำสุดวันนี้');
      expect(serverMarkup).toContain('ราคาปิดก่อนหน้า');
      expect(serverMarkup).toContain('50.5');
      expect(serverMarkup).toContain('ธันวาคม');
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
    const card = host.querySelector('[data-metric="ราคาปิดก่อนหน้า"]');
    expect(card?.textContent).toContain('—');
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
        stockDetailTree(),
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
      root = hydrateRoot(container, stockDetailTree());
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
    /* The signal card's own content, named by what its beginner layer carries.
       The score moved behind `ดูรายละเอียดการคำนวณ` — a figure that has to ship
       with a warning against reading it as a percentage does not belong on a
       ten-second read — so this asserts the line that replaced it: the Thai
       gloss now set beside the state name rather than under it. */
    expect(signalCard?.textContent).toContain('BULLISH');
    expect(signalCard?.textContent).toContain('กำลังเป็นขาขึ้น');
    expect(signalCard?.textContent).toContain('หลักฐานไปทางเดียวกันบ้าง');
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

/**
 * The Overview tab tells the reader WHAT a number is and WHEN it was taken —
 * never which vendor sold it, and never only on hover.
 */
describe('Stock Detail overview provenance and metric hints', () => {
  it('dates the fundamental footnote without naming a provider', () => {
    const markup = initialMarkup();

    expect(markup).toContain('ข้อมูลพื้นฐาน · ');
    // The profile resource is served by alpha-vantage; the reader is not told so.
    expect(markup).not.toContain('Alpha Vantage');
    expect(markup).not.toContain('Financial Modeling Prep');
    expect(markup).not.toContain('ไม่ทราบแหล่งข้อมูล');
    // The company card keeps its freshness word and as-of, minus the vendor.
    expect(markup).toContain('ข้อมูลแคช');
    expect(markup).not.toContain('ไม่ทราบผู้ให้บริการ');
    // The provider itself is untouched in the data and still readable for support.
    expect(markup).toContain('data-profile-provider="alpha-vantage"');
  });

  it('opens a metric explanation by click, by keyboard, and closes it again', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    container.innerHTML = initialMarkup();
    let root: Root | undefined;
    await act(async () => { root = hydrateRoot(container, stockDetailTree()); });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-metric="สูงสุดวันนี้"] button[data-testid="metric-hint-สูงสุดวันนี้"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    // Tap/click — the only gesture available on a touch screen, where the old
    // hover-only `title` said nothing at all.
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="dialog"]')?.textContent)
      .toContain('ราคาสูงสุดที่ซื้อขายกันในวันนี้ (High)');

    // Pressing the trigger again closes it.
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    // Keyboard: a real <button> turns Enter/Space into the same click.
    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      trigger?.click();
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    // A press outside the trigger and its panel dismisses.
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => root?.unmount());
    container.remove();
  });
});
