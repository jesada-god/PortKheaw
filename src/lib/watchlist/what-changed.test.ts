import { describe, expect, it } from 'vitest';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import { STATUS_PRESENTATION, type StatusLevel } from '@/src/lib/presentation/status';
import {
  WHAT_CHANGED_DETECTORS,
  WHAT_CHANGED_LIMIT,
  WHAT_CHANGED_THRESHOLDS,
  capWhatChanged,
  detectWhatChanged,
  median,
  sampleStandardDeviation,
  whatChanged,
  type DailyBar,
  type WhatChangedInput,
  type WhatChangedItem,
} from './what-changed';

/**
 * The detectors, at their boundaries and with their inputs taken away.
 *
 * The boundary tests are written against the CONSTANTS rather than against the
 * literals they currently hold. A test asserting that 4.1% fires and 3.9% does
 * not is a test that keeps passing after somebody moves the rule to 3σ, which
 * is the one moment it needed to speak.
 *
 * The monotonicity sweep is the reason this file is long. Everything else here
 * checks that a detector fires when it should; the sweep checks the property
 * that cannot be tested one case at a time — that no combination of missing
 * inputs produces an item the complete inputs did not.
 */

/** A flat history: same close, same volume, every day. Zero volatility. */
function flatBars(count: number, close = 100, volume = 1_000_000): DailyBar[] {
  return Array.from({ length: count }, (_unused, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    open: close,
    close,
    volume,
    finalized: true,
  }));
}

/**
 * A history with a stated daily standard deviation.
 *
 * Alternating ±`stepPercent` around a level gives a return series of exactly
 * two magnitudes, whose sample deviation is close to `stepPercent` — near
 * enough that a test can sit either side of `2σ` without being fragile, and the
 * assertions below measure the realised sigma rather than assuming it.
 */
function alternatingBars(count: number, stepPercent: number, base = 100): DailyBar[] {
  return Array.from({ length: count }, (_unused, index) => {
    const close = base * (1 + (index % 2 === 0 ? 0 : stepPercent / 100));
    return {
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      open: close,
      close,
      volume: 1_000_000,
      finalized: true,
    };
  });
}

/** Enough bars for every bar-reading detector, with nothing unusual in them. */
function quietHistory(): DailyBar[] {
  return alternatingBars(WHAT_CHANGED_THRESHOLDS.returnSigmaLookbackDays + 1, 1);
}

function input(overrides: Partial<WhatChangedInput> = {}): WhatChangedInput {
  return {
    symbol: 'AAPL',
    dayChangePercent: null,
    bars: [],
    price: null,
    previousClose: null,
    support: null,
    resistance: null,
    trend: null,
    previousTrendLevel: null,
    earningsDays: null,
    ...overrides,
  };
}

function ids(items: readonly WhatChangedItem[]): string[] {
  return items.map((item) => item.detector).sort();
}

function textOf(items: readonly WhatChangedItem[], detector: string): string {
  const found = items.find((item) => item.detector === detector);
  expect(found, `expected a ${detector} item`).toBeDefined();
  return found!.text;
}

