import { describe, expect, it } from 'vitest';
import {
  canExpandScopedNews,
  matchesScope,
  NEWS_FILTER_PREVIEW_COUNT,
  scopesOf,
  selectScopedNews,
  visibleScopedCount,
} from './scope';
import type { NewsArticle } from './types';

function article(over: Partial<NewsArticle> & Pick<NewsArticle, 'id'>): NewsArticle {
  return {
    title: `Headline ${over.id}`,
    source: 'Example Wire',
    publishedAt: '2026-08-30T12:00:00.000Z',
    url: `https://publisher.com/${over.id}`,
    imageUrl: null,
    symbols: [],
    ...over,
  };
}

const CONTEXT = { portfolioSymbols: ['AAPL', 'MSFT'], watchlistSymbols: ['NVDA', 'AAPL'] };

describe('news scopes', () => {
  it('puts an article about a held symbol in the portfolio tab', () => {
    const scopes = scopesOf(article({ id: 'a', symbols: ['MSFT'] }), CONTEXT);
    expect([...scopes].sort()).toEqual(['all', 'portfolio']);
  });

  it('puts an article about a watched symbol in the watchlist tab', () => {
    const scopes = scopesOf(article({ id: 'a', symbols: ['NVDA'] }), CONTEXT);
    expect([...scopes].sort()).toEqual(['all', 'watchlist']);
  });

  /*
   * A symbol that is both held and watched is ONE symbol. Picking a winner
   * would make one of the two tabs lie about what is in it.
   */
  it('puts a symbol that is both held and watched in both tabs', () => {
    const scopes = scopesOf(article({ id: 'a', symbols: ['AAPL'] }), CONTEXT);
    expect([...scopes].sort()).toEqual(['all', 'portfolio', 'watchlist']);
  });

  /*
   * ===========================================================================
   * THE RULE THAT MATTERS MOST: AN UNTAGGED ARTICLE IS MARKET NEWS
   * ===========================================================================
   * It is not assigned to a holding by reading the headline, and it is not
   * dropped. Guessing would be right often enough to be trusted and wrong often
   * enough to matter.
   */
  it('files an article with no symbols under ตลาด rather than guessing an owner', () => {
    const scopes = scopesOf(article({ id: 'a', symbols: [] }), CONTEXT);
    expect([...scopes].sort()).toEqual(['all', 'market']);
    expect(scopes.has('portfolio')).toBe(false);
    expect(scopes.has('watchlist')).toBe(false);
  });

  it('does not read a symbol out of the headline text', () => {
    // The tagger attaches symbols; this module never re-derives them.
    const untagged = article({ id: 'a', title: 'AAPL beats estimates', symbols: [] });
    expect(scopesOf(untagged, CONTEXT).has('portfolio')).toBe(false);
    expect(scopesOf(untagged, CONTEXT).has('market')).toBe(true);
  });

  it('files an article about a symbol the reader has nothing to do with under ตลาด', () => {
    const scopes = scopesOf(article({ id: 'a', symbols: ['TSLA'] }), CONTEXT);
    expect([...scopes].sort()).toEqual(['all', 'market']);
  });

  it('matches symbols regardless of case or padding', () => {
    expect(matchesScope(article({ id: 'a', symbols: [' aapl '] }), 'portfolio', CONTEXT)).toBe(true);
  });

  it('puts every article in ทั้งหมด', () => {
    for (const symbols of [[], ['AAPL'], ['NVDA'], ['TSLA']]) {
      expect(matchesScope(article({ id: 'a', symbols }), 'all', CONTEXT)).toBe(true);
    }
  });

  it('treats an empty portfolio and watchlist as everything being market news', () => {
    const empty = { portfolioSymbols: [], watchlistSymbols: [] };
    expect([...scopesOf(article({ id: 'a', symbols: ['AAPL'] }), empty)].sort())
      .toEqual(['all', 'market']);
  });
});

describe('scoped selection', () => {
  const articles = [
    article({ id: 'market-new', symbols: [], publishedAt: '2026-08-30T15:00:00.000Z' }),
    article({ id: 'portfolio-mid', symbols: ['MSFT'], publishedAt: '2026-08-30T14:00:00.000Z' }),
    article({ id: 'watch-old', symbols: ['NVDA'], publishedAt: '2026-08-30T10:00:00.000Z' }),
  ];

  /*
   * The watchlist is the list a reader is still deciding about; the holdings
   * are decided. So on the combined tab the stories that could change what
   * somebody does today go above the ones confirming yesterday — even when they
   * are older, which is the only place this order overrides newest-first.
   */
  it('leads with watchlist stories on the combined tab', () => {
    const selected = selectScopedNews(articles, 'all', CONTEXT, 10);
    expect(selected.map((item) => item.id)).toEqual(['watch-old', 'market-new', 'portfolio-mid']);
  });

  it('sorts newest-first within each half', () => {
    const withTwoMarket = [
      ...articles,
      article({ id: 'market-old', symbols: [], publishedAt: '2026-08-30T09:00:00.000Z' }),
    ];
    const selected = selectScopedNews(withTwoMarket, 'all', CONTEXT, 10);
    expect(selected.map((item) => item.id))
      .toEqual(['watch-old', 'market-new', 'portfolio-mid', 'market-old']);
  });

  it('returns only the matching articles for a single tab', () => {
    expect(selectScopedNews(articles, 'portfolio', CONTEXT, 10).map((item) => item.id))
      .toEqual(['portfolio-mid']);
    expect(selectScopedNews(articles, 'market', CONTEXT, 10).map((item) => item.id))
      .toEqual(['market-new']);
  });

  it('returns an empty list for a tab with nothing in it, rather than falling back', () => {
    const noneHeld = { portfolioSymbols: ['ZZZZ'], watchlistSymbols: [] };
    expect(selectScopedNews(articles, 'portfolio', noneHeld, 10)).toEqual([]);
  });

  /*
   * One story republished by a second outlet must not take two of the eight
   * rows a tab has — the same guarantee every other News surface gets, applied
   * after the filter so it holds across both halves of the order.
   */
  it('de-duplicates a story republished under another id', () => {
    const duplicated = [
      article({ id: 'one', symbols: ['NVDA'], title: 'Same Story', url: 'https://a.com/x' }),
      article({ id: 'two', symbols: ['NVDA'], title: 'Same Story', url: 'https://b.com/y' }),
    ];
    expect(selectScopedNews(duplicated, 'all', CONTEXT, 10)).toHaveLength(1);
  });

  it('honours the limit it is given', () => {
    expect(selectScopedNews(articles, 'all', CONTEXT, 2)).toHaveLength(2);
  });
});

describe('the eight-row preview', () => {
  it('shows eight before the reader asks for more', () => {
    expect(NEWS_FILTER_PREVIEW_COUNT).toBe(8);
    expect(visibleScopedCount(12, false)).toBe(8);
    expect(visibleScopedCount(12, true)).toBe(12);
  });

  it('never claims more rows than there are', () => {
    expect(visibleScopedCount(3, false)).toBe(3);
    expect(visibleScopedCount(3, true)).toBe(3);
  });

  it('offers ดูเพิ่มเติม only when it would reveal something', () => {
    expect(canExpandScopedNews(8)).toBe(false);
    expect(canExpandScopedNews(9)).toBe(true);
  });
});
