/**
 * The price series behind the technical chart.
 *
 * A chart type only decides which lightweight-charts series draws the bars and
 * how it is styled. The bar array itself is the same canonical OHLCV in every
 * case, so volume, EMA/RSI/MACD, VPVR and S/R are untouched by the choice —
 * switching type is a redraw, never a refetch.
 *
 * The `ISeriesApi<SeriesType, Time>` union and the cast-per-shape write helpers
 * follow the pattern already proven in `chart-series-manager.ts`.
 */

import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { CanonicalDisplayMode, DisplayBar } from '@/src/lib/analytics/canonical-bars';

export type PriceSeries = ISeriesApi<SeriesType, Time>;

/** Series shapes that need a distinct lightweight-charts series instance. */
export type PriceSeriesKind = 'candlestick' | 'hollow-candles' | 'ohlc' | 'line' | 'area';

const UP = '#00c57f';
const DOWN = '#ff3b30';
const ACCENT = '#D4FF00';

/**
 * Candlestick and Heikin-Ashi share one series: they differ only in the numbers
 * `toDisplayBars` produces, so switching between them must not recreate it.
 */
export function priceSeriesKind(chartType: CanonicalDisplayMode): PriceSeriesKind {
  return chartType === 'heikin-ashi' ? 'candlestick' : chartType;
}

export function addPriceSeries(chart: IChartApi, kind: PriceSeriesKind, pane = 0): PriceSeries {
  const shared = { lastValueVisible: true, priceLineVisible: false } as const;
  if (kind === 'line') {
    return chart.addSeries(LineSeries, { ...shared, color: ACCENT, lineWidth: 2 }, pane);
  }
  if (kind === 'area') {
    return chart.addSeries(AreaSeries, {
      ...shared, lineColor: ACCENT, topColor: '#D4FF0055', bottomColor: '#D4FF0000', lineWidth: 2,
    }, pane);
  }
  if (kind === 'ohlc') {
    return chart.addSeries(BarSeries, { ...shared, upColor: UP, downColor: DOWN, thinBars: false }, pane);
  }
  // Hollow candles keep the real body outline and leave rising bodies unfilled,
  // which is what makes a long wick — and therefore a rejected level — easier to
  // read at a glance.
  const hollow = kind === 'hollow-candles';
  return chart.addSeries(CandlestickSeries, {
    ...shared,
    upColor: hollow ? 'transparent' : UP,
    downColor: DOWN,
    borderVisible: hollow,
    borderUpColor: UP,
    borderDownColor: DOWN,
    wickUpColor: UP,
    wickDownColor: DOWN,
  }, pane);
}

function ohlcPoint(bar: DisplayBar) {
  return {
    time: bar.time as UTCTimestamp as Time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

function valuePoint(bar: DisplayBar) {
  return { time: bar.time as UTCTimestamp as Time, value: bar.close };
}

/** Line and area carry the closing value only; every other form carries OHLC. */
export function priceSeriesData(kind: PriceSeriesKind, bars: readonly DisplayBar[]) {
  return kind === 'line' || kind === 'area' ? bars.map(valuePoint) : bars.map(ohlcPoint);
}

export function setPriceSeriesData(series: PriceSeries, kind: PriceSeriesKind, bars: readonly DisplayBar[]): void {
  if (kind === 'line' || kind === 'area') {
    (series as ISeriesApi<'Line'>).setData(bars.map(valuePoint));
    return;
  }
  (series as ISeriesApi<'Candlestick'>).setData(bars.map(ohlcPoint));
}

export function updatePriceSeries(series: PriceSeries, kind: PriceSeriesKind, bar: DisplayBar): void {
  if (kind === 'line' || kind === 'area') {
    (series as ISeriesApi<'Line'>).update(valuePoint(bar));
    return;
  }
  (series as ISeriesApi<'Candlestick'>).update(ohlcPoint(bar));
}

/**
 * Bar width of the default view.
 *
 * `fitContent()` alone squeezes a year of daily bars into whatever width the
 * container has — around 5px each — which is too tight to count a support or a
 * resistance touch. When fitting everything would fall below this spacing the
 * chart opens at this width instead, anchored to the newest bar; the older bars
 * are still there, one pan or zoom-out away.
 */
export const READABLE_BAR_SPACING = 9;

export type DefaultViewport = { mode: 'fit' } | { mode: 'spacing'; barSpacing: number };

export function resolveDefaultViewport(width: number, barCount: number): DefaultViewport {
  if (!Number.isFinite(width) || width <= 0 || barCount < 2) return { mode: 'fit' };
  return width / barCount >= READABLE_BAR_SPACING
    ? { mode: 'fit' }
    : { mode: 'spacing', barSpacing: READABLE_BAR_SPACING };
}
