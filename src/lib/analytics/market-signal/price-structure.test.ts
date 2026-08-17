import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MARKET_SIGNAL_THRESHOLDS } from '@/src/config/signal';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { confirmedSwingPivots } from '@/src/lib/analytics/support-resistance/calculations';
import { calculateMarketSignal } from './calculations';
import type { MarketSignalCandle } from './types';

/**
 * Price Structure regressions.
 *
 * Two defects were found in the component, both of which made it report a
 * bearish structure that the chart did not show:
 *
 *   1. The level said to have broken could be ANY confirmed pivot in the five
 *      years of history the engine loads. On the reported IREN day it was a
 *      swing low from nine months earlier; across the ten snapshot symbols the
 *      same selection produced "breakouts" of levels from 2023 and, for
 *      BTC-USD, from 2021.
 *   2. The swing sequence was read only from CONFIRMED pivots, which lag price
 *      by the confirmation window, so "lower highs" kept being reported for
 *      days after price had traded clean through those highs.
 */

const freshness: DataFreshness = { status: 'end-of-day', asOf: '2026-08-14T20:00:00.000Z', maxAgeSeconds: 21_600 };
const context = { symbol: 'TEST', source: 'synthetic-fixture', freshness, calculatedAt: '2026-01-01T00:00:00.000Z' };

function series(closes: readonly number[]): MarketSignalCandle[] {
  return closes.map((close, index) => ({
    date: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
    open: close - 0.2,
    high: close + 0.8,
    low: close - 0.8,
    close,
    volume: 1_000,
    finalized: true,
  }));
}

const structureReasons = (result: ReturnType<typeof calculateMarketSignal>) => result.reasons
  .filter((reason) => reason.id === 'structure-breakout' || reason.id === 'structure-breakdown')
  .map((reason) => reason.id);

describe('price structure only reads levels that still describe the market', () => {
  /*
   * One low at bar 10, then a year and a half spent far above it, then a slide
   * back down through it. The old selection reached 290 bars into the past for
   * that low and announced a breakdown of it.
   */
  const closes = [
    ...Array.from({ length: 10 }, (_, index) => 110 - index),
    100,
    ...Array.from({ length: 20 }, (_, index) => 100 + (index + 1) * 5),
    ...Array.from({ length: 240 }, (_, index) => 200 + Math.sin(index / 3) * 4),
  ];
  const peak = closes.at(-1)!;
  closes.push(...Array.from({ length: 30 }, (_, index) => peak - (peak - 98.5) * ((index + 1) / 30)));
  const candles = series(closes);
  const result = calculateMarketSignal(candles, context);

  it('leaves a stale level out of reach even when price trades through it', () => {
    const pivots = confirmedSwingPivots(
      candles.map(({ finalized: _finalized, ...candle }) => candle),
      MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow,
    );
    const previousClose = candles.at(-2)!.close;
    const stale = pivots.filter((pivot) => pivot.kind === 'low' && pivot.price <= previousClose)
      .sort((left, right) => right.price - left.price)[0];

    // The level the old code would have chosen still exists, is still the only
    // low beneath the previous close, and price really did close under it.
    expect(stale).toBeDefined();
    expect(candles.length - 1 - stale.index).toBeGreaterThan(MARKET_SIGNAL_THRESHOLDS.structure.pivotLookbackBars);
    expect(candles.at(-1)!.close).toBeLessThan(stale.price * (1 - MARKET_SIGNAL_THRESHOLDS.structure.breakoutBufferRatio));

    // And the engine says nothing about it, because it is not today's structure.
    expect(structureReasons(result)).toEqual([]);
  });
});

describe('price structure reads the swing sequence against where price actually is', () => {
  /*
   * A lower high (115.8 after 120.8) and a higher low (103.2 after 99.2), then a
   * four-bar rally to 121.5 — above BOTH highs, but too recent for the newest
   * high to have been confirmed. The confirmed-only reading still called this a
   * lower high.
   */
  const closes = [
    ...Array.from({ length: 60 }, (_, index) => 100 + Math.sin(index / 4) * 2),
    ...Array.from({ length: 21 }, (_, index) => 100 + 20 * Math.sin((Math.PI * index) / 20)),
    ...Array.from({ length: 21 }, (_, index) => 104 + 11 * Math.sin((Math.PI * index) / 20)),
    108, 112, 116, 121.5,
  ];
  const candles = series(closes);
  const result = calculateMarketSignal(candles, context);
  const pivots = confirmedSwingPivots(
    candles.map(({ finalized: _finalized, ...candle }) => candle),
    MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow,
  );
  const highs = pivots.filter((pivot) => pivot.kind === 'high');
  const close = candles.at(-1)!.close;

  it('does not report lower highs once price has closed above the newest one', () => {
    // The premise: the confirmed pair really is a lower high, and price is above it.
    expect(highs.at(-1)!.price).toBeLessThan(highs.at(-2)!.price);
    expect(close).toBeGreaterThan(highs.at(-2)!.price);

    expect(result.status).toBe('available');
    expect(result.scoreBreakdown.priceStructure.normalizedScore).toBeGreaterThan(0);
    expect(result.reasons.find((reason) => reason.id === 'swing-structure')?.polarity).toBe('positive');
  });
});

describe('the reported IREN day', () => {
  const capture = JSON.parse(
    readFileSync(join(process.cwd(), '__golden__', 'candles', 'IREN.json'), 'utf8'),
  ) as { source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] };
  const result = calculateMarketSignal(capture.candles, {
    symbol: 'IREN', source: capture.source, freshness: capture.freshness, calculatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('no longer scores a full bearish structure on a close above every EMA', () => {
    const { metrics, scoreBreakdown } = result;
    // The premise the brief flagged: price is above all three moving averages.
    expect(metrics.close).toBeGreaterThan(metrics.ema20 as number);
    expect(metrics.close).toBeGreaterThan(metrics.ema50 as number);
    expect(metrics.close).toBeGreaterThan(metrics.ema200 as number);

    // Was -15/15 with a "Breakdown แนวรับ" reason attached to a level from 2025-11-14.
    expect(scoreBreakdown.priceStructure.points).toBe(0);
    expect(structureReasons(result)).toEqual([]);
  });
});
