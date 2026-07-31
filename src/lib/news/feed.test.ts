import { describe, expect, it } from 'vitest';
import {
  NEWS_MAX_COUNT,
  NEWS_PREVIEW_COUNT,
  canExpandNews,
  normalizeNewsTitle,
  selectLatestNews,
  selectPrioritizedNews,
  visibleNewsCount,
} from './feed';
import type { NewsArticle } from './types';

function article(overrides: Partial<NewsArticle> & { id: string }): NewsArticle {
  return {
    title: `Headline ${overrides.id}`,
    source: 'Example',
    publishedAt: '2026-07-20T00:00:00.000Z',
    url: `https://example.com/${overrides.id}`,
    imageUrl: null,
    symbols: [],
    ...overrides,
  };
}

describe('selectLatestNews', () => {
  it('orders newest first regardless of provider order', () => {
    const selected = selectLatestNews([
      article({ id: 'b', publishedAt: '2026-07-22T09:00:00.000Z' }),
      article({ id: 'c', publishedAt: '2026-07-25T09:00:00.000Z' }),
      article({ id: 'a', publishedAt: '2026-07-24T09:00:00.000Z' }),
    ]);
    expect(selected.map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps the newest copy when one story arrives under links that differ only by tracking', () => {
    const selected = selectLatestNews([
      article({
        id: 'old',
        title: 'Rocket Lab wins a launch contract',
        url: 'https://www.publisher.com/rocket-lab/?utm_source=feed&utm_medium=rss',
        publishedAt: '2026-07-24T08:00:00.000Z',
      }),
      article({
        id: 'new',
        title: 'Rocket Lab wins a launch contract',
        url: 'https://publisher.com/rocket-lab',
        publishedAt: '2026-07-24T12:00:00.000Z',
      }),
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe('new');
  });

  it('collapses one headline republished by a second outlet under a different link', () => {
    // Observed live: NewsAPI returns the same wire story from Biztoc and Yahoo.
    const selected = selectLatestNews([
      article({ id: 'yahoo', title: 'Is NVIDIA Corporation (NVDA) A Good Stock To Buy Now?', url: 'https://finance.yahoo.com/news/nvda-good-stock', publishedAt: '2026-07-25T19:04:42.000Z' }),
      article({ id: 'biztoc', title: 'Is NVIDIA Corporation (NVDA) a good stock to buy now?', url: 'https://biztoc.com/x/nvda', publishedAt: '2026-07-25T19:22:04.000Z' }),
    ]);
    expect(selected.map((item) => item.id)).toEqual(['biztoc']);
  });

  it('keeps distinct stories that merely share a publisher', () => {
    const selected = selectLatestNews([
      article({ id: '1', title: 'Apple beats estimates', url: 'https://publisher.com/a?p=1' }),
      article({ id: '2', title: 'Apple names a new CFO', url: 'https://publisher.com/a?p=2' }),
    ]);
    expect(selected).toHaveLength(2);
  });

  it('caps the feed at the maximum the UI can expand to', () => {
    const many = Array.from({ length: 25 }, (_, index) => article({
      id: `item-${index}`,
      title: `Headline ${index}`,
      publishedAt: new Date(Date.UTC(2026, 6, 1, index)).toISOString(),
    }));
    const selected = selectLatestNews(many);
    expect(selected).toHaveLength(NEWS_MAX_COUNT);
    // The cap keeps the *latest* items, not the first ones the provider listed.
    expect(selected[0]?.id).toBe('item-24');
  });

  it('returns fewer than the cap when the provider has fewer real articles', () => {
    expect(selectLatestNews([article({ id: 'only' })])).toHaveLength(1);
    expect(selectLatestNews([])).toEqual([]);
  });

  it('never drops an article with an unparseable timestamp, but never lets it outrank a real one', () => {
    const selected = selectLatestNews([
      article({ id: 'broken', publishedAt: 'not-a-date' }),
      article({ id: 'real', publishedAt: '2026-07-01T00:00:00.000Z' }),
    ]);
    expect(selected.map((item) => item.id)).toEqual(['real', 'broken']);
  });
});

describe('selectPrioritizedNews', () => {
  it('keeps portfolio priority and removes a duplicate from later categories', () => {
    const portfolio = article({
      id: 'portfolio',
      title: 'Apple announces earnings',
      publishedAt: '2026-07-20T00:00:00.000Z',
    });
    const duplicate = article({
      id: 'duplicate',
      title: 'Apple announces earnings',
      url: 'https://another.example/apple',
      publishedAt: '2026-07-25T00:00:00.000Z',
    });
    const market = article({
      id: 'market',
      publishedAt: '2026-07-26T00:00:00.000Z',
    });
    expect(selectPrioritizedNews([[portfolio], [duplicate, market]]).map((item) => item.id))
      .toEqual(['portfolio', 'market']);
  });
});

describe('normalizeNewsTitle', () => {
  it('ignores case, punctuation and spacing differences between syndicators', () => {
    expect(normalizeNewsTitle('Rocket Lab: Stock  Rises — Here’s Why!'))
      .toBe(normalizeNewsTitle('rocket lab stock rises here s why'));
  });
});

describe('feed visibility', () => {
  it('shows five by default and ten once expanded', () => {
    expect(visibleNewsCount(10, false)).toBe(NEWS_PREVIEW_COUNT);
    expect(visibleNewsCount(10, true)).toBe(NEWS_MAX_COUNT);
  });

  it('never shows more than the articles that actually exist', () => {
    expect(visibleNewsCount(3, false)).toBe(3);
    expect(visibleNewsCount(3, true)).toBe(3);
    expect(visibleNewsCount(0, true)).toBe(0);
  });

  it('offers expansion only when it would reveal another article', () => {
    expect(canExpandNews(5)).toBe(false);
    expect(canExpandNews(4)).toBe(false);
    expect(canExpandNews(6)).toBe(true);
  });
});
