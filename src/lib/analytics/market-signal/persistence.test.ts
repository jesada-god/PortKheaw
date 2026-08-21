import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MARKET_SIGNAL_PERSISTENCE } from '@/src/config/signal';
import type { DataFreshness } from '@/src/lib/market-data/types';

import { calculateMarketSignal } from './calculations';
import { summariseHistory } from './history';
import type {
  MarketSignalCandle,
  MarketSignalHistoryEntry,
  MarketSignalState,
} from './types';

/**
 * P8 — how long a changed label has to mean it, and what that must not cost.
 *
 * THE MEASUREMENT THIS EXISTS FOR. `trend_agreement.md` §1: over 108
 * instruments and 62,968 comparable bars the card changed its word 13,994
 * times while the move it describes changed 8,603 times — a flip ratio of 1.63
 * with every flag off, 1.17 with GATE+ZONES on. §4 found the OFF value above
 * 1.0 at all 27 definitions of "move" it tested. A reading that lasts one bar
 * and is gone describes nothing.
 *
 * THE TARGET IS 1.0, NOT ZERO, and this file is written that way on purpose:
 * nothing below asserts that fewer flips is better. The two baselines in that
 * same table sit at 0.33 and 0.38 and are worse labellers, not better ones —
 * B2 cannot say SIDEWAYS at all and 4,179 of its 7,852 catch-up events never
 * resolve. So the assertions here are about the RULE being the rule, and the
 * corpus-wide verdict lives in `trend_persistence.md` against pre-registered
 * criteria.
 *
 * THE TRAP THIS FILE ALSO GUARDS. Holding labels makes them last longer, so
 * every age the card prints would grow for a reason that has nothing to do with
 * the market. `docs/signal-handover.md` §6.8 measured that an older label is not
 * a more accurate one (49.2% against 49.9% at the extremes) and forbids the card
 * implying otherwise. The last describe block is that rule, executed.
 */

const capture = (symbol: string) => JSON.parse(
  readFileSync(join(process.cwd(), '__golden__', 'candles', `${symbol}.json`), 'utf8'),
) as { source: string | null; freshness: DataFreshness; candles: MarketSignalCandle[] };

const SYMBOLS = ['IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD'];

const runs = new Map<string, ReturnType<typeof calculateMarketSignal>>();
const run = (symbol: string, gate: boolean) => {
  const key = `${symbol}:${gate}`;
  const cached = runs.get(key);
  if (cached) return cached;
  const frozen = capture(symbol);
  const result = calculateMarketSignal(frozen.candles, {
    symbol,
    source: frozen.source,
    freshness: frozen.freshness,
    calculatedAt: '2026-01-01T00:00:00.000Z',
    ...(gate ? { features: { gate: true, zones: true, actionable: false } } : {}),
  });
  runs.set(key, result);
  return result;
};

describe('the block is published on every path', () => {
  /*
   * Not behind a flag, and that is the design rather than an oversight. A flag
   * would mean two different answers to "what does the card say today", and the
   * point of a hold rule is that there is one.
   */
  /*
   * A generous timeout, stated rather than hidden: P8 makes every call three
   * engine evaluations (measured at 92ms -> 306ms on the 1255-bar SPY capture),
   * and this sweep is ten symbols in two flag states. The memo above keeps the
   * rest of the file from paying it again.
   */
  it('carries a persistence block with both flag states', () => {
    SYMBOLS.forEach((symbol) => {
      [true, false].forEach((gate) => {
        const result = run(symbol, gate);
        if (result.status !== 'available') return;
        expect(result.persistence, `${symbol} gate=${gate}`).toBeDefined();
        expect(result.persistence!.rawState).toBeTruthy();
      });
    });
  }, 30_000);

  it('publishes the raw reading beside the held one, never instead of it', () => {
    SYMBOLS.forEach((symbol) => {
      const result = run(symbol, false);
      if (result.status !== 'available') return;
      const { rawState, held } = result.persistence!;
      // `held` is exactly "the two disagree", with no third state to get wrong.
      expect(held, symbol).toBe(rawState !== result.state);
    });
  });

  /*
   * The count is capped by the replay, and the cap is not a lie a reader can
   * be handed: `rawRunBars` is bounded by how far the engine looked, and the
   * field's own documentation says so. The age a reader sees comes from
   * `history.currentRawLabelDays`, which counts recorded days instead.
   */
  it('never reports a raw run longer than the replay could have seen', () => {
    const cap = MARKET_SIGNAL_PERSISTENCE.lookbackBars + 1;
    SYMBOLS.forEach((symbol) => {
      [true, false].forEach((gate) => {
        const result = run(symbol, gate);
        if (result.status !== 'available') return;
        expect(result.persistence!.rawRunBars, `${symbol} gate=${gate}`).toBeGreaterThanOrEqual(1);
        expect(result.persistence!.rawRunBars, `${symbol} gate=${gate}`).toBeLessThanOrEqual(cap);
      });
    });
  });
});

