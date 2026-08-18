import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MARKET_SIGNAL_ZONE } from '@/src/config/signal';
import { confirmedSwingPivots } from '@/src/lib/analytics/support-resistance/calculations';
import { ema } from '@/src/lib/analytics/technical/calculations';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { calculateMarketSignal, calculateTrendZones } from './calculations';
import type { MarketSignalCandle } from './types';

/**
 * P2 — trend zones behind `SIGNAL_ZONES`.
 *
 * The frame is anchored to swing structure and is deliberately NOT built from
 * `nearestSupport`/`nearestResistance`. Those are defined as the confirmed
 * levels closest to the current price, so a trigger derived from them retreats
 * every time price advances and can never be crossed — it answers "is this near
 * an all-time high" rather than "how far does price have to go before this is an
 * uptrend", which is the question the card exists for. The first two blocks
 * below are what hold that distinction in place.
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

const SYMBOLS = ['IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD'];

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

/** A clean 14-bar oscillation between roughly 90 and 110, so pivots are predictable. */
const swings = (cycles: number) => Array.from(
  { length: cycles * 14 },
  (_, index) => 100 + 10 * Math.sin((2 * Math.PI * index) / 14),
);

const zonesOf = (closes: readonly number[], options?: { volume?: (index: number) => number; halfRange?: number }) => {
  const candles = bars(closes, options);
  return calculateTrendZones({ candles, ema20: ema(candles.map((candle) => candle.close), 20).at(-1) ?? null })!;
};

describe('the frame is anchored, not price-relative', () => {
  /*
   * This is the falsification check, run in-process on the committed captures.
   * `scripts/signal-falsify.ts` runs the same measurement across 108
   * instruments over 250 bars each: 0 of 108 had zero crossings, median 33.
   * If a future change reintroduces a price-relative anchor these go to zero.
   */
  it.each(SYMBOLS)('%s has closes that actually reach its trigger', (symbol) => {
    expect(run(symbol, true).zones!.triggerCrossings).toBeGreaterThan(0);
  });

  it.each(SYMBOLS)('%s does not take its frame from the levels nearest price', (symbol) => {
    const result = run(symbol, true);
    const zones = result.zones!;
    // The nearest levels remain available as context in `metrics`; they are
    // simply not what the trigger is measured from.
    const nearest = [result.metrics.nearestSupport, result.metrics.nearestResistance];
    const anchored = [zones.support, zones.resistance];
    expect(anchored).not.toEqual(nearest);
  });

  it('anchors on confirmed swing pivots', () => {
    const frozen = capture('IREN');
    const finalized = frozen.candles.filter((candle) => candle.finalized)
      .map(({ finalized: _f, ...candle }) => candle);
    const pivots = confirmedSwingPivots(finalized, 3);
    const zones = run('IREN', true).zones!;
    // The published levels are rounded to four places; the anchors themselves
    // are raw pivot prices.
    expect(pivots.some((pivot) => Math.abs(pivot.price - zones.resistance) < 1e-3)).toBe(true);
    expect(pivots.some((pivot) => Math.abs(pivot.price - zones.support) < 1e-3)).toBe(true);
  });
});

describe('the IREN frame', () => {
  const zones = run('IREN', true).zones!;

  /*
   * The brief's original fixture (S 39.2727 / R 46.2297 / pos 68.8% / SIDEWAYS)
   * came from the nearest-level inputs and could not survive the anchor change.
   * These are the real numbers for the same capture: the frame is the swing low
   * of 2026-07-29 and the swing high of 2026-08-04, and price has closed above
   * the trigger.
   */
  it('reads from the swing pair, with price through the trigger', () => {
    expect(zones.mode).toBe('structural');
    expect(zones.support).toBeCloseTo(28.93, 2);
    expect(zones.resistance).toBeCloseTo(42.24, 2);
    expect(zones.upperTrigger).toBeCloseTo(43.2544, 3);
    expect(zones.referenceClose).toBeCloseTo(44.06, 2);
    expect(zones.referenceClose).toBeGreaterThan(zones.upperTrigger);
    expect(zones.positionPct).toBeCloseTo(113.7, 1);
    expect(zones.zone).toBe('uptrend');
  });

  it('says which close every number is measured from', () => {
    expect(zones.referenceDate).toBe('2026-08-14');
    expect(zones.referenceDate).toBe(run('IREN', true).latestCandleAt);
  });

  it('leaves position unclamped so a break reads as a break', () => {
    expect(zones.positionPct).toBeGreaterThan(100);
  });
});

