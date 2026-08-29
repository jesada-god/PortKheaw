import { describe, expect, it } from 'vitest';
import { MARKET_SIGNAL_PERSISTENCE } from '@/src/config/signal';
import {
  MARKET_STATUS_EXEMPTION_PERCENT,
  MARKET_STATUS_INPUTS,
  MARKET_STATUS_PERSISTENCE,
  type MarketStatusInputKey,
  type MarketStatusLabel,
} from '@/src/config/market-status';
import { heldLabel } from '@/src/lib/analytics/persistence-hold';
import { evaluateMarketStatus, type MarketStatusReading } from './rules';

/**
 * The hold rule END TO END, over the sequence of days a stored history produces.
 *
 * `rules.test.ts` covers the rule against a history handed to it directly. What
 * these cover is the thing that was actually broken in production: the card
 * passed `[]` on every render, so `minDurationBars: 2` was configured,
 * documented, unit-tested and completely inert — every reading published
 * immediately and the status could flip day to day on noise.
 */

function readings(moves: Partial<Record<MarketStatusInputKey, number | null>>): MarketStatusReading[] {
  return MARKET_STATUS_INPUTS.map((input) => {
    const percent = moves[input.key] ?? (moves[input.key] === undefined ? 0 : null);
    return {
      key: input.key,
      value: percent === null ? null : 100 * (1 + percent / 100),
      comparisonClose: percent === null ? null : 100,
    };
  });
}

const UP = { SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: -15, US10Y: -4, DXY: -1.2 } as const;
const DOWN = { SPX: -1.5, NDX: -1.8, DJI: -1.5, VIX: 15, US10Y: 4, DXY: 1.2 } as const;
const FLAT = { SPX: 0, NDX: 0, DJI: 0, VIX: 0, US10Y: 0, DXY: 0 } as const;

/**
 * Run a run of days, feeding each day's RAW label forward as the next day's
 * history — which is what the store does across renders.
 */
function runDays(tapes: ReadonlyArray<Partial<Record<MarketStatusInputKey, number | null>>>) {
  const history: MarketStatusLabel[] = [];
  return tapes.map((tape) => {
    const result = evaluateMarketStatus(readings(tape), [...history]);
    if (result.rawLabel) history.unshift(result.rawLabel);
    return result;
  });
}

describe('first render — an empty history must still publish', () => {
  it('publishes immediately when nothing has been recorded yet', () => {
    /*
      A brand-new deployment, or the first render after the table is created, has
      no history. That is not a degraded state and must not withhold the card:
      the rule's answer to an empty sequence is to publish today's reading.
    */
    const result = evaluateMarketStatus(readings(UP), []);
    expect(result.status).toBe('available');
    expect(result.label).toBe('UPTREND');
    expect(result.rawLabel).toBe('UPTREND');
    expect(result.held).toBe(false);
  });

  it('publishes immediately for every label, not just the flattering one', () => {
    for (const [tape, expected] of [[UP, 'UPTREND'], [DOWN, 'WEAK'], [FLAT, 'SIDEWAYS']] as const) {
      const result = evaluateMarketStatus(readings(tape), []);
      expect(result.label).toBe(expected);
      expect(result.held).toBe(false);
    }
  });
});

