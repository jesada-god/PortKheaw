import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { loadPersonalizedNews } from './personalized';
import type { NewsArticle, NewsProvider, NewsProviderResult } from './types';

function article(id: string, title: string): NewsArticle {
  return {
    id,
    title,
    source: 'Example',
    publishedAt: '2026-07-31T01:00:00.000Z',
    url: `https://example.com/${id}`,
    imageUrl: null,
    symbols: [],
  };
}

function result(articles: NewsArticle[]): NewsProviderResult {
  return {
    data: { articles, nextCursor: null },
    status: 'live',
    asOf: '2026-07-31T02:00:00.000Z',
  };
}

it('orders portfolio, watchlist, industry, then market and adds truthful tags', async () => {
  const buckets = [
    result([article('portfolio', 'AAPL earnings surprise')]),
    result([article('watchlist', 'NVDA launches a new chip')]),
    result([article('industry', 'Semiconductors rally')]),
  ];
  const provider: NewsProvider = {
    id: 'test',
    getMarketNews: vi.fn(async () => result([article('market', 'Stock market update')])),
    getSymbolNews: vi.fn(async () => result([])),
    getTopicNews: vi.fn(async () => buckets.shift() ?? result([])),
  };
  const output = await loadPersonalizedNews({
    portfolioSymbols: ['AAPL'],
    watchlistSymbols: ['NVDA'],
    industryNames: ['Semiconductors'],
  }, provider);
  expect(output.data.articles.map((item) => item.id))
    .toEqual(['portfolio', 'watchlist', 'industry', 'market']);
  expect(output.data.articles[0]).toMatchObject({ symbols: ['AAPL'] });
  expect(output.data.articles[2]).toMatchObject({ industries: ['Semiconductors'] });
});

it('keeps successful categories when one personalized provider request fails', async () => {
  let topicCall = 0;
  const provider: NewsProvider = {
    id: 'test',
    getMarketNews: vi.fn(async () => result([article('market', 'Market update')])),
    getSymbolNews: vi.fn(async () => result([])),
    getTopicNews: vi.fn(async () => {
      topicCall += 1;
      if (topicCall === 1) throw new Error('portfolio unavailable');
      return result([article('watchlist', 'NVDA rises')]);
    }),
  };
  const output = await loadPersonalizedNews({
    portfolioSymbols: ['AAPL'],
    watchlistSymbols: ['NVDA'],
    industryNames: [],
  }, provider);
  expect(output.data.articles.map((item) => item.id)).toEqual(['watchlist', 'market']);
});