describe('the hold rule, on constructed sequences', () => {
  /*
   * A synthetic series long enough for every indicator, whose LAST bars can be
   * bent without disturbing the history behind them. `shape` is applied to the
   * closing price as a multiplier on the final `tail` bars.
   */
  const context = {
    symbol: 'TEST',
    source: null,
    freshness: { status: 'fresh', asOf: '2026-01-01T00:00:00.000Z' } as unknown as DataFreshness,
    calculatedAt: '2026-01-01T00:00:00.000Z',
  };
  const series = (length: number, close: (index: number) => number): MarketSignalCandle[] =>
    Array.from({ length }, (_unused, index) => {
      const value = close(index);
      return {
        date: new Date(Date.UTC(2022, 0, 3) + index * 86_400_000).toISOString().slice(0, 10),
        open: value,
        high: value * 1.004,
        low: value * 0.996,
        close: value,
        volume: 1_000_000,
        finalized: true,
      };
    });

  /*
   * A one-bar spike is what the rule is FOR. The engine reads one bar that
   * disagrees with its neighbours on both sides; `minDurationBars` says a
   * reading that has not stood two bars is not yet the card's word.
   */
  it('does not publish a reading that has stood for only one bar', () => {
    const steady = series(320, (index) => 100 + index * 0.09);
    const spiked = steady.map((candle, index) => (index === steady.length - 1
      ? { ...candle, close: candle.close * 0.86, low: candle.close * 0.85 }
      : candle));
    const before = calculateMarketSignal(steady, context);
    const after = calculateMarketSignal(spiked, context);
    if (before.status !== 'available' || after.status !== 'available') throw new Error('fixture too short');
    // The reading did move — otherwise this fixture proves nothing.
    expect(after.persistence!.rawState).not.toBe(before.state);
    // ...and either the hold kept the old word, or an exemption released it.
    if (after.persistence!.exemption === null) {
      expect(after.persistence!.held).toBe(true);
      expect(after.state).not.toBe(after.persistence!.rawState);
    }
  });

  /*
   * THE EXCEPTION, and the reason it exists. Waiting is a bet that a one-bar
   * change is noise. A gap or a range several times the recent average is the
   * case where that bet is wrong: the market repriced, and holding yesterday's
   * word through it publishes a reading the chart has already contradicted.
   */
  it('skips the wait on a bar the market clearly repriced', () => {
    const steady = series(320, (index) => 100 + index * 0.09);
    const previousClose = steady[steady.length - 2].close;
    const gapped = [...steady];
    const open = previousClose * 0.6;
    gapped[gapped.length - 1] = {
      ...gapped[gapped.length - 1],
      open,
      high: previousClose * 0.62,
      low: open * 0.97,
      close: open * 0.98,
    };
    const result = calculateMarketSignal(gapped, context);
    if (result.status !== 'available') throw new Error('fixture too short');
    expect(result.persistence!.exemption).not.toBeNull();
    // An exempt bar publishes what it read, with nothing held back.
    expect(result.state).toBe(result.persistence!.rawState);
    expect(result.persistence!.held).toBe(false);
  });

  it('holds nothing back on a quiet bar that agrees with the ones before it', () => {
    const steady = series(320, (index) => 100 + index * 0.09);
    const result = calculateMarketSignal(steady, context);
    if (result.status !== 'available') throw new Error('fixture too short');
    expect(result.persistence!.exemption).toBeNull();
    expect(result.persistence!.held).toBe(false);
    expect(result.state).toBe(result.persistence!.rawState);
  });
});

