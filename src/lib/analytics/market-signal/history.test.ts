import { describe, expect, it } from 'vitest';
import { snapshotOf, summariseHistory } from './history';
import type { MarketSignalHistoryEntry, MarketSignalResult, MarketSignalState } from './types';

/**
 * P6 derivation, tested on hand-written days rather than on a table.
 *
 * Everything interesting about a history is arithmetic over dates that are
 * missing in awkward places, which is exactly the kind of thing that is easy to
 * get right against a tidy fixture and wrong against a real symbol nobody opened
 * for a fortnight.
 */

const entry = (asOf: string, state: MarketSignalState): MarketSignalHistoryEntry => ({
  asOf,
  state,
  bias: state.includes('BULL') ? 'bullish' : state.includes('BEAR') ? 'bearish' : 'neutral',
  zone: state.includes('BULL') ? 'uptrend' : state.includes('BEAR') ? 'downtrend' : 'sideways',
  score: 12,
  evidenceAgreement: 61,
  flags: [],
});

const options = { windowDays: 30, recentFlipDays: 3 };

describe('summariseHistory', () => {
  it('has nothing to say about a symbol with no recorded days', () => {
    expect(summariseHistory([], options)).toBeNull();
  });

  it('orders the days itself, so no caller has to remember to', () => {
    const history = summariseHistory([
      entry('2026-08-12', 'SIDEWAYS'),
      entry('2026-08-10', 'SIDEWAYS'),
      entry('2026-08-11', 'SIDEWAYS'),
    ], options)!;
    expect(history.entries.map((item) => item.asOf)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
  });

  it('measures the current run from the first day of that run to the newest', () => {
    const history = summariseHistory([
      entry('2026-08-01', 'BEARISH'),
      entry('2026-08-05', 'SIDEWAYS'),
      entry('2026-08-06', 'SIDEWAYS'),
      entry('2026-08-12', 'SIDEWAYS'),
    ], options)!;
    // 08-05 to 08-12, not the count of recorded days and not since 08-01.
    expect(history.currentLabelDays).toBe(7);
  });

  /*
   * A run of one is `null` and not 0. Zero would read as "it changed today",
   * which is a claim about yesterday — and one recorded day says nothing about
   * yesterday, because yesterday may simply never have been recorded.
   */
  it('refuses to call a single recorded day a run of zero', () => {
    const history = summariseHistory([entry('2026-08-12', 'BULLISH')], options)!;
    expect(history.currentLabelDays).toBeNull();
  });

  /*
   * The gap case, which is the whole reason this is not a row count. Two
   * recorded days a month apart are two days of evidence about a 30-day run,
   * and the run is still 30 days long — what must not happen is the gap
   * silently ending the run or the run being reported as "2".
   */
  it('carries a run across a gap without inventing the days inside it', () => {
    const history = summariseHistory([
      entry('2026-07-13', 'SIDEWAYS'),
      entry('2026-08-12', 'SIDEWAYS'),
    ], options)!;
    expect(history.currentLabelDays).toBe(30);
    expect(history.entries).toHaveLength(2);
  });

  describe('recent_flip', () => {
    it('is raised when a different label was seen inside the window', () => {
      const history = summariseHistory([
        entry('2026-08-10', 'BEARISH'),
        entry('2026-08-11', 'SIDEWAYS'),
        entry('2026-08-12', 'SIDEWAYS'),
      ], options)!;
      expect(history.recentFlip).toBe(true);
    });

    it('is not raised when the change is older than the window', () => {
      const history = summariseHistory([
        entry('2026-08-01', 'BEARISH'),
        entry('2026-08-11', 'SIDEWAYS'),
        entry('2026-08-12', 'SIDEWAYS'),
      ], options)!;
      expect(history.recentFlip).toBe(false);
    });

    /*
     * A short run is not a flip. A symbol whose only recorded day is today has
     * a run of one, and nothing is KNOWN to have changed — raising the flag
     * there would warn about instability the product never observed.
     */
    it('is not raised by a short history, only by an observed change', () => {
      const history = summariseHistory([entry('2026-08-12', 'BULLISH')], options)!;
      expect(history.recentFlip).toBe(false);
    });

    it('measures the window in calendar days, not in recorded days', () => {
      // Two recorded days, four calendar days apart, one flip: outside a 3-day window.
      const history = summariseHistory([
        entry('2026-08-08', 'BEARISH'),
        entry('2026-08-12', 'SIDEWAYS'),
      ], options)!;
      expect(history.recentFlip).toBe(false);
    });
  });

  it('reports the window it was asked for, so a renderer can show the density', () => {
    const history = summariseHistory([entry('2026-08-12', 'BULLISH')], options)!;
    expect(history.windowDays).toBe(30);
    expect(history.entries).toHaveLength(1);
  });
});

const result = (over: Partial<MarketSignalResult> = {}): MarketSignalResult => ({
  status: 'available',
  symbol: 'AAPL',
  state: 'SIDEWAYS',
  bias: 'neutral',
  score: 4,
  confidence: 61,
  confidenceLabel: 'Medium',
  evidenceAgreement: 61,
  evidenceAgreementLabel: 'Medium',
  timeframe: '1D',
  calculatedAt: '2026-08-18T09:00:00.000Z',
  latestCandleAt: '2026-08-17',
  source: 'yahoo-finance-chart',
  freshness: { status: 'end-of-day', asOf: '2026-08-17T20:00:00.000Z', maxAgeSeconds: 21_600 },
  dataPoints: { received: 700, finalized: 699 },
  scoreBreakdown: {} as MarketSignalResult['scoreBreakdown'],
  reasons: [],
  warnings: [],
  flags: ['squeeze'],
  metrics: {} as MarketSignalResult['metrics'],
  confidenceBreakdown: {} as MarketSignalResult['confidenceBreakdown'],
  ...over,
} as MarketSignalResult);

describe('snapshotOf', () => {
  it('files the reading under the finalized candle, not under today', () => {
    // Two readers opening the same symbol either side of a close would otherwise
    // file two different readings under one date and lose one of them.
    expect(snapshotOf(result(), { gate: true })!.asOf).toBe('2026-08-17');
  });

  it('records nothing for a reading that was never published', () => {
    const insufficient = result({
      status: 'insufficient-data',
      state: null,
      bias: null,
      score: null,
      reason: 'ไม่พอ',
    } as Partial<MarketSignalResult>);
    expect(snapshotOf(insufficient, { gate: true })).toBeNull();
  });

  it('records nothing when there is no finalized candle to date it by', () => {
    expect(snapshotOf(result({ latestCandleAt: null }), { gate: true })).toBeNull();
  });

  it('keeps the flags that qualified the label, and which switches were on', () => {
    const snapshot = snapshotOf(result(), { gate: true, zones: false })!;
    expect(snapshot.flags).toEqual(['squeeze']);
    expect(snapshot.features).toEqual({ gate: true, zones: false });
  });

  it('stores the agreement figure under its honest name', () => {
    expect(snapshotOf(result(), {})!.evidenceAgreement).toBe(61);
  });
});
