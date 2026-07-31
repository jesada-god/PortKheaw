import 'server-only';

import { NEWS_MAX_COUNT, selectPrioritizedNews } from './feed';
import { getNewsProvider, NewsProviderError } from './provider';
import type {
  NewsArticle,
  NewsProvider,
  NewsProviderResult,
} from './types';

export interface PersonalizedNewsContext {
  portfolioSymbols: string[];
  watchlistSymbols: string[];
  industryNames: string[];
}

function normalizedTopics(values: readonly string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function containsTopic(title: string, topic: string): boolean {
  const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i').test(title);
}

function tagArticles(
  articles: readonly NewsArticle[],
  symbols: readonly string[],
  industries: readonly string[],
): NewsArticle[] {
  return articles.map((article) => ({
    ...article,
    symbols: symbols.filter((symbol) => containsTopic(article.title, symbol)),
    industries: industries.filter((industry) =>
      article.title.toLocaleLowerCase('en-US').includes(industry.toLocaleLowerCase('en-US'))),
  }));
}

export async function loadPersonalizedNews(
  context: PersonalizedNewsContext,
  provider: NewsProvider = getNewsProvider(),
): Promise<NewsProviderResult> {
  const portfolio = normalizedTopics(context.portfolioSymbols, 6);
  const watchlist = normalizedTopics(
    context.watchlistSymbols.filter((symbol) => !portfolio.includes(symbol)),
    6,
  );
  const industries = normalizedTopics(context.industryNames, 8);
  const topics = (values: readonly string[]) => provider.getTopicNews
    ? provider.getTopicNews(values)
    : provider.getMarketNews();
  const requests: Array<Promise<NewsProviderResult> | null> = [
    portfolio.length ? topics(portfolio) : null,
    watchlist.length ? topics(watchlist) : null,
    industries.length ? topics(industries) : null,
    provider.getMarketNews(),
  ];
  const settled = await Promise.all(requests.map(async (request) =>
    request ? request.then((value) => ({ value })).catch((error) => ({ error })) : null));
  const successful = settled.filter(
    (item): item is { value: NewsProviderResult } => Boolean(item && 'value' in item),
  );
  if (!successful.length) {
    const firstFailure = settled.find(
      (item): item is { error: unknown } => Boolean(item && 'error' in item),
    );
    throw firstFailure?.error instanceof NewsProviderError
      ? firstFailure.error
      : new NewsProviderError('NEWS_PROVIDER_UPSTREAM_FAILURE', 'News is temporarily unavailable');
  }
  const categories = settled.map((item) => {
    if (!item || !('value' in item)) return [];
    return tagArticles(item.value.data.articles, [...portfolio, ...watchlist], industries);
  });
  const timestamps = successful.map(({ value }) => value.asOf).sort();
  const statuses = successful.map(({ value }) => value.status);
  return {
    data: {
      articles: selectPrioritizedNews(categories, NEWS_MAX_COUNT),
      nextCursor: null,
    },
    status: statuses.includes('stale')
      ? 'stale'
      : statuses.includes('cached') ? 'cached' : 'live',
    asOf: timestamps.at(-1) ?? new Date(0).toISOString(),
  };
}
