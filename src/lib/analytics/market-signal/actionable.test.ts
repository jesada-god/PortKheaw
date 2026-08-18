import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MARKET_SIGNAL_ACTIONABLE, MARKET_SIGNAL_ZONE } from '@/src/config/signal';
import { atrWilder, ema } from '@/src/lib/analytics/technical/calculations';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { calculateActionable, calculateMarketSignal, calculateTrendZones } from './calculations';
import type { MarketSignalCandle, MarketSignalZones } from './types';

/**
 * P3 — invalidation and risk:reward behind `SIGNAL_ACTIONABLE`.
 *
 * The layer's whole value is what it REFUSES to print. Any engine can multiply
 * ATR by a number and call the product a stop; a reader cannot tell that apart
 * from a level with a provenance, which is exactly why it must not be done. So
 * most of what is checked here is that nothing appears — and, where a number
 * does appear, that it is a level the zone engine itself acts on.
 */

type Bar = Omit<MarketSignalCandle, 'finalized'>;

const capture = (symbol: string) => JSON.parse(
  readFileSync(join(process.cwd(), '__golden__', 'candles', `${symbol}.json`), 'utf8'),
) as { source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] };

const SYMBOLS = ['IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD'];

const run = (symbol: string, features?: { gate?: boolean; zones?: boolean; actionable?: boolean }) => {
  const frozen = capture(symbol);
  return calculateMarketSignal(frozen.candles, {
    symbol,
    source: frozen.source,
    freshness: frozen.freshness,
    calculatedAt: '2026-01-01T00:00:00.000Z',
    ...(features ? { features } : {}),
  });
};

const on = (symbol: string) => run(symbol, { gate: false, zones: true, actionable: true });

const finalizedBars = (symbol: string): Bar[] => capture(symbol).candles
  .filter((candle) => candle.finalized)
  .map(({ finalized: _finalized, ...candle }) => candle);