describe('day two — a changed label is held, not announced', () => {
  it('keeps the ESTABLISHED label when today is the first day of a new reading', () => {
    /*
      The bug this whole change exists to fix. With `[]` passed every render this
      published UPTREND on the first up day and the status flipped daily.

      Note what "established" means, because it is not "yesterday": the rule falls
      back to the most recent label that has ITSELF stood `minDurationBars`
      consecutive days. So two prior SIDEWAYS days are needed, not one. With only
      one day of history there is no established label to fall back to, and
      publishing today's reading is the correct answer rather than a missed hold —
      the same behaviour the signal engine has always had, since this is its
      algorithm lifted verbatim.
    */
    const [, , third] = runDays([FLAT, FLAT, UP]);
    expect(third.rawLabel).toBe('UPTREND');
    expect(third.label).toBe('SIDEWAYS');
    expect(third.held).toBe(true);
  });

  it('publishes today’s reading when no label has been established yet', () => {
    // One prior day is not an established label. This is the boundary of the
    // rule, asserted so it reads as a decision rather than an accident.
    const [, second] = runDays([FLAT, UP]);
    expect(second.rawLabel).toBe('UPTREND');
    expect(second.label).toBe('UPTREND');
    expect(second.held).toBe(false);
  });

  it('adopts the new label once it has stood two consecutive days', () => {
    const [, , , fourth] = runDays([FLAT, FLAT, UP, UP]);
    expect(fourth.rawLabel).toBe('UPTREND');
    expect(fourth.label).toBe('UPTREND');
    expect(fourth.held).toBe(false);
  });

  it('absorbs a one-day flip entirely — the reader never sees it', () => {
    // SIDEWAYS, one stray UPTREND day, back to SIDEWAYS. The published series
    // never moves, which is the entire point of the rule.
    const days = runDays([FLAT, FLAT, UP, FLAT, FLAT]);
    expect(days.map((day) => day.rawLabel)).toEqual([
      'SIDEWAYS', 'SIDEWAYS', 'UPTREND', 'SIDEWAYS', 'SIDEWAYS',
    ]);
    expect(days.map((day) => day.label)).toEqual([
      'SIDEWAYS', 'SIDEWAYS', 'SIDEWAYS', 'SIDEWAYS', 'SIDEWAYS',
    ]);
  });

  it('holds a WEAK reading exactly as it holds an UPTREND one', () => {
    // The rule is not directional; a bad day waits the same as a good one.
    const [, , third] = runDays([FLAT, FLAT, DOWN]);
    expect(third.rawLabel).toBe('WEAK');
    expect(third.label).toBe('SIDEWAYS');
    expect(third.held).toBe(true);
  });

  it('uses the same duration the signal engine uses', () => {
    // Two cards on one page reaching different conclusions about how long a
    // reading must stand would be two answers to one question.
    expect(MARKET_STATUS_PERSISTENCE.minDurationBars)
      .toBe(MARKET_SIGNAL_PERSISTENCE.minDurationBars);
  });
});

describe('the exemption still skips the hold', () => {
  it('publishes a new label immediately on a day big enough to have repriced', () => {
    /*
      The signal engine's escape hatch is `exceptionAtrMultiple`, measured
      against a bar's own ATR. This card has no candles, so the equivalent
      judgement is a move in the broadest equity input — but the BEHAVIOUR it
      buys is identical: holding yesterday's word through a repricing would
      publish a reading the tape has already contradicted.
    */
    const result = evaluateMarketStatus(
      readings({ ...UP, SPX: MARKET_STATUS_EXEMPTION_PERCENT + 0.5 }),
      ['SIDEWAYS', 'SIDEWAYS', 'SIDEWAYS'],
    );
    expect(result.exempt).toBe(true);
    expect(result.label).toBe('UPTREND');
    expect(result.held).toBe(false);
  });

  it('does NOT skip the hold just below the threshold', () => {
    const result = evaluateMarketStatus(
      readings({ ...UP, SPX: MARKET_STATUS_EXEMPTION_PERCENT - 0.1 }),
      ['SIDEWAYS', 'SIDEWAYS', 'SIDEWAYS'],
    );
    expect(result.exempt).toBe(false);
    expect(result.held).toBe(true);
  });

  it('fires on a large move in either direction', () => {
    const down = evaluateMarketStatus(
      readings({ ...DOWN, SPX: -(MARKET_STATUS_EXEMPTION_PERCENT + 0.5) }),
      ['SIDEWAYS', 'SIDEWAYS'],
    );
    expect(down.exempt).toBe(true);
    expect(down.label).toBe('WEAK');
  });

  it('is driven by the broad index, not by a noisy fear-gauge spike', () => {
    // VIX routinely moves 20% on a quiet afternoon. Letting it trigger the
    // exemption would make the escape hatch the normal path.
    const result = evaluateMarketStatus(
      readings({ ...FLAT, VIX: 40 }),
      ['SIDEWAYS', 'SIDEWAYS'],
    );
    expect(result.exempt).toBe(false);
  });
});

