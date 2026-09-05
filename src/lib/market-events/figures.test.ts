import { describe, expect, it } from 'vitest';
import { EVENT_FIGURE_MUST_NOT_SAY } from '@/src/lib/presentation/banned-copy';
/*
 * The ids come from the table rather than being retyped here. `bls-series.test.ts`
 * fails if any file outside that table names one, and a fixture is a file — a
 * test carrying its own copy is exactly the second source that check exists to
 * prevent, and it would go stale the day the adjustment changes.
 */
import { BLS_SERIES } from './bls-series';
import {
  canCarryFigure,
  figureSentenceTh,
  figuresFor,
  type FigureRow,
} from './figures';
import type { MarketEvent } from './types';

/**
 * THE NUMBERS UNDER A CALENDAR ROW.
 *
 * Two published levels and the month each is about. The tests that matter here
 * are about what is ABSENT: no forecast, no dash where a number is missing, and
 * no unit-less figure — "332.813" without "ดัชนี" beside it is a digit string.
 */

function event(over: Partial<MarketEvent> & Pick<MarketEvent, 'id'>): MarketEvent {
  return {
    kind: 'CPI',
    titleTh: 'เงินเฟ้อผู้บริโภค (CPI)',
    shortTh: 'CPI',
    importance: 'high',
    source: 'BLS',
    referencePeriod: 'August 2026',
    at: '2026-09-11T12:30:00.000Z',
    etDisplay: '8:30 a.m. ET',
    ...over,
  };
}

const observation = (over: Partial<FigureRow['latest']> = {}): FigureRow['latest'] => ({
  year: 2026,
  period: 'M08',
  periodLabel: 'August 2026',
  periodLabelTh: 'ส.ค. 2569',
  value: 332.813,
  footnotes: [],
  ...over,
});

const CPI_ROW: FigureRow = {
  eventId: 'cpi-2026-09-11',
  kind: 'CPI',
  seriesId: BLS_SERIES.CPI!.seriesId,
  adjustment: BLS_SERIES.CPI!.adjustment,
  unit: BLS_SERIES.CPI!.unit,
  latest: observation(),
  previous: observation({
    period: 'M07',
    periodLabel: 'July 2026',
    periodLabelTh: 'ก.ค. 2569',
    value: 332.107,
  }),
};

const NFP_ROW: FigureRow = {
  eventId: 'nfp-2026-09-04',
  kind: 'NFP',
  seriesId: BLS_SERIES.NFP!.seriesId,
  adjustment: BLS_SERIES.NFP!.adjustment,
  unit: BLS_SERIES.NFP!.unit,
  latest: observation({ value: 159075, footnotes: ['preliminary'] }),
  previous: observation({
    period: 'M07',
    periodLabel: 'July 2026',
    periodLabelTh: 'ก.ค. 2569',
    value: 159053,
  }),
};

const rows = (...list: FigureRow[]) => ({ rows: list });

