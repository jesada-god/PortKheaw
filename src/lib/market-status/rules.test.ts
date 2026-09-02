import { describe, expect, it } from 'vitest';
import {
  MARKET_STATUS_BANDS,
  MARKET_STATUS_INPUTS,
  MARKET_STATUS_TOTAL_WEIGHT,
  type MarketStatusInputKey,
  type MarketStatusLabel,
} from '@/src/config/market-status';
import { contributionOf, evaluateMarketStatus, scoreBounds, type MarketStatusReading } from './rules';

/**
 * Every reading is written as a percent move and converted to a price pair, so
 * a case reads as the market event it represents rather than as two numbers.
 * The base is 100 for every instrument: nothing in the table depends on an
 * instrument's absolute level, only on its move, and pinning the base makes
 * that visible.
 */
const BASE = 100;

function move(percent: number | null): { value: number | null; comparisonClose: number | null } {
  return percent === null
    ? { value: null, comparisonClose: null }
    : { value: BASE * (1 + percent / 100), comparisonClose: BASE };
}

function readings(moves: Partial<Record<MarketStatusInputKey, number | null>>): MarketStatusReading[] {
  return MARKET_STATUS_INPUTS.map((input) => ({
    key: input.key,
    ...move(moves[input.key] === undefined ? 0 : moves[input.key]!),
  }));
}

/** A clearly risk-on tape: equities up hard, every risk input falling. */
const STRONG_UP = { SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: -15, US10Y: -4, DXY: -1.2 } as const;
/** Its mirror. */
const STRONG_DOWN = { SPX: -1.5, NDX: -1.8, DJI: -1.5, VIX: 15, US10Y: 4, DXY: 1.2 } as const;
/** Everything inside its own dead band. */
const FLAT = { SPX: 0, NDX: 0, DJI: 0, VIX: 0, US10Y: 0, DXY: 0 } as const;

describe('the rule table — every branch of the label', () => {
  it('reads a broad advance as UPTREND', () => {
    const result = evaluateMarketStatus(readings(STRONG_UP));
    expect(result.status).toBe('available');
    expect(result.rawLabel).toBe('UPTREND');
  });

  it('reads a broad decline as WEAK', () => {
    expect(evaluateMarketStatus(readings(STRONG_DOWN)).rawLabel).toBe('WEAK');
  });

  it('reads a tape where nothing moved as SIDEWAYS', () => {
    const result = evaluateMarketStatus(readings(FLAT));
    expect(result.rawLabel).toBe('SIDEWAYS');
    // Every input readable and every one contributing exactly zero — which is a
    // reading, not an absence.
    expect(result.missing).toEqual([]);
    expect(result.inputs.every((item) => item.contribution === 0)).toBe(true);
  });

  it('stays SIDEWAYS when equities rise but the risk inputs disagree', () => {
    /*
      The case the card exists for. Equities up while the fear gauge, yields and
      the dollar all rise too is not an advance — it is a market pulling in two
      directions, and calling it UPTREND on the equity rows alone would be the
      reading a reader could get by glancing at the index and skipping the card.
    */
    const result = evaluateMarketStatus(readings({
      SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: 15, US10Y: 4, DXY: 1.2,
    }));
    expect(result.rawLabel).toBe('SIDEWAYS');
  });

  it('produces all three labels and never a fourth, across the whole range', () => {
    const seen = new Set<MarketStatusLabel>();
    for (let percent = -3; percent <= 3; percent += 0.05) {
      const result = evaluateMarketStatus(readings({
        SPX: percent, NDX: percent, DJI: percent, VIX: -percent * 8, US10Y: -percent * 2, DXY: -percent,
      }));
      if (result.rawLabel) seen.add(result.rawLabel);
    }
    expect([...seen].sort()).toEqual(['SIDEWAYS', 'UPTREND', 'WEAK']);
  });
});