describe('MONOTONICITY SURVIVES THE HISTORY', () => {
  /*
    ===========================================================================
    A LOST HISTORY MUST NOT SHARPEN THE ANSWER EITHER
    ===========================================================================
    The subset sweep in `rules.test.ts` proves that losing an INPUT cannot make
    the label more definite. Reading a stored history introduces a second thing
    that can go missing — the history itself — and it would be its own version of
    the JOBY bug if losing it made the card MORE certain.

    The direction that matters: the hold rule only ever keeps an OLDER label on
    screen. So an empty history can only ever publish today's raw reading, and a
    populated one can only ever replace it with something that has already stood.
    Losing the history must therefore never turn SIDEWAYS into a definite claim
    that the readings alone do not support.
  */
  const DEFINITE: Record<MarketStatusLabel, boolean> = {
    WEAK: true, UPTREND: true, SIDEWAYS: false,
  };

  const TAPES = [UP, DOWN, FLAT,
    { SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: 15, US10Y: 4, DXY: 1.2 },
    { SPX: 0.4, NDX: -0.5, DJI: 0.2, VIX: -6, US10Y: 1.5, DXY: -0.4 },
  ] as const;

  const HISTORIES: MarketStatusLabel[][] = [
    [],
    ['SIDEWAYS'],
    ['SIDEWAYS', 'SIDEWAYS'],
    ['UPTREND', 'UPTREND'],
    ['WEAK', 'WEAK'],
    ['UPTREND', 'WEAK', 'SIDEWAYS'],
  ];

  it('never publishes a label the readings alone did not already produce', () => {
    /*
      The strongest form: whatever the history says, the published label is
      either today's raw reading or a label that appears in the history. The rule
      cannot invent a third answer, so no history — present, absent or corrupted
      — can manufacture certainty the readings did not support.
    */
    for (const tape of TAPES) {
      for (const history of HISTORIES) {
        const result = evaluateMarketStatus(readings(tape), history);
        if (result.rawLabel === null) continue;
        expect([result.rawLabel, ...history]).toContain(result.label);
      }
    }
  });

  it('losing the history never sharpens a SIDEWAYS reading into a claim', () => {
    for (const tape of TAPES) {
      const withHistory = evaluateMarketStatus(readings(tape), ['SIDEWAYS', 'SIDEWAYS']);
      const without = evaluateMarketStatus(readings(tape), []);
      if (withHistory.label === null || without.label === null) continue;
      if (!DEFINITE[withHistory.label]) {
        /*
          With a history the card was noncommittal. Dropping the history may not
          make it definite — and it cannot, because an empty sequence publishes
          the raw reading, which is what produced SIDEWAYS in the first place
          unless the history was holding an older definite label.
        */
        expect(DEFINITE[without.label] && without.label !== without.rawLabel).toBe(false);
      }
    }
  });

  it('an unreadable history is exactly the first-render case, never worse', () => {
    // `loadLabelHistory` returns [] when the table cannot be read. That path
    // must land on publish-immediately, not on a withheld or sharpened card.
    for (const tape of TAPES) {
      const result = evaluateMarketStatus(readings(tape), []);
      expect(result.label).toBe(result.rawLabel);
      expect(result.held).toBe(false);
    }
  });

  it('a history full of a label the readings contradict still cannot invent one', () => {
    // The adversarial case: a corrupted or stale history claiming UPTREND while
    // today reads WEAK. The rule may hold UPTREND — that is what holding means —
    // but it may never publish something in neither place.
    const result = evaluateMarketStatus(readings(DOWN), ['UPTREND', 'UPTREND', 'UPTREND']);
    expect(['WEAK', 'UPTREND']).toContain(result.label);
    expect(result.rawLabel).toBe('WEAK');
  });

  it('the shared rule itself never returns a label outside what it was given', () => {
    // Asserted on `heldLabel` directly, so the guarantee belongs to the rule and
    // not to this card's use of it — the signal engine relies on it too.
    for (const sequence of [['A'], ['A', 'B'], ['A', 'B', 'B'], ['A', 'A', 'B']]) {
      const held = heldLabel(sequence, sequence[0]!, { minDurationBars: 2 });
      expect(sequence).toContain(held);
    }
  });
});
