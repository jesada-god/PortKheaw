import { describe, expect, it } from 'vitest';
import type { NewsArticle } from '@/src/lib/news/types';
import type { NewsSummary } from '@/src/lib/news/summary-types';
import { sourceLabel, splitNewsBySummary } from './news-summary-view';

function article(id: string, url: string): NewsArticle {
  return {
    id,
    title: `Headline ${id}`,
    source: 'Example Wire',
    publishedAt: '2026-08-23T08:00:00.000Z',
    url,
    imageUrl: null,
    summary: null,
    symbols: [],
  };
}

function summaryCiting(urls: readonly string[]): NewsSummary {
  return {
    overview: 'ภาพรวม',
    points: urls.map((_, index) => ({ text: `ประเด็น ${index}`, sourceIndex: index })),
    sources: urls.map((url, index) => ({
      title: `Headline ${index}`,
      source: 'Example Wire',
      url,
      publishedAt: '2026-08-23T08:00:00.000Z',
    })),
    generatedAt: '2026-08-23T09:00:00.000Z',
  };
}

describe('splitNewsBySummary', () => {
  it('follows the cited links instead of the first three cards', () => {
    // The summary was cached when b/c/d were the top three; e has arrived since
    // and pushed them down, which is exactly the case slice(0, 3) gets wrong.
    const feed = [
      article('e', 'https://example.com/e'),
      article('b', 'https://example.com/b'),
      article('c', 'https://example.com/c'),
      article('d', 'https://example.com/d'),
    ];
    const summary = summaryCiting([
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ]);

    const { cited, others } = splitNewsBySummary(feed, summary);

    expect(cited.map((item) => item.id)).toEqual(['b', 'c', 'd']);
    expect(others.map((item) => item.id)).toEqual(['e']);
  });

  it('orders the cited cards the way the bullets cite them', () => {
    const feed = [
      article('b', 'https://example.com/b'),
      article('c', 'https://example.com/c'),
      article('d', 'https://example.com/d'),
    ];
    const summary = summaryCiting([
      'https://example.com/d',
      'https://example.com/b',
      'https://example.com/c',
    ]);

    expect(splitNewsBySummary(feed, summary).cited.map((item) => item.id)).toEqual(['d', 'b', 'c']);
  });

  it('matches a syndicated link that only differs by tracking parameters', () => {
    const feed = [article('b', 'https://www.example.com/b?utm_source=feed')];
    const summary = summaryCiting([
      'https://example.com/b',
      'https://example.com/gone',
      'https://example.com/also-gone',
    ]);

    const { cited, others } = splitNewsBySummary(feed, summary);

    expect(cited.map((item) => item.id)).toEqual(['b']);
    expect(others).toEqual([]);
  });

  it('leaves the whole feed in one list when there is no summary', () => {
    const feed = [article('b', 'https://example.com/b'), article('c', 'https://example.com/c')];

    expect(splitNewsBySummary(feed, null)).toEqual({ cited: [], others: feed });
  });
});

describe('sourceLabel', () => {
  it('presents the zero-based index to readers as [1]', () => {
    expect(sourceLabel(0)).toBe('[1]');
    expect(sourceLabel(2)).toBe('[3]');
  });
});