describe('what changed — the rule table itself', () => {
  it('gives every detector a name, a distinct id and a distinct importance', () => {
    const seenIds = new Set(WHAT_CHANGED_DETECTORS.map((detector) => detector.id));
    const seenImportance = new Set(WHAT_CHANGED_DETECTORS.map((detector) => detector.importance));
    expect(seenIds.size).toBe(WHAT_CHANGED_DETECTORS.length);
    /*
      Distinct importances are not cosmetic. Two detectors sharing one would
      make the cap's outcome depend on the tie-break for a pair the table meant
      to rank, which is the one place "deterministic" and "intended" come apart.
    */
    expect(seenImportance.size).toBe(WHAT_CHANGED_DETECTORS.length);
    for (const detector of WHAT_CHANGED_DETECTORS) {
      expect(detector.name.trim().length, detector.id).toBeGreaterThan(0);
      expect(Number.isInteger(detector.importance), detector.id).toBe(true);
    }
  });

  it('never says ผิดปกติ, and never a banned phrase, in any sentence it can produce', () => {
    /*
      Every sentence the table can emit, gathered by firing every detector at
      once rather than by reading the source — a source scan proves a string is
      absent from a file, not that the branch printing it cannot be reached.
    */
    const everything = detectWhatChanged(input({
      dayChangePercent: -9,
      bars: [...quietHistory(), {
        date: '2026-03-02', open: 90, close: 91, volume: 9_000_000, finalized: false,
      }],
      price: 88,
      previousClose: 100,
      support: 95,
      resistance: 120,
      trend: { level: 'bad', word: 'ขาลง', demoted: false },
      previousTrendLevel: 'good',
      earningsDays: 3,
    }));
    expect(everything.length).toBe(WHAT_CHANGED_DETECTORS.length);
    const sentences = everything.map((item) => item.text).join(' ');
    expect(sentences).not.toContain('ผิดปกติ');
    for (const phrase of [...CARD_MUST_NOT_SAY, ...NEVER_SAY]) {
      expect(sentences, phrase).not.toContain(phrase);
    }
  });

  it('states a number in every sentence that has a threshold behind it', () => {
    const everything = detectWhatChanged(input({
      dayChangePercent: -9,
      bars: [...quietHistory(), {
        date: '2026-03-02', open: 90, close: 91, volume: 9_000_000, finalized: false,
      }],
      price: 88,
      previousClose: 100,
      support: 95,
      resistance: 120,
      trend: { level: 'bad', word: 'ขาลง', demoted: false },
      previousTrendLevel: 'good',
      earningsDays: 3,
    }));
    for (const item of everything) {
      /*
        `trend-change` is the one exemption and it is not a hole: it names both
        levels in words, which is the measurement. Every other sentence has to
        carry a digit, because its threshold is numeric and a reader who cannot
        see the number cannot tell why the line is there.
      */
      if (item.detector === 'trend-change') continue;
      expect(/\d/.test(item.text), `${item.detector}: ${item.text}`).toBe(true);
    }
  });

  it('marks every item with the shared five-level vocabulary and never with unknown', () => {
    const everything = detectWhatChanged(input({
      dayChangePercent: 9,
      bars: [...quietHistory(), {
        date: '2026-03-02', open: 110, close: 111, volume: 9_000_000, finalized: false,
      }],
      price: 130,
      previousClose: 100,
      support: 95,
      resistance: 120,
      trend: { level: 'good', word: 'ขาขึ้น', demoted: false },
      previousTrendLevel: 'bad',
      earningsDays: 0,
    }));
    for (const item of everything) {
      expect(['good', 'neutral', 'bad'], item.detector).toContain(item.level);
      /*
        Every item still resolves to a drawable mark — the guarantee the old
        `emoji.length > 0` held — except the mark now comes from the level
        through the one shared table, so this asserts the level maps to a real
        direction rather than that a detector remembered to copy a character in.
      */
      expect(['trending_up', 'trending_flat', 'trending_down'], item.detector)
        .toContain(STATUS_PRESENTATION[item.level].icon);
    }
  });
});

