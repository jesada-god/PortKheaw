import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MARKET_SIGNAL_ZONE } from '@/src/config/signal';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { calculateMarketSignal, calculateTrendZones } from './calculations';
import type { MarketSignalCandle } from './types';

/**
 * P2 — trend zones behind `SIGNAL_ZONES`.
 *
 * The phase exists because the card printed a direction at the top and, a few
 * centimetres below, a support and a resistance showing price parked in the
 * middle of its own range. Only one of those can be the headline, and structure
 * is the one a reader can check against the chart.
 */

const capture = (symbol: string) => JSON.parse(
  readFileSync(join(process.cwd(), '__golden__', 'candles', `${symbol}.json`), 'utf8'),
) as { source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] };

const run = (symbol: string, zones: boolean) => {
  const frozen = capture(symbol);
  return calculateMarketSignal(frozen.candles, {
    symbol,
    source: frozen.source,
    freshness: frozen.freshness,
    calculatedAt: '2026-01-01T00:00:00.000Z',
    ...(zones ? { features: { gate: false, zones: true } } : {}),
  });
};

const freshness: DataFreshness = { status: 'end-of-day', asOf: '2026-08-14T20:00:00.000Z', maxAgeSeconds: 21_600 };

/** Bars with an explicit range, so a wick can be placed independently of the close. */
function bars(closes: readonly number[], options: { volume?: (index: number) => number; halfRange?: number } = {}) {
  const halfRange = options.halfRange ?? 0.4;
  return closes.map((close, index) => ({
    date: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
    open: close,
    high: close + halfRange,
    low: close - halfRange,
    close,
    volume: options.volume?.(index) ?? 1_000,
  }));
}

describe('the fixture the brief pinned', () => {
  const zones = run('IREN', true).zones!;

  it('reproduces every number of it from the real IREN capture', () => {
    // close 44.06 · ATR14 4.0574 · S 39.2727 · R 46.2297
    expect(zones.mode).toBe('structural');
    expect(zones.support).toBeCloseTo(39.2727, 4);
    expect(zones.resistance).toBeCloseTo(46.2297, 4);
    // upper 47.24 (+3.18 = 0.78 ATR)
    expect(zones.upperTrigger).toBeCloseTo(47.244, 3);
    expect(zones.upperDistance).toBeCloseTo(3.18, 2);
    expect(zones.upperDistanceAtr).toBe(0.78);
    // lower 38.26 (-5.80 = 1.43 ATR)
    expect(zones.lowerTrigger).toBeCloseTo(38.2583, 4);
    expect(zones.lowerDistance).toBeCloseTo(5.8, 2);
    expect(zones.lowerDistanceAtr).toBe(1.43);
    // pos 68.8% · zone SIDEWAYS
    expect(zones.positionPct).toBe(68.8);
    expect(zones.zone).toBe('sideways');
    expect(run('IREN', true).state).toBe('SIDEWAYS');
  });

  it('says which close every number is measured from', () => {
    expect(zones.referenceClose).toBeCloseTo(44.06, 2);
    expect(zones.referenceDate).toBe('2026-08-14');
    expect(zones.referenceDate).toBe(run('IREN', true).latestCandleAt);
  });
});

describe('the levels the card draws are the levels the page already prints', () => {
  /*
   * The summary card at the top of the stock page renders
   * `marketSignal.metrics.nearestSupport`. If the zone bar built its own levels
   * the same screen would quote two different supports for one instrument.
   */
  it.each(['IREN', 'QQQ', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD'])('%s keeps one support and one resistance', (symbol) => {
    const result = run(symbol, true);
    expect(result.zones?.mode).toBe('structural');
    expect(result.zones?.support).toBeCloseTo(result.metrics.nearestSupport as number, 4);
    expect(result.zones?.resistance).toBeCloseTo(result.metrics.nearestResistance as number, 4);
  });
});

