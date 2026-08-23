import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { InMemoryNewsCache } from './cache-double';
import { NewsProviderError } from './provider';
import { NEWS_RAW_TTL_SECONDS, handleNewsSummaryRequest, newsRawKey } from './summary-route';
import type { NewsArticle, NewsProvider, NewsProviderResult } from './types';

const NOW = new Date('2026-08-23T09:00:00.000Z');

function article(index: number): NewsArticle {
  return {
    id: `article-${index}`,
    title: `Headline ${index}`,
    source: 'Example Wire',
    publishedAt: new Date(Date.UTC(2026, 7, 23, 8 - index)).toISOString(),
    url: `https://publisher.com/story-${index}`,
    imageUrl: null,
    summary: `Body ${index}`,
    symbols: ['AAPL'],
  };
}

const ARTICLES = [article(0), article(1), article(2), article(3)];

function providerReturning(articles: NewsArticle[], onCall?: () => void): NewsProvider {
  const result: NewsProviderResult = {
    data: { articles, nextCursor: null },
    status: 'live',
    asOf: NOW.toISOString(),
  };
  return {
    id: 'newsapi',
    getMarketNews: async () => result,
    getSymbolNews: async () => { onCall?.(); return result; },
  };
}

const noCache = { getCache: () => null, geminiApiKey: undefined, now: () => NOW };

describe('handleNewsSummaryRequest', () => {
  it('rejects a symbol that is not a symbol without calling the provider', async () => {
    const getSymbolNews = vi.fn();
    const response = await handleNewsSummaryRequest('../etc/passwd', {
      ...noCache,
      getProvider: () => ({ ...providerReturning(ARTICLES), getSymbolNews }),
    });

    expect(response.status).toBe(400);
    expect(getSymbolNews).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves articles with a null summary when the summary cache is not configured', async () => {
    const response = await handleNewsSummaryRequest('aapl', {
      ...noCache,
      getProvider: () => providerReturning(ARTICLES),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.symbol).toBe('AAPL');
    expect(body.summary).toBeNull();
    expect(body.error).toBeNull();
    expect(body.news).toHaveLength(4);
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=60');
  });

  it('caches the raw feed so a second reader inside the window costs no provider quota', async () => {
    const cache = new InMemoryNewsCache(() => NOW.valueOf());
    const getSymbolNews = vi.fn();
    const deps = {
      ...noCache,
      getCache: () => cache,
      getProvider: () => providerReturning(ARTICLES, getSymbolNews),
    };

    await handleNewsSummaryRequest('AAPL', deps);
    await handleNewsSummaryRequest('AAPL', deps);

    expect(getSymbolNews).toHaveBeenCalledTimes(1);
    expect(cache.has(newsRawKey('AAPL'))).toBe(true);
  });

  it('goes back to the provider once the raw window has passed', async () => {
    let clock = NOW.valueOf();
    const cache = new InMemoryNewsCache(() => clock);
    const getSymbolNews = vi.fn();
    const deps = {
      ...noCache,
      getCache: () => cache,
      getProvider: () => providerReturning(ARTICLES, getSymbolNews),
    };

    await handleNewsSummaryRequest('AAPL', deps);
    clock += (NEWS_RAW_TTL_SECONDS + 1) * 1000;
    await handleNewsSummaryRequest('AAPL', deps);

    expect(getSymbolNews).toHaveBeenCalledTimes(2);
  });

  it('reports the provider failure with its own status and forbids caching it', async () => {
    const response = await handleNewsSummaryRequest('AAPL', {
      ...noCache,
      getProvider: () => ({
        ...providerReturning(ARTICLES),
        getSymbolNews: async () => {
          throw new NewsProviderError('NEWS_PROVIDER_RATE_LIMITED', 'rate limited', 60);
        },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error.code).toBe('NEWS_PROVIDER_RATE_LIMITED');
    expect(body.news).toEqual([]);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
