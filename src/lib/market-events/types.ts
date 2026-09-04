import { z } from 'zod';

/**
 * The macro releases the calendar knows about.
 *
 * MACRO ONLY, and that is a boundary rather than a stage of work. Earnings
 * dates belong to one company and answer a question about a holding; these
 * move the whole tape and answer a question about the day. The Upcoming feed
 * still carries earnings exactly as it did — see `src/lib/upcoming` — and
 * nothing here reads or replaces it.
 */
export const marketEventKindSchema = z.enum([
  'CPI', 'PPI', 'PCE', 'NFP', 'GDP', 'FOMC', 'JOBLESS_CLAIMS',
]);

/**
 * How loudly a row is drawn, and nothing more.
 *
 * This is an EDITORIAL ranking of how widely a release is watched — it is not
 * measured, not back-tested, and says nothing about how any symbol responds to
 * anything. The detail page is careful for the same reason: a macro release is
 * shown with the COUNT of holdings a reader has, never with a claim about which
 * of them it will move.
 */
export const marketEventImportanceSchema = z.enum(['high', 'medium', 'low']);

export const marketEventSchema = z.object({
  id: z.string().min(1),
  kind: marketEventKindSchema,
  titleTh: z.string().min(1),
  /** The name that fits in a calendar cell. */
  shortTh: z.string().min(1),
  importance: marketEventImportanceSchema,
  source: z.enum(['BLS', 'BEA', 'FED', 'DOL']),
  referencePeriod: z.string().min(1),
  /*
   * THE VALUE. A UTC instant, and the regex is the guard rail: an offset form
   * like `2026-09-11T08:30:00-04:00` would still parse, still be correct today,
   * and still be the shape that invites somebody to store a local time with a
   * zone name beside it later. Z or it does not load.
   */
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
  /*
   * A LABEL. Never parsed, never computed with — see the header of `time.ts`
   * and the assertion in `market-events.contract.test.ts`.
   */
  etDisplay: z.string().min(1),
});

export const marketEventFileSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.array(marketEventSchema),
});

/**
 * The three ranks in Thai words.
 *
 * IT LIVES HERE, not beside the feed, because both calendar components need it
 * for their `aria-label` and `feed.ts` imports `calendar.ts` — which imports
 * the events JSON. A client component reaching for the label through `feed.ts`
 * would drag the whole file into the browser bundle, which is the exact cost
 * `card-view.ts` exists to avoid. This module imports nothing but zod.
 *
 * `feed.ts` re-exports it, so every existing caller is unchanged and there is
 * still one copy.
 */
export const IMPORTANCE_LABEL_TH: Record<z.infer<typeof marketEventImportanceSchema>, string> = {
  high: 'สำคัญมาก',
  medium: 'สำคัญปานกลาง',
  low: 'ติดตามได้',
};

export type MarketEventKind = z.infer<typeof marketEventKindSchema>;
export type MarketEventImportance = z.infer<typeof marketEventImportanceSchema>;
export type MarketEvent = z.infer<typeof marketEventSchema>;