describe('a range price is inside, versus structure price has left', () => {
  /*
   * `nearestSupport`/`nearestResistance` are BY CONSTRUCTION the confirmed
   * levels immediately below and above the current price, so whenever both
   * exist price is between them. A zone built only from that pair would read
   * sideways forever. What separates a trending instrument is that one side has
   * no confirmed level left at all.
   */
  it('calls an instrument inside its own range sideways, whatever the score says', () => {
    const qqq = run('QQQ', true);
    expect(qqq.score).toBeGreaterThan(40);
    expect(qqq.zones?.mode).toBe('structural');
    expect(qqq.zones?.zone).toBe('sideways');
    expect(qqq.state).toBe('SIDEWAYS');
  });

  it.each(['SPY', 'DIA', 'IWM'])('%s is trending because nothing confirmed is left above it', (symbol) => {
    const result = run(symbol, true);
    expect(result.metrics.nearestResistance).toBeNull();
    expect(result.zones?.mode).toBe('open_above');
    expect(result.zones?.zone).toBe('uptrend');
    expect(result.state).toBe('BULLISH');
    // Nothing overhead means nothing to break, so there is no upper trigger to
    // report — and a projected number would read as a level nobody defended.
    expect(result.zones?.resistance).toBeNull();
    expect(result.zones?.upperTrigger).toBeNull();
    expect(result.zones?.positionPct).toBeNull();
    // The support below is still real, and it is what would end the move.
    expect(result.zones?.lowerTrigger).not.toBeNull();
  });
});

describe('confirmation runs on closes', () => {
  const support = 90;
  const resistance = 110;
  const atr14 = 4;
  const trigger = resistance + MARKET_SIGNAL_ZONE.triggerAtrMultiple * atr14; // 111

  const base = Array.from({ length: 60 }, (_, index) => 100 + Math.sin(index / 3) * 2);

  it('accepts one close beyond the trigger when the day carried volume', () => {
    const candles = bars([...base, 112], { volume: (index) => (index === base.length ? 2_000 : 1_000) });
    const zones = calculateTrendZones({ candles, support, resistance, atr14, ema20: 100 })!;
    expect(zones.zone).toBe('uptrend');
  });

  it('needs two closes when the day did not', () => {
    const one = bars([...base, 112]);
    expect(calculateTrendZones({ candles: one, support, resistance, atr14, ema20: 100 })!.zone).toBe('sideways');
    const two = bars([...base, 112, 112.5]);
    expect(calculateTrendZones({ candles: two, support, resistance, atr14, ema20: 100 })!.zone).toBe('uptrend');
  });

  it('reports the wait as pending rather than moving the zone or staying silent', () => {
    const candles = bars([...base, 112]);
    const zones = calculateTrendZones({ candles, support, resistance, atr14, ema20: 100 })!;
    expect(zones.zone).toBe('sideways');
    expect(zones.pendingBreakout).toBe(true);
    expect(zones.pendingBreakdown).toBe(false);
  });

  it('ignores a wick that pierced the level without closing past it', () => {
    // High reaches 113, close stays at 108 — under the trigger.
    const candles = bars([...base, 108, 108], { halfRange: 5 });
    expect(candles.at(-1)!.high).toBeGreaterThan(trigger);
    expect(calculateTrendZones({ candles, support, resistance, atr14, ema20: 100 })!.zone).toBe('sideways');
  });
});

describe('hysteresis', () => {
  /*
   * Entry needs `resistance + 0.25 ATR`; exit needs only `resistance`. A price
   * grinding across the trigger must not relabel the card on alternate days —
   * a flickering label teaches a reader that the label is noise.
   */
  it('does not flicker on a series oscillating across the trigger', () => {
    const support = 90;
    const resistance = 110;
    const atr14 = 4;
    const warmup = Array.from({ length: 60 }, () => 100);
    const oscillation = [112, 112.5, 110.6, 111.4, 110.8, 111.6, 110.5, 111.8, 110.7, 111.2];

    const labels = oscillation.map((_, index) => calculateTrendZones({
      candles: bars([...warmup, ...oscillation.slice(0, index + 1)]),
      support,
      resistance,
      atr14,
      ema20: 100,
    })!.zone);

    // Once entered, every subsequent close stays above `resistance`, so the zone
    // holds for the whole oscillation instead of toggling with each bar.
    expect(labels.at(-1)).toBe('uptrend');
    expect(new Set(labels.slice(1)).size).toBe(1);
  });

  it('leaves the zone only on a close back inside the level', () => {
    const warmup = Array.from({ length: 60 }, () => 100);
    const entered = [112, 112.5, 111.5];
    const held = calculateTrendZones({
      candles: bars([...warmup, ...entered]), support: 90, resistance: 110, atr14: 4, ema20: 100,
    })!;
    expect(held.zone).toBe('uptrend');

    const left = calculateTrendZones({
      candles: bars([...warmup, ...entered, 109.5]), support: 90, resistance: 110, atr14: 4, ema20: 100,
    })!;
    expect(left.zone).toBe('sideways');
    expect(left.zoneAgeBars).toBe(0);
  });
});