describe('what changed — |ret| against 2 sigma of 60 days', () => {
  const bars = quietHistory();
  /* The realised deviation of the fixture, measured rather than assumed. */
  const returns = bars.slice(1).map((bar, index) =>
    ((bar.close - bars[index]!.close) / bars[index]!.close) * 100);
  const sigma = sampleStandardDeviation(returns)!;
  const bound = sigma * WHAT_CHANGED_THRESHOLDS.returnSigmaMultiple;
  const today: DailyBar = {
    date: '2026-03-02', open: 100, close: 100, volume: 1_000_000, finalized: false,
  };

  it('fires just above the bound and is silent just below it', () => {
    const above = detectWhatChanged(input({
      bars: [...bars, today], dayChangePercent: bound + 0.01,
    }));
    const below = detectWhatChanged(input({
      bars: [...bars, today], dayChangePercent: bound - 0.01,
    }));
    expect(ids(above)).toContain('return-sigma');
    expect(ids(below)).not.toContain('return-sigma');
  });

  it('is silent exactly at the bound — the rule is "more than", not "at least"', () => {
    const exact = detectWhatChanged(input({
      bars: [...bars, today], dayChangePercent: bound,
    }));
    expect(ids(exact)).not.toContain('return-sigma');
  });

  it('reads a fall as well as a rise, and marks them differently', () => {
    const up = detectWhatChanged(input({ bars: [...bars, today], dayChangePercent: bound + 1 }));
    const down = detectWhatChanged(input({ bars: [...bars, today], dayChangePercent: -(bound + 1) }));
    expect(up.find((item) => item.detector === 'return-sigma')!.level).toBe('good');
    expect(down.find((item) => item.detector === 'return-sigma')!.level).toBe('bad');
  });

  it('is silent on one bar fewer than the lookback needs, however large the move', () => {
    /*
      The heart of the monotonicity rule for this detector: it does not fall
      back to the deviation of what arrived. A shorter window has a different
      deviation, and accepting one means a provider truncation can PRODUCE a
      line.
    */
    const short = bars.slice(1);
    expect(short.length).toBe(WHAT_CHANGED_THRESHOLDS.returnSigmaLookbackDays);
    const result = detectWhatChanged(input({
      bars: [...short, today], dayChangePercent: 500,
    }));
    expect(ids(result)).not.toContain('return-sigma');
  });

  it('is silent when the history never moved, rather than treating zero as a bound', () => {
    /*
      A flat series has a deviation of zero, and `|ret| > 0` would be true of
      every non-zero day. `sampleStandardDeviation` returns null instead, so a
      symbol with no measurable volatility reports nothing rather than
      everything.
    */
    const result = detectWhatChanged(input({
      bars: [...flatBars(WHAT_CHANGED_THRESHOLDS.returnSigmaLookbackDays + 1), today],
      dayChangePercent: 0.4,
    }));
    expect(ids(result)).not.toContain('return-sigma');
  });
});

describe('what changed — volume against 2x the 20-day median', () => {
  const history = flatBars(WHAT_CHANGED_THRESHOLDS.volumeMedianLookbackDays, 100, 1_000_000);
  const multiple = WHAT_CHANGED_THRESHOLDS.volumeMedianMultiple;

  function withVolume(volume: number) {
    return detectWhatChanged(input({
      bars: [...history, { date: '2026-03-02', open: 100, close: 100, volume, finalized: false }],
    }));
  }

  it('fires just above the multiple and is silent at it and below it', () => {
    expect(ids(withVolume(1_000_000 * multiple + 1))).toContain('volume-surge');
    expect(ids(withVolume(1_000_000 * multiple))).not.toContain('volume-surge');
    expect(ids(withVolume(1_000_000 * multiple - 1))).not.toContain('volume-surge');
  });

  it('is silent on one bar fewer than the median needs', () => {
    const result = detectWhatChanged(input({
      bars: [
        ...history.slice(1),
        { date: '2026-03-02', open: 100, close: 100, volume: 99_000_000, finalized: false },
      ],
    }));
    expect(ids(result)).not.toContain('volume-surge');
  });

  it('uses the median, so one huge day in the sample does not raise the bar', () => {
    /*
      The reason the rule says median and not mean, made concrete. One
      eight-times day inside a twenty-day window lifts the MEAN by 35%, which
      would swallow a genuine 2.2x surge the next day. The median does not
      move at all.
    */
    const spiked = [...history];
    spiked[0] = { ...spiked[0]!, volume: 8_000_000 };
    const result = detectWhatChanged(input({
      bars: [...spiked, { date: '2026-03-02', open: 100, close: 100, volume: 2_200_000, finalized: false }],
    }));
    expect(ids(result)).toContain('volume-surge');
    expect(textOf(result, 'volume-surge')).toContain('2.2');
  });

  it('claims no direction — heavier trading is neither good news nor bad', () => {
    const result = withVolume(5_000_000);
    expect(result.find((item) => item.detector === 'volume-surge')!.level).toBe('neutral');
  });
});

describe('what changed — crossing support or resistance', () => {
  it('fires on the crossing and not on the days after it', () => {
    const crossed = detectWhatChanged(input({ previousClose: 118, price: 121, resistance: 120 }));
    expect(ids(crossed)).toContain('level-break');
    /* Already above yesterday too: the crossing was news then, not now. */
    const stillAbove = detectWhatChanged(input({ previousClose: 121, price: 123, resistance: 120 }));
    expect(ids(stillAbove)).not.toContain('level-break');
  });

  it('reads a fall through support as its own event', () => {
    const result = detectWhatChanged(input({ previousClose: 96, price: 94, support: 95 }));
    expect(result.find((item) => item.detector === 'level-break')!.level).toBe('bad');
    expect(textOf(result, 'level-break')).toContain('95');
  });

  it('is silent when the level is missing, and when the previous close is', () => {
    expect(ids(detectWhatChanged(input({ previousClose: 118, price: 121 })))).toEqual([]);
    expect(ids(detectWhatChanged(input({ price: 121, resistance: 120 })))).toEqual([]);
  });
});

