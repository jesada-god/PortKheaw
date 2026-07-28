import { MarketDataError, mapProviderFailure } from '@/src/lib/market-data/errors';
import {
  alphaVantageNotice,
  parseAlphaVantageEarningsCsv,
  parseFinancialModelingPrepEarnings,
} from './normalize';
import type { EarningsCandidate, EarningsProviderId } from './types';

const ALPHA_VANTAGE_URL = 'https://www.alphavantage.co/query';
const FMP_URL = 'https://financialmodelingprep.com/stable/earnings';
const TIMEOUT_MS = 10_000;

export interface EarningsProviderRequest {
  symbol: string;
  apiKey: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

export interface EarningsProviderResponse {
  provider: EarningsProviderId;
  candidates: EarningsCandidate[];
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Alpha Vantage `EARNINGS_CALENDAR` returns CSV on success and a JSON note for
 * rate limits / premium refusals. The JSON branch is routed through the shared
 * failure mapper so an entitlement refusal is never retried as a quota error.
 */
export async function loadAlphaVantageEarnings(
  request: EarningsProviderRequest,
): Promise<EarningsProviderResponse> {
  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set('function', 'EARNINGS_CALENDAR');
  url.searchParams.set('symbol', request.symbol);
  url.searchParams.set('horizon', '3month');
  url.searchParams.set('apikey', request.apiKey);

  let response: Response;
  try {
    // Alpha Vantage answers `Accept: text/csv` with HTTP 406 even though the
    // endpoint returns CSV. It negotiates on `application/json` and then sends
    // the CSV body anyway, so that is the header the live endpoint requires.
    response = await (request.fetcher ?? fetch)(url, {
      headers: { Accept: 'application/json' },
      signal: combinedSignal(request.signal),
      cache: 'no-store',
    });
  } catch (cause) {
    throw mapProviderFailure({ cause });
  }
  const body = await response.text();
  if (!response.ok) {
    throw mapProviderFailure({ status: response.status, payload: safeJson(body) ?? body });
  }
  if (body.trimStart().startsWith('{')) {
    throw mapProviderFailure({ status: response.status, payload: safeJson(body) ?? body });
  }
  // The CSV endpoint truncates its notices to the header width, so the surviving
  // text ("Informa") cannot be classified as quota vs plan. It is reported as a
  // retryable upstream fault rather than guessed at, and never as "no report".
  if (alphaVantageNotice(body)) {
    throw new MarketDataError(
      'upstream-unavailable',
      'Alpha Vantage returned a service notice instead of the earnings calendar',
    );
  }
  return { provider: 'alpha-vantage', candidates: parseAlphaVantageEarningsCsv(body, request.symbol) };
}

/** Financial Modeling Prep `stable/earnings`, the secondary source. */
export async function loadFinancialModelingPrepEarnings(
  request: EarningsProviderRequest,
): Promise<EarningsProviderResponse> {
  const url = new URL(FMP_URL);
  url.searchParams.set('symbol', request.symbol);
  url.searchParams.set('apikey', request.apiKey);

  let response: Response;
  try {
    response = await (request.fetcher ?? fetch)(url, {
      headers: { Accept: 'application/json' },
      signal: combinedSignal(request.signal),
      cache: 'no-store',
    });
  } catch (cause) {
    throw mapProviderFailure({ cause });
  }
  const body = await response.text();
  const payload = safeJson(body);
  if (!response.ok) throw mapProviderFailure({ status: response.status, payload: payload ?? body });
  // FMP signals plan/quota faults as a JSON object rather than the expected array.
  if (!Array.isArray(payload)) {
    if (payload && typeof payload === 'object') {
      throw mapProviderFailure({ status: response.status, payload });
    }
    throw new MarketDataError('invalid-provider-response', 'FMP earnings returned a non-array payload');
  }
  return {
    provider: 'financial-modeling-prep',
    candidates: parseFinancialModelingPrepEarnings(payload, request.symbol),
  };
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}