describe('a range too narrow to break', () => {
  it('falls back to an ATR band around EMA20 and says so', () => {
    const candles = bars(Array.from({ length: 60 }, () => 100));
    // Support and resistance 2 apart on an ATR of 4: narrower than one normal day.
    const zones = calculateTrendZones({ candles, support: 99, resistance: 101, atr14: 4, ema20: 100 })!;
    expect(zones.mode).toBe('atr_band');
    expect(zones.support).toBeCloseTo(100 - MARKET_SIGNAL_ZONE.narrowRange.atrBandMultiplier * 4, 6);
    expect(zones.resistance).toBeCloseTo(100 + MARKET_SIGNAL_ZONE.narrowRange.atrBandMultiplier * 4, 6);
  });

  it('keeps the structural levels when they are wide enough to mean something', () => {
    const candles = bars(Array.from({ length: 60 }, () => 100));
    expect(calculateTrendZones({ candles, support: 90, resistance: 110, atr14: 4, ema20: 100 })!.mode).toBe('structural');
  });
});

describe('degrading instead of failing', () => {
  const candles = bars(Array.from({ length: 60 }, () => 100));

  it('returns nothing rather than inventing a zone without ATR', () => {
    expect(calculateTrendZones({ candles, support: 90, resistance: 110, atr14: null, ema20: 100 })).toBeNull();
    expect(calculateTrendZones({ candles, support: 90, resistance: 110, atr14: 0, ema20: 100 })).toBeNull();
  });

  it('returns nothing when there is neither a level nor an EMA to fall back to', () => {
    expect(calculateTrendZones({ candles, support: null, resistance: null, atr14: 4, ema20: null })).toBeNull();
  });
});

describe('BTC-USD trades every day of the week', () => {
  /*
   * Crypto has no session, so the provider marks every bar finalized — the
   * equity captures each carry one forming bar that the engine drops. The zone
   * walk counts BARS, so a seven-day week and a five-day week are different
   * lengths of history for the same wall-clock window, and `zoneAgeBars` on
   * BTC-USD is not comparable to `zoneAgeBars` on an equity.
   */
  const frozen = capture('BTC-USD');
  const result = run('BTC-USD', true);

  it('drops no bar for a weekend and still resolves a zone', () => {
    expect(frozen.candles.every((candle) => candle.finalized)).toBe(true);
    expect(result.dataPoints.received).toBe(result.dataPoints.finalized);
    expect(result.zones).not.toBeUndefined();
    expect(result.zones?.referenceDate).toBe(result.latestCandleAt);
  });

  it('measures the zone from the newest bar, weekend or not', () => {
    const lastDate = frozen.candles.at(-1)!.date;
    expect(result.zones?.referenceDate).toBe(lastDate);
    expect(result.zones?.referenceClose).toBeCloseTo(frozen.candles.at(-1)!.close, 6);
  });

  it('lets a volatility regime outrank the zone', () => {
    // A squeeze is a statement the zone does not contradict, and it serves a
    // reader better than "sideways" when both are true.
    expect(result.zones?.zone).toBe('sideways');
    expect(result.state).toBe('SQUEEZE');
  });
});

describe('the flag is the rollout contract', () => {
  const symbols = ['IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD'];

  it.each(symbols)('%s is untouched with zones off', (symbol) => {
    const golden = JSON.parse(
      readFileSync(join(process.cwd(), '__golden__', 'signal', `${symbol}.json`), 'utf8'),
    ) as Record<string, unknown>;
    const off = run(symbol, false);
    expect(JSON.parse(JSON.stringify(off))).toEqual(golden);
    expect('zones' in off).toBe(false);
  });

  it('emits no P2 flag while the flag is off', () => {
    const p2 = ['pending_breakout', 'pending_breakdown', 'stale_zone', 'narrow_range'];
    symbols.forEach((symbol) => {
      expect(run(symbol, false).flags.filter((flag) => p2.includes(flag))).toEqual([]);
    });
  });
});
