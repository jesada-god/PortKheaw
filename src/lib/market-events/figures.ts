import { z } from 'zod';
import figureFile from '@/src/data/market-event-figures.json';
import {
  BLS_SERIES,
  CHANGE_UNIT_LABEL_TH,
  UNIT_LABEL_TH,
  type BlsUnit,
} from './bls-series';
import { marketEventKindSchema, type MarketEvent } from './types';

/**
 * WHAT THE RELEASE ACTUALLY PUBLISHED, AND WHAT IT PUBLISHED THE MONTH BEFORE.
 *
 * ===========================================================================
 * THE ONE SENTENCE THIS MODULE IS ALLOWED TO WRITE
 * ===========================================================================
 *     ตัวเลขที่ประกาศ — ส.ค. 2569: ดัชนี 332.813 · ก.ค. 2569: ดัชนี 332.107
 *
 * Two published levels and the month each belongs to. Both came from BLS and
 * both can be looked up. There is no third number derived from them beyond the
 * month-over-month change, which is subtraction the reader could do themselves
 * and which is labelled with its own unit.
 *
 * WHAT IS ABSENT IS THE POINT. There is no forecast, no consensus, no "beat" or
 * "miss" — this product has no expectations to be met, and a panel that said a
 * number came in below them would be inventing the expectation. The phrases
 * that would cross that line are in `EVENT_FIGURE_MUST_NOT_SAY`, with the
 * reasoning, and asserted over rendered output.
 *
 * ===========================================================================
 * NOTHING IS FETCHED, AND AN ABSENT FIGURE IS ABSENT
 * ===========================================================================
 * The file is static and written by `scripts/backfill-event-figures.mts`. A
 * published statistic for a past month does not change between renders — and
 * when it does change, it changes because BLS revised it, which is an event
 * that should show up as a diff on a committed file rather than as a number
 * that silently moved under a reader.
 *
 * When there is nothing to show this returns NULL and the caller renders
 * nothing at all — no heading, no dash, no empty row. A dash invites a reader
 * to wonder what broke; the honest rendering of "this has not been published
 * yet" is silence. That is the state MOST rows are in: the calendar runs to
 * December and BLS has published through August, so a release that has not
 * happened has no figure, correctly.
 *
 * ===========================================================================
 * A PRELIMINARY NUMBER SAYS IT IS PRELIMINARY
 * ===========================================================================
 * PPI carries "subject to monthly revisions up to four months after original
 * publication" and NFP carries "preliminary" in BLS's own footnotes. Those are
 * not decoration: a reader who writes 159,075 down today and compares it
 * against the same cell in December will find a different number, and the panel
 * has to have told them that would happen. The footnote is rendered, never
 * dropped.
 */

const observationSchema = z.object({
  /** BLS `year` + `period`, e.g. 2026 and M08. Kept for a checkable citation. */
  year: z.number().int(),
  period: z.string().min(1),
  /** "August 2026" — the month the figure is ABOUT, not the day it was published. */
  periodLabel: z.string().min(1),
  /** Thai rendering of the same month, e.g. "ส.ค. 2569". */
  periodLabelTh: z.string().min(1),
  value: z.number().finite(),
  /**
   * BLS's own footnotes, verbatim. Empty when the number is final.
   *
   * Stored as the agency wrote them rather than as a boolean: "preliminary" and
   * "subject to monthly revisions up to four months" say different things about
   * how long a reader should expect the number to keep moving.
   */
  footnotes: z.array(z.string()),
});

const figureRowSchema = z.object({
  eventId: z.string().min(1),
  kind: marketEventKindSchema,
  seriesId: z.string().min(1),
  adjustment: z.enum(['SA', 'NSA']),
  unit: z.enum(['index', 'thousands-of-persons']),
  latest: observationSchema,
  /** Null when the series has no month before the one published. */
  previous: observationSchema.nullable(),
});

const figureFileSchema = z.object({
  schemaVersion: z.literal(1),
  _provenance: z.object({
    source: z.literal('BLS'),
    api: z.string().min(1),
    /** 'registered' or 'anonymous' — which shapes what could be verified. */
    access: z.enum(['registered', 'anonymous']),
    /**
     * Whether BLS confirmed each series id through its catalog.
     *
     * FALSE here means the numbers are real but the ids behind them were never
     * checked against the agency's own titles. `bls-series.test.ts` is red
     * while this is false; see the header of `bls-series.ts`.
     */
    catalogVerified: z.boolean(),
    fetchedAt: z.string().min(1),
    series: z.array(z.object({
      kind: marketEventKindSchema,
      seriesId: z.string().min(1),
      adjustment: z.enum(['SA', 'NSA']),
    })),
  }),
  figures: z.array(figureRowSchema),
});

export type FigureObservation = z.infer<typeof observationSchema>;
export type FigureRow = z.infer<typeof figureRowSchema>;

/*
 * A file that does not parse yields NO figures, never a partial set — the
 * discipline `calendar.ts` and `reactions.ts` both state. Half a set looks
 * exactly like a complete one and would tell a reader that a release simply has
 * no history.
 */
