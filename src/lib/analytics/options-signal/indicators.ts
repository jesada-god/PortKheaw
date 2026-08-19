import { bollingerBands, keltnerChannels, sma } from '@/src/lib/analytics/technical/calculations';
import { isSqueezeOn } from '@/src/lib/analytics/market-signal/calculations';
import type { HistoricalPrice } from '@/src/lib/market-data/types';
import { OPTIONS_SIGNAL_CONFIG } from './config';
import type { SqueezeState } from './types';

/**
 * The two indicators the Options Signal Engine needs that the shared technical
 * library does not already expose: the TTM squeeze *state machine* (the existing
 * library reports only whether the latest bar is compressed) and the TTM squeeze
 * momentum histogram that gives a release its direction.
 *
 * Both are built on the EXISTING primitives (`bollingerBands`, `keltnerChannels`,
 * `sma`, `isSqueezeOn`), so there is exactly one implementation of each band in
 * the codebase.
 */

export interface TtmSqueezeSeries {
  /** Per-candle compression flag; `null` before the bands have enough history. */
  compressed: Array<boolean | null>;
  /** Per-candle TTM momentum histogram; `null` before it can be computed. */
  momentum: Array<number | null>;
}

/** Least-squares fit over `values`, evaluated at the newest point. */
export function linearRegressionEndpoint(values: readonly number[]): number | null {
  const count = values.length;
  if (count < 2 || values.some((value) => !Number.isFinite(value))) return null;
  const meanX = (count - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < count; index += 1) {
    const deltaX = index - meanX;
    covariance += deltaX * (values[index] - meanY);
    variance += deltaX * deltaX;
  }
  if (variance === 0) return null;
  const slope = covariance / variance;
  return meanY + slope * (count - 1 - meanX);
}

/**
 * TTM squeeze momentum (Carter): the linear-regression endpoint of the close's
 * distance from the midpoint between the Donchian mid-line and the SMA.
 */
export function ttmMomentumSeries(
  candles: readonly HistoricalPrice[],
  period: number,
): Array<number | null> {
  const closes = candles.map((candle) => candle.close);
  const closeSma = sma(closes, period);
  const deltas = candles.map((candle, index): number | null => {
    if (index < period - 1) return null;
    const window = candles.slice(index - period + 1, index + 1);
    const highest = Math.max(...window.map((item) => item.high));
    const lowest = Math.min(...window.map((item) => item.low));
    const average = closeSma[index];
    if (average === null || !Number.isFinite(highest) || !Number.isFinite(lowest)) return null;
    return candle.close - ((highest + lowest) / 2 + average) / 2;
  });

  return deltas.map((_value, index) => {
    if (index < period * 2 - 2) return null;
    const window = deltas.slice(index - period + 1, index + 1);
    if (window.some((value) => value === null)) return null;
    return linearRegressionEndpoint(window as number[]);
  });
}

/**
 * Per-candle squeeze compression and momentum, aligned index-for-index with the
 * supplied FINALIZED candles.
 */
export function ttmSqueezeSeries(
  candles: readonly HistoricalPrice[],
  options: {
    period?: number;
    standardDeviations?: number;
    atrPeriod?: number;
    atrMultiplier?: number;
  } = {},
): TtmSqueezeSeries {
  const period = options.period ?? 20;
  const bands = bollingerBands(candles.map((candle) => candle.close), period, options.standardDeviations ?? 2);
  const channels = keltnerChannels(candles, period, options.atrPeriod ?? 14, options.atrMultiplier ?? 1.5);
  return {
    compressed: candles.map((_candle, index) => isSqueezeOn(bands[index] ?? null, channels[index] ?? null)),
    momentum: ttmMomentumSeries(candles, period),
  };
}

/**
 * Collapse the compression series into the four states the engine reasons about.
 *
 * A squeeze that is still ON is compression — deliberately NOT a direction. A
 * release only becomes `FIRED_*` when the momentum histogram at the release has
 * a definite sign; a release with flat or unavailable momentum stays `OFF`.
 */
export function classifySqueezeState(series: TtmSqueezeSeries, lookbackBars = OPTIONS_SIGNAL_CONFIG.momentum.firedLookbackBars): SqueezeState | null {
  const latestIndex = series.compressed.length - 1;
  if (latestIndex < 0) return null;
  const latest = series.compressed[latestIndex];
  if (latest === null) return null;
  if (latest) return 'ON';

  const earliest = Math.max(0, latestIndex - lookbackBars);
  const releasedRecently = series.compressed
    .slice(earliest, latestIndex)
    .some((value) => value === true);
  if (!releasedRecently) return 'OFF';

  const momentum = series.momentum[latestIndex];
  if (momentum === null || momentum === 0) return 'OFF';
  return momentum > 0 ? 'FIRED_BULLISH' : 'FIRED_BEARISH';
}

/**
 * Annualized realized volatility from close-to-close log returns over the most
 * recent `window` finalized candles. Returns `null` rather than a partial-window
 * estimate when there is not enough real history.
 */
export function realizedVolatility(
  candles: readonly HistoricalPrice[],
  window: number,
  minimumObservations: number,
): { value: number; observations: number } | null {
  const closes = candles.map((candle) => candle.close).filter((close) => Number.isFinite(close) && close > 0);
  const returns: number[] = [];
  for (let index = Math.max(1, closes.length - window); index < closes.length; index += 1) {
    returns.push(Math.log(closes[index] / closes[index - 1]));
  }
  if (returns.length < minimumObservations) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  if (!Number.isFinite(variance) || variance < 0) return null;
  return { value: Math.sqrt(variance) * Math.sqrt(252), observations: returns.length };
}

/**
 * Where `value` sits inside `history`, as a fraction in [0, 1].
 *
 * The share of observations at or below the value — the ordinary empirical
 * percentile. Returns `null` rather than an estimate when there are fewer than
 * `minimumObservations` real readings, because a "percentile" drawn from four
 * days is a number with a misleading name rather than a weak measurement.
 */
export function percentileRank(
  value: number,
  history: readonly number[],
  minimumObservations: number,
): { percentile: number; observations: number } | null {
  if (!Number.isFinite(value)) return null;
  const usable = history.filter((entry) => Number.isFinite(entry));
  if (usable.length < minimumObservations) return null;
  const atOrBelow = usable.filter((entry) => entry <= value).length;
  return { percentile: atOrBelow / usable.length, observations: usable.length };
}
