import { describe, expect, it } from 'vitest';
import {
  isIntradayLiveSelection,
  resolveMarketSourceConfig,
  selectionKeyOf,
} from './config';
import type { CandleInterval } from '@/src/lib/market-data/gateway/contracts';

describe('resolveMarketSourceConfig', () => {
  const intraday: CandleInterval[] = ['1m', '5m', '10m', '15m', '30m', '1h', '2h', '4h'];

  it.each(intraday)('streams %s from Yahoo with truthful interval provenance (regular)', (interval) => {
    const config = resolveMarketSourceConfig({ interval, session: 'regular', adjusted: false });
    expect(config.mode).toBe('intraday-live');
    expect(config.pollsAggregate).toBe(true);
    expect(config.provenance).toBe(['10m', '2h', '4h'].includes(interval) ? 'aggregated' : 'provider-native');
    // Every intraday live poll must use a chart-route-compatible range that still
    // contains the newest bucket (never a range the Yahoo candle route rejects).
    expect(config.aggregateRange).not.toBeNull();
  });

  it('supports extended-hours for intraday intervals the provider serves pre/post', () => {
    const config = resolveMarketSourceConfig({ interval: '5m', session: 'extended', adjusted: false });
    expect(config.mode).toBe('intraday-live');
    expect(config.pollsAggregate).toBe(true);
  });

  it.each(['1D', 'Week', 'Month'] as CandleInterval[])(
    'keeps %s history-only and never rapid-polls it', (interval) => {
      const config = resolveMarketSourceConfig({ interval, session: 'regular', adjusted: true });
      expect(config.mode).toBe('history-only');
      expect(config.pollsAggregate).toBe(false);
      expect(config.aggregateRange).toBeNull();
      expect(config.reason).toBeTruthy();
    },
  );

  it('returns a typed unavailable for extended-hours daily instead of substituting regular data', () => {
    const config = resolveMarketSourceConfig({ interval: '1D', session: 'extended', adjusted: false });
    expect(config.mode).toBe('unsupported');
    expect(config.pollsAggregate).toBe(false);
    expect(config.reason).toContain('never substituted');
  });

  it('keys selections by interval + session + adjusted for single-flight dedup', () => {
    expect(selectionKeyOf({ interval: '5m', session: 'regular', adjusted: false })).toBe('5m:regular:false');
    expect(selectionKeyOf({ interval: '1h', session: 'extended', adjusted: false })).toBe('1h:extended:false');
    expect(resolveMarketSourceConfig({ interval: '5m', session: 'regular', adjusted: false }).selectionKey)
      .not.toBe(resolveMarketSourceConfig({ interval: '5m', session: 'extended', adjusted: false }).selectionKey);
  });
});

describe('isIntradayLiveSelection', () => {
  it('is true for every supported intraday interval and both sessions', () => {
    expect(isIntradayLiveSelection('1m', 'regular')).toBe(true);
    expect(isIntradayLiveSelection('4h', 'extended')).toBe(true);
    expect(isIntradayLiveSelection('10m', 'regular')).toBe(true);
  });

  it('is false for history-only and unsupported selections', () => {
    expect(isIntradayLiveSelection('1D', 'regular')).toBe(false);
    expect(isIntradayLiveSelection('Week', 'regular')).toBe(false);
    expect(isIntradayLiveSelection('1D', 'extended')).toBe(false);
  });
});