describe('the replay stays a pure function and stays bounded', () => {
  /*
   * The engine has no memory and does not acquire one here: the previous bars'
   * labels come from running the same function on the same candles minus the
   * last k finalized bars. So the same input still gives the same output, and a
   * replay of the whole file reproduces every label in it.
   */
  it('gives the same answer twice for the same candles', () => {
    const frozen = capture('SPY');
    const context = {
      symbol: 'SPY',
      source: frozen.source,
      freshness: frozen.freshness,
      calculatedAt: '2026-01-01T00:00:00.000Z',
    };
    const first = calculateMarketSignal(frozen.candles, context);
    const second = calculateMarketSignal(frozen.candles, context);
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
  });

  /*
   * `replayDepth` is what stops the recursion being a tree. A call carrying one
   * publishes its raw reading and does no replay of its own, so the whole
   * mechanism costs `lookbackBars` extra evaluations at the top call and
   * nothing below it.
   */
  it('does no holding inside a replay', () => {
    const frozen = capture('SPY');
    const inner = calculateMarketSignal(frozen.candles, {
      symbol: 'SPY',
      source: frozen.source,
      freshness: frozen.freshness,
      calculatedAt: '2026-01-01T00:00:00.000Z',
      replayDepth: 1,
    });
    if (inner.status !== 'available') throw new Error('capture too short');
    expect(inner.persistence!.held).toBe(false);
    expect(inner.state).toBe(inner.persistence!.rawState);
    expect(inner.persistence!.rawRunBars).toBe(1);
  });

  it('keeps the lookback wide enough to express the duration it asks for', () => {
    expect(MARKET_SIGNAL_PERSISTENCE.lookbackBars)
      .toBeGreaterThanOrEqual(MARKET_SIGNAL_PERSISTENCE.minDurationBars);
  });
});

describe('the age a reader is shown is the one the hold rule did not touch', () => {
  const entry = (
    asOf: string,
    state: MarketSignalState,
    rawState: MarketSignalState | null,
  ): MarketSignalHistoryEntry => ({
    asOf, state, rawState, bias: 'neutral', zone: 'sideways', score: 4, evidenceAgreement: 60, flags: [],
  });
  const options = { windowDays: 30, recentFlipDays: 3 };

  /*
   * The exact shape the hold rule produces: the published word ran for four
   * days, the reading underneath it changed on the last one. §6.8 forbids the
   * card presenting a longer-standing label as a better one, and a duration the
   * engine itself lengthened is that claim with an extra step.
   */
  it('counts the run of the reading, not of the held word', () => {
    const history = summariseHistory([
      entry('2026-08-10', 'BULLISH', 'BULLISH'),
      entry('2026-08-11', 'BULLISH', 'BULLISH'),
      entry('2026-08-12', 'BULLISH', 'BULLISH'),
      entry('2026-08-13', 'BULLISH', 'SIDEWAYS'),
    ], options)!;
    expect(history.currentLabelDays).toBe(3);
    expect(history.currentRawLabelDays).toBeNull();
  });

  it('agrees with the held count on days nothing was held', () => {
    const history = summariseHistory([
      entry('2026-08-10', 'BULLISH', 'BULLISH'),
      entry('2026-08-11', 'BULLISH', 'BULLISH'),
      entry('2026-08-12', 'BULLISH', 'BULLISH'),
    ], options)!;
    expect(history.currentLabelDays).toBe(2);
    expect(history.currentRawLabelDays).toBe(2);
  });

  /*
   * A row written before P8 has no raw reading and one cannot be recovered — it
   * is a property of the engine version that published it. The count stops
   * rather than treating "not recorded" as "unchanged", which would invent a
   * run nobody read.
   */
  it('refuses to count a run through a day that recorded no reading', () => {
    const history = summariseHistory([
      entry('2026-08-10', 'BULLISH', null),
      entry('2026-08-11', 'BULLISH', 'BULLISH'),
      entry('2026-08-12', 'BULLISH', 'BULLISH'),
    ], options)!;
    expect(history.currentLabelDays).toBe(2);
    expect(history.currentRawLabelDays).toBeNull();
  });

  it('will not call one recorded day a run, on either count', () => {
    const history = summariseHistory([entry('2026-08-12', 'BULLISH', 'BULLISH')], options)!;
    expect(history.currentLabelDays).toBeNull();
    expect(history.currentRawLabelDays).toBeNull();
  });

  /*
   * Gaps are real days that were not recorded, and neither count may close one.
   * A label whose only two recorded days are thirty days apart has a run of
   * thirty days and the strip has to show that it is two days of evidence.
   */
  it('measures the raw run in calendar days across a gap, the same as the held one', () => {
    const history = summariseHistory([
      entry('2026-07-14', 'SIDEWAYS', 'SIDEWAYS'),
      entry('2026-08-13', 'SIDEWAYS', 'SIDEWAYS'),
    ], options)!;
    expect(history.currentRawLabelDays).toBe(30);
  });
});