describe('confirmation runs on closes', () => {
  const base = swings(6);

  it('accepts one close beyond the trigger when the day carried volume', () => {
    const closes = [...base, 118];
    const zones = zonesOf(closes, { volume: (index) => (index === closes.length - 1 ? 2_000 : 1_000) });
    expect(zones.zone).toBe('uptrend');
  });

  it('needs two closes when the day did not', () => {
    expect(zonesOf([...base, 118]).zone).toBe('sideways');
    expect(zonesOf([...base, 118, 118.5]).zone).toBe('uptrend');
  });

  it('reports the wait as pending rather than moving the zone or staying silent', () => {
    const zones = zonesOf([...base, 118]);
    expect(zones.zone).toBe('sideways');
    expect(zones.pendingBreakout).toBe(true);
    expect(zones.pendingBreakdown).toBe(false);
  });

  it('ignores a wick that pierced the level without closing past it', () => {
    // Only the final bar gets the long upper shadow, so ATR — and with it the
    // trigger — stays where the rest of the series put it.
    const candles = bars([...base, 106]);
    const last = candles.at(-1)!;
    candles[candles.length - 1] = { ...last, high: last.close + 8 };
    const zones = calculateTrendZones({ candles, ema20: ema(candles.map((candle) => candle.close), 20).at(-1) ?? null })!;
    expect(candles.at(-1)!.high).toBeGreaterThan(zones.upperTrigger);
    expect(candles.at(-1)!.close).toBeLessThan(zones.upperTrigger);
    expect(zones.zone).toBe('sideways');
  });

  it('confirms a breakdown the same way', () => {
    expect(zonesOf([...base, 82, 81.5]).zone).toBe('downtrend');
  });
});

describe('hysteresis', () => {
  const base = swings(6);

  /*
   * Entry needs `resistance + 0.25 ATR`; leaving needs only the resistance. A
   * price grinding across the trigger must not relabel the card on alternate
   * days — a flickering label teaches a reader that the label is noise.
   */
  it('does not flicker on a series oscillating across the trigger', () => {
    const entry = [118, 118.5];
    const oscillation = [112.2, 113.4, 112.1, 113.8, 112.3, 113.1, 112.5, 113.6];
    const labels = oscillation.map((_, index) => zonesOf([...base, ...entry, ...oscillation.slice(0, index + 1)]).zone);

    /*
     * Eight alternating closes across the trigger produce ONE label change, not
     * eight. The change that does happen is not the oscillation: it is the
     * breakout peak confirming as a new swing high, which re-anchors the frame
     * above price and correctly reports that the break did not hold.
     */
    const transitions = labels.filter((label, index) => index > 0 && label !== labels[index - 1]).length;
    expect(transitions).toBeLessThanOrEqual(1);
    expect(labels[0]).toBe('uptrend');
  });

  it('leaves the zone only on a close back inside the level', () => {
    const entered = zonesOf([...base, 118, 118.5]);
    expect(entered.zone).toBe('uptrend');
    const left = zonesOf([...base, 118, 118.5, entered.resistance - 1]);
    expect(left.zone).toBe('sideways');
  });
});

