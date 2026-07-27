import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { MarketDataError } from '../errors';
import type { ProviderResult } from '../types';
import { aggregateCandles } from './aggregate';
import { sourceIntervalFor, supportsCandleRequest } from './capabilities';
import { normalizedCandleResultSchema, type CandleRequest, type NormalizedCandleResult, type NormalizedMarketDataProvider } from './contracts';
import {
  candleRangeBounds,
  canonicalCandleBounds,
  canonicalCandleRange,
  latestTradingDayCandles,
} from './range';

const INTRADAY_INTERVALS = new Set(['1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m', '1h', '2h', '3h', '4h']);
const INTRADAY_POLICY = { freshMs: 60_000, staleMs: 15 * 60_000, errorMs: 30_000 } as const;
const HISTORICAL_POLICY = { freshMs: 6 * 60 * 60_000, staleMs: 7 * 24 * 60 * 60_000, errorMs: 30_000 } as const;

function errorPriority(error: MarketDataError): number {
  return error.code === 'rate-limited' ? 7
    : error.code === 'provider-unauthorized' || error.code === 'forbidden' ? 6
      : error.code === 'timeout' ? 5
        : error.code === 'upstream-unavailable' || error.code === 'provider-unavailable' ? 4
          : error.code === 'invalid-provider-response' ? 3
            : error.code === 'insufficient-data' ? 2 : 1;
}

function publicFailure(error: MarketDataError): string {
  if (error.code === 'forbidden' || error.code === 'provider-unauthorized') return 'entitlement-unavailable';
  if (error.code === 'rate-limited') return 'rate-limited';
  if (error.code === 'unsupported') return 'unsupported';
  if (error.code === 'insufficient-data' || error.code === 'not-found') return 'no-data';
  return 'provider-unavailable';
}

export class CandleMarketDataService {
  private readonly blockedUntil = new Map<string, number>();

  constructor(
    private readonly providers: readonly NormalizedMarketDataProvider[],
    private readonly cache = new SharedRequestCache(),
    private readonly now: () => number = Date.now,
  ) {}