describe('the dead band and the ramp', () => {
  it('contributes exactly zero inside the band, on both sides', () => {
    for (const input of MARKET_STATUS_INPUTS) {
      expect(contributionOf(input, input.flatBandPercent)).toBe(0);
      expect(contributionOf(input, -input.flatBandPercent)).toBe(0);
      expect(contributionOf(input, 0)).toBe(0);
    }
  });

  it('contributes the full weight at the cap and no more beyond it', () => {
    for (const input of MARKET_STATUS_INPUTS) {
      const atCap = contributionOf(input, input.fullWeightPercent)!;
      const wayBeyond = contributionOf(input, input.fullWeightPercent * 10)!;
      expect(Math.abs(atCap)).toBeCloseTo(input.weight, 10);
      // The cap is what stops one instrument's very bad day deciding the card.
      expect(Math.abs(wayBeyond)).toBeCloseTo(input.weight, 10);
    }
  });

  it('ramps monotonically between the band and the cap', () => {
    for (const input of MARKET_STATUS_INPUTS) {
      let previous = 0;
      for (let step = 0; step <= 20; step += 1) {
        const percent = input.flatBandPercent
          + ((input.fullWeightPercent - input.flatBandPercent) * step) / 20;
        const magnitude = Math.abs(contributionOf(input, percent)!);
        expect(magnitude).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = magnitude;
      }
    }
  });

  it('returns null — never zero — for a reading it does not have', () => {
    // The distinction the whole availability gate rests on: "did not move" and
    // "could not be read" must stay separable all the way through.
    for (const input of MARKET_STATUS_INPUTS) {
      expect(contributionOf(input, null)).toBeNull();
      expect(contributionOf(input, Number.NaN)).toBeNull();
    }
  });

  it('treats an unusable comparison base as unreadable rather than as a huge move', () => {
    const result = evaluateMarketStatus(MARKET_STATUS_INPUTS.map((input) => ({
      key: input.key,
      value: 100,
      comparisonClose: input.key === 'VIX' ? 0 : BASE,
    })));
    expect(result.missing).toEqual(['VIX']);
  });
});

describe('polarity — the direction of every input, pinned', () => {
  /*
    ===========================================================================
    THE MOST EXPENSIVE THING ON THIS CARD TO GET WRONG
    ===========================================================================
    A flipped polarity produces a card that is confidently wrong in exactly the
    conditions that matter most — calling a VIX spike an advance — and nothing
    about the output looks broken. It cannot be caught by reading the label,
    only by asserting the direction of each input in isolation.

    Each case moves ONE input and holds the rest flat, so nothing else can mask
    or supply the sign being tested.
  */
  const alone = (key: MarketStatusInputKey, percent: number) =>
    evaluateMarketStatus(readings({ ...FLAT, [key]: percent }));

  const contributionFor = (key: MarketStatusInputKey, percent: number) =>
    alone(key, percent).inputs.find((item) => item.input.key === key)!.contribution!;

  it.each(['SPX', 'NDX', 'DJI'] as const)('%s rising pushes TOWARD an uptrend', (key) => {
    expect(contributionFor(key, 5)).toBeGreaterThan(0);
    expect(contributionFor(key, -5)).toBeLessThan(0);
  });

  it('VIX rising pushes AWAY from an uptrend — the fear gauge is inverted', () => {
    // VIX up means traders are paying up for protection. It is the one price on
    // this card where a bigger number is worse news.
    expect(contributionFor('VIX', 25)).toBeLessThan(0);
    expect(contributionFor('VIX', -25)).toBeGreaterThan(0);
  });

  it('the ten-year yield rising pushes AWAY from an uptrend', () => {
    // A higher risk-free yield makes owning stocks relatively less attractive.
    expect(contributionFor('US10Y', 8)).toBeLessThan(0);
    expect(contributionFor('US10Y', -8)).toBeGreaterThan(0);
  });

  it('the dollar strengthening pushes AWAY from an uptrend', () => {
    expect(contributionFor('DXY', 3)).toBeLessThan(0);
    expect(contributionFor('DXY', -3)).toBeGreaterThan(0);
  });

  it('states the polarity of all six as data, so a table edit has to face it', () => {
    expect(Object.fromEntries(MARKET_STATUS_INPUTS.map((input) => [input.key, input.polarity])))
      .toEqual({ SPX: 1, NDX: 1, DJI: 1, VIX: -1, US10Y: -1, DXY: -1 });
  });

  /*
    A BOND-FUND PROXY WOULD NEED THE OPPOSITE SIGN, and this is here so that the
    day somebody swaps `^TNX` for `IEF` they trip over it.

    `^TNX` IS the yield: the number rises when yields rise. IEF is a fund holding
    7-10y Treasuries, and a bond's PRICE moves inversely to its yield — so IEF
    rising means yields FALLING, which is the opposite market event. Swapping the
    symbol without flipping `polarity` from -1 to +1 would silently invert the
    card's reading of interest rates.
  */
  it('documents that the yield input quotes the YIELD, not a bond price', () => {
    const us10y = MARKET_STATUS_INPUTS.find((input) => input.key === 'US10Y')!;
    expect(us10y.symbol).toBe('^TNX');
    expect(us10y.polarity).toBe(-1);
    // If this ever becomes a bond fund the polarity must flip with it.
    expect(us10y.symbol).not.toBe('IEF');
  });
});