describe('the frame is sticky', () => {
  /*
   * A frame that moved with price would put the trigger permanently out of
   * reach, which is the failure this phase exists to correct. It moves for two
   * reasons only: a confirmed break of it, or a newly confirmed pivot outside it.
   */
  it('holds its level while price drifts inside it', () => {
    const base = swings(6);
    const drift = [104, 105, 106, 107];
    const first = zonesOf(base);
    const later = zonesOf([...base, ...drift]);
    // The anchor itself does not move at all. The trigger sits a quarter of ATR
    // above it, so it breathes with volatility — by pennies, not by the amount
    // price advanced.
    expect(later.resistance).toBeCloseTo(first.resistance, 6);
    expect(Math.abs(later.upperTrigger - first.upperTrigger)).toBeLessThan(0.05);
    expect(later.frameAgeBars).toBeGreaterThan(first.frameAgeBars);
  });

  it('re-anchors once price confirms through it', () => {
    const base = swings(6);
    const before = zonesOf(base);
    const after = zonesOf([...base, 118, 118.5]);
    expect(after.zone).toBe('uptrend');
    expect(after.frameAgeBars).toBeLessThan(before.frameAgeBars + 2);
  });
});

describe('a range too narrow to break', () => {
  it('falls back to an ATR band around EMA20 and says so', () => {
    // A flat series produces pivots within pennies of each other, so the frame
    // they would define is narrower than a normal day's movement.
    const flat = Array.from({ length: 80 }, (_, index) => 100 + Math.sin(index / 2) * 0.02);
    const zones = zonesOf(flat);
    expect(zones.mode).toBe('atr_band');
    expect(zones.resistance - zones.support).toBeGreaterThan(0);
  });

  it('keeps the structural frame when the swings are wide enough to mean something', () => {
    expect(zonesOf(swings(6)).mode).toBe('structural');
  });
});

describe('degrading instead of failing', () => {
  it('returns nothing rather than inventing a zone without enough history', () => {
    expect(calculateTrendZones({ candles: bars([100, 101, 102]), ema20: 100 })).toBeNull();
    expect(calculateTrendZones({ candles: [], ema20: 100 })).toBeNull();
  });
});

describe('BTC-USD trades every day of the week', () => {
  /*
   * Crypto has no session, so the provider marks every bar finalized — the
   * equity captures each carry one forming bar that the engine drops. The frame
   * walk counts BARS, so a seven-day week and a five-day week are different
   * lengths of history for the same wall-clock window, and `zoneAgeBars` on
   * BTC-USD is not comparable to `zoneAgeBars` on an equity.
   */
  const frozen = capture('BTC-USD');
  const result = run('BTC-USD', true);

  it('drops no bar for a weekend and still resolves a frame', () => {
    expect(frozen.candles.every((candle) => candle.finalized)).toBe(true);
    expect(result.dataPoints.received).toBe(result.dataPoints.finalized);
    expect(result.zones?.mode).toBe('structural');
    expect(result.zones?.referenceDate).toBe(result.latestCandleAt);
  });

  it('measures the frame from the newest bar, weekend or not', () => {
    expect(result.zones?.referenceClose).toBeCloseTo(frozen.candles.at(-1)!.close, 6);
  });

  it('lets a volatility regime outrank the zone', () => {
    expect(result.state).toBe('SQUEEZE');
  });
});

describe('the flag is the rollout contract', () => {
  it.each(SYMBOLS)('%s is untouched with zones off', (symbol) => {
    const golden = JSON.parse(
      readFileSync(join(process.cwd(), '__golden__', 'signal', `${symbol}.json`), 'utf8'),
    ) as Record<string, unknown>;
    const off = run(symbol, false);
    expect(JSON.parse(JSON.stringify(off))).toEqual(golden);
    expect('zones' in off).toBe(false);
  });

  it('emits no P2 flag while the flag is off', () => {
    const p2 = ['pending_breakout', 'pending_breakdown', 'stale_zone', 'narrow_range'];
    SYMBOLS.forEach((symbol) => {
      expect(run(symbol, false).flags.filter((flag) => p2.includes(flag))).toEqual([]);
    });
  });

  it('keeps the anchor lookback in config rather than in the engine', () => {
    expect(MARKET_SIGNAL_ZONE.anchor.lookbackBars).toBe(120);
  });
});