describe('the published figures for a release', () => {
  it('gives both months, each with its own unit', () => {
    const view = figuresFor(event({ id: 'cpi-2026-09-11' }), rows(CPI_ROW))!;
    expect(view.latest.valueLabel).toBe('332.813');
    expect(view.latest.unitLabelTh).toBe('ดัชนี');
    expect(view.latest.periodLabelTh).toBe('ส.ค. 2569');
    expect(view.previous?.valueLabel).toBe('332.107');
    expect(view.previous?.periodLabelTh).toBe('ก.ค. 2569');
  });

  /*
   * A HEADCOUNT AND AN INDEX ARE NOT THE SAME KIND OF NUMBER, and the change
   * between two months is measured differently for each: an index moves in
   * percent-shaped points, a headcount moves in people.
   */
  it('writes a headcount as people and an index as index points', () => {
    const nfp = figuresFor(event({ id: 'nfp-2026-09-04', kind: 'NFP' }), rows(NFP_ROW))!;
    expect(nfp.latest.valueLabel).toBe('159,075');
    expect(nfp.latest.unitLabelTh).toBe('พันคน');
    expect(nfp.changeLabel).toBe('+22 พันคน');

    const cpi = figuresFor(event({ id: 'cpi-2026-09-11' }), rows(CPI_ROW))!;
    expect(cpi.changeLabel).toBe('+0.706%');
  });

  it('signs the change so the direction never has to be worked out', () => {
    const falling: FigureRow = {
      ...CPI_ROW,
      latest: observation({ value: 331.500 }),
    };
    expect(figuresFor(event({ id: 'cpi-2026-09-11' }), rows(falling))!.changeLabel)
      .toBe('−0.607%');
  });

  /*
   * ===========================================================================
   * AN ABSENT FIGURE IS ABSENT — NOT A DASH
   * ===========================================================================
   * This is the common case, not an edge one: the calendar runs to December and
   * BLS has published through August, so most releases on it have not happened.
   * Null is what makes the caller render nothing at all.
   */
  it('returns null for a release with no published figure', () => {
    expect(figuresFor(event({ id: 'cpi-2026-12-10' }), rows(CPI_ROW))).toBeNull();
    expect(figuresFor(event({ id: 'cpi-2026-12-10' }), rows())).toBeNull();
  });

  it('still renders when there is no earlier month to compare against', () => {
    const alone: FigureRow = { ...CPI_ROW, previous: null };
    const view = figuresFor(event({ id: 'cpi-2026-09-11' }), rows(alone))!;
    expect(view.previous).toBeNull();
    expect(view.changeLabel).toBeNull();
    // The month that IS published still says what it is.
    expect(view.latest.unitLabelTh).toBe('ดัชนี');
  });

  /*
   * A number that will be revised has to say so. BLS marks NFP "preliminary"
   * and PPI "subject to monthly revisions up to four months"; a reader who
   * writes today's figure down and checks the same cell in December will find a
   * different one.
   */
  it('carries the revision warning, and BLS own wording with it', () => {
    const view = figuresFor(event({ id: 'nfp-2026-09-04', kind: 'NFP' }), rows(NFP_ROW))!;
    expect(view.preliminary).toBe(true);
    expect(view.preliminaryNoteTh).toContain('จะถูกแก้');
    expect(view.latest.footnotesTh).toEqual(['preliminary']);
  });

  it('says nothing about revisions when BLS marked nothing', () => {
    const view = figuresFor(event({ id: 'cpi-2026-09-11' }), rows(CPI_ROW))!;
    expect(view.preliminary).toBe(false);
    expect(view.preliminaryNoteTh).toBeNull();
  });

  it('knows which kinds can carry a figure at all', () => {
    expect(canCarryFigure(event({ id: 'a', kind: 'CPI' }))).toBe(true);
    expect(canCarryFigure(event({ id: 'b', kind: 'PPI' }))).toBe(true);
    expect(canCarryFigure(event({ id: 'c', kind: 'NFP' }))).toBe(true);
    // BLS publishes none of these — DOL, BEA and the Fed do.
    for (const kind of ['JOBLESS_CLAIMS', 'PCE', 'GDP', 'FOMC'] as const) {
      expect(canCarryFigure(event({ id: 'd', kind })), `${kind} has no BLS series`).toBe(false);
    }
  });
});

describe('what the figures panel refuses to say', () => {
  /*
   * "ผิดคาด" and "ตรงคาด" are the pair this list exists for: both compare
   * against a forecast, and there is no consensus estimate anywhere in this
   * codebase. A panel that said a number missed expectations would be inventing
   * the expectation it missed.
   */
  it('names no forecast and no tendency in the sentence it writes', () => {
    for (const row of [CPI_ROW, NFP_ROW]) {
      const view = figuresFor(event({ id: row.eventId, kind: row.kind }), rows(row))!;
      const sentence = [
        figureSentenceTh(view),
        view.changeLabel ?? '',
        view.preliminaryNoteTh ?? '',
        ...view.latest.footnotesTh,
      ].join(' ');
      for (const phrase of EVENT_FIGURE_MUST_NOT_SAY) {
        expect(sentence, `the figures must not say "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('states the months and the values, and nothing derived beyond the change', () => {
    const view = figuresFor(event({ id: 'cpi-2026-09-11' }), rows(CPI_ROW))!;
    expect(figureSentenceTh(view))
      .toBe('ตัวเลขที่ประกาศ — ส.ค. 2569: ดัชนี 332.813 · ก.ค. 2569: ดัชนี 332.107');
  });
});
