import 'server-only';
import { NextResponse } from 'next/server';
import { serverEnv } from '@/src/config/env/server';
import { getNewsCacheClient, type NewsCacheClient } from './cache-client';
import { selectMarketWideNews } from './market-wide';
import { getNewsProvider, NewsProviderError } from './provider';
import {
  NEWS_MARKET_RAW_KEY,
  loadNewsFeedForSummary,
  resolveNewsSummaryPayload,
} from './summary-feed';
import { MARKET_NEWS_SYSTEM_INSTRUCTION } from './summarizer';
import { MARKET_NEWS_SUMMARY_SCOPE } from './summary-store';
import type { NewsProvider } from './types';

export interface MarketNewsSummaryRouteDependencies {
  getProvider: () => NewsProvider;
  getCache: () => NewsCacheClient | null;
  geminiApiKey: string | undefined;
  now: () => Date;
}

const defaults: MarketNewsSummaryRouteDependencies = {
  getProvider: getNewsProvider,
  getCache: getNewsCacheClient,
  geminiApiKey: serverEnv.GEMINI_API_KEY,
  now: () => new Date(),
};

/**
 * `GET /api/news/market-summary` — the AI summary of the dashboard's market feed.
 *
 * It carries no articles. The dashboard block already has the feed from
 * `/api/news?scope=market-wide`, and the card's bullets carry their own headline
 * and link, so sending the articles a second time would only invite the two
 * copies to disagree.
 *
 * The feed loaded here is `selectMarketWideNews` over `getMarketNews` — exactly
 * what that block renders — so the fingerprint is taken over the same top three
 * stories the reader is looking at, and the summary regenerates when those move
 * and at no other time.
 */
export async function handleMarketNewsSummaryRequest(
  dependencies: Partial<MarketNewsSummaryRouteDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies };
  const cache = deps.getCache();

  let articles;
  let asOf: string;
  try {
    const loaded = await loadNewsFeedForSummary({
      key: NEWS_MARKET_RAW_KEY,
      cache,
      load: async () => {
        const result = await deps.getProvider().getMarketNews();
        return {
          articles: selectMarketWideNews(result.data.articles),
          asOf: result.asOf ?? deps.now().toISOString(),
        };
      },
    });
    articles = loaded.articles;
    asOf = loaded.asOf;
  } catch (cause) {
    const error = cause instanceof NewsProviderError
      ? cause
      : new NewsProviderError('NEWS_PROVIDER_UPSTREAM_FAILURE', 'News is temporarily unavailable');
    const response = NextResponse.json({
      summary: null,
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
    scope: MARKET_NEWS_SUMMARY_SCOPE,
    articles,
    cache,
    geminiApiKey: deps.geminiApiKey,
    systemInstruction: MARKET_NEWS_SYSTEM_INSTRUCTION,
    now: deps.now,
  });

  return NextResponse.json({ summary, error: null, asOf }, {
    headers: {
      // The same minute the symbol route uses, for the same reason: Redis decides
      // how long a summary lives, and a card that appears should reach readers
      // holding a cached `summary: null` in a minute rather than in ten.
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600',
    },
  });
}
