import { z } from 'zod';
import type {
  AnalystTargetProvider,
  AnalystTargetSnapshot,
  ProviderAvailabilityStatus,
} from './types';

const FINNHUB_BASE_URL = 'https://api.finnhub.io/api/v1';
const ALPHA_VANTAGE_URL = 'https://www.alphavantage.co/query';
const REQUEST_TIMEOUT_MS = 8_000;

const rowSchema = z.record(z.string(), z.unknown());

export type ProviderFailureKind = Exclude<ProviderAvailabilityStatus, 'available' | 'unconfigured'>;

export class ProviderRequestError extends Error {
  constructor(
    public readonly provider: AnalystTargetProvider,
    public readonly endpoint: 'stock/price-target' | 'OVERVIEW',
    public readonly kind: ProviderFailureKind,
    public readonly status: number | null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(`${provider} ${endpoint} failed: ${kind}`);
    this.name = 'ProviderRequestError';
  }
}

export interface ProviderRequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - Date.now()) / 1_000))
    : null;
}

function failureKind(status: number): ProviderFailureKind {
  if (status === 401 || status === 403) return 'not-entitled';
  if (status === 404) return 'unavailable';
  if (status === 429) return 'rate-limited';
  return 'provider-error';
}

export async function requestProviderJson(
  provider: AnalystTargetProvider,
  endpoint: 'stock/price-target' | 'OVERVIEW',
  url: URL,
  headers: HeadersInit,
  options: ProviderRequestOptions = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retries = Math.min(2, Math.max(0, options.retries ?? 1));
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        const kind = failureKind(response.status);
        const retryable = response.status >= 500 && response.status <= 599;
        if (retryable && attempt < retries) {
          await sleep(Math.min(1_000, 100 * 2 ** attempt));
          continue;
        }
        throw new ProviderRequestError(
          provider,
          endpoint,
          kind,
          response.status,
          retryAfterSeconds(response),
        );
      }
      try {
        return await response.json();
      } catch {
        throw new ProviderRequestError(provider, endpoint, 'provider-error', response.status);
      }
    } catch (cause) {
      if (cause instanceof ProviderRequestError) throw cause;
      if (attempt < retries) {
        await sleep(Math.min(1_000, 100 * 2 ** attempt));
        continue;
      }
      throw new ProviderRequestError(provider, endpoint, 'provider-error', null);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new ProviderRequestError(provider, endpoint, 'provider-error', null);
}

function objectPayload(
  provider: AnalystTargetProvider,
  endpoint: 'stock/price-target' | 'OVERVIEW',
  payload: unknown,
): Record<string, unknown> {
  const parsed = rowSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderRequestError(provider, endpoint, 'provider-error', 200);
  }
  return parsed.data;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized || normalized.toLowerCase() === 'none') return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function analystCount(value: unknown): number | null {
  const parsed = positiveNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function providerMessage(row: Record<string, unknown>): string {
  return [row.error, row.Information, row.Note, row['Error Message']]
    .find((value) => typeof value === 'string')?.toString().toLowerCase() ?? '';
}

function finnhubPayloadFailure(message: string): ProviderFailureKind | null {
  if (!message) return null;
  if (message.includes('limit') || message.includes('too many')) return 'rate-limited';
  if (
    message.includes('access')
    || message.includes('premium')
    || message.includes('permission')
    || message.includes('api key')
  ) return 'not-entitled';
  return 'provider-error';
}

function alphaPayloadFailure(message: string): ProviderFailureKind | null {
  if (!message) return null;
  if (
    message.includes('limit')
    || message.includes('frequency')
    || message.includes('call volume')
  ) return 'rate-limited';
  if (message.includes('invalid') || message.includes('api key')) return 'invalid-key';
  return 'provider-error';
}

export async function loadFinnhubPriceTarget(
  symbol: string,
  apiKey: string,
  options: ProviderRequestOptions = {},
): Promise<AnalystTargetSnapshot> {
  const endpoint = 'stock/price-target' as const;
  const url = new URL(`${FINNHUB_BASE_URL}/${endpoint}`);
  url.searchParams.set('symbol', symbol);
  const payload = await requestProviderJson(
    'finnhub',
    endpoint,
    url,
    { Accept: 'application/json', 'X-Finnhub-Token': apiKey },
    options,
  );
  const row = objectPayload('finnhub', endpoint, payload);
  const payloadFailure = finnhubPayloadFailure(providerMessage(row));
  if (payloadFailure) {
    throw new ProviderRequestError('finnhub', endpoint, payloadFailure, 200);
  }

  const responseSymbol = optionalString(row.symbol)?.toUpperCase() ?? null;
  const targetPrice = positiveNumber(row.targetMean);
  if (responseSymbol !== symbol || targetPrice === null) {
    throw new ProviderRequestError('finnhub', endpoint, 'unavailable', 200);
  }

  return {
    symbol: responseSymbol,
    targetPrice,
    medianTarget: positiveNumber(row.targetMedian),
    highTarget: positiveNumber(row.targetHigh),
    lowTarget: positiveNumber(row.targetLow),
    analystCount: analystCount(row.numberAnalysts),
    provider: 'finnhub',
    providerLabel: 'Finnhub',
    currency: null,
    lastUpdated: optionalString(row.lastUpdated),
  };
}

export async function loadAlphaVantagePriceTarget(
  symbol: string,
  apiKey: string,
  options: ProviderRequestOptions = {},
): Promise<AnalystTargetSnapshot> {
  const endpoint = 'OVERVIEW' as const;
  const url = new URL(ALPHA_VANTAGE_URL);
  url.searchParams.set('function', endpoint);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', apiKey);
  const payload = await requestProviderJson(
    'alpha-vantage',
    endpoint,
    url,
    { Accept: 'application/json' },
    options,
  );
  const row = objectPayload('alpha-vantage', endpoint, payload);
  const payloadFailure = alphaPayloadFailure(providerMessage(row));
  if (payloadFailure) {
    throw new ProviderRequestError('alpha-vantage', endpoint, payloadFailure, 200);
  }

  const responseSymbol = optionalString(row.Symbol)?.toUpperCase() ?? null;
  const targetPrice = positiveNumber(row.AnalystTargetPrice);
  if (responseSymbol !== symbol || targetPrice === null) {
    throw new ProviderRequestError('alpha-vantage', endpoint, 'unavailable', 200);
  }

  return {
    symbol: responseSymbol,
    targetPrice,
    medianTarget: null,
    highTarget: null,
    lowTarget: null,
    analystCount: null,
    provider: 'alpha-vantage',
    providerLabel: 'Alpha Vantage',
    currency: optionalString(row.Currency)?.toUpperCase() ?? null,
    lastUpdated: null,
  };
}

export function availabilityStatus(error: unknown): ProviderFailureKind {
  return error instanceof ProviderRequestError ? error.kind : 'provider-error';
}