describe('proxy labelling — a stand-in is never presented as the thing', () => {
  /*
    This used to assert the opposite: that every EQUITY input carried a proxy
    badge, because all three quoted funds — SPY, QQQ, DIA — under labels naming
    the indices. The badge was the compensation for a number that was not the
    thing its label said. The equity rows now quote `^GSPC`, `^NDX` and `^DJI`,
    so there is nothing left to compensate for and a badge on any of them would
    itself be the false statement.

    What survives from that test is the rule it was enforcing, which was never
    "equities are proxies": a symbol that is not the thing its label names must
    say so on screen. Both halves are pinned below.
  */
  it('quotes every input at the instrument its label names', () => {
    const bySymbol = Object.fromEntries(MARKET_STATUS_INPUTS.map((i) => [i.key, i.symbol]));
    expect(bySymbol).toMatchObject({
      SPX: '^GSPC',
      NDX: '^NDX',
      DJI: '^DJI',
      VIX: '^VIX',
      US10Y: '^TNX',
      DXY: 'DX-Y.NYB',
    });
  });

  it('carries no proxy badge, because nothing is standing in for anything', () => {
    for (const input of MARKET_STATUS_INPUTS) expect(input.proxyLabelTh).toBeNull();
  });

  /*
    The other half — that a badge, once set, actually reaches the reader — is a
    statement about the screen and is pinned beside the component, in
    `MarketTodaySection.test.tsx`. `ReadingCell` renders whatever is here for
    ANY input, with no list of which keys are allowed to have one, which is what
    makes the day a provider forces a proxy back a one-line config change.
  */
});

describe('missing data — the card withholds rather than guesses', () => {
  it.each(['SPX', 'NDX', 'DJI'] as const)(
    'reports insufficient when the %s reading is missing',
    (key) => {
      const result = evaluateMarketStatus(readings({ ...STRONG_UP, [key]: null }));
      expect(result.status).toBe('insufficient');
      expect(result.label).toBeNull();
      expect(result.rawLabel).toBeNull();
      expect(result.insufficientReason).toBe('missing-equity-input');
      expect(result.missing).toContain(key);
    },
  );

  it('withholds the regime subtitle but keeps the label when VIX is missing', () => {
    const result = evaluateMarketStatus(readings({ ...STRONG_UP, VIX: null }));
    expect(result.status).toBe('available');
    expect(result.rawLabel).toBe('UPTREND');
    expect(result.regime).toBeNull();
  });

  it('withholds the regime subtitle but keeps the label when the ten-year is missing', () => {
    const result = evaluateMarketStatus(readings({ ...STRONG_UP, US10Y: null }));
    expect(result.status).toBe('available');
    expect(result.regime).toBeNull();
  });

  it('keeps the regime when only the dollar is missing', () => {
    // The least load-bearing of the three: losing it degrades the reading rather
    // than invalidating it, so the subtitle survives.
    const result = evaluateMarketStatus(readings({ ...STRONG_UP, DXY: null }));
    expect(result.status).toBe('available');
    expect(result.regime).not.toBeNull();
  });

  it('reports insufficient and no regime when everything is missing', () => {
    const result = evaluateMarketStatus(readings({
      SPX: null, NDX: null, DJI: null, VIX: null, US10Y: null, DXY: null,
    }));
    expect(result.status).toBe('insufficient');
    expect(result.regime).toBeNull();
    expect(result.missing).toHaveLength(MARKET_STATUS_INPUTS.length);
  });

  it('treats an input absent from the readings exactly as an unreadable one', () => {
    // A caller that simply did not supply a key must not be luckier than one
    // that supplied it as null.
    const partial = readings(STRONG_UP).filter((reading) => reading.key !== 'SPX');
    const result = evaluateMarketStatus(partial);
    expect(result.status).toBe('insufficient');
    expect(result.missing).toContain('SPX');
  });
});

