import { describe, expect, it, vi } from 'vitest';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { MarketDataError } from '../errors';
import { FMP_CANDLE_CAPABILITIES, YAHOO_CANDLE_CAPABILITIES } from './capabilities';
import type { CandleRequest, NormalizedCandleResult, NormalizedMarketDataProvider, ProviderCapabilities } from './contracts';
import { CandleMarketDataService } from './service';

const start = Date.parse('2021-07-21T00:00:00.000Z') / 1_000;
function result(provider: string, input: CandleRequest & { sourceInterval: CandleRequest['interval'] }): NormalizedCandleResult {
  return {
    symbol: input.symbol, provider, attemptedProviders: [provider], requestedInterval: input.interval,
    actualInterval: input.sourceInterval, sourceInterval: input.sourceInterval, requestedRange: input.range,
    actualStart: start, actualEnd: start + 86_400, exchangeTimezone: 'America/New_York', currency: 'USD',
    dataStatus: 'end-of-day', delayedByMinutes: null, adjusted: Boolean(input.adjusted), aggregated: false,
    cacheStatus: 'miss', fallbackReason: null, warnings: [], candles: [
      { timestamp: start, open: 10, high: 12, low: 9, close: 11, adjustedClose: 11, volume: 100 },
      { timestamp: start + 86_400, open: 11, high: 13, low: 10, close: 12, adjustedClose: 12, volume: 200 },
    ],
  };
}

function provider(id: string, capabilities: ProviderCapabilities, implementation?: NormalizedMarketDataProvider['getCandles']): NormalizedMarketDataProvider {
  return { id, getCapabilities: () => capabilities, getCandles: implementation ?? (async (input) => result(id, input)) };
}

describe('candle provider service', () => {
  it('uses deterministic provider order and never mixes a successful series', async () => {
    const first = provider('first', YAHOO_CANDLE_CAPABILITIES);
    const secondCall = vi.fn(async (input) => result('second', input));
    const service = new CandleMarketDataService([first, provider('second', YAHOO_CANDLE_CAPABILITIES, secondCall)]);
    const response = await service.getCandles({ symbol: 'AAPL', interval: '1D', range: '5y', adjusted: true, session: 'regular' });
    expect(response.data.provider).toBe('first');
    expect(response.data.attemptedProviders).toEqual(['first']);
    expect(secondCall).not.toHaveBeenCalled();
  });

  it('falls back after entitlement failure and circuit-breaks that operation', async () => {
    const denied = vi.fn(async () => { throw new MarketDataError('forbidden', 'not entitled'); });
    const fallback = vi.fn(async (input) => result('fallback', input));
    const service = new CandleMarketDataService([
      provider('denied', YAHOO_CANDLE_CAPABILITIES, denied),
      provider('fallback', YAHOO_CANDLE_CAPABILITIES, fallback),
    ], new SharedRequestCache());
    const input = { symbol: 'AAPL', interval: '1D', range: '5y', adjusted: true, session: 'regular' } as const;
    expect((await service.getCandles(input)).data.fallbackReason).toContain('denied:entitlement-unavailable');
    await service.getCandles({ ...input, symbol: 'MSFT' });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('respects Retry-After cooldown and then retries the provider', async () => {
    let now = 1_000;
    const limited = vi.fn(async (input) => {
      if (limited.mock.calls.length === 1) throw new MarketDataError('rate-limited', 'slow down', 10);
      return result('limited', input);
    });
    const fallback = vi.fn(async (input) => result('fallback', input));
    const service = new CandleMarketDataService([
      provider('limited', YAHOO_CANDLE_CAPABILITIES, limited), provider('fallback', YAHOO_CANDLE_CAPABILITIES, fallback),
    ], new SharedRequestCache(), () => now);
    const input = { symbol: 'AAPL', interval: '1D', range: '1y', adjusted: true, session: 'regular' } as const;
    expect((await service.getCandles(input)).data.provider).toBe('fallback');
    expect((await service.getCandles({ ...input, symbol: 'MSFT' })).data.provider).toBe('fallback');
    now += 11_000;
    expect((await service.getCandles({ ...input, symbol: 'NVDA' })).data.provider).toBe('limited');
    expect(limited).toHaveBeenCalledTimes(2);
  });

  it.each(['1D', 'Week', 'Month'] as const)('serves %s + 5Y with actual range metadata', async (interval) => {
    const service = new CandleMarketDataService([provider('yahoo', YAHOO_CANDLE_CAPABILITIES)]);
    const response = await service.getCandles({ symbol: 'AAPL', interval, range: '5y', adjusted: true, session: 'regular' });
    expect(response.data.requestedRange).toBe('5y');
    expect(response.data.actualStart).toBe(start);
    expect(response.data.actualEnd).not.toBeNull();
  });

  it('does not call any provider for unsupported daily-to-intraday substitution', async () => {
    const call = vi.fn(async (input) => result('daily-only', input));
    const dailyOnly: ProviderCapabilities = { ...FMP_CANDLE_CAPABILITIES, intervals: FMP_CANDLE_CAPABILITIES.intervals.filter((item) => item.interval === '1D') };
    const service = new CandleMarketDataService([provider('daily-only', dailyOnly, call)]);
    await expect(service.getCandles({ symbol: 'AAPL', interval: '1m', range: '1d', adjusted: false, session: 'regular' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(call).not.toHaveBeenCalled();
  });

  it('reuses one rolling-range request key instead of refetching as period bounds advance', async () => {
    let now = Date.parse('2026-07-24T12:00:00.000Z');
    const call = vi.fn(async (input) => result('yahoo', input));
    const service = new CandleMarketDataService([
      provider('yahoo', YAHOO_CANDLE_CAPABILITIES, call),
    ], new SharedRequestCache(), () => now);
    const input = { symbol: 'AAPL', interval: '5m', range: '1m', adjusted: false, session: 'extended' } as const;

    await service.getCandles(input);
    now += 12_000;
    await service.getCandles(input);

    expect(call).toHaveBeenCalledTimes(1);
  });
});
