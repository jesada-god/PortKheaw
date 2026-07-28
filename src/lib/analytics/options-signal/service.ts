import 'server-only';

import { loadEarningsSchedule } from '@/src/lib/analytics/earnings/service';
import { getCandleMarketDataService } from '@/src/lib/market-data/candles';
import type { DataFreshness } from '@/src/lib/market-data/types';
import type { OptionsSignalServerContext } from './assemble';
import { OPTIONS_SIGNAL_CONFIG } from './config';
import type { EventRiskInput, OptionsSignalInputSlot } from './types';
import {
  buildMacroInput,
  buildUnderlyingInputs,
  type MacroBenchmarkSource,
  type UnderlyingCandle,
} from './underlying';

const UNAVAILABLE_FRESHNESS: DataFreshness = { status: 'unavailable', asOf: null, maxAgeSeconds: null };

interface DailySeries {
  candles: UnderlyingCandle[];
  provider: string | null;
  freshness: DataFreshness;
}

/**
 * One canonical daily dataset per symbol, from the SAME cached candle service
 * the Market Signal and chart already use. Opening the Analysis tab therefore
 * adds no provider request for a symbol the page has already loaded, and the
 * SPY/QQQ benchmarks are shared by every stock page on the instance.
 */
async function loadDailySeries(symbol: string): Promise<DailySeries> {
  try {
    const result = await getCandleMarketDataService().getCandles({
      symbol,
      interval: '1D',
      range: '5y',
      adjusted: true,
      session: 'regular',
    });
    return {
      candles: result.data.candles.map((candle) => ({
        date: new Date(candle.timestamp * 1_000).toISOString().slice(0, 10),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Math.round(candle.volume),
        finalized: candle.partial !== true,
      })),
      provider: result.provider ?? result.data.provider,
      freshness: result.freshness,
    };
  } catch {
    return { candles: [], provider: null, freshness: UNAVAILABLE_FRESHNESS };
  }
}

function eventSlot(
  schedule: Awaited<ReturnType<typeof loadEarningsSchedule>>,
): OptionsSignalInputSlot<EventRiskInput> {
  if (schedule.status === 'unavailable') {
    return {
      status: 'unavailable',
      state: 'UNAVAILABLE',
      reason: schedule.message,
      provider: schedule.provider,
      asOf: schedule.asOf,
    };
  }
  return {
    status: 'available',
    // The calendar is published ahead of time, so it is never "live" — a value
    // recovered from cache after a provider failure is disclosed as STALE.
    state: schedule.stale ? 'STALE' : 'DELAYED',
    value: {
      reportDate: schedule.reportDate,
      daysToEarnings: schedule.daysToEarnings,
      timeOfDay: schedule.timeOfDay,
    },
    provider: schedule.provider,
    asOf: schedule.asOf,
  };
}

/**
 * Load every server-derived Options Signal input for `symbol`.
 *
 * Never throws: each source degrades into its own typed unavailable slot so a
 * missing benchmark or earnings calendar reduces coverage instead of hiding the
 * whole card.
 */
export async function loadOptionsSignalContext(
  symbol: string,
  options: { now?: () => Date } = {},
): Promise<OptionsSignalServerContext> {
  const calculatedAt = (options.now ?? (() => new Date()))().toISOString();
  const benchmarkSymbols = OPTIONS_SIGNAL_CONFIG.macroBenchmarks;

  const [primary, ...benchmarks] = await Promise.all([
    loadDailySeries(symbol),
    ...benchmarkSymbols.map((benchmark) => loadDailySeries(benchmark)),
  ]);
  const schedule = await loadEarningsSchedule(symbol).catch(() => null);

  const underlying = buildUnderlyingInputs(primary.candles, {
    symbol,
    provider: primary.provider,
    freshness: primary.freshness,
    calculatedAt,
  });

  const macroSources: MacroBenchmarkSource[] = benchmarkSymbols.map((benchmarkSymbol, index) => ({
    symbol: benchmarkSymbol,
    candles: benchmarks[index]?.candles ?? [],
    provider: benchmarks[index]?.provider ?? null,
    freshness: benchmarks[index]?.freshness ?? UNAVAILABLE_FRESHNESS,
  }));

  return {
    symbol,
    timeframe: '1D',
    calculatedAt,
    latestCandleAt: underlying.latestCandleAt,
    finalizedCandles: underlying.finalizedCandles,
    macro: buildMacroInput(macroSources, calculatedAt),
    trend: underlying.trend,
    momentum: underlying.momentum,
    levels: underlying.levels,
    event: schedule
      ? eventSlot(schedule)
      : {
        status: 'unavailable',
        state: 'UNAVAILABLE',
        reason: 'ดึงวันประกาศงบจากผู้ให้บริการไม่สำเร็จ',
        provider: null,
        asOf: null,
      },
    realizedVolatility: underlying.realizedVolatility,
  };
}
