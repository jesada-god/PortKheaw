import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CompanyProfile, MarketDataApiError, Quote } from '@/src/lib/market-data/types';
import { CompanyProfileCard } from './CompanyProfileCard';
import { buildStockPriceHeaderModel } from './price-header';
import { StockPriceHeader } from './StockPriceHeader';

vi.stubGlobal('React', React);

const unavailableFreshness = {
  status: 'unavailable' as const,
  asOf: null,
  maxAgeSeconds: null,
};

const rateLimitedProfile: MarketDataApiError = {
  code: 'rate-limited',
  message: 'Profile quota exceeded',
  retryable: true,
  retryAfterSeconds: 30,
};

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

describe('Stock Detail unavailable UX', () => {
  it('deduplicates Profile errors and keeps missing fields non-technical', () => {
    const html = renderToStaticMarkup(
      <CompanyProfileCard
        symbol="RKLB"
        profile={null}
        freshness={unavailableFreshness}
        provider={null}
        error={rateLimitedProfile}
        loading={false}
        retryAt={0}
        onRetry={vi.fn()}
      />,
    );

    expect(occurrences(html, 'Company profile is temporarily unavailable')).toBe(1);
    expect(occurrences(
      html,
      'The data provider rate limit was reached. Please try again later.',
    )).toBe(1);
    expect(occurrences(html, 'ยังไม่มีรายละเอียดบริษัทสำหรับแปล')).toBe(1);
    expect(occurrences(html, 'Unavailable')).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain('rate-limited');
    expect(html).not.toContain('Profile quota exceeded');
  });

  it('disables Thai translation when no source description exists', () => {
    const html = renderToStaticMarkup(
      <CompanyProfileCard
        symbol="RKLB"
        profile={null}
        freshness={unavailableFreshness}
        provider={null}
        error={null}
        loading={false}
        retryAt={0}
        onRetry={vi.fn()}
      />,
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('title="ยังไม่มีข้อความต้นฉบับสำหรับแปล"');
    expect(html).toContain('ยังไม่มีรายละเอียดบริษัทสำหรับแปล');
  });

  it('disables Profile Retry while the provider cooldown is active', () => {
    const html = renderToStaticMarkup(
      <CompanyProfileCard
        symbol="RKLB"
        profile={null}
        freshness={unavailableFreshness}
        provider={null}
        error={rateLimitedProfile}
        loading={false}
        retryAt={Date.now() + 30_000}
        onRetry={vi.fn()}
        language="en"
      />,
    );

    expect(html).toMatch(
      /<button type="button" disabled=""[^>]*>Wait for the retry period, then try again<\/button>/,
    );
  });

  it('shows a cached Profile after a provider rate limit with status and timestamp', () => {
    const cachedProfile: CompanyProfile = {
      symbol: 'RKLB',
      name: 'Rocket Lab USA, Inc.',
      description: 'Rocket Lab provides launch services.',
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
    const html = renderToStaticMarkup(
      <CompanyProfileCard
        symbol="RKLB"
        profile={cachedProfile}
        freshness={{
          status: 'stale',
          asOf: '2026-06-30T00:00:00.000Z',
          cachedAt: '2026-07-19T08:30:00.000Z',
          maxAgeSeconds: 86_400,
        }}
        provider="alpha-vantage"
        error={null}
        loading={false}
        retryAt={0}
        onRetry={vi.fn()}
        language="en"
      />,
    );

    expect(html).toContain('Rocket Lab provides launch services.');
    expect(html).toContain('Stale · alpha-vantage');
    expect(html).toContain('19 ก.ค. 2569 15:30');
    expect(html).not.toContain('Company profile is temporarily unavailable');
  });

  it('shows secondary Profile data normally with a fallback-source badge', () => {
    const fallbackProfile: CompanyProfile = {
      symbol: 'RKLB',
      name: 'Rocket Lab USA, Inc.',
      description: 'Rocket Lab provides launch services.',
      exchange: 'NASDAQ',
      currency: 'USD',
      country: 'US',
      sector: 'Industrials',
      industry: 'Aerospace & Defense',
      website: null,
      marketCapitalization: null,
      employees: null,
      fiscalYearEnd: null,
      latestQuarter: null,
    };
    const html = renderToStaticMarkup(
      <CompanyProfileCard
        symbol="RKLB"
        profile={fallbackProfile}
        freshness={{
          status: 'cached',
          asOf: null,
          cachedAt: '2026-07-20T00:00:00.000Z',
          maxAgeSeconds: 86_400,
        }}
        provider="financial-modeling-prep"
        fallbackUsed
        error={null}
        loading={false}
        retryAt={0}
        onRetry={vi.fn()}
        language="en"
      />,
    );

    expect(html).toContain('Rocket Lab provides launch services.');
    expect(html).toContain('Fallback source');
    expect(html).toContain('financial-modeling-prep');
    expect(html).not.toContain('Company profile is temporarily unavailable');
  });

  it('switches every Profile card label between Thai and English', () => {
    const localizedProfile: CompanyProfile = {
      symbol: 'RKLB',
      name: 'Rocket Lab USA, Inc.',
      description: 'Rocket Lab provides launch services.',
      exchange: 'NASDAQ',
      currency: 'USD',
      country: 'USA',
      sector: 'Industrials',
      industry: 'Aerospace & Defense',
      website: null,
      marketCapitalization: null,
      employees: null,
      fiscalYearEnd: null,
      latestQuarter: null,
    };
    const baseProps = {
      symbol: 'RKLB',
      profile: localizedProfile,
      freshness: {
        status: 'cached' as const,
        asOf: '2026-07-19T00:00:00.000Z',
        maxAgeSeconds: 86_400,
      },
      provider: 'alpha-vantage',
      error: null,
      loading: false,
      retryAt: 0,
      onRetry: vi.fn(),
    };
    const thai = renderToStaticMarkup(
      <CompanyProfileCard {...baseProps} language="th" />,
    );
    const english = renderToStaticMarkup(
      <CompanyProfileCard {...baseProps} language="en" />,
    );

    for (const label of ['ข้อมูลบริษัท', 'ประเทศ', 'จำนวนพนักงาน', 'สกุลเงิน', 'สิ้นสุดปีบัญชี', 'ไม่พร้อมใช้งาน']) {
      expect(thai).toContain(label);
    }
    for (const label of ['Company Profile', 'Country', 'Employees', 'Currency', 'Fiscal year end', 'Unavailable']) {
      expect(english).toContain(label);
    }
    for (const thaiLabel of ['ข้อมูลบริษัท', 'ประเทศ', 'จำนวนพนักงาน', 'สกุลเงิน', 'สิ้นสุดปีบัญชี']) {
      expect(english).not.toContain(thaiLabel);
    }
  });

  it('shows the fallback price and session date, keeping fallback/debug wording out of the primary row', () => {
    const quote: Quote = {
      symbol: 'RKLB',
      price: 42,
      open: 40,
      high: 43,
      low: 39,
      previousClose: null,
      change: null,
      changePercent: null,
      volume: 1_000,
      latestTradingDay: '2026-07-17',
      currency: null,
    };
    const html = renderToStaticMarkup(
      <StockPriceHeader
        symbol="RKLB"
        exchange="NASDAQ"
        sourceCurrency="USD"
        model={buildStockPriceHeaderModel({
          data: {
            quote,
            freshness: {
              status: 'end-of-day',
              asOf: '2026-07-17T00:00:00.000Z',
              maxAgeSeconds: 86_400,
            },
            provider: 'nasdaq',
            fallbackLabel: 'Previous trading day',
            extendedQuote: null,
          },
          // The market-status provider could not be verified at all.
          currentSession: 'UNKNOWN',
          currentSessionEvaluatedAt: '2026-07-18T00:00:00.000Z',
          currentSessionSource: 'unresolved',
        })}
        providerConfigured
        quoteError={{
          code: 'rate-limited',
          message: 'Quote quota exceeded',
          retryable: true,
        }}
        quoteLoading={false}
        quoteRetryAt={0}
        onRetryQuote={vi.fn()}
        fxQuote={null}
        evaluatedAt="2026-07-18T00:00:00.000Z"
      />,
    );

    expect(html).toContain('42.00');
    expect(html).toContain('USD');
    // The trading date is exchange-local: 2026-07-17T00:00Z is still 16 July in
    // New York, and the session label must name the session, not the reader's day.
    expect(html).toContain('16/07');
    expect(html).not.toContain('rate-limited');
    expect(html).not.toContain('Quote quota exceeded');
    expect(html).not.toContain('Unavailable');
    expect(html).not.toContain('ไม่พบข้อมูล');
    expect(occurrences(html, 'ไม่ทราบสถานะตลาด')).toBe(1);
    // Provenance belongs behind the ⓘ control, never in the price hierarchy.
    expect(html).not.toContain('ข้อมูลจากวันซื้อขายก่อนหน้า');
    expect(html).not.toContain('ราคาปิด intraday ล่าสุด');
    expect(html).not.toContain('nasdaq');
  });
});
