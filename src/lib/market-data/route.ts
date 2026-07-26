import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { MARKET_DATA_PROVIDER_ID } from './index';
import { fromZodError, MarketDataError } from './errors';
import type {
  CompanyProfile,
  HistoricalPrices,
  HistoricalUnavailableData,
  MarketDataEnvelope,
  ProviderResult,
} from './types';
import type { CompanyProfileResult } from './profile-service';

const unavailableFreshness = {
  status: 'unavailable' as const,
  asOf: null,
  maxAgeSeconds: null,
};

export async function marketDataResponse<T>(
  operation: () => Promise<ProviderResult<T>>,
): Promise<NextResponse<MarketDataEnvelope<T>>> {
  try {
    const result = await operation();
    const response = NextResponse.json({
      data: result.data,
      meta: {
        provider: result.provider ?? MARKET_DATA_PROVIDER_ID,
        timestamp: new Date().toISOString(),
        freshness: result.freshness,
      },
    });
    if (result.freshness.maxAgeSeconds !== null) {
      const staleWhileRevalidate = result.freshness.staleWhileRevalidateSeconds
        ?? result.freshness.maxAgeSeconds * 2;
      response.headers.set(
        'Cache-Control',
        `public, s-maxage=${result.freshness.maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidate}`,
      );
    }
    return response;
  } catch (cause) {
    const error = cause instanceof ZodError
      ? fromZodError(cause)
      : cause instanceof MarketDataError
        ? cause
        : new MarketDataError('internal-error', 'Unexpected market data error');
    // Sanitized structured log: identifies the classified error source and HTTP
    // status without ever emitting the API key, upstream URL or raw provider text.
    console.warn(JSON.stringify({
      event: 'market_data_error',
      source: 'market-data-gateway',
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    }));
    const response = NextResponse.json({
      data: null,
      error: error.toApiError(),
      meta: {
        provider: MARKET_DATA_PROVIDER_ID,
        timestamp: new Date().toISOString(),
        freshness: unavailableFreshness,
      },
    }, { status: error.status });
    response.headers.set('Cache-Control', 'no-store');
    if (error.retryAfterSeconds) {
      response.headers.set('Retry-After', String(error.retryAfterSeconds));
    }
    return response;
  }
}

export async function observedMarketDataResponse<T>(
  request: Pick<NextRequest, 'headers'>,
  context: { route: string; symbol: string | null },
  operation: () => Promise<ProviderResult<T>>,
): Promise<NextResponse<MarketDataEnvelope<T>>> {
  const startedAt = Date.now();
  const suppliedRequestId = request.headers.get('x-request-id');
  const requestId = suppliedRequestId && /^[A-Za-z0-9._-]{1,80}$/.test(suppliedRequestId)
    ? suppliedRequestId
    : crypto.randomUUID();
  const resolution: { value: ProviderResult<T> | null } = { value: null };
  const response = await marketDataResponse(async () => {
    resolution.value = await operation();
    return resolution.value;
  });
  const result = resolution.value;
  const freshnessStatus = result?.freshness.status;
  const cacheStatus = freshnessStatus === 'cached' || freshnessStatus === 'stale'
    ? freshnessStatus
    : result ? 'provider-or-fresh-cache' : 'none';
  console.info(JSON.stringify({
    event: 'market_data_request', requestId, route: context.route,
    symbol: context.symbol, provider: result?.provider ?? null,
    durationMs: Date.now() - startedAt, cacheStatus,
    resultStatus: response.ok ? 'success' : 'error',
    errorCode: response.ok ? null : `http-${response.status}`,
  }));
  response.headers.set('X-Request-Id', requestId);
  response.headers.set('X-Market-Data-Cache-Status', cacheStatus);
  if (result?.provider) response.headers.set('X-Market-Data-Provider', result.provider);
  return response;
}

