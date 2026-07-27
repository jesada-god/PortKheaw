import { describe, expect, it } from 'vitest';
import {
  CANDLE_INTERVALS,
  YAHOO_CANDLE_CAPABILITIES,
  sourceIntervalFor,
  timeframeCapability,
} from '@/src/lib/market-data/candles/capabilities';
import { supportedRangesForInterval } from '@/src/lib/market-data/gateway/capabilities';
import {
  chartCompatibleSelection,
  chartSupportedRanges,
  defaultIntervalForChartRange,
  isChartSelectionSupported,
} from './compatibility';

describe('chart timeframe compatibility', () => {
  it('offers every interval at least one range, so no interval is dead in the UI', () => {
    for (const interval of CANDLE_INTERVALS) {
      expect(chartSupportedRanges(interval).length, interval).toBeGreaterThan(0);
    }
  });

  it('never offers a combination the Yahoo historical primary cannot serve', () => {
    for (const interval of CANDLE_INTERVALS) {
      const available = timeframeCapability(YAHOO_CANDLE_CAPABILITIES, interval)?.supportedRanges ?? [];
      for (const range of chartSupportedRanges(interval)) {
        expect(available, `${interval}/${range}`).toContain(range);
      }
    }
  });

  it('drops the quarter-long 30m/45m combinations Yahoo caps at ~60 days', () => {
    // The readability matrix allows them; Yahoo does not serve them. The offered
    // set is the intersection, so the click is disabled instead of failing after
    // a provider request.
    expect(supportedRangesForInterval('30m')).toContain('3m');
    expect(isChartSelectionSupported('30m', '3m')).toBe(false);
    expect(isChartSelectionSupported('45m', '3m')).toBe(false);
    expect(chartSupportedRanges('30m')).toEqual(['5d', '1m']);
  });

  it('keeps daily ranges independent while requiring 5Y for Week/Month', () => {
    // "12 เดือน" is the canonical `1y` range key — a historical range, never an
    // interval — and it must remain a first-class selection on the daily chart.
    expect(isChartSelectionSupported('1D', '1y')).toBe(true);
    expect(chartSupportedRanges('Week')).toEqual(['5y']);
    expect(chartSupportedRanges('Month')).toEqual(['5y']);
    expect(isChartSelectionSupported('Week', '1y')).toBe(false);
    expect(isChartSelectionSupported('Month', '3y')).toBe(false);
    // 5Y resolves to Yahoo-native weekly/monthly source intervals, so neither
    // depends on client-side aggregation.
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, '1D')).toBe('1D');
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, 'Week')).toBe('Week');
    expect(sourceIntervalFor(YAHOO_CANDLE_CAPABILITIES, 'Month')).toBe('Month');
  });

  it('never offers a minute interval for a year of history', () => {
    expect(isChartSelectionSupported('1m', '1y')).toBe(false);
    expect(isChartSelectionSupported('1m', '5y')).toBe(false);
  });

  it('auto-adjusts the untouched axis and always lands on a loadable pair', () => {
    // The user changed the range: keep the range, move the interval.
    const byRange = chartCompatibleSelection('30m', '3m', 'range');
    expect(byRange.changed).toBe(true);
    expect(byRange.range).toBe('3m');
    expect(isChartSelectionSupported(byRange.interval, byRange.range)).toBe(true);
    expect(byRange.notice).toContain('3M');

    // The user changed the interval: keep the interval, move the range.
    const byInterval = chartCompatibleSelection('30m', '3m', 'interval');
    expect(byInterval.interval).toBe('30m');
    expect(isChartSelectionSupported(byInterval.interval, byInterval.range)).toBe(true);

    expect(chartCompatibleSelection('Week', '6m', 'interval')).toMatchObject({
      interval: 'Week', range: '5y', changed: true,
    });
    expect(chartCompatibleSelection('Month', '1y', 'interval')).toMatchObject({
      interval: 'Month', range: '5y', changed: true,
    });

    // A pair that is already loadable is returned untouched and silent.
    expect(chartCompatibleSelection('1D', '1y', 'range')).toEqual({
      interval: '1D', range: '1y', changed: false, notice: null,
    });
  });

  it('recommends a loadable interval for every offered range', () => {
    for (const interval of CANDLE_INTERVALS) {
      for (const range of chartSupportedRanges(interval)) {
        const recommended = defaultIntervalForChartRange(range);
        expect(isChartSelectionSupported(recommended, range), `${range} → ${recommended}`).toBe(true);
      }
    }
  });
});