describe('what changed — the published trend changing level', () => {
  function trendInput(level: StatusLevel, previous: StatusLevel, demoted = false) {
    return input({
      trend: { level, word: 'ไม่ได้อ่านในเทสต์นี้', demoted },
      previousTrendLevel: previous,
    });
  }

  it('fires when the level actually changed', () => {
    const result = detectWhatChanged(trendInput('bad', 'good'));
    expect(ids(result)).toContain('trend-change');
    expect(textOf(result, 'trend-change')).toBe('แนวโน้มเปลี่ยนจากขาขึ้นเป็นขาลง');
  });

  it('is silent when the level is the same as before', () => {
    expect(ids(detectWhatChanged(trendInput('good', 'good')))).toEqual([]);
  });

  it('IS SILENT ON A DEMOTED READING, however different the two levels look', () => {
    /*
      The guard the whole module is built around. `watchlistTrend` demotes when
      the evidence interval will not carry the engine's label, so a demoted
      ทรงตัว beside yesterday's ขาขึ้น is a statement about missing components,
      not about a reversal. Reporting it would be announcing a trend change
      caused by a provider outage.
    */
    expect(ids(detectWhatChanged(trendInput('neutral', 'good', true)))).toEqual([]);
  });

  it('is silent when either side has no reading', () => {
    expect(ids(detectWhatChanged(trendInput('good', 'unknown')))).toEqual([]);
    expect(ids(detectWhatChanged(trendInput('unknown', 'good')))).toEqual([]);
    expect(ids(detectWhatChanged(input({
      trend: { level: 'good', word: 'ขาขึ้น', demoted: false }, previousTrendLevel: null,
    })))).toEqual([]);
  });
});

describe('what changed — the opening gap', () => {
  const yesterday = flatBars(2, 100);
  const limit = WHAT_CHANGED_THRESHOLDS.gapPercent;

  function withOpen(open: number) {
    return detectWhatChanged(input({
      bars: [...yesterday, { date: '2026-03-02', open, close: open, volume: 1_000_000, finalized: false }],
    }));
  }

  it('fires just past the limit in both directions and is silent at it', () => {
    expect(ids(withOpen(100 * (1 + (limit + 0.01) / 100)))).toContain('gap');
    expect(ids(withOpen(100 * (1 - (limit + 0.01) / 100)))).toContain('gap');
    expect(ids(withOpen(100 * (1 + limit / 100)))).not.toContain('gap');
  });

  it('marks a gap down as a fall', () => {
    const result = withOpen(95);
    expect(result.find((item) => item.detector === 'gap')!.level).toBe('bad');
    expect(textOf(result, 'gap')).toContain('-5.00%');
  });

  it('is silent with only one bar, which has nothing to gap from', () => {
    expect(ids(detectWhatChanged(input({
      bars: [{ date: '2026-03-02', open: 130, close: 130, volume: 1, finalized: false }],
    })))).toEqual([]);
  });
});

describe('what changed — a scheduled report within 7 days', () => {
  const within = WHAT_CHANGED_THRESHOLDS.earningsWithinDays;

  it('fires on the boundary day and is silent the day past it', () => {
    expect(ids(detectWhatChanged(input({ earningsDays: within })))).toContain('earnings-soon');
    expect(ids(detectWhatChanged(input({ earningsDays: within + 1 })))).not.toContain('earnings-soon');
  });

  it('says วันนี้ on the day itself rather than "อีก 0 วัน"', () => {
    expect(textOf(detectWhatChanged(input({ earningsDays: 0 })), 'earnings-soon'))
      .toBe('ประกาศผลประกอบการวันนี้');
  });

  it('is silent on a negative count and on a fractional one', () => {
    expect(ids(detectWhatChanged(input({ earningsDays: -1 })))).toEqual([]);
    expect(ids(detectWhatChanged(input({ earningsDays: 3.5 })))).toEqual([]);
  });
});