export async function companyProfileMarketDataResponse(
  operation: () => Promise<CompanyProfileResult>,
): Promise<NextResponse> {
  try {
    const result = await operation();
    const response = NextResponse.json({
      data: result.data satisfies CompanyProfile,
      status: result.profileStatus,
      providerUsed: result.providerUsed,
      fallbackUsed: result.fallbackUsed,
      cachedAt: result.cachedAt,
      retryAfterSeconds: result.retryAfterSeconds,
      reasonCode: result.reasonCode,
      meta: {
        provider: result.providerUsed,
        timestamp: new Date().toISOString(),
        freshness: result.freshness,
      },
    });
    if (result.freshness.maxAgeSeconds !== null) {
      const staleWhileRevalidate = result.freshness.staleWhileRevalidateSeconds
        ?? result.freshness.maxAgeSeconds * 2;
      response.headers.set(
        'Cache-Control',
        `public, s-maxage=${result.freshness.maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidate}`,
      );
    }
    if (result.retryAfterSeconds > 0) {
      response.headers.set('Retry-After', String(result.retryAfterSeconds));
    }
    return response;
  } catch (cause) {
    const error = cause instanceof ZodError
      ? fromZodError(cause)
      : cause instanceof MarketDataError
        ? cause
        : new MarketDataError(
          'internal-error',
          'Unexpected company profile error',
        );
    const preservesOwnStatus = new Set([
      'invalid-request',
      'invalid-symbol',
      'not-found',
    ]).has(error.code);
    const status = error.code === 'rate-limited'
      ? 429
      : preservesOwnStatus ? error.status : 503;
    const retryAfterSeconds = error.retryAfterSeconds ?? 0;
    const response = NextResponse.json({
      data: null,
      status: 'unavailable',
      providerUsed: null,
      fallbackUsed: Boolean(error.context?.fallbackReason),
      cachedAt: null,
      retryAfterSeconds,
      reasonCode: error.context?.reason ?? error.code,
      error: error.toApiError(),
      meta: {
        provider: null,
        timestamp: new Date().toISOString(),
        freshness: unavailableFreshness,
      },
    }, { status });
    response.headers.set('Cache-Control', 'no-store');
    if (retryAfterSeconds > 0) {
      response.headers.set('Retry-After', String(retryAfterSeconds));
    }
    return response;
  }
}

export async function historicalMarketDataResponse(
  operation: () => Promise<ProviderResult<HistoricalPrices>>,
): Promise<NextResponse<MarketDataEnvelope<HistoricalPrices | HistoricalUnavailableData>>> {
  try {
    const result = await operation();
    const response = NextResponse.json({
      data: result.data,
      meta: {
        provider: result.provider ?? MARKET_DATA_PROVIDER_ID,
        timestamp: new Date().toISOString(),
        freshness: result.freshness,
      },
    });
    if (result.freshness.maxAgeSeconds !== null) {
      const staleWhileRevalidate = result.freshness.staleWhileRevalidateSeconds
        ?? result.freshness.maxAgeSeconds * 2;
      response.headers.set('Cache-Control', `public, s-maxage=${result.freshness.maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidate}`);
    }
    return response;
  } catch (cause) {
    const error = cause instanceof ZodError
      ? fromZodError(cause)
      : cause instanceof MarketDataError
        ? cause
        : new MarketDataError('internal-error', 'Unexpected historical market data error');
    const unavailable: HistoricalUnavailableData = {
      status: 'unavailable',
      reason: error.context?.reason ?? error.code,
      primaryReason: error.context?.primaryReason ?? 'PRIMARY_INVALID_RESPONSE',
      fallbackReason: error.context?.fallbackReason ?? 'FALLBACK_NETWORK_ERROR',
      retryable: error.retryable,
      retryAfter: error.retryAfterSeconds ? new Date(Date.now() + error.retryAfterSeconds * 1000).toISOString() : null,
      retryAfterSeconds: error.retryAfterSeconds ?? 0,
      lastAvailableAt: error.context?.lastAvailableAt ?? null,
    };
    const response = NextResponse.json({
      data: unavailable,
      error: error.toApiError(),
      meta: { provider: null, timestamp: new Date().toISOString(), freshness: unavailableFreshness },
    }, { status: error.status });
    response.headers.set('Cache-Control', 'no-store');
    if (error.retryAfterSeconds) response.headers.set('Retry-After', String(error.retryAfterSeconds));
    return response;
  }
}
