import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { MARKET_SIGNAL_GATE, MARKET_SIGNAL_RANGE_DIRECTION } from '@/src/config/signal';
import type { DataFreshness } from '@/src/lib/market-data/types';

import {
  bandAtLeast,
  calculateMarketSignal,
  rangeDirection,
} from './calculations';
import type { MarketSignalBand, MarketSignalCandle, MarketSignalConflict } from './types';

/**
 * P7 — a sideways zone may no longer erase a direction on its own.
 *
 * THE MEASUREMENT THIS EXISTS TO PROTECT. `trend_diagnosis.md` §B took every
 * bar where the ground truth called a move and the GATE+ZONES engine answered
 * SIDEWAYS — 11,330 of them — and attributed each to the rule that actually
 * produced it, in the engine's own order of evaluation. One line accounted for
 * **100%**: `zone === 'sideways'` in `zonePresentationState`, which returned
 * before the gate was consulted. The other three candidates were true on some
 * of those bars and could not have caused any of them (`band == neutral` 4.7%,
 * `conflicts` 17.9%, `regime.sideways` 0.2%). On the same bars the flags-OFF
 * engine named the ground truth's direction 95.3% of the time.
 *
 * §C then moved both knobs the zone entry rule owns by ±20% and measured the
 * recovery: 428 bars of 11,330 at best (3.8%). So the fix could not be a
 * threshold, and this is the rule that replaced it.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: whether the rule improves agreement.
 * That is a corpus-wide question with pre-registered pass criteria and it is
 * answered in `trend_persistence.md`, not by a unit test that could be made to
 * pass by choosing a friendlier fixture.
 */

const capture = (symbol: string) => JSON.parse(
  readFileSync(join(process.cwd(), '__golden__', 'candles', `${symbol}.json`), 'utf8'),
) as { source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] };

const SYMBOLS = ['IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD'];

const runs = new Map<string, ReturnType<typeof calculateMarketSignal>>();
/** Memoised: P8 makes every call three engine evaluations. See `zones.test.ts`. */
const withGateZones = (symbol: string) => {
  const cached = runs.get(symbol);
  if (cached) return cached;
  const frozen = capture(symbol);
  const result = calculateMarketSignal(frozen.candles, {
    symbol,
    source: frozen.source,
    freshness: frozen.freshness,
    calculatedAt: '2026-01-01T00:00:00.000Z',
    features: { gate: true, zones: true, actionable: false },
  });
  runs.set(symbol, result);
  return result;
};

/*
 * WARMED ONCE, SO NO SINGLE CASE PAYS FOR THE FIXTURE.
 *
 * `withGateZones` is memoised across the file and each miss is three engine
 * evaluations over a golden capture, so building all ten symbols costs about
 * four seconds — and every one of those seconds was billed to whichever `it`
 * happened to touch the map first, against Vitest's 5s default. On an idle
 * machine that left 20% of headroom; under a full `vitest run` it did not, and
 * "never publishes STRONG from inside a sideways frame" failed with "Test timed
 * out in 5000ms" while passing on its own.
 *
 * The cost belongs to the fixture, not to the first assertion that needs it. So
 * it is paid here, under a hook timeout sized for a loaded machine, and every
 * case below then measures only its own work — which is a map lookup. This also
 * makes the file independent of the order its cases run in, which is what made
 * the failure move around.
 */
beforeAll(() => {
  SYMBOLS.forEach(withGateZones);
}, 120_000);

const noConflict: readonly MarketSignalConflict[] = [];
const conflicted: readonly MarketSignalConflict[] = ['ema_vs_momentum'];

/** A score sitting squarely inside the named band, so no test depends on an edge. */
const scoreInside = (band: MarketSignalBand): number => {
  const { neutral, weak, strong } = MARKET_SIGNAL_GATE.bands;
  if (band === 'neutral') return Math.round(neutral / 2);
  if (band === 'weak') return Math.round((neutral + weak) / 2);
  if (band === 'moderate') return Math.round((weak + strong) / 2);
  return Math.min(100, strong + 10);
};

describe('band ordering', () => {
  it('ranks the four bands the way the config lists them', () => {
    const order: MarketSignalBand[] = ['neutral', 'weak', 'moderate', 'strong'];
    order.forEach((band, index) => {
      order.slice(0, index + 1).forEach((lower) => expect(bandAtLeast(band, lower)).toBe(true));
      order.slice(index + 1).forEach((higher) => expect(bandAtLeast(band, higher)).toBe(false));
    });
  });
});