describe('what changed — the daily cap', () => {
  function item(symbol: string, detector: WhatChangedItem['detector'], importance: number): WhatChangedItem {
    return { detector, symbol, importance, level: 'neutral', text: `${symbol} ${detector}` };
  }

  it('keeps the most important and drops the least, never the tail of the input', () => {
    const items = [
      item('AAA', 'earnings-soon', 0),
      item('BBB', 'volume-surge', 1),
      item('CCC', 'gap', 2),
      item('DDD', 'return-sigma', 3),
      item('EEE', 'trend-change', 4),
      item('FFF', 'level-break', 5),
    ];
    const capped = capWhatChanged(items);
    expect(capped).toHaveLength(WHAT_CHANGED_LIMIT);
    expect(capped.map((entry) => entry.detector)).toEqual([
      'level-break', 'trend-change', 'return-sigma', 'gap', 'volume-surge',
    ]);
    /* The one dropped is the least important, not the last one passed in. */
    expect(capped.map((entry) => entry.symbol)).not.toContain('AAA');
  });

  it('produces the same list from the same items whatever order they arrive in', () => {
    const items = [
      item('MSFT', 'gap', 2),
      item('AAPL', 'gap', 2),
      item('NVDA', 'level-break', 5),
      item('AAPL', 'volume-surge', 1),
      item('TSLA', 'gap', 2),
    ];
    const forwards = capWhatChanged(items).map((entry) => `${entry.symbol}:${entry.detector}`);
    const backwards = capWhatChanged([...items].reverse()).map((entry) => `${entry.symbol}:${entry.detector}`);
    expect(backwards).toEqual(forwards);
    /* Importance first, then symbol — a total order, so no pair can swap. */
    expect(forwards).toEqual([
      'NVDA:level-break', 'AAPL:gap', 'MSFT:gap', 'TSLA:gap', 'AAPL:volume-surge',
    ]);
  });

  it('shows no section at all when nothing changed', () => {
    /*
      The empty array is the ordinary outcome, not an error state. A watchlist
      of quiet symbols must produce nothing for the page to render.
    */
    expect(whatChanged([input({ symbol: 'AAPL' }), input({ symbol: 'MSFT' })])).toEqual([]);
  });

  it('caps across the whole watchlist, not per symbol', () => {
    const loud = (symbol: string) => input({
      symbol,
      previousClose: 118,
      price: 121,
      resistance: 120,
      earningsDays: 2,
    });
    const produced = whatChanged([loud('AAA'), loud('BBB'), loud('CCC')]);
    expect(produced).toHaveLength(WHAT_CHANGED_LIMIT);
    /* Three crossings outrank three report dates; two of the dates are dropped. */
    expect(produced.filter((entry) => entry.detector === 'level-break')).toHaveLength(3);
    expect(produced.filter((entry) => entry.detector === 'earnings-soon')).toHaveLength(2);
  });
});