  async getCandles(input: CandleRequest): Promise<ProviderResult<NormalizedCandleResult>> {
    const effectiveRange = canonicalCandleRange(input.interval, input.range);
    const effectiveInput = effectiveRange === input.range ? input : { ...input, range: effectiveRange };
    const failures: MarketDataError[] = [];
    const attemptedProviders: string[] = [];
    const fallbackReasons: string[] = [];
    let explicitBounds = false;
    let bounds: { period1: number; period2: number };
    if (input.period1 !== undefined && input.period2 !== undefined) {
      explicitBounds = true;
      bounds = canonicalCandleBounds(input.interval, { period1: input.period1, period2: input.period2 });
    } else {
      bounds = candleRangeBounds(effectiveRange, new Date(this.now()));
    }

    for (const provider of this.providers) {
      const capabilities = provider.getCapabilities();
      if (!supportsCandleRequest(capabilities, input.interval, effectiveRange, Boolean(input.adjusted), input.session ?? 'regular')) continue;
      const sourceInterval = sourceIntervalFor(capabilities, input.interval);
      if (!sourceInterval) continue;
      const circuitKey = `${provider.id}:${sourceInterval}:${Boolean(input.adjusted)}:${input.session ?? 'regular'}`;
      const blockedUntil = this.blockedUntil.get(circuitKey) ?? 0;
      if (blockedUntil > this.now()) {
        fallbackReasons.push(`${provider.id}:cooldown`);
        continue;
      }
      attemptedProviders.push(provider.id);
      const cacheKey = [
        'candles', provider.id, input.symbol, input.interval, sourceInterval, effectiveRange,
        explicitBounds ? bounds.period1 : 'rolling-range',
        explicitBounds ? bounds.period2 : 'rolling-range',
        Boolean(input.adjusted), input.session ?? 'regular',
      ].join(':');
      try {
        const resolution = await this.cache.resolve(
          cacheKey,
          () => provider.getCandles({ ...effectiveInput, ...bounds, sourceInterval }),
          INTRADAY_INTERVALS.has(input.interval) ? INTRADAY_POLICY : HISTORICAL_POLICY,
        );
        const bucketed = aggregateCandles(
          resolution.value.candles,
          input.interval,
          sourceInterval,
          resolution.value.exchangeTimezone,
        );
        // `1d` is "the most recent trading session", so the rolling window is
        // fetched wide enough to always contain one and then trimmed to its newest
        // exchange-local date. Explicit period bounds are the caller's own window
        // and are never trimmed.
        const latestSessionOnly = !explicitBounds && input.range === '1d';
        const aggregatedWithPartial = latestSessionOnly
          ? latestTradingDayCandles(bucketed, resolution.value.exchangeTimezone)
          : bucketed;
        // Historical higher-timeframe series consist only of finalized candles.
        // The provider may include the still-forming current week/month; it is
        // retained in the raw provider result but never returned as history.
        const aggregated = input.interval === 'Week' || input.interval === 'Month'
          ? aggregatedWithPartial.filter((candle) => candle.partial !== true)
          : aggregatedWithPartial;
        if (!aggregated.length) throw new MarketDataError('insufficient-data', 'No candles remain after validated aggregation');
        const cacheStatus = resolution.state === 'fresh' ? 'miss' as const : resolution.state === 'cache' ? 'hit' as const : 'stale' as const;
        const dataStatus = resolution.state === 'stale' ? 'stale' as const
          : resolution.state === 'cache' ? 'cached' as const : resolution.value.dataStatus;
        const warnings = [
          ...resolution.value.warnings,
          ...(resolution.state === 'stale' ? ['Serving stale candles after a provider failure'] : []),
        ];
        const requestedStart = bounds.period1;
        const toleranceSeconds = INTRADAY_INTERVALS.has(input.interval) ? 2 * 86_400 : 10 * 86_400;
        // The `1d` window is deliberately wider than the session it returns, so a
        // trimmed result is complete by definition, not partially loaded.
        if (!latestSessionOnly
          && (aggregated[0]?.timestamp ?? Number.POSITIVE_INFINITY) > requestedStart + toleranceSeconds) {
          warnings.push('Historical data loaded only partially; inspect actualStart and actualEnd');
        }
        const data = normalizedCandleResultSchema.parse({
          ...resolution.value,
          attemptedProviders,
          requestedInterval: input.interval,
          actualInterval: input.interval,
          sourceInterval,
          requestedRange: effectiveRange,
          actualStart: aggregated[0]?.timestamp ?? null,
          actualEnd: aggregated.at(-1)?.timestamp ?? null,
          dataStatus,
          adjusted: Boolean(input.adjusted),
          aggregated: input.interval !== sourceInterval,
          cacheStatus,
          candles: aggregated,
          warnings,
          fallbackReason: fallbackReasons.length ? fallbackReasons.join('; ') : null,
        });
        const maxAgeSeconds = INTRADAY_INTERVALS.has(input.interval) ? 60 : 21_600;
        return {
          data,
          provider: data.provider,
          freshness: {
            status: data.dataStatus === 'live' ? 'realtime' : data.dataStatus,
            asOf: data.actualEnd ? new Date(data.actualEnd * 1_000).toISOString() : null,
            maxAgeSeconds,
            staleWhileRevalidateSeconds: INTRADAY_INTERVALS.has(input.interval) ? 900 : 604_800,
          },
        };
      } catch (cause) {
        const error = cause instanceof MarketDataError
          ? cause : new MarketDataError('provider-unavailable', 'Candle provider failed');
        failures.push(error);
        fallbackReasons.push(`${provider.id}:${publicFailure(error)}`);
        if (error.code === 'forbidden' || error.code === 'provider-unauthorized') {
          this.blockedUntil.set(circuitKey, Number.POSITIVE_INFINITY);
        } else if (error.code === 'rate-limited') {
          this.blockedUntil.set(circuitKey, this.now() + (error.retryAfterSeconds ?? 60) * 1_000);
        }
      }
    }

    if (!attemptedProviders.length && !fallbackReasons.length) {
      throw new MarketDataError('unsupported', 'No configured provider supports this timeframe/range/adjustment combination');
    }
    const error = failures.sort((left, right) => errorPriority(right) - errorPriority(left))[0]
      ?? new MarketDataError('provider-unavailable', 'All candle providers are in cooldown');
    throw new MarketDataError(
      error.code,
      error.message,
      error.retryAfterSeconds,
      undefined,
      { reason: fallbackReasons.join('; '), fallbackReason: fallbackReasons.join('; ') },
    );
  }
}
