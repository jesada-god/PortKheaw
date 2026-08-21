import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { confirmedSwingPivots } from '@/src/lib/analytics/support-resistance/calculations';
import { calculateTrendZones } from '@/src/lib/analytics/market-signal/calculations';
import { ema } from '@/src/lib/analytics/technical/calculations';
import { MARKET_SIGNAL_THRESHOLDS } from '@/src/config/signal';
import type { MarketSignalCandle } from '@/src/lib/analytics/market-signal/types';

/**
 * THE LOOK-AHEAD GUARD, written after the round-3 audit found nothing wrong.
 *
 * A confirmed swing pivot at bar `i` is decided by a symmetric window: three
 * bars to its left and THREE BARS TO ITS RIGHT. The bar it sits on is therefore
 * not knowable when that bar closes — it is knowable three bars later, and
 * `confirmedAtIndex` is where the producer records that. Every consumer filters
 * on that field:
 *
 *   anchorAt()  `pivot.confirmedAtIndex <= index`   calculations.ts:690
 *   freshPivot  `pivot.confirmedAtIndex === index`  calculations.ts:779
 *   structure   `pivot.confirmedAtIndex >= horizon` calculations.ts:1217
 *
 * `pivot.index` sits right beside it, three bars earlier, and reads like the
 * obvious field to use. Swapping one filter to it would still typecheck, still
 * pass every existing test, and quietly make every historical trigger look
 * easier to cross than it was — the frame would anchor on swings the market had
 * not finished making. The audit that established all this was a throwaway
 * script. This is that script, kept.
 *
 * The corpus is deliberately small and frozen: three instruments from the
 * golden candles, most recent 400 bars, no network and no clock.
 */

const WINDOW = MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow;
const INSTRUMENTS = ['BTC-USD', 'DIA', 'IREN'];
const BARS = 400;

function fixture(symbol: string): MarketSignalCandle[] {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), '__golden__', 'candles', `${symbol}.json`), 'utf8'),
  ) as { candles: MarketSignalCandle[] };
  return raw.candles.filter((candle) => candle.finalized).slice(-BARS);
}

const CORPUS = INSTRUMENTS.map((symbol) => ({ symbol, candles: fixture(symbol) }));

/** Same pivot, by the three fields that identify one. */
const samePivot = (
  left: { index: number; kind: string; price: number },
  right: { index: number; kind: string; price: number },
): boolean => left.index === right.index && left.kind === right.kind && left.price === right.price;

describe('confirmed swing pivots are causal', () => {
  it('has a corpus with enough pivots to be worth asserting on', () => {
    for (const { symbol, candles } of CORPUS) {
      expect(candles.length, `${symbol} has too few bars`).toBeGreaterThanOrEqual(BARS - 1);
      const pivots = confirmedSwingPivots(candles, WINDOW);
      expect(pivots.length, `${symbol} produced no pivots`).toBeGreaterThan(20);
    }
  });

  it('stamps every pivot exactly pivotWindow bars after the swing it names', () => {
    for (const { symbol, candles } of CORPUS) {
      for (const pivot of confirmedSwingPivots(candles, WINDOW)) {
        expect(
          pivot.confirmedAtIndex - pivot.index,
          `${symbol} pivot at ${pivot.index} is stamped ${pivot.confirmedAtIndex - pivot.index} bars late, not ${WINDOW}`,
        ).toBe(WINDOW);
      }
    }
  });

  /*
   * The two halves of "the stamp is exactly right".
   *
   * Truncating AT the confirmation bar must still produce the pivot — otherwise
   * the producer needs data it claims not to, and the stamp is wrong in the
   * optimistic direction. Truncating ONE BAR EARLIER must produce none of them
   * — otherwise the stamp is merely late, and every consumer is holding back a
   * fact it could already have used.
   */
  it('finds every pivot in a series truncated at its own confirmation bar', () => {
    for (const { symbol, candles } of CORPUS) {
      for (const pivot of confirmedSwingPivots(candles, WINDOW)) {
        const known = confirmedSwingPivots(candles.slice(0, pivot.confirmedAtIndex + 1), WINDOW);
        expect(
          known.some((candidate) => samePivot(candidate, pivot)),
          `${symbol} pivot at ${pivot.index} needs bars after ${pivot.confirmedAtIndex} to be found`,
        ).toBe(true);
      }
    }
  });

  it('finds none of them one bar earlier than that', () => {
    for (const { symbol, candles } of CORPUS) {
      for (const pivot of confirmedSwingPivots(candles, WINDOW)) {
        const tooEarly = confirmedSwingPivots(candles.slice(0, pivot.confirmedAtIndex), WINDOW);
        expect(
          tooEarly.some((candidate) => samePivot(candidate, pivot)),
          `${symbol} pivot at ${pivot.index} was already known at ${pivot.confirmedAtIndex - 1}, so the stamp is late`,
        ).toBe(false);
      }
    }
  });

  /*
   * The identity every consumer's filter depends on: what you would have known
   * at bar `e` IS the full history filtered by `confirmedAtIndex`. This is what
   * makes `confirmedAtIndex <= index` a correct replay rather than an
   * approximation of one.
   */
  it('gives the same set as filtering the full history by confirmedAtIndex', () => {
    const fingerprint = (pivot: { index: number; kind: string; price: number }): string =>
      `${pivot.index}:${pivot.kind}:${pivot.price}`;
    for (const { symbol, candles } of CORPUS) {
      const full = confirmedSwingPivots(candles, WINDOW);
      for (const end of [80, 160, 240, 320, candles.length]) {
        const live = confirmedSwingPivots(candles.slice(0, end), WINDOW);
        expect(
          live.map(fingerprint),
          `${symbol} at bar ${end}: the live pivot set is not the confirmedAtIndex-filtered one`,
        ).toEqual(full.filter((pivot) => pivot.confirmedAtIndex < end).map(fingerprint));
      }
    }
  });

  /*
   * THE CONSUMER SIDE, which is where the regression would actually land.
   *
   * `zones` publishes enough to check the frame's causality from outside:
   * `frameAgeBars` says which bar the frame was anchored at, and a structural
   * frame's `support`/`resistance` are pivot prices rounded to 4. So every edge
   * has to trace to a pivot the market had already confirmed BY that anchor
   * bar. Flip `anchorAt`'s filter to `pivot.index <= index` and a frame becomes
   * able to anchor on a swing confirmed up to three bars after it was drawn,
   * which this fails on.
   */
  it('never anchors the zone frame on a pivot confirmed after the anchor bar', () => {
    let structuralFrames = 0;
    for (const { symbol, candles } of CORPUS) {
      const closes = candles.map((candle) => candle.close);
      for (const end of [200, 260, 320, 380, candles.length]) {
        const window = candles.slice(0, end);
        const ema20 = ema(closes.slice(0, end), 20).at(-1) ?? null;
        const zones = calculateTrendZones({ candles: window, ema20 });
        if (zones === null || zones.mode !== 'structural') continue;
        structuralFrames += 1;

        const anchoredAt = window.length - 1 - zones.frameAgeBars;
        const available = confirmedSwingPivots(window, WINDOW)
          .filter((pivot) => pivot.confirmedAtIndex <= anchoredAt)
          .map((pivot) => Number(pivot.price.toFixed(4)));

        for (const edge of [zones.support, zones.resistance]) {
          expect(
            available,
            `${symbol} at bar ${end}: frame edge ${edge} is not a pivot confirmed by its anchor bar ${anchoredAt}`,
          ).toContain(edge);
        }
      }
    }
    expect(structuralFrames, 'no structural frame was exercised at all').toBeGreaterThan(2);
  });
});
