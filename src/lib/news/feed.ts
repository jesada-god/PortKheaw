import { canonicalNewsUrl } from './url';
import type { NewsArticle } from './types';

/** Cards shown before the reader asks for more. */
export const NEWS_PREVIEW_COUNT = 5;
/** Hard ceiling for one symbol's feed — the expanded view and the fetch cap. */
export const NEWS_MAX_COUNT = 10;

/**
 * Title identity for de-duplication. Case, punctuation and whitespace differ
 * between syndicators that republish one wire story, so they are removed; the
 * remaining letters/digits are what a reader would recognise as "the same headline".
 */
export function normalizeNewsTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function publishedMs(article: NewsArticle): number {
  const value = Date.parse(article.publishedAt);
  // An unparseable timestamp must never outrank a real one, and must not be
  // dropped either — it sorts last and still reaches the reader.
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/**
 * The feed contract shared by every News surface: newest first, one card per
 * story, never more than `limit` items.
 *
 * De-duplication uses three keys because providers repeat an article in three
 * different ways: the identical link (tracking parameters aside), the identical
 * generated id, and the same headline republished by a second outlet. The first
 * occurrence after sorting wins, so the surviving copy is always the most
 * recently published one.
 */
export function selectLatestNews(
  articles: readonly NewsArticle[],
  limit: number = NEWS_MAX_COUNT,
): NewsArticle[] {
  const ordered = [...articles].sort((a, b) => {
    const difference = publishedMs(b) - publishedMs(a);
    if (difference) return difference;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const seen = new Set<string>();
  const selected: NewsArticle[] = [];
  for (const article of ordered) {
    if (selected.length >= limit) break;
    const keys = [
      `id:${article.id}`,
      `url:${canonicalNewsUrl(article.url) ?? article.url}`,
      ...(normalizeNewsTitle(article.title) ? [`title:${normalizeNewsTitle(article.title)}`] : []),
    ];
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    selected.push(article);
  }
  return selected;
}

/** Keep category priority while still sorting newest-first inside each category. */
export function selectPrioritizedNews(
  categories: readonly (readonly NewsArticle[])[],
  limit: number = NEWS_MAX_COUNT,
): NewsArticle[] {
  const seen = new Set<string>();
  const selected: NewsArticle[] = [];
  for (const category of categories) {
    for (const article of selectLatestNews(category, category.length)) {
      const keys = [
        `id:${article.id}`,
        `url:${canonicalNewsUrl(article.url) ?? article.url}`,
        ...(normalizeNewsTitle(article.title) ? [`title:${normalizeNewsTitle(article.title)}`] : []),
      ];
      if (keys.some((key) => seen.has(key))) continue;
      keys.forEach((key) => seen.add(key));
      selected.push(article);
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

/** How many of the already-loaded articles the collapsed/expanded feed shows. */
export function visibleNewsCount(total: number, expanded: boolean): number {
  return Math.min(total, expanded ? NEWS_MAX_COUNT : NEWS_PREVIEW_COUNT);
}

/** "ดูเพิ่มเติม" is offered only when it would actually reveal another article. */
export function canExpandNews(total: number): boolean {
  return total > NEWS_PREVIEW_COUNT;
}