describe('what changed — monotonicity under missing data', () => {
  /**
   * The complete input: every detector fires on it.
   *
   * The sweep below removes subsets of these fields and asserts the result is
   * always a SUBSET of what the complete input produced. Nothing else in this
   * file can catch a detector that reads "if this is missing, then…".
   */
  function complete(): WhatChangedInput {
    return input({
      dayChangePercent: -9,
      bars: [
        ...quietHistory(),
        { date: '2026-03-02', open: 90, close: 91, volume: 9_000_000, finalized: false },
      ],
      price: 88,
      previousClose: 100,
      support: 95,
      resistance: 120,
      trend: { level: 'bad', word: 'ขาลง', demoted: false },
      previousTrendLevel: 'good',
      earningsDays: 3,
    });
  }

  /**
   * Each way one input can go missing, as a function that erases it.
   *
   * `trend` gets TWO erasures because it has two ways to degrade: the reading
   * can vanish entirely, and it can survive as a demoted one. The second is the
   * interesting case and the one a null-only sweep would miss.
   */
  const erasures: Array<[string, (value: WhatChangedInput) => WhatChangedInput]> = [
    ['dayChangePercent', (value) => ({ ...value, dayChangePercent: null })],
    ['bars', (value) => ({ ...value, bars: [] })],
    ['price', (value) => ({ ...value, price: null })],
    ['previousClose', (value) => ({ ...value, previousClose: null })],
    ['support', (value) => ({ ...value, support: null })],
    ['resistance', (value) => ({ ...value, resistance: null })],
    ['trend', (value) => ({ ...value, trend: null })],
    ['trend demoted', (value) => ({
      ...value,
      trend: value.trend === null ? null : { ...value.trend, demoted: true },
    })],
    ['previousTrendLevel', (value) => ({ ...value, previousTrendLevel: null })],
    ['earningsDays', (value) => ({ ...value, earningsDays: null })],
  ];

  it('fires every detector on the complete input, so the sweep has something to lose', () => {
    expect(ids(detectWhatChanged(complete())))
      .toEqual(WHAT_CHANGED_DETECTORS.map((detector) => detector.id).sort());
  });

  it('never produces an item on any subset that the full input did not produce', () => {
    const full = new Set(detectWhatChanged(complete()).map((entry) => entry.detector));
    const total = 2 ** erasures.length;
    for (let mask = 0; mask < total; mask += 1) {
      let value = complete();
      const applied: string[] = [];
      for (let bit = 0; bit < erasures.length; bit += 1) {
        if ((mask & (1 << bit)) === 0) continue;
        const [name, erase] = erasures[bit]!;
        applied.push(name);
        value = erase(value);
      }
      for (const produced of detectWhatChanged(value)) {
        expect(
          full.has(produced.detector),
          `removing [${applied.join(', ')}] produced ${produced.detector}: ${produced.text}`,
        ).toBe(true);
      }
    }
  });

  it('never produces an item on any truncation of the history', () => {
    /*
      Field-level erasure is not the only way data goes missing. A provider that
      returns thirty bars instead of sixty-one is the common case, and the
      detectors answer it by reading a fixed-length SUFFIX with a hard minimum —
      so dropping older bars either changes nothing or silences a detector. This
      walks every prefix cut and proves it.
    */
    const value = complete();
    const full = new Set(detectWhatChanged(value).map((entry) => entry.detector));
    for (let cut = 0; cut < value.bars.length; cut += 1) {
      const truncated = { ...value, bars: value.bars.slice(cut) };
      for (const produced of detectWhatChanged(truncated)) {
        expect(
          full.has(produced.detector),
          `dropping the oldest ${cut} bars produced ${produced.detector}: ${produced.text}`,
        ).toBe(true);
      }
    }
  });

  it('produces nothing at all when every input is missing', () => {
    expect(detectWhatChanged(input())).toEqual([]);
  });

  it('produces nothing from non-finite numbers rather than a NaN sentence', () => {
    const produced = detectWhatChanged(input({
      dayChangePercent: Number.NaN,
      bars: quietHistory(),
      price: Number.POSITIVE_INFINITY,
      previousClose: Number.NaN,
      support: Number.NaN,
      resistance: Number.NaN,
      earningsDays: Number.NaN,
    }));
    expect(produced).toEqual([]);
  });

  it('produces nothing from a history of unusable prices', () => {
    const zeroed = quietHistory().map((bar) => ({ ...bar, close: 0, open: 0, volume: 0 }));
    const produced = detectWhatChanged(input({
      dayChangePercent: 12,
      bars: [...zeroed, { date: '2026-03-02', open: 0, close: 0, volume: 0, finalized: false }],
    }));
    expect(produced).toEqual([]);
  });
});

describe('what changed — the two statistics', () => {
  it('takes the median of an even sample as the mean of the middle pair', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 4, 2])).toBe(2.5);
    expect(median([1, 2, 3])).toBe(2);
    expect(median([])).toBeNull();
  });

  it('refuses a deviation it cannot compute, rather than returning zero', () => {
    expect(sampleStandardDeviation([])).toBeNull();
    expect(sampleStandardDeviation([5])).toBeNull();
    /* A flat sample has a real deviation of zero, and zero is not a usable bound. */
    expect(sampleStandardDeviation([2, 2, 2, 2])).toBeNull();
    expect(sampleStandardDeviation([1, Number.NaN])).toBeNull();
    expect(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });
});
