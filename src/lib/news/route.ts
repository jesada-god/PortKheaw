import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { symbolSchema } from '@/src/lib/market-data/validation';
import {
  getNewsProvider,
  NewsProviderError,
  type NewsErrorCode,
} from './provider';
import type { NewsProvider } from './types';
import { loadPersonalizedNews } from './personalized';
import { selectMarketWideNews } from './market-wide';

const cursorSchema = z.coerce.number().int().min(1).max(100).transform(String);
const topicListSchema = z.string().max(500).transform((value) =>
  [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 8));

type NewsRouteCode = NewsErrorCode | 'NEWS_INVALID_REQUEST' | 'OK';
interface NewsRouteLog {
  route: '/api/news';
  provider: string | null;
  code: NewsRouteCode;
  status: number;
  retryable: boolean;
}

export interface NewsRouteDependencies {
  getProvider: () => NewsProvider;
  now: () => Date;
  log: (entry: NewsRouteLog) => void;
}

function defaultLog(entry: NewsRouteLog) {
  const method = entry.status >= 500 ? 'error' : entry.status >= 400 ? 'warn' : 'info';
  console[method](entry);
}

const defaults: NewsRouteDependencies = {
  getProvider: getNewsProvider,
  now: () => new Date(),
  log: defaultLog,
};

export async function handleNewsRequest(
  request: NextRequest,
  dependencies: Partial<NewsRouteDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies };
  const rawSymbol = request.nextUrl.searchParams.get('symbol');
  const rawCursor = request.nextUrl.searchParams.get('cursor');
  const marketWide = request.nextUrl.searchParams.get('scope') === 'market-wide';
  const parsedSymbol = rawSymbol ? symbolSchema.safeParse(rawSymbol) : null;
  const parsedCursor = rawCursor ? cursorSchema.safeParse(rawCursor) : null;
  const parsedPortfolio = request.nextUrl.searchParams.has('portfolio')
    ? topicListSchema.safeParse(request.nextUrl.searchParams.get('portfolio') ?? '')
    : null;
  const parsedWatchlist = request.nextUrl.searchParams.has('watchlist')
    ? topicListSchema.safeParse(request.nextUrl.searchParams.get('watchlist') ?? '')
    : null;
  const parsedIndustries = request.nextUrl.searchParams.has('industries')
    ? topicListSchema.safeParse(request.nextUrl.searchParams.get('industries') ?? '')
    : null;
  const timestamp = deps.now().toISOString();

  if (
    (parsedSymbol && !parsedSymbol.success)
    || (parsedCursor && !parsedCursor.success)
    || (parsedPortfolio && !parsedPortfolio.success)
    || (parsedWatchlist && !parsedWatchlist.success)
    || (parsedIndustries && !parsedIndustries.success)
  ) {
    const entry: NewsRouteLog = {
      route: '/api/news',
      provider: null,
      code: 'NEWS_INVALID_REQUEST',
      status: 400,
      retryable: false,
    };
    deps.log(entry);
    return NextResponse.json({
      data: null,
      error: {
        code: entry.code,
        message: 'Invalid news request',
        retryable: false,
      },
      meta: {
        provider: null,
        timestamp,
        asOf: null,
        status: 'unavailable',
      },
    }, { status: entry.status });
  }

  let provider: NewsProvider | null = null;
  try {
    provider = deps.getProvider();
    const cursor = parsedCursor?.success ? parsedCursor.data : undefined;
    const personalized = parsedPortfolio || parsedWatchlist || parsedIndustries;
    const loaded = personalized
      ? await loadPersonalizedNews({
        portfolioSymbols: parsedPortfolio?.success ? parsedPortfolio.data : [],
        watchlistSymbols: parsedWatchlist?.success ? parsedWatchlist.data : [],
        industryNames: parsedIndustries?.success ? parsedIndustries.data : [],
      }, provider)
      : parsedSymbol?.success
        ? await provider.getSymbolNews(parsedSymbol.data, cursor)
        : await provider.getMarketNews(cursor);
    const result = marketWide && !parsedSymbol?.success && !personalized
      ? {
          ...loaded,
          data: {
            ...loaded.data,
            articles: selectMarketWideNews(loaded.data.articles),
            nextCursor: null,
          },
        }
      : loaded;
    deps.log({
      route: '/api/news',
      provider: provider.id,
      code: 'OK',
      status: 200,
      retryable: false,
    });
    return NextResponse.json({
      data: result.data,
      error: null,
      meta: {
        provider: provider.id,
        timestamp,
        asOf: result.asOf,
        status: result.status,
      },
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
      },
    });
  } catch (cause) {
    const error = cause instanceof NewsProviderError
      ? cause
      : new NewsProviderError(
        'NEWS_PROVIDER_UPSTREAM_FAILURE',
        'News is temporarily unavailable',
      );
    deps.log({
      route: '/api/news',
      provider: provider?.id ?? null,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
    });
    const response = NextResponse.json({
      data: null,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterSeconds
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      },
      meta: {
        provider: provider?.id ?? null,
        timestamp,
        asOf: null,
        status: 'unavailable',
      },
    }, { status: error.status });
    response.headers.set('Cache-Control', 'no-store');
    if (error.retryAfterSeconds) {
      response.headers.set('Retry-After', String(error.retryAfterSeconds));
    }
    return response;
  }
}
