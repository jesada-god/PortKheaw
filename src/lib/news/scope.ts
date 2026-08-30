import { selectLatestNews } from './feed';
import type { NewsArticle } from './types';

/**
 * The four things a reader can ask the news feed for.
 *
 * ===========================================================================
 * "ตลาด" IS AN ANSWER, NOT A FALLBACK
 * ===========================================================================
 * An article the tagger attached no symbol to is MARKET news. It is not
 * assigned to a holding by guessing from the headline, and it is not dropped.
 *
 * That is the whole discipline of this module. The tagger matches whole symbols
 * against a title (`personalized.ts`), and where it finds none the honest
 * reading is "this is about the market", not "this is probably about the thing
 * the reader owns most of". A feed that guessed would be right often enough to
 * be trusted and wrong often enough to matter.
 */
export type NewsScope = 'all' | 'portfolio' | 'watchlist' | 'market';

export const NEWS_SCOPES: readonly NewsScope[] = ['all', 'portfolio', 'watchlist', 'market'];

export const NEWS_SCOPE_LABEL_TH: Record<NewsScope, string> = {
  all: 'ทั้งหมด',
  portfolio: 'พอร์ต',
  watchlist: 'Watchlist',
  market: 'ตลาด',
};

/** Cards shown before the reader asks for more. */
export const NEWS_FILTER_PREVIEW_COUNT = 8;

export interface NewsScopeContext {
  portfolioSymbols: readonly string[];
  watchlistSymbols: readonly string[];
}

function normalize(symbols: readonly string[]): Set<string> {
  return new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
}

/**
 * Which buckets an article belongs to.
 *
 * An article can be in BOTH `portfolio` and `watchlist` — a symbol a reader
 * owns and also watches is one symbol, and hiding the story from one of the two
 * tabs would make a tab lie about what is in it. So this returns a set rather
 * than picking a winner.
 *
 * `market` is exclusive of the other two by construction: it means "tied to
 * nothing the reader holds or watches", which covers an untagged article and an
 * article about a symbol that is not theirs. Both are, from this reader's
 * position, news about the market rather than about them.
 */
export function scopesOf(article: NewsArticle, context: NewsScopeContext): Set<NewsScope> {
  const portfolio = normalize(context.portfolioSymbols);
  const watchlist = normalize(context.watchlistSymbols);
  const symbols = article.symbols.map((symbol) => symbol.trim().toUpperCase());

  const scopes = new Set<NewsScope>(['all']);
  if (symbols.some((symbol) => portfolio.has(symbol))) scopes.add('portfolio');
  if (symbols.some((symbol) => watchlist.has(symbol))) scopes.add('watchlist');
  if (!scopes.has('portfolio') && !scopes.has('watchlist')) scopes.add('market');
  return scopes;
}

/** True when the article belongs in the tab currently selected. */
export function matchesScope(
  article: NewsArticle,
  scope: NewsScope,
  context: NewsScopeContext,
): boolean {
  return scopesOf(article, context).has(scope);
}

/**
 * The feed for one tab: watchlist stories first, then everything else, each
 * newest-first.
 *
 * WHY WATCHLIST LEADS. A reader's watchlist is the list of things they are
 * deciding about — the holdings are decided already. So on the combined tab the
 * stories most likely to change what somebody does today go above the ones that
 * confirm what they did yesterday. Inside each half the order is the feed's
 * usual one, so nothing is reordered except across that single boundary.
 *
 * `selectLatestNews` does the de-duplication and the newest-first sort, so a
 * story republished by a second outlet cannot occupy two rows — the same
 * guarantee every other News surface gets, applied after the split so it holds
 * across both halves.
 */
export function selectScopedNews(
  articles: readonly NewsArticle[],
  scope: NewsScope,
  context: NewsScopeContext,
  limit: number,
): NewsArticle[] {
  const matching = articles.filter((article) => matchesScope(article, scope, context));
  const deduped = selectLatestNews(matching, matching.length);
  const watched: NewsArticle[] = [];
  const rest: NewsArticle[] = [];
  for (const article of deduped) {
    if (scopesOf(article, context).has('watchlist')) watched.push(article);
    else rest.push(article);
  }
  return [...watched, ...rest].slice(0, limit);
}

/** How many rows the collapsed / expanded feed shows. */
export function visibleScopedCount(total: number, expanded: boolean): number {
  return expanded ? total : Math.min(total, NEWS_FILTER_PREVIEW_COUNT);
}

/** "ดูเพิ่มเติม" is offered only when it would actually reveal another story. */
export function canExpandScopedNews(total: number): boolean {
  return total > NEWS_FILTER_PREVIEW_COUNT;
}
