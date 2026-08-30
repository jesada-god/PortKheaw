import { describe, expect, it } from 'vitest';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import { previousTrendLevelOf } from './what-changed-service';

/**
 * WHAT `trend-change` ACTUALLY COMPARES, ON A GAPPY HISTORY.
 *
 * ===========================================================================
 * WHY THIS IS A CHARACTERIZATION TEST
 * ===========================================================================
 * `previousTrendLevelOf` had no coverage, and it is the whole input to the one
 * detector that is silent today because `SIGNAL_HISTORY` is off. Before anybody
 * turns that flag on, the honest question is not "does this function work" but
 * "what does it say when the data behind it looks the way it will actually
 * look" — and `market_signal_history` is gappy by construction: a row exists
 * for a day only if somebody with the entitlement opened that symbol that day.
 *
 * So these tests pin the real behaviour, including the part that is a problem.
 * They are written to keep passing after the fix in
 * `docs/signal-history-proposal.md` is applied ONLY where the behaviour is
 * correct; the one that documents the defect says so in its name, so it shows
 * up as the thing to change rather than as a regression.
 */

function signal(entries: Array<{ asOf: string; state: string }>): MarketSignalResult {
  return {
    symbol: 'AAA',
    status: 'available',
    history: { entries },
  } as unknown as MarketSignalResult;
}

describe('the previous published trend level', () => {
  it('is null when there is no signal at all', () => {
    expect(previousTrendLevelOf(null)).toBeNull();
  });

  /*
   * The entitlement coupling, stated as a test.
   *
   * `loadEntitledMarketSignal` returns null WITHOUT running the engine for a
   * reader who has not bought the Technical Outlook. So for those readers this
   * is always null, the detector is always silent, and turning SIGNAL_HISTORY
   * on changes nothing for them. See the proposal — this is the reason the flag
   * does not simply "restore the sixth detector" for everybody.
   */
  it('is null for an unavailable reading, which is what an unentitled reader gets', () => {
    const insufficient = {
      symbol: 'AAA',
      status: 'insufficient-data',
    } as unknown as MarketSignalResult;
    expect(previousTrendLevelOf(insufficient)).toBeNull();
  });

  it('is null on the first recorded day, so the detector stays silent during warm-up', () => {
    expect(previousTrendLevelOf(signal([{ asOf: '2026-08-28', state: 'BULLISH' }]))).toBeNull();
  });

  it('is null when history is absent entirely', () => {
    expect(previousTrendLevelOf(signal([]))).toBeNull();
  });

  it('reads the newest entry that is not the newest, on consecutive days', () => {
    const level = previousTrendLevelOf(signal([
      { asOf: '2026-08-27', state: 'BEARISH' },
      { asOf: '2026-08-28', state: 'SIDEWAYS' },
      { asOf: '2026-08-31', state: 'BULLISH' },
    ]));
    // The reading before today's, not the oldest one on file.
    expect(level).toBe('neutral');
  });

  it('does not depend on the order the rows arrive in', () => {
    const ordered = previousTrendLevelOf(signal([
      { asOf: '2026-08-27', state: 'BEARISH' },
      { asOf: '2026-08-31', state: 'BULLISH' },
    ]));
    const shuffled = previousTrendLevelOf(signal([
      { asOf: '2026-08-31', state: 'BULLISH' },
      { asOf: '2026-08-27', state: 'BEARISH' },
    ]));
    expect(ordered).toBe(shuffled);
  });

  /*
   * Once a change has been announced, the next visit is silent because the two
   * newest entries agree. So a gappy history does NOT cause the same change to
   * be reported over and over — worth pinning, because that was the first
   * failure mode to suspect and it is not present.
   */
  it('goes quiet on the visit after a change, rather than repeating it', () => {
    const afterAnnouncement = previousTrendLevelOf(signal([
      { asOf: '2026-08-03', state: 'BULLISH' },
      { asOf: '2026-08-28', state: 'BEARISH' },
      { asOf: '2026-08-31', state: 'BEARISH' },
    ]));
    // Equal to today's level, so `trend-change` compares equal and says nothing.
    expect(afterAnnouncement).toBe('bad');
  });

  /*
   * A round trip between two visits is invisible, which is correct: nothing
   * changed between the two readings the product actually published.
   */
  it('sees no change when the level returned to where it was between visits', () => {
    expect(previousTrendLevelOf(signal([
      { asOf: '2026-08-03', state: 'BULLISH' },
      { asOf: '2026-08-31', state: 'BULLISH' },
    ]))).toBe('good');
  });

  /*
   * ===========================================================================
   * THE DEFECT. This test documents behaviour that should change.
   * ===========================================================================
   * The two entries are 28 days apart, and the function reports the older one
   * as "the previous reading" with nothing marking the distance. `trend-change`
   * then writes "แนวโน้มเปลี่ยนจาก…เป็น…" into a section a reader reads as a
   * statement about TODAY.
   *
   * The comparison is not false — those are genuinely the last two things the
   * card said — but presenting a four-week-old comparison as today's news is
   * the kind of true-but-misread sentence this module's own header sets out to
   * avoid. `readSignalHistory` bounds the window to 30 days, so ~29 days is the
   * worst case rather than an unbounded one.
   *
   * The proposal is to bound it by recency at this function. When that lands,
   * this expectation becomes `toBeNull()` and the test name loses "stale".
   */
  it('DEFECT: reports a stale comparison with no indication of how old it is', () => {
    const level = previousTrendLevelOf(signal([
      { asOf: '2026-08-03', state: 'BULLISH' },
      { asOf: '2026-08-31', state: 'BEARISH' },
    ]));
    expect(level).toBe('good');
  });
});
