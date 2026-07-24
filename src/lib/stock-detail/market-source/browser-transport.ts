import {
  normalizedCandleResultSchema,
  type CandleDataStatus,
} from '@/src/lib/market-data/candles/contracts';
import { quoteEnvelopeSchema } from '@/src/lib/stock-detail/api-schemas';
import type { MarketDataApiError } from '@/src/lib/market-data/types';
import type {
  AggregateValue,
  MarketSourceTransport,
  SnapshotValue,
  TransportFreshness,
  TransportOutcome,
} from './types';

function freshnessFromQuote(status: string): TransportFreshness {
  switch (status) {
    case 'realtime':
    case 'delayed':
    case 'end-of-day':
    case 'cached':
    case 'stale':
      return status;
    default:
      return 'unknown';
  }
}

function freshnessFromBars(status: CandleDataStatus): TransportFreshness {
  switch (status) {
    case 'live':
      return 'realtime';
    case 'delayed':
      return 'delayed';
    case 'end-of-day':
      return 'end-of-day';
    case 'cached':
      return 'cached';
    case 'stale':
      return 'stale';
    default:
      return 'unknown';
  }
}

function errorFromEnvelope(
  response: Response,
  envelopeError: { code?: string; message?: string; retryable?: boolean; retryAfterSeconds?: number } | undefined,
): { error: MarketDataApiError; retryAfterSeconds: number | null } {
  const headerRetry = Number(response.headers.get('Retry-After') ?? 0);
  const retryAfterSeconds = envelopeError?.retryAfterSeconds ?? (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : null);
  const error: MarketDataApiError = {
    code: (envelopeError?.code as MarketDataApiError['code']) ?? 'upstream-unavailable',
    message: envelopeError?.message ?? 'Market data request failed',
    retryable: envelopeError?.retryable ?? response.status >= 500,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
  return { error, retryAfterSeconds };
}

/**
 * REST transport for the Stock Detail live price. Uses only entitled endpoints:
 * `/api/market/quote/[symbol]` for the snapshot and the server-side Yahoo Chart
 * JSON pipeline at `/api/market/candles` for the verified aggregate that drives
 * the active candle and fallback price.
 */
export function createBrowserMarketTransport(): MarketSourceTransport {
  return {
    async fetchSnapshot({ symbol, signal }): Promise<TransportOutcome<SnapshotValue>> {
      const response = await fetch(`/api/market/quote/${encodeURIComponent(symbol)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal,
      });
      const payload = await response.json();
      const parsed = quoteEnvelopeSchema.safeParse(payload);
      if (!response.ok || !parsed.success || !parsed.data.data) {
        const envelopeError = parsed.success ? parsed.data.error : (payload?.error as never);
        return { ok: false, ...errorFromEnvelope(response, envelopeError) };
      }
      const quote = parsed.data.data;
      return {
        ok: true,
        value: {
          quote,
          price: quote.price,
          provider: parsed.data.meta.provider,
          status: freshnessFromQuote(parsed.data.meta.freshness.status),
          asOf: parsed.data.meta.freshness.asOf,
        },
      };
    },

    async fetchAggregate({ symbol, interval, session, range, adjusted, signal }): Promise<TransportOutcome<AggregateValue>> {
      const query = new URLSearchParams({ symbol, interval, range, adjusted: String(adjusted), session });
      const response = await fetch(`/api/market/candles?${query.toString()}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        return { ok: false, ...errorFromEnvelope(response, payload?.error) };
      }
      const parsed = normalizedCandleResultSchema.safeParse(payload?.data);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: 'invalid-provider-response', message: 'Chart response failed validation', retryable: false },
          retryAfterSeconds: null,
        };
      }
      const bars = parsed.data;
      return {
        ok: true,
        value: {
          bars: bars.candles.map((bar) => ({
            time: bar.timestamp,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
          })),
          provider: bars.provider,
          status: freshnessFromBars(bars.dataStatus),
          asOf: bars.actualEnd ? new Date(bars.actualEnd * 1_000).toISOString() : null,
        },
      };
    },
  };
}
