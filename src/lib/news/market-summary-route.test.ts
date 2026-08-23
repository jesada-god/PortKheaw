import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { InMemoryNewsCache } from './cache-double';
import { handleMarketNewsSummaryRequest } from './market-summary-route';
import { NewsProviderError } from './provider';
import { NEWS_MARKET_RAW_KEY, NEWS_RAW_TTL_SECONDS } from './summary-feed';
import type { NewsArticle, NewsProvider, NewsProviderResult } from './types';

const NOW = new Date('2026-08-23T09:00:00.000Z');

/** Reads as market-wide to `selectMarketWideNews`: a macro subject and a market subject. */
function macroArticle(index: number): NewsArticle {
  return {
    id: `macro-${index}`,
    title: `Federal Reserve rate decision moves global markets ${index}`,
    source: 'Example Wire',
    publishedAt: new Date(Date.UTC(2026, 7, 23, 8 - index)).toISOString(),
    url: `https://publisher.com/macro-${index}`,
    imageUrl: null,
    summary: 'Inflation data leaves the S&P 500 and treasury yields waiting on the FOMC.',
    symbols: [],
  };
}

/** A single-company story the dashboard block excludes. */
const COMPANY_ARTICLE: NewsArticle = {
  id: 'company-1',
  title: 'Acme announces a contract win',
  source: 'Example Wire',
  publishedAt: new Date(Date.UTC(2026, 7, 23, 8)).toISOString(),
  url: 'https://publisher.com/company-1',
  imageUrl: null,
  summary: 'Acme signed a partnership agreement.',
  symbols: ['ACME'],
};

const ARTICLES = [macroArticle(0), macroArticle(1), macroArticle(2), COMPANY_ARTICLE];

function providerReturning(articles: NewsArticle[], onCall?: () => void): NewsProvider {
  const result: NewsProviderResult = {
    data: { articles, nextCursor: null },
    status: 'live',
    asOf: NOW.toISOString(),
  };
  return {
    id: 'newsapi',
    getMarketNews: async () => { onCall?.(); return result; },
    getSymbolNews: async () => result,
  };
}

const noCache = { getCache: () => null, geminiApiKey: undefined, now: () => NOW };

describe('handleMarketNewsSummaryRequest', () => {
  it('answers with a null summary — not an error — when the cache is not configured', async () => {
    const response = await handleMarketNewsSummaryRequest({
      ...noCache,
      getProvider: () => providerReturning(ARTICLES),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary).toBeNull();
    expect(body.error).toBeNull();
    expect(body.asOf).toBe(NOW.toISOString());
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=60');
  });

  it('sends no articles — the dashboard already has the feed this summarises', async () => {
    const response = await handleMarketNewsSummaryRequest({
      ...noCache,
      getProvider: () => providerReturning(ARTICLES),
    });

    expect(Object.keys(await response.json()).sort()).toEqual(['asOf', 'error', 'summary']);
  });

  it('caches the market feed under one key so a second reader costs no provider quota', async () => {
    const cache = new InMemoryNewsCache(() => NOW.valueOf());
    const getMarketNews = vi.fn();
    const deps = {
      ...noCache,
      getCache: () => cache,
      getProvider: () => providerReturning(ARTICLES, getMarketNews),
    };

    await handleMarketNewsSummaryRequest(deps);
    await handleMarketNewsSummaryRequest(deps);

    expect(getMarketNews).toHaveBeenCalledTimes(1);
    expect(cache.has(NEWS_MARKET_RAW_KEY)).toBe(true);
  });

  it('goes back to the provider once the raw window has passed', async () => {
    let clock = NOW.valueOf();
    const cache = new InMemoryNewsCache(() => clock);
    const getMarketNews = vi.fn();
    const deps = {
      ...noCache,
      getCache: () => cache,
      getProvider: () => providerReturning(ARTICLES, getMarketNews),
    };

    await handleMarketNewsSummaryRequest(deps);
    clock += (NEWS_RAW_TTL_SECONDS + 1) * 1000;
    await handleMarketNewsSummaryRequest(deps);

    expect(getMarketNews).toHaveBeenCalledTimes(2);
  });

  it('summarises the market-wide selection, not the raw provider feed', async () => {
    const cache = new InMemoryNewsCache(() => NOW.valueOf());
    await handleMarketNewsSummaryRequest({
      ...noCache,
      getCache: () => cache,
      getProvider: () => providerReturning(ARTICLES),
    });

    const cached = await cache.get<{ articles: NewsArticle[] }>(NEWS_MARKET_RAW_KEY);
    // The single-company story is filtered out before it can reach a fingerprint
    // or a prompt — the card describes the same stories the block renders.
    expect(cached?.articles.map((item) => item.id)).toEqual(['macro-0', 'macro-1', 'macro-2']);
  });

  it('reports a provider failure with its own status and forbids caching it', async () => {
    const response = await handleMarketNewsSummaryRequest({
      ...noCache,
      getProvider: () => ({
        ...providerReturning(ARTICLES),
        getMarketNews: async () => {
          throw new NewsProviderError('NEWS_PROVIDER_RATE_LIMITED', 'rate limited', 60);
        },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.summary).toBeNull();
    expect(body.error.code).toBe('NEWS_PROVIDER_RATE_LIMITED');
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