/** Bars with an explicit range, so a wick can be placed independently of the close. */
function bars(closes: readonly number[], options: { volume?: (index: number) => number; halfRange?: number } = {}): Bar[] {
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

const zonesOf = (candles: readonly Bar[]): MarketSignalZones =>
  calculateTrendZones({ candles, ema20: ema(candles.map((candle) => candle.close), 20).at(-1) ?? null })!;

const actionableOf = (candles: readonly Bar[]) =>
  calculateActionable({ zones: zonesOf(candles), atr: atrWilder(candles, 14).at(-1) ?? null });

/** Everything after a `swings(8)` base, with volume loud enough to confirm on one close. */
const afterBase = (tail: readonly number[]) => {
  const base = swings(8);
  return bars([...base, ...tail], { volume: (index) => index >= base.length ? 5_000 : 1_000 });
};

/** The engine run over a synthetic series, so flags and reasons can be read. */
const engine = (symbol: string, candles: readonly Bar[]) => calculateMarketSignal(
  candles.map((candle) => ({ ...candle, finalized: true })),
  {
    symbol,
    source: null,
    freshness: { status: 'end-of-day', asOf: null, maxAgeSeconds: null },
    calculatedAt: '2026-01-01T00:00:00.000Z',
    features: { gate: false, zones: true, actionable: true },
  },
);

describe('the flag is the whole contract', () => {
  it.each(SYMBOLS)('%s carries no actionable block with every flag off', (symbol) => {
    expect('actionable' in run(symbol)).toBe(false);
  });

  /*
   * P3 is defined in terms of the zone — an invalidation is the price at which
   * the ZONE stops being true — so without P2 the sentence has no subject. This
   * is the real dependency, not a guard against misconfiguration.
   */
  it.each(SYMBOLS)('%s carries no actionable block when zones are off', (symbol) => {
    expect('actionable' in run(symbol, { gate: false, zones: false, actionable: true })).toBe(false);
  });

  it.each(SYMBOLS)('%s carries one when both are on', (symbol) => {
    expect('actionable' in on(symbol)).toBe(true);
  });
});

describe('a direction is required before anything can be invalidated', () => {
  /*
   * Eight of the ten captures are sideways, and the instruction for that state
   * is to send `null` rather than force a number into every field. The corpus
   * makes the scale of it plain: 86 of 108 instruments are sideways today, so
   * the layer is silent on roughly four in five. That is the intended outcome,
   * and it is why the UI hides the rows rather than drawing an em dash.
   */
  it.each(SYMBOLS)('%s publishes a level only where the zone claims a direction', (symbol) => {
    const result = on(symbol);
    const zones = result.zones!;
    const actionable = result.actionable!;
    if (zones.zone === 'sideways') {
      expect(actionable.invalidation).toBeNull();
      expect(actionable.target).toBeNull();
      expect(actionable.riskReward).toBeNull();
      expect(actionable.notes).toContain('no_direction_to_invalidate');
    } else {
      expect(actionable.notes).not.toContain('no_direction_to_invalidate');
    }
  });

  it('counts the golden ten so a change in the mix is visible', () => {
    const withLevel = SYMBOLS.filter((symbol) => on(symbol).actionable!.invalidation !== null);
    expect(withLevel).toEqual(['IREN', 'SI-F']);
  });
});

describe('the invalidation is the level the engine itself acts on', () => {
  /*
   * The brief said "the lower edge of the frame" for an uptrend. Read as the
   * frame's far side that would be wrong, and — worse — untestable: an uptrend
   * ends, by `calculateTrendZones`'s own hysteresis, on the first close back
   * below `resistance`, so a stop at `support` would sit far below a level the
   * card had already stopped defending. What is published is the edge the zone
   * stands on, which makes the claim checkable. The next test checks it.
   */
  it.each(SYMBOLS)('%s takes its invalidation from a frame edge and nowhere else', (symbol) => {
    const result = on(symbol);
    const { invalidation, invalidationBasis } = result.actionable!;
    if (invalidation === null) return;
    const zones = result.zones!;
    expect(invalidation).toBe(zones.zone === 'uptrend' ? zones.resistance : zones.support);
    expect(invalidationBasis).toBe(zones.zone === 'uptrend' ? 'zone_floor' : 'zone_ceiling');
  });

  /*
   * The falsification of the whole row. Append one bar closing a tenth of a
   * percent past the published level and the zone must end; append one closing a
   * tenth of a percent short of it and the zone must hold. A level that fails
   * either half is decoration.
   *
   * Run across the 108-instrument corpus while P3 was being written: 18 of 18
   * published invalidations passed both halves. `atr_band` frames failed it in
   * both directions, which is why that mode publishes nothing — see
   * `calculateActionable`.
   */
  it.each(SYMBOLS)('%s changes zone on a close through its invalidation, and not before', (symbol) => {
    const candles = finalizedBars(symbol);
    const zones = zonesOf(candles);
    const { invalidation } = calculateActionable({ zones, atr: atrWilder(candles, 14).at(-1) ?? null });
    if (invalidation === null) return;
    const last = candles.at(-1)!;
    const step = Math.abs(invalidation) * 0.001;
    const append = (close: number): Bar => ({
      date: '2099-01-01',
      open: close,
      high: Math.max(close, last.high),
      low: Math.min(close, last.low),
      close,
      volume: last.volume,
    });
    const beyond = zones.zone === 'uptrend' ? invalidation - step : invalidation + step;
    const short = zones.zone === 'uptrend' ? invalidation + step : invalidation - step;
    expect(zonesOf([...candles, append(beyond)]).zone).toBe('sideways');
    expect(zonesOf([...candles, append(short)]).zone).toBe(zones.zone);
  });

  it('reads the ceiling rather than the floor in a downtrend', () => {
    const candles = afterBase([97.5, 95, 92.5, 90, 87.5]);
    const zones = zonesOf(candles);
    const actionable = actionableOf(candles);
    expect(zones.zone).toBe('downtrend');
    expect(actionable.invalidationBasis).toBe('zone_ceiling');
    expect(actionable.invalidation).toBe(zones.support);
    expect(actionable.invalidation!).toBeGreaterThan(zones.referenceClose);
  });

  /*
   * The frame re-anchors ON the breakout bar and is rebuilt from pivots, not
   * from where price happens to be, so the new edge can land at or above the
   * close. A stop above the current price is not a stop. Three of 108
   * instruments were in this state when P3 landed.
   */
  it('withholds the level when the re-anchored edge lands on the wrong side of the close', () => {
    const zones: MarketSignalZones = { ...on('IREN').zones!, zone: 'uptrend', resistance: 999, referenceClose: 100 };
    const actionable = calculateActionable({ zones, atr: 4 });
    expect(actionable.invalidation).toBeNull();
    expect(actionable.notes).toContain('invalidation_behind_close');
  });
});

describe('re-anchoring moves the invalidation with it', () => {
  /*
   * The failure this exists to catch is an invalidation that keeps pointing at
   * the frame that was current when the zone was entered. It is checked by
   * replaying IREN bar by bar and looking at every bar where the frame
   * re-anchored while the zone was directional: at each one the published level
   * must equal the NEW edge, and at least one must actually have moved.
   */
  const replay = (symbol: string) => {
    const all = finalizedBars(symbol);
    const rows: Array<{
      date: string;
      zone: string;
      mode: string;
      invalidation: number | null;
      resistance: number;
      support: number;
      entryLevel: number | null;
      reanchored: boolean;
    }> = [];
    for (let end = all.length - 200; end < all.length; end += 1) {
      const slice = all.slice(0, end + 1);
      const zones = zonesOf(slice);
      const { invalidation } = calculateActionable({ zones, atr: atrWilder(slice, 14).at(-1) ?? null });
      rows.push({
        date: slice.at(-1)!.date,
        zone: zones.zone,
        mode: zones.mode,
        invalidation,
        resistance: zones.resistance,
        support: zones.support,
        entryLevel: zones.entry?.level ?? null,
        reanchored: zones.frameAgeBars === 0,
      });
    }
    return rows;
  };

  it('reads the CURRENT frame edge at every bar of a 200-bar replay', () => {
    const rows = replay('IREN');
    const published = rows.filter((row) => row.invalidation !== null);
    expect(published.length).toBeGreaterThan(0);
    published.forEach((row) => {
      expect(row.invalidation).toBe(row.zone === 'uptrend' ? row.resistance : row.support);
    });
    // And it demonstrably moves rather than sticking: thirteen distinct levels
    // over those 200 bars, every one of them an edge of the frame current at the
    // bar that published it.
    expect(new Set(published.map((row) => row.invalidation)).size).toBeGreaterThan(1);
  });

  /*
   * The textbook case, pinned. DIA stays in the same uptrend across 2026-04-16
   * while the frame re-anchors under it, and the two anchors correctly move
   * independently: the invalidation follows the NEW edge, while `entry` — which
   * is what the target is measured from — keeps pointing at the level that was
   * actually broken five bars earlier.
   *
   * Pinned deliberately. `--refresh` moves the capture and this fails loudly,
   * the same way `reference.test.ts` guards the IREN identity.
   */
  it('follows the new edge while the target keeps its own anchor', () => {
    const rows = replay('DIA');
    const index = rows.findIndex((row) => row.date === '2026-04-16');
    expect(index).toBeGreaterThan(0);
    expect(rows[index - 1].zone).toBe('uptrend');
    expect(rows[index].zone).toBe('uptrend');
    expect(rows[index].reanchored).toBe(true);
    expect(rows[index - 1].invalidation).toBe(466.0394);
    expect(rows[index].invalidation).toBe(473.2605);
    expect(rows[index].entryLevel).toBe(466.0394);
  });

  /*
   * The other thing a re-anchor can do, also pinned: IREN re-anchors inside its
   * uptrend on 2026-04-24 straight into the ATR-band fallback, and the level is
   * DROPPED rather than kept. Not keeping a stale number even when there is
   * nothing to replace it with is the strongest form of the guarantee.
   *
   * The three bars after it are the measurement that decided the band rule. No
   * level was broken between them and the band edge moved every single day,
   * because it is EMA20 plus a multiple rather than something the market traded.
   */
  it('drops the level rather than carry it into an ATR band', () => {
    const rows = replay('IREN');
    const index = rows.findIndex((row) => row.date === '2026-04-24');
    expect(rows[index - 1].invalidation).toBe(44.75);
    expect(rows[index].reanchored).toBe(true);
    expect(rows[index].zone).toBe('uptrend');
    expect(rows[index].mode).toBe('atr_band');
    expect(rows[index].invalidation).toBeNull();

    const drifting = rows.slice(index, index + 3);
    expect(drifting.map((row) => row.mode)).toEqual(['atr_band', 'atr_band', 'atr_band']);
    expect(new Set(drifting.map((row) => row.resistance)).size).toBe(3);
  });
});

describe('the target is a measured move or it is nothing', () => {
  it('projects the broken frame from the level that broke', () => {
    const result = on('IREN');
    const entry = result.zones!.entry!;
    const actionable = result.actionable!;
    expect(entry).toEqual({ level: 43.72, height: 14.79, mode: 'structural', barsAgo: 1 });
    expect(actionable.target).toBe(58.51);
    expect(actionable.target).toBeCloseTo(entry.level + entry.height!, 4);
    expect(actionable.targetBasis).toBe('measured_move');
  });

  it('mirrors it downward', () => {
    const candles = afterBase([97, 94, 91, 88, 85]);
    const zones = zonesOf(candles);
    const actionable = actionableOf(candles);
    expect(zones.zone).toBe('downtrend');
    expect(actionable.target).toBeCloseTo(zones.entry!.level - zones.entry!.height!, 4);
  });

  /*
   * A measured move is a CONVENTION — the claim that a broken range travels its
   * own height again. Nothing in this repo has tested it; P4a's harness is what
   * turns it into a falsifiable claim. Until then every published target has to
   * carry the admission, and the card has to print it.
   */
  it.each(SYMBOLS)('%s never publishes a target without admitting it is a convention', (symbol) => {
    const actionable = on(symbol).actionable!;
    expect(actionable.targetIsConvention).toBe(actionable.target !== null);
  });

  it('withholds a projection price has already run past', () => {
    const actionable = actionableOf(afterBase(Array.from({ length: 12 }, (_, index) => 100 + (index + 1) * 3)));
    expect(actionable.invalidation).not.toBeNull();
    expect(actionable.target).toBeNull();
    expect(actionable.notes).toContain('measured_move_reached');
  });

  it('has no target without an invalidation, ever', () => {
    SYMBOLS.forEach((symbol) => {
      const actionable = on(symbol).actionable!;
      if (actionable.invalidation === null) expect(actionable.target).toBeNull();
    });
  });
});

describe('an ATR envelope is not a level', () => {
  /*
   * A departure from the brief, taken on a measurement rather than on taste. The
   * brief asked for the band edge with the fallback named in a reason; the band
   * is centred on EMA20 and re-centres every bar, so it failed the
   * close-through-it check in BOTH directions on NVDA. It is also, literally,
   * the 1.5-ATR-from-a-moving-average number this layer refuses to publish as a
   * target. One instrument in 108 is in this mode today.
   */
  const monotonic = bars(Array.from({ length: 80 }, (_, index) => 100 + index * 0.5));

  it('publishes nothing at all while the frame is an ATR band', () => {
    const zones = zonesOf(monotonic);
    const actionable = actionableOf(monotonic);
    expect(zones.mode).toBe('atr_band');
    expect(zones.zone).not.toBe('sideways');
    expect(actionable.invalidation).toBeNull();
    expect(actionable.target).toBeNull();
    expect(actionable.riskReward).toBeNull();
    expect(actionable.notes).toContain('atr_band_fallback');
  });

  it('records no height for a band, so nothing downstream can project one', () => {
    expect(zonesOf(monotonic).entry!.height).toBeNull();
  });

  it('says so in words, not only in a code', () => {
    expect(engine('BAND', monotonic).reasons.map((reason) => reason.id)).toContain('invalidation-from-band');
  });
});

describe('risk against reward', () => {
  it('is the reward leg over the risk leg and nothing else', () => {
    const result = on('IREN');
    const { invalidation, target, riskReward } = result.actionable!;
    const close = result.zones!.referenceClose;
    expect(riskReward).toBeCloseTo(Math.abs(target! - close) / Math.abs(close - invalidation!), 2);
  });

  /*
   * The brief's fixture was 3.18 : 5.80 = 0.55 : 1, taken when the frame came
   * from `nearestSupport`/`nearestResistance`. P2.5 moved the anchor to swing
   * structure and those numbers stopped describing anything, so they are
   * replaced rather than preserved. Across the corpus: 16 of 108 instruments
   * produce a ratio at all, median 2.12, and 4 of the 16 fall below 1.
   */
  it('reports both golden ratios as they now stand', () => {
    expect(on('IREN').actionable!.riskReward).toBe(7.94);
    expect(on('SI-F').actionable!.riskReward).toBe(1.05);
  });

  it('raises unfavorable_risk_reward below one, and not at one', () => {
    // The same breakout stopped one bar earlier or later straddles the line:
    // 122 leaves 0.71 of the frame's height still ahead of price, 120 leaves 1.06.
    const poor = afterBase([111, 113, 115, 117, 118, 120, 122]);
    const fair = afterBase([111, 113, 115, 117, 118, 120]);
    expect(actionableOf(poor).riskReward!).toBeLessThan(MARKET_SIGNAL_ACTIONABLE.unfavorableRiskReward);
    expect(actionableOf(fair).riskReward!).toBeGreaterThan(MARKET_SIGNAL_ACTIONABLE.unfavorableRiskReward);
    expect(engine('POOR', poor).flags).toContain('unfavorable_risk_reward');
    expect(engine('FAIR', fair).flags).not.toContain('unfavorable_risk_reward');
    // SI-F sits at 1.05, just the safe side of the line, and stays unflagged.
    expect(on('SI-F').flags).not.toContain('unfavorable_risk_reward');
  });

  /*
   * Approved after P4a measured it. A ratio built on a sub-half-ATR risk leg is
   * arithmetically correct and unstable, which calls for a label rather than a
   * deletion — and the measurements say those signals carry an edge of
   * +0.5 / +0.5 / -0.8pp, i.e. they are not better than any other.
   */
  it('marks a ratio whose risk leg is inside the noise', () => {
    const result = on('IREN');
    const actionable = result.actionable!;
    expect(actionable.invalidationAtr!).toBeLessThan(MARKET_SIGNAL_ZONE.proximity.nearTriggerAtr);
    expect(actionable.notes).toContain('risk_leg_inside_noise');
    expect(result.flags).toContain('risk_leg_inside_noise');
    // The ratio is still published — it is labelled, not withheld.
    expect(actionable.riskReward).toBe(7.94);
  });

  it('leaves a ratio with a real risk leg unmarked', () => {
    const result = on('SI-F');
    expect(result.actionable!.invalidationAtr!).toBeGreaterThan(MARKET_SIGNAL_ZONE.proximity.nearTriggerAtr);
    expect(result.actionable!.notes).not.toContain('risk_leg_inside_noise');
    expect(result.flags).not.toContain('risk_leg_inside_noise');
  });

  it('never flags an instrument that has no ratio', () => {
    SYMBOLS.forEach((symbol) => {
      const result = on(symbol);
      if (result.actionable!.riskReward === null) {
        expect(result.flags).not.toContain('unfavorable_risk_reward');
      }
    });
  });
});

describe('distances are stated in the instrument own terms', () => {
  it.each(SYMBOLS)('%s reports ATR and percent alongside every level it publishes', (symbol) => {
    const result = on(symbol);
    const actionable = result.actionable!;
    if (actionable.invalidation === null) {
      expect(actionable.invalidationAtr).toBeNull();
      expect(actionable.invalidationPct).toBeNull();
      return;
    }
    const close = result.zones!.referenceClose;
    const atr = result.metrics.atr14!;
    expect(actionable.invalidationAtr).toBeCloseTo(Math.abs(close - actionable.invalidation) / atr, 2);
    expect(actionable.invalidationPct).toBeCloseTo(Math.abs(close - actionable.invalidation) / close * 100, 2);
    // Magnitudes, never signed: which side the level lies on is already carried
    // by `invalidationBasis`, and a sign here reads as a direction it does not have.
    expect(actionable.invalidationAtr!).toBeGreaterThanOrEqual(0);
  });
});
