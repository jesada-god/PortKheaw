import 'server-only';
import { NextResponse } from 'next/server';
import { serverEnv } from '@/src/config/env/server';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { getNewsCacheClient, type NewsCacheClient } from './cache-client';
import { NEWS_MAX_COUNT, selectLatestNews } from './feed';
import { getNewsProvider, NewsProviderError } from './provider';
import {
  loadNewsFeedForSummary,
  newsRawKey,
  resolveNewsSummaryPayload,
  type CachedNewsFeed,
} from './summary-feed';
import { SYMBOL_NEWS_SYSTEM_INSTRUCTION } from './summarizer';
import { symbolNewsSummaryScope } from './summary-store';
import type { NewsArticle, NewsProvider } from './types';

export { NEWS_RAW_TTL_SECONDS, newsRawKey } from './summary-feed';

export interface NewsSummaryRouteDependencies {
  getProvider: () => NewsProvider;
  getCache: () => NewsCacheClient | null;
  geminiApiKey: string | undefined;
  now: () => Date;
}

const defaults: NewsSummaryRouteDependencies = {
  getProvider: getNewsProvider,
  getCache: getNewsCacheClient,
  geminiApiKey: serverEnv.GEMINI_API_KEY,
  now: () => new Date(),
};

async function loadArticles(
  symbol: string,
  provider: NewsProvider,
  cache: NewsCacheClient | null,
  now: () => Date,
): Promise<CachedNewsFeed> {
  return loadNewsFeedForSummary({
    key: newsRawKey(symbol),
    cache,
    load: async () => {
      const loaded = await provider.getSymbolNews(symbol);
      return {
        articles: selectLatestNews(loaded.data.articles, NEWS_MAX_COUNT),
        asOf: loaded.asOf ?? now().toISOString(),
      };
    },
  });
}

/**
 * `GET /api/news/summary/{symbol}` — the symbol's articles and, when one can be
 * had, the shared AI summary of them.
 *
 * A missing summary is a normal response, never an error: no Redis, no Gemini
 * key, too few articles, an answer that failed validation, and "another request
 * is generating the first one right now" all produce `summary: null` beside a
 * complete `news` array. Only the articles failing is a failure.
 */
export async function handleNewsSummaryRequest(
  rawSymbol: string,
  dependencies: Partial<NewsSummaryRouteDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies };
  const parsedSymbol = symbolSchema.safeParse(rawSymbol);
  if (!parsedSymbol.success) {
    return NextResponse.json({
      symbol: null,
      summary: null,
      news: [],
      error: { code: 'NEWS_INVALID_REQUEST', message: 'Invalid symbol', retryable: false },
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const symbol = parsedSymbol.data;

  let articles: NewsArticle[];
  let asOf: string;
  try {
    const loaded = await loadArticles(symbol, deps.getProvider(), deps.getCache(), deps.now);
    articles = loaded.articles;
    asOf = loaded.asOf;
  } catch (cause) {
    const error = cause instanceof NewsProviderError
      ? cause
      : new NewsProviderError('NEWS_PROVIDER_UPSTREAM_FAILURE', 'News is temporarily unavailable');
    const response = NextResponse.json({
      symbol,
      summary: null,
      news: [],
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      },
    }, { status: error.status });
    response.headers.set('Cache-Control', 'no-store');
    if (error.retryAfterSeconds) {
      response.headers.set('Retry-After', String(error.retryAfterSeconds));
    }
    return response;
  }

  const summary = await resolveNewsSummaryPayload({
    scope: symbolNewsSummaryScope(symbol),
    articles,
    cache: deps.getCache(),
    geminiApiKey: deps.geminiApiKey,
    systemInstruction: SYMBOL_NEWS_SYSTEM_INSTRUCTION,
    now: deps.now,
  });

  return NextResponse.json({
    symbol,
    summary,
    news: articles,
    error: null,
    asOf,
  }, {
    headers: {
      /*
       * Shorter than the raw cache's ten minutes on purpose: the edge must not
       * be the layer that decides how long a summary lives. Redis already
       * guarantees one generation per fingerprint, so a revalidation that gets
       * this far is cheap, and a summary that appears while the edge holds a
       * `summary: null` copy should reach readers in a minute, not in ten.
       */
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600',
    },
  });
}
