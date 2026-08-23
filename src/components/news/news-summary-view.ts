import { canonicalNewsUrl } from '@/src/lib/news/url';
import type { NewsArticle } from '@/src/lib/news/types';
import type { NewsSummary } from '@/src/lib/news/summary-types';

export interface NewsSummarySplit {
  /** The articles the summary actually cites, in the order its bullets cite them. */
  cited: NewsArticle[];
  /** Everything else in the current feed, newest-first order preserved. */
  others: NewsArticle[];
}

/**
 * Which articles the summary is about — decided by link, never by position.
 *
 * `articles.slice(0, 3)` would be the same thing only if the summary had just
 * been generated from this exact feed, and it never has: a cached summary is
 * served for as long as the top three headlines hold, so by the time a reader
 * sees it the feed underneath can have gained an article and pushed a cited one
 * down. Matching on the canonical link keeps the [1][2][3] under the bullets
 * pointing at the same stories the cards below show, whatever moved in between.
 *
 * A cited article that has left the feed entirely simply has no card here; the
 * summary carries its own headline and link, so it is still reachable from the
 * source list at the foot of the card.
 */
export function splitNewsBySummary(
  articles: readonly NewsArticle[],
  summary: NewsSummary | null,
): NewsSummarySplit {
  if (!summary) return { cited: [], others: [...articles] };

  const wanted = new Map<string, number>();
  summary.sources.forEach((source, index) => {
    const key = canonicalNewsUrl(source.url) ?? source.url;
    if (!wanted.has(key)) wanted.set(key, index);
  });

  const cited: Array<{ article: NewsArticle; order: number }> = [];
  const others: NewsArticle[] = [];
  const taken = new Set<number>();
  for (const article of articles) {
    const key = canonicalNewsUrl(article.url) ?? article.url;
    const order = wanted.get(key);
    if (order === undefined || taken.has(order)) {
      others.push(article);
      continue;
    }
    taken.add(order);
    cited.push({ article, order });
  }

  return {
    cited: cited.sort((a, b) => a.order - b.order).map((entry) => entry.article),
    others,
  };
}

/** The [n] a bullet or a source row is labelled with. Sources are 1-based to readers. */
export function sourceLabel(sourceIndex: number): string {
  return `[${sourceIndex + 1}]`;
}