describe('the direction a range is allowed to carry', () => {
  // Widened off the literal types on purpose: these tests must keep compiling
  // whichever band the config names, including when the two are set equal to
  // switch the buffer margin off.
  const minimum: MarketSignalBand = MARKET_SIGNAL_RANGE_DIRECTION.minimumBand;
  const retention: MarketSignalBand = MARKET_SIGNAL_RANGE_DIRECTION.retentionBand;
  /* Compared as strings so the check survives the config naming the same band
     twice — which is how the margin is switched off, and is a valid setting. */
  const marginIsOff = (minimum as string) === (retention as string);

  it('names the score\'s direction once the score reaches the minimum band', () => {
    expect(rangeDirection({
      score: scoreInside(minimum), band: minimum, conflicts: noConflict, previousDirection: null,
    })).toBe('bullish');
    expect(rangeDirection({
      score: -scoreInside(minimum), band: minimum, conflicts: noConflict, previousDirection: null,
    })).toBe('bearish');
  });

  /*
   * The one veto the range keeps. §5 of the handover already says a conflict
   * cannot erase a direction price has actually reached by leaving its frame —
   * but inside the frame price has reached nothing, so the evidence is the only
   * witness, and evidence pointing two ways is not one.
   */
  it('says nothing at all while two parts of the evidence contradict each other', () => {
    expect(rangeDirection({
      score: scoreInside('strong'), band: 'strong', conflicts: conflicted, previousDirection: null,
    })).toBeNull();
    expect(rangeDirection({
      score: scoreInside('strong'), band: 'strong', conflicts: conflicted, previousDirection: 'bullish',
    })).toBeNull();
  });

  it('stays silent below the minimum band', () => {
    const below: MarketSignalBand[] = ['neutral', 'weak', 'moderate']
      .filter((band) => !bandAtLeast(band as MarketSignalBand, minimum)) as MarketSignalBand[];
    expect(below.length).toBeGreaterThan(0);
    below.forEach((band) => {
      expect(rangeDirection({
        score: scoreInside(band), band, conflicts: noConflict, previousDirection: null,
      })).toBeNull();
    });
  });

  it('treats a score of exactly zero as no direction rather than as bullish', () => {
    expect(rangeDirection({
      score: 0, band: 'strong', conflicts: noConflict, previousDirection: null,
    })).toBeNull();
  });

  /*
   * THE BUFFER MARGIN, which is the whole reason `previousDirection` exists.
   *
   * Entering costs `minimumBand`; staying costs only `retentionBand`. Without
   * the gap a score grinding across one band edge relabels the card on
   * alternate days — the same failure the zone frame's own confirmation rule
   * was built to stop, and `trend_agreement.md` §1 measured the cost of not
   * having it as a flip ratio above 1.0 at all 27 grid points.
   */
  it('keeps a direction the previous bar named on a score that could not have started it', () => {
    if (marginIsOff) return; // margin switched off by config; nothing to assert
    const band = retention;
    expect(bandAtLeast(band, minimum)).toBe(false);
    expect(rangeDirection({
      score: scoreInside(band), band, conflicts: noConflict, previousDirection: null,
    })).toBeNull();
    expect(rangeDirection({
      score: scoreInside(band), band, conflicts: noConflict, previousDirection: 'bullish',
    })).toBe('bullish');
  });

  it('will not let the margin carry a direction the previous bar did not name', () => {
    if (marginIsOff) return;
    expect(rangeDirection({
      score: scoreInside(retention), band: retention, conflicts: noConflict, previousDirection: 'bearish',
    })).toBeNull();
  });

  it('never lets the margin reach below the retention band', () => {
    const under: MarketSignalBand[] = (['neutral', 'weak', 'moderate'] as MarketSignalBand[])
      .filter((band) => !bandAtLeast(band, retention));
    under.forEach((band) => {
      expect(rangeDirection({
        score: scoreInside(band), band, conflicts: noConflict, previousDirection: 'bullish',
      })).toBeNull();
    });
  });
});

describe('what the rule does to a real capture', () => {
  /*
   * A direction named from inside a frame is never STRONG_*.
   *
   * STRONG says the reading is confirmed by structure as well as by evidence,
   * and price that has not left its own frame has no structural confirmation to
   * offer. This is the assertion that stops the range path from quietly
   * becoming a second way to reach the loudest label the card has.
   */
  it('never publishes STRONG from inside a sideways frame', () => {
    SYMBOLS.forEach((symbol) => {
      const result = withGateZones(symbol);
      if (result.status !== 'available' || result.zones?.zone !== 'sideways') return;
      expect(result.state, symbol).not.toBe('STRONG_BULLISH');
      expect(result.state, symbol).not.toBe('STRONG_BEARISH');
    });
  });

  /*
   * The zone bar and the headline are allowed to disagree, and this is the
   * shape of the disagreement: the frame still says sideways. P7 does not move
   * the zone, it stops the zone from being the only voice — so `zones.zone`
   * must be untouched by it.
   */
  it('leaves the zone itself saying sideways when the headline names a direction', () => {
    SYMBOLS.forEach((symbol) => {
      const result = withGateZones(symbol);
      if (result.status !== 'available' || result.zones?.zone !== 'sideways') return;
      if (result.state !== 'BULLISH' && result.state !== 'BEARISH') return;
      expect(result.zones.zone, symbol).toBe('sideways');
      // and the bias follows the headline, so the card colours one answer
      expect(result.bias, symbol).toBe(result.state === 'BULLISH' ? 'bullish' : 'bearish');
    });
  });

  /*
   * The regime veto is above all of this and stays there. `trend_agreement.md`
   * appendix §6 measured it as flag-independent — 9837 bars either way — and
   * handover §5 states it as "regime มาก่อนทุกอย่าง, veto สูงสุด, เสมอ".
   */
  it('lets the regime veto outrank a range direction', () => {
    SYMBOLS.forEach((symbol) => {
      const result = withGateZones(symbol);
      if (result.status !== 'available') return;
      if (result.metrics.squeezeOn !== true) return;
      expect(result.persistence?.rawState, symbol).toBe('SQUEEZE');
    });
  });
});
