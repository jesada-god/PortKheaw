import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { serverEnv } from '@/src/config/env/server';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { getNewsCacheClient, type NewsCacheClient } from './cache-client';
import { NEWS_MAX_COUNT, selectLatestNews } from './feed';
import { getNewsProvider, NewsProviderError } from './provider';
import { createGeminiNewsSummaryCall, summarizeNews } from './summarizer';
import { resolveNewsSummary } from './summary-store';
import { newsArticleSchema, type NewsArticle, type NewsProvider } from './types';

/**
 * The raw feed's own cache, separate from the summary's.
 *
 * Without it the summary would save Gemini tokens by spending NewsAPI quota
 * instead: every reader of a symbol whose fingerprint already matches still has
 * to fetch the articles to compute that fingerprint. Ten minutes is under the
 * lock's practical regeneration cadence and well inside NewsAPI's free-tier
 * refresh, so a busy symbol costs one provider call per ten minutes rather than
 * one per reader.
 */
export const NEWS_RAW_TTL_SECONDS = 600;

export function newsRawKey(symbol: string): string {
  return `news:raw:${symbol.toUpperCase()}`;
}

const rawRecordSchema = z.object({
  articles: z.array(newsArticleSchema),
  asOf: z.iso.datetime(),
});

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
): Promise<{ articles: NewsArticle[]; asOf: string }> {
  const key = newsRawKey(symbol);
  if (cache) {
    const parsed = rawRecordSchema.safeParse(await cache.get<unknown>(key));
    if (parsed.success) return parsed.data;
  }
  const loaded = await provider.getSymbolNews(symbol);
  const record = {
    articles: selectLatestNews(loaded.data.articles, NEWS_MAX_COUNT),
    asOf: loaded.asOf ?? now().toISOString(),
  };
  if (cache) await cache.set(key, record, NEWS_RAW_TTL_SECONDS);
  return record;
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

  const cache = deps.getCache();
  const apiKey = deps.geminiApiKey;
  let summary: Awaited<ReturnType<typeof resolveNewsSummary>> = null;
  if (cache && apiKey) {
    const callModel = createGeminiNewsSummaryCall(apiKey);
    try {
      summary = await resolveNewsSummary({
        symbol,
        articles,
        cache,
        generate: (input) => summarizeNews({ articles: input, callModel, now: deps.now }),
      });
    } catch {
      // Redis itself is down. The articles are already in hand and the card is
      // an addition to them, so the reader gets the tab rather than an error.
      summary = null;
    }
  }

  return NextResponse.json({
    symbol,
    summary: summary ? { summary: summary.summary, stale: summary.stale } : null,
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
