import { describe, expect, it } from 'vitest';
import { marketNewsRelevanceScore, selectMarketWideNews } from './market-wide';
import type { NewsArticle } from './types';

function article(id: string, title: string, summary: string, publishedAt: string): NewsArticle {
  return {
    id,
    title,
    summary,
    source: 'Test Wire',
    publishedAt,
    url: `https://example.test/${id}`,
    imageUrl: null,
    symbols: [],
    tags: [],
  };
}

describe('market-wide news policy', () => {
  it('scores title, summary and tags but rejects trading advice and routine company news', () => {
    const macro = article(
      'macro',
      'Wall Street rises after Federal Reserve rate decision',
      'S&P 500 and Nasdaq reacted to the FOMC statement.',
      '2026-08-01T10:00:00.000Z',
    );
    const recommendation = article(
      'pick',
      'Three stocks to buy after earnings beat',
      'Analysts raised a price target.',
      '2026-08-01T11:00:00.000Z',
    );
    expect(marketNewsRelevanceScore(macro)).toBeGreaterThanOrEqual(4);
    expect(selectMarketWideNews([recommendation, macro])).toEqual([macro]);
  });

  it('deduplicates syndicated headlines, orders newest first and caps the feed at five', () => {
    const stories = Array.from({ length: 7 }, (_, index) => article(
      `story-${index}`,
      `Stock market reacts to CPI inflation report ${index}`,
      'S&P 500 index futures moved after the macro release.',
      `2026-08-01T${String(index + 10).padStart(2, '0')}:00:00.000Z`,
    ));
    const duplicate = { ...stories[6]!, id: 'duplicate', url: 'https://other.test/story' };
    const selected = selectMarketWideNews([...stories, duplicate]);
    expect(selected).toHaveLength(5);
    expect(selected[0]?.publishedAt).toBe(stories[6]?.publishedAt);
    expect(selected.filter((item) => item.title === stories[6]?.title)).toHaveLength(1);
  });

  it('returns a truthful empty state payload when nothing passes', () => {
    expect(selectMarketWideNews([
      article('contract', 'Small company signs customer contract', 'Routine business update.', '2026-08-01T10:00:00.000Z'),
    ])).toEqual([]);
  });
});
