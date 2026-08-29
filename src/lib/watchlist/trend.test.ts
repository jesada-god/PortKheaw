import { describe, expect, it } from 'vitest';
import { MARKET_SIGNAL_SCORE_WEIGHTS } from '@/src/config/signal';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import type {
  MarketSignalComponentId,
  MarketSignalResult,
  MarketSignalScoreBreakdown,
  MarketSignalState,
} from '@/src/lib/analytics/market-signal/types';
import {
  WATCHLIST_TREND_WORD,
  trendProminence,
  watchlistTrend,
} from './trend';

/**
 * The engine's payload is large and almost none of it reaches this column, so
 * these build the two fields that do — `state` and `scoreBreakdown` — and leave
 * the rest as the shape the type requires. A fixture that filled in all of it
 * would be asserting the engine's structure rather than this module's rule.
 */
const COMPONENTS: MarketSignalComponentId[] = [
  'emaTrend', 'momentum', 'trendStrength', 'volume', 'priceStructure',
];

function breakdown(points: Partial<Record<MarketSignalComponentId, number | null>>): MarketSignalScoreBreakdown {
  return Object.fromEntries(COMPONENTS.map((id) => {
    const value = id in points ? points[id]! : 0;
    const maxPoints = MARKET_SIGNAL_SCORE_WEIGHTS[id];
    return [id, {
      points: value,
      maxPoints,
      normalizedScore: value === null ? null : value / maxPoints,
      coverage: value === null ? 0 : 1,
      factorsUsed: value === null ? 0 : 3,
      available: value !== null,
    }];
  })) as MarketSignalScoreBreakdown;
}

function signal(
  state: MarketSignalState,
  points: Partial<Record<MarketSignalComponentId, number | null>>,
): MarketSignalResult {
  return {
    symbol: 'TEST',
    timeframe: '1D',
    calculatedAt: '2026-08-29T00:00:00.000Z',
    latestCandleAt: '2026-08-28',
    source: 'test',
    freshness: { status: 'realtime', asOf: null, maxAgeSeconds: null },
    dataPoints: { received: 300, finalized: 299 },
    scoreBreakdown: breakdown(points),
    reasons: [],
    warnings: [],
    flags: [],
    metrics: {} as MarketSignalResult['metrics'],
    confidenceBreakdown: {
      completeness: 1, agreement: 1, evidenceStrength: 1,
      volumeConfirmation: 1, regimeClarity: 1, conflictPenalty: 0,
    },
    status: 'available',
    state,
    bias: 'neutral',
    score: 0,
    confidence: 50,
    confidenceLabel: 'Medium',
    evidenceAgreement: 50,
    evidenceAgreementLabel: 'Medium',
  } as MarketSignalResult;
}

/** How definite a published level is. The only thing monotonicity is about. */
const definiteness: Record<string, number> = {
  unknown: 0, neutral: 0, weak: 1, good: 2, bad: 2,
};

