import { describe, expect, it } from 'vitest';
import {
  OV_CHANGE_KIND_OF,
  dedupeOvChanges,
  ovChangeSeverity,
  ovChanges,
  type OvChangeKind,
} from './what-changed';
import {
  WHAT_CHANGED_DETECTORS,
  type WhatChangedDetectorId,
  type WhatChangedItem,
} from '@/src/lib/watchlist/what-changed';

const IMPORTANCE: Readonly<Record<WhatChangedDetectorId, number>> = Object.fromEntries(
  WHAT_CHANGED_DETECTORS.map((detector) => [detector.id, detector.importance]),
) as Record<WhatChangedDetectorId, number>;

function item(
  detector: WhatChangedDetectorId,
  symbol: string,
  text = `${symbol} ${detector}`,
): WhatChangedItem {
  return {
    detector,
    symbol,
    importance: IMPORTANCE[detector],
    level: 'neutral',
    emoji: '🟡',
    text,
  };
}

describe('the detector-to-kind mapping', () => {
  it('names every detector that exists', () => {
    /*
      Adding a seventh detector upstream must be a compile error here, not an
      item that silently vanishes from this feed. This asserts the runtime half
      of the same property.
    */
    for (const detector of WHAT_CHANGED_DETECTORS) {
      expect(OV_CHANGE_KIND_OF[detector.id], detector.id).toBeDefined();
    }
    expect(Object.keys(OV_CHANGE_KIND_OF).sort())
      .toEqual(WHAT_CHANGED_DETECTORS.map((detector) => detector.id).sort());
  });

  it('maps each detector to the kind the contract names', () => {
    expect(OV_CHANGE_KIND_OF).toEqual({
      'level-break': 'level_break',
      'trend-change': 'trend_flip',
      'return-sigma': 'price_move',
      gap: 'price_move',
      'volume-surge': 'volume',
      'earnings-soon': 'earnings',
    });
  });

  it('produces no `news` item, because no detector measures news', () => {
    /*
      The kind is in the union because the contract names it and a future rule
      needs somewhere to land. Stubbing it — "three new articles" — would be a
      detector written outside the one table that is supposed to hold them all,
      and it would have no stated threshold.
    */
    const produced = new Set<OvChangeKind>(Object.values(OV_CHANGE_KIND_OF));
    expect(produced.has('news')).toBe(false);

    const everything = WHAT_CHANGED_DETECTORS.map((detector) => item(detector.id, 'AAPL'));
    expect(ovChanges(everything).some((event) => event.kind === 'news')).toBe(false);
  });
});

describe('severity', () => {
  it('splits the detector table at the two gaps it already argues for', () => {
    expect(ovChangeSeverity(IMPORTANCE['level-break'])).toBe('high');
    expect(ovChangeSeverity(IMPORTANCE['trend-change'])).toBe('high');
    expect(ovChangeSeverity(IMPORTANCE['return-sigma'])).toBe('medium');
    expect(ovChangeSeverity(IMPORTANCE.gap)).toBe('medium');
    expect(ovChangeSeverity(IMPORTANCE['volume-surge'])).toBe('low');
    expect(ovChangeSeverity(IMPORTANCE['earnings-soon'])).toBe('low');
  });
});

describe('the price_move dedupe', () => {
  it('collapses two detectors that describe one day into one line', () => {
    /*
      A stock that gapped down and then moved more than two sigma did ONE thing.
      Without the dedupe it spends two of the section's five slots saying so.
    */
    const events = ovChanges([item('gap', 'RKLB'), item('return-sigma', 'RKLB')]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('price_move');
  });

  it('keeps the stronger of the pair, whichever order they arrive in', () => {
    const sigmaText = 'ขยับ +7.10% เกินช่วงปกติ 60 วัน (±3.00%)';
    const forward = ovChanges([
      item('gap', 'RKLB', 'เปิดตลาดห่างจากราคาปิดก่อนหน้า +2.50%'),
      item('return-sigma', 'RKLB', sigmaText),
    ]);
    const reversed = ovChanges([
      item('return-sigma', 'RKLB', sigmaText),
      item('gap', 'RKLB', 'เปิดตลาดห่างจากราคาปิดก่อนหน้า +2.50%'),
    ]);
    // `return-sigma` carries importance 3 against the gap's 2; both are medium,
    // so the tie is broken by importance and the answer must not depend on the
    // order the watchlist happened to hand them over in.
    expect(forward[0]!.valueText).toBe(sigmaText);
    expect(reversed[0]!.valueText).toBe(sigmaText);
  });

  it('never merges across symbols', () => {
    const events = ovChanges([item('gap', 'AAPL'), item('return-sigma', 'RKLB')]);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.symbol)).toEqual(['AAPL', 'RKLB']);
  });

  it('never merges across kinds', () => {
    const events = ovChanges([item('gap', 'AAPL'), item('volume-surge', 'AAPL')]);
    expect(events.map((event) => event.kind)).toEqual(['price_move', 'volume']);
  });

  it('applies to every kind, not only to price_move', () => {
    /*
      Today only `price_move` has two sources. A dedupe that special-cased it
      would be a rule about the current table and would stop applying the day a
      second kind gained a second detector.
    */
    const events = dedupeOvChanges([
      { symbol: 'AAPL', kind: 'volume', severity: 'low', valueText: 'first', level: 'neutral' },
      { symbol: 'AAPL', kind: 'volume', severity: 'high', valueText: 'second', level: 'neutral' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.valueText).toBe('second');
  });

  it('preserves the order the caller already chose', () => {
    // The watchlist has already sorted and capped by importance; re-sorting
    // here would throw that away.
    const events = ovChanges([
      item('earnings-soon', 'ZM'),
      item('level-break', 'AAPL'),
      item('volume-surge', 'MSFT'),
    ]);
    expect(events.map((event) => event.symbol)).toEqual(['ZM', 'AAPL', 'MSFT']);
  });

  it('copies the detector sentence verbatim', () => {
    const text = 'ปริมาณซื้อขายวันนี้ 3.2 เท่าของค่ากลาง 20 วัน';
    expect(ovChanges([item('volume-surge', 'AAPL', text)])[0]!.valueText).toBe(text);
  });

  it('returns nothing for a quiet day', () => {
    expect(ovChanges([])).toEqual([]);
  });
});