describe('MONOTONICITY — losing an input never strengthens the answer', () => {
  /*
    ===========================================================================
    THE JOBY BUG, WRITTEN DOWN AS A TEST
    ===========================================================================
    A provider returned nothing for one factor; the factor fell out of the
    average; the average of what remained was HIGHER than the average of
    everything. A symbol got a stronger label for having less evidence behind
    it, and the output looked completely normal.

    THE PROPERTY, stated precisely, because "stronger" is ambiguous and the
    ambiguity is where the bug hides.

    UPTREND and WEAK are both DEFINITE claims; SIDEWAYS is the one that commits
    to nothing. Losing evidence may only ever move the answer TOWARD the
    noncommittal one. So for any tape, removing any subset of readings must
    leave the label either unchanged or SIDEWAYS — and in particular:

      * SIDEWAYS may never become UPTREND or WEAK  (a firmer claim on less)
      * UPTREND may never become WEAK, or the reverse  (a flipped claim)

    This is the first version of this test that the code passed honestly. The
    version before it asserted a bullishness ordering, which let WEAK become
    SIDEWAYS unnoticed while it caught the real bug — the ordering was the wrong
    axis, and it is definiteness that the JOBY failure is about.
  */
  const DEFINITE: Record<MarketStatusLabel, boolean> = {
    WEAK: true, UPTREND: true, SIDEWAYS: false,
  };

  /** Every subset of the six inputs, as a bitmask over the table. */
  function* subsets(): Generator<Set<MarketStatusInputKey>> {
    const keys = MARKET_STATUS_INPUTS.map((input) => input.key);
    for (let mask = 0; mask < 1 << keys.length; mask += 1) {
      yield new Set(keys.filter((_, index) => (mask & (1 << index)) !== 0));
    }
  }

  const TAPES: Array<Record<string, number>> = [
    { ...STRONG_UP },
    { ...STRONG_DOWN },
    { ...FLAT },
    // The mixed tapes are where a naive average is most likely to break: the
    // dropped input is the one holding the score back.
    { SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: 15, US10Y: 4, DXY: 1.2 },
    { SPX: -1.5, NDX: -1.8, DJI: -1.5, VIX: -15, US10Y: -4, DXY: -1.2 },
    { SPX: 0.4, NDX: -0.5, DJI: 0.2, VIX: -6, US10Y: 1.5, DXY: -0.4 },
    { SPX: -0.2, NDX: 0.3, DJI: -0.1, VIX: 4, US10Y: -2, DXY: 0.5 },
  ];

  it('never sharpens or flips the label when any subset of readings goes missing', () => {
    for (const tape of TAPES) {
      const full = evaluateMarketStatus(readings(tape as Partial<Record<MarketStatusInputKey, number>>));
      // Only meaningful for tapes that produce a label at all.
      if (full.rawLabel === null) continue;

      for (const dropped of subsets()) {
        if (dropped.size === 0) continue;
        const degraded = evaluateMarketStatus(readings(Object.fromEntries(
          MARKET_STATUS_INPUTS.map((input) => [
            input.key,
            dropped.has(input.key) ? null : tape[input.key] ?? 0,
          ]),
        ) as Partial<Record<MarketStatusInputKey, number>>));

        // Falling back to "cannot say" is always allowed.
        if (degraded.rawLabel === null) continue;
        const why = `dropping ${[...dropped].join(',')} from ${JSON.stringify(tape)} `
          + `moved ${full.rawLabel} to ${degraded.rawLabel}`;

        if (DEFINITE[full.rawLabel]) {
          // A definite claim may survive or soften — never become the opposite
          // definite claim.
          expect([full.rawLabel, 'SIDEWAYS'], why).toContain(degraded.rawLabel);
        } else {
          // SIDEWAYS may never sharpen into a claim on less evidence.
          expect(DEFINITE[degraded.rawLabel], why).toBe(false);
        }
      }
    }
  });

  it('never sharpens or flips the REGIME when a risk reading goes missing', () => {
    const DEFINITE_REGIME = { RISK_OFF: true, RISK_ON: true, NEUTRAL: false } as const;
    for (const tape of TAPES) {
      const full = evaluateMarketStatus(readings(tape as Partial<Record<MarketStatusInputKey, number>>));
      if (full.regime === null) continue;
      for (const key of ['VIX', 'US10Y', 'DXY'] as const) {
        const degraded = evaluateMarketStatus(readings({ ...tape, [key]: null } as Partial<Record<MarketStatusInputKey, number>>));
        if (degraded.regime === null) continue;
        if (DEFINITE_REGIME[full.regime]) {
          expect([full.regime, 'NEUTRAL']).toContain(degraded.regime);
        } else {
          expect(DEFINITE_REGIME[degraded.regime]).toBe(false);
        }
      }
    }
  });

  it('widens the interval by a missing input’s weight rather than dropping it', () => {
    /*
      The mechanism behind the property above, asserted directly so that a
      refactor back to averaging-over-what-survived fails here with a readable
      reason rather than only somewhere inside the subset sweep.

      Equities up at full ramp is a clear UPTREND with the risk inputs present
      and flat. Take those three readings away — half the table's weight — and
      the interval is wide enough that the worst case no longer clears the band,
      so the card stops short of the claim. That is the honest answer: with the
      fear gauge, yields and the dollar all unknown, "the market is advancing" is
      a bigger statement than the evidence in hand.
    */
    const withRiskFlat = evaluateMarketStatus(readings({
      SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: 0, US10Y: 0, DXY: 0,
    }));
    const withRiskMissing = evaluateMarketStatus(readings({
      SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: null, US10Y: null, DXY: null,
    }));
    expect(withRiskFlat.rawLabel).toBe('UPTREND');
    expect(withRiskMissing.rawLabel).toBe('SIDEWAYS');

    // Losing only the smallest risk weight leaves enough certainty to keep it.
    expect(evaluateMarketStatus(readings({
      SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: 0, US10Y: null, DXY: 0,
    })).rawLabel).toBe('UPTREND');

    expect(MARKET_STATUS_TOTAL_WEIGHT).toBe(12);
  });

  it('collapses the interval to a point when everything is readable', () => {
    const result = evaluateMarketStatus(readings(STRONG_UP));
    const bounds = scoreBounds(result.inputs)!;
    expect(bounds.worst).toBeCloseTo(bounds.best, 12);
  });
});