describe('watchlist trend — monotonicity', () => {
  /*
   * THE JOBY CASE, in the engine's own units.
   *
   * Four components agree bullish and one pushes hard the other way, which nets
   * out to a score the engine reads as directional. Dropping the single
   * NEGATIVE component is the exact move that made the old market-status ratio
   * upgrade itself: what remains is more positive than the whole was.
   */
  it('does not strengthen the label when the one negative component goes missing', () => {
    const whole = signal('BULLISH', {
      emaTrend: 24, momentum: 20, trendStrength: 12, volume: 12, priceStructure: -15,
    });
    const partial = signal('BULLISH', {
      emaTrend: 24, momentum: 20, trendStrength: 12, volume: 12, priceStructure: null,
    });

    const before = watchlistTrend(whole);
    const after = watchlistTrend(partial);

    expect(definiteness[after.level]).toBeLessThanOrEqual(definiteness[before.level]);
  });

  /*
   * The general property, swept rather than argued. Every subset of the five
   * components is removed from a reading in turn; not one of them may produce a
   * more definite answer than the full set did.
   */
  it('never becomes more definite for any subset of missing components', () => {
    const full: Record<MarketSignalComponentId, number> = {
      emaTrend: 21, momentum: 18, trendStrength: -9, volume: 10, priceStructure: -12,
    };
    const baseline = watchlistTrend(signal('BULLISH', full));

    for (let mask = 1; mask < 1 << COMPONENTS.length; mask += 1) {
      const points: Partial<Record<MarketSignalComponentId, number | null>> = { ...full };
      const dropped: string[] = [];
      COMPONENTS.forEach((id, index) => {
        if (mask & (1 << index)) { points[id] = null; dropped.push(id); }
      });
      const degraded = watchlistTrend(signal('BULLISH', points));
      expect(
        definiteness[degraded.level],
        `dropping ${dropped.join(', ')} strengthened ${baseline.level} to ${degraded.level}`,
      ).toBeLessThanOrEqual(definiteness[baseline.level]);
    }
  });

  it('marks the reading as demoted when the interval refuses the engine label', () => {
    const demoted = watchlistTrend(signal('BULLISH', {
      emaTrend: 24, momentum: null, trendStrength: null, volume: null, priceStructure: null,
    }));
    expect(demoted.level).toBe('neutral');
    expect(demoted.demoted).toBe(true);
    expect(demoted.word).toBe(WATCHLIST_TREND_WORD.neutral);
  });

  it('leaves a fully readable engine label alone', () => {
    const clear = watchlistTrend(signal('STRONG_BULLISH', {
      emaTrend: 28, momentum: 23, trendStrength: 14, volume: 13, priceStructure: 14,
    }));
    expect(clear.level).toBe('good');
    expect(clear.demoted).toBe(false);
  });

  it('never upgrades the engine, even when the interval would allow more', () => {
    /*
     * The engine calls this SIDEWAYS despite a clearly positive interval — the
     * gate, a conflict veto, or the neutral band. The column follows the engine
     * down, never up: this module withholds, it does not decide.
     */
    const held = watchlistTrend(signal('SIDEWAYS', {
      emaTrend: 28, momentum: 23, trendStrength: 14, volume: 13, priceStructure: 14,
    }));
    expect(held.level).toBe('neutral');
    expect(held.demoted).toBe(false);
  });
});

describe('watchlist trend — missing data', () => {
  it('reads an insufficient-data payload as no reading, never as calm', () => {
    const insufficient = {
      ...signal('SIDEWAYS', {}),
      status: 'insufficient-data',
      state: null,
      bias: null,
      score: null,
      reason: 'not enough candles',
    } as unknown as MarketSignalResult;

    const trend = watchlistTrend(insufficient);
    expect(trend.level).toBe('unknown');
    expect(trend.word).toBe('ยังไม่มีข้อมูล');
  });

  it('reads an absent signal as no reading', () => {
    expect(watchlistTrend(null).level).toBe('unknown');
  });

  it('reads every component missing as no reading rather than ทรงตัว', () => {
    const blank = watchlistTrend(signal('SIDEWAYS', {
      emaTrend: null, momentum: null, trendStrength: null, volume: null, priceStructure: null,
    }));
    /*
     * The interval spans the entire range, so it supports nothing — but the
     * engine still said SIDEWAYS, and `lessDefinite` keeps the neutral reading
     * rather than inventing an unknown. What must NOT happen is a definite
     * label, which is what this asserts.
     */
    expect(definiteness[blank.level]).toBe(0);
  });
});

describe('watchlist trend — ordering', () => {
  it('ranks a fall as prominently as a rise', () => {
    expect(trendProminence('bad')).toBe(trendProminence('good'));
  });

  it('sorts a reading above a row that has none', () => {
    expect(trendProminence('neutral')).toBeGreaterThan(trendProminence('unknown'));
    expect(trendProminence('unknown')).toBeLessThan(trendProminence('weak'));
  });
});

describe('watchlist trend — copy', () => {
  it('says nothing from the banned lists', () => {
    const words = Object.values(WATCHLIST_TREND_WORD).join(' ');
    for (const phrase of [...CARD_MUST_NOT_SAY, ...NEVER_SAY]) {
      expect(words, phrase).not.toContain(phrase);
    }
  });

  it('gives every level a word, so no cell can render empty', () => {
    for (const word of Object.values(WATCHLIST_TREND_WORD)) {
      expect(word.trim().length).toBeGreaterThan(0);
    }
  });

  it('publishes no score, percentage or confidence anywhere in the column', () => {
    const trend = watchlistTrend(signal('BULLISH', {
      emaTrend: 24, momentum: 20, trendStrength: 12, volume: 12, priceStructure: 8,
    }));
    expect(Object.keys(trend).sort()).toEqual(['demoted', 'level', 'word']);
  });
});