const parsed = figureFileSchema.safeParse(figureFile);
const ROWS: readonly FigureRow[] = parsed.success ? parsed.data.figures : [];

/** Whether the shipped figures were confirmed against BLS's catalog. */
export const FIGURES_CATALOG_VERIFIED = parsed.success
  ? parsed.data._provenance.catalogVerified
  : false;

export interface FigureReading {
  /** "ส.ค. 2569" — the month this level is about. */
  periodLabelTh: string;
  value: number;
  /** "332.813" — grouped, and never without `unitLabelTh` beside it. */
  valueLabel: string;
  /** "ดัชนี" or "พันคน". A bare number is a digit string. */
  unitLabelTh: string;
  /** BLS's own footnotes, verbatim. Empty when the number is final. */
  footnotesTh: string[];
}

export interface EventFigureView {
  eventId: string;
  /** "ตัวเลขที่ประกาศ" — states that these are published values, nothing more. */
  headingTh: string;
  latest: FigureReading;
  /** Null when there is no earlier month to put beside it. */
  previous: FigureReading | null;
  /**
   * Month over month, already written with its own unit — "+0.21%" for an
   * index, "+22 พันคน" for a headcount. Null when there is no previous month.
   */
  changeLabel: string | null;
  /** True when BLS marked either reading as subject to revision. */
  preliminary: boolean;
  /** The sentence that says so, when it is true. */
  preliminaryNoteTh: string | null;
}

/**
 * The figures for one release, or null when there are none.
 *
 * Null is the common case and the correct one: the calendar runs months ahead
 * of what has been published.
 */
export function figuresFor(
  event: MarketEvent,
  { rows = ROWS }: { rows?: readonly FigureRow[] } = {},
): EventFigureView | null {
  const row = rows.find((entry) => entry.eventId === event.id);
  if (!row) return null;

  const latest = toReading(row.latest, row.unit);
  const previous = row.previous ? toReading(row.previous, row.unit) : null;
  const preliminary = [...row.latest.footnotes, ...(row.previous?.footnotes ?? [])].length > 0;

  return {
    eventId: row.eventId,
    headingTh: 'ตัวเลขที่ประกาศ',
    latest,
    previous,
    changeLabel: row.previous
      ? changeLabelOf(row.latest.value - row.previous.value, row.unit)
      : null,
    preliminary,
    /*
      One sentence for both footnote kinds. BLS's own wording is kept on the
      reading itself; this is the short warning that has to survive being read
      at a glance, because "จะถูกแก้ภายหลัง" is the part a reader acts on.
    */
    preliminaryNoteTh: preliminary ? 'ตัวเลขเบื้องต้น จะถูกแก้ภายหลัง' : null,
  };
}

function toReading(observation: FigureObservation, unit: BlsUnit): FigureReading {
  return {
    periodLabelTh: observation.periodLabelTh,
    value: observation.value,
    valueLabel: formatLevel(observation.value, unit),
    unitLabelTh: UNIT_LABEL_TH[unit],
    footnotesTh: observation.footnotes,
  };
}

/**
 * An index keeps its three decimals because that is the precision BLS
 * publishes and rounding it would make two adjacent months look identical. A
 * headcount is a whole number of thousands and is grouped, because 159075 and
 * 159,075 are not equally readable at a glance.
 */
function formatLevel(value: number, unit: BlsUnit): string {
  if (unit === 'index') return value.toFixed(3);
  return Math.round(value).toLocaleString('en-US');
}

/**
 * SIGNED, ALWAYS. The direction is the whole point of putting two months side
 * by side, and a reader should not have to compare the two levels themselves to
 * recover it.
 */
function changeLabelOf(delta: number, unit: BlsUnit): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const magnitude = Math.abs(delta);
  if (unit === 'index') {
    return `${sign}${magnitude.toFixed(3)} ${CHANGE_UNIT_LABEL_TH[unit]}`.replace(' %', '%');
  }
  return `${sign}${Math.round(magnitude).toLocaleString('en-US')} ${CHANGE_UNIT_LABEL_TH[unit]}`;
}

/**
 * The whole block as one line, so the wording exists in exactly one place.
 *
 *     ตัวเลขที่ประกาศ — ส.ค. 2569: ดัชนี 332.813 · ก.ค. 2569: ดัชนี 332.107
 *
 * The component renders the parts separately and this is what a test asserts
 * they add up to, which is how the two stay the same sentence.
 */
export function figureSentenceTh(view: EventFigureView): string {
  const latest = `${view.latest.periodLabelTh}: ${view.latest.unitLabelTh} ${view.latest.valueLabel}`;
  if (!view.previous) return `${view.headingTh} — ${latest}`;
  const previous = `${view.previous.periodLabelTh}: ${view.previous.unitLabelTh} ${view.previous.valueLabel}`;
  return `${view.headingTh} — ${latest} · ${previous}`;
}

/** The kinds that can carry a figure at all, for a caller that wants to ask. */
export function canCarryFigure(event: MarketEvent): boolean {
  return Object.prototype.hasOwnProperty.call(BLS_SERIES, event.kind);
}