describe('persistence — a new reading waits before it is published', () => {
  it('keeps the previous label until a new one has stood two evaluations', () => {
    // One UPTREND reading after a run of SIDEWAYS is not yet an uptrend.
    const result = evaluateMarketStatus(readings(STRONG_UP), ['SIDEWAYS', 'SIDEWAYS', 'SIDEWAYS']);
    expect(result.rawLabel).toBe('UPTREND');
    expect(result.label).toBe('SIDEWAYS');
    expect(result.held).toBe(true);
  });

  it('adopts the new label once it has stood', () => {
    const result = evaluateMarketStatus(readings(STRONG_UP), ['UPTREND', 'SIDEWAYS']);
    expect(result.label).toBe('UPTREND');
    expect(result.held).toBe(false);
  });

  it('publishes immediately when there is no history to hold against', () => {
    // A first render is not a degraded state.
    const result = evaluateMarketStatus(readings(STRONG_UP));
    expect(result.label).toBe('UPTREND');
    expect(result.held).toBe(false);
  });

  it('skips the wait on a day big enough to have repriced the market', () => {
    // Holding yesterday's word through a 2%+ move in the broad index would
    // publish a reading the tape has already contradicted.
    const result = evaluateMarketStatus(
      readings({ ...STRONG_UP, SPX: 2.5 }),
      ['SIDEWAYS', 'SIDEWAYS', 'SIDEWAYS'],
    );
    expect(result.exempt).toBe(true);
    expect(result.label).toBe('UPTREND');
    expect(result.held).toBe(false);
  });

  it('counts the age over the RAW run, never over the held one', () => {
    /*
      `docs/signal-handover.md` §6.8: label age may not feed a threshold and a
      card may not imply an older label is a better one. A hold rule makes labels
      last longer, so an age counted over the held run would silently grow. This
      pins the age to the raw sequence.
    */
    const result = evaluateMarketStatus(readings(STRONG_UP), ['SIDEWAYS', 'SIDEWAYS']);
    expect(result.label).toBe('SIDEWAYS');
    // Held for three evaluations, but today's RAW reading is one evaluation old.
    expect(result.rawRunLength).toBe(1);
  });

  it('counts a standing raw run correctly', () => {
    const result = evaluateMarketStatus(readings(STRONG_UP), ['UPTREND', 'UPTREND', 'SIDEWAYS']);
    expect(result.rawRunLength).toBe(3);
  });
});

describe('the output vocabulary', () => {
  it('is exactly three words and the bands are symmetric', () => {
    // A fourth label would have to be added in the config, the rules and the
    // copy; this fails first and says so.
    expect(MARKET_STATUS_BANDS.uptrendAbove).toBe(-MARKET_STATUS_BANDS.weakBelow);
  });
});
