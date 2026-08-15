/**
 * What a saved plan must be, written once for both sides of the wire.
 *
 * The browser validates with this so the reader is told about a bad plan without
 * a round trip, and the route validates with the *same* schema so the browser's
 * check is a convenience rather than the thing being relied on. A client-side
 * check is not validation; it is a faster way of telling somebody something the
 * server is going to decide anyway.
 *
 * The cross-field rules (`target > baseline > invalidation`, a horizon in the
 * future) live here rather than in each caller, so there is exactly one statement
 * of what a valid v1 plan is — and the database repeats it again in its own
 * constraints, which is what makes it true of rows rather than of requests.
 */

import { z } from 'zod';

/** The same symbol shape the rest of the tools accept. */
const symbol = z.string().trim().toUpperCase().regex(
  /^[A-Z0-9][A-Z0-9.-]{0,19}$/,
  'สัญลักษณ์หุ้นไม่ถูกต้อง',
);

const price = z.number().finite().positive().max(1_000_000);

const horizonDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ไม่ถูกต้อง');

/**
 * A plan as it is created.
 *
 * `baselinePrice` is accepted here because creation is the one moment it is
 * legitimately set — it is the canonical accepted price the reader saw. The
 * server does not take the browser's word for the *value* being sensible beyond
 * these bounds, but it is the browser's to send exactly once.
 */
export const stockPlanCreateSchema = z.object({
  symbol,
  baselinePrice: price,
  targetPrice: price,
  invalidationPrice: price,
  horizonDate,
}).superRefine(orderedLevels);

/**
 * A plan as it is edited.
 *
 * `baselinePrice` is absent, and that absence is the feature: there is no field
 * here that could carry a new baseline, so no edit request can express moving one
 * even if it wanted to. The route re-checks the ordering against the *stored*
 * baseline, because that is the number the edited levels have to make sense
 * against — not one the caller supplied.
 */
export const stockPlanUpdateSchema = z.object({
  targetPrice: price,
  invalidationPrice: price,
  horizonDate,
});

export type StockPlanCreateInput = z.infer<typeof stockPlanCreateSchema>;
export type StockPlanUpdateInput = z.infer<typeof stockPlanUpdateSchema>;

function orderedLevels(
  value: { baselinePrice: number; targetPrice: number; invalidationPrice: number },
  context: z.RefinementCtx,
): void {
  if (value.targetPrice <= value.baselinePrice) {
    context.addIssue({
      code: 'custom',
      path: ['targetPrice'],
      message: 'ราคาเป้าหมายต้องสูงกว่าราคาปัจจุบัน',
    });
  }
  if (value.invalidationPrice >= value.baselinePrice) {
    context.addIssue({
      code: 'custom',
      path: ['invalidationPrice'],
      message: 'ระดับที่แผนไม่เป็นไปตามคาดต้องต่ำกว่าราคาปัจจุบัน',
    });
  }
}

/**
 * The edited levels checked against the baseline already on the row.
 *
 * Kept separate from the schema because the baseline is not part of the request:
 * it is read from storage first, and only then is the caller's plan judged
 * against it.
 */
export function updateKeepsOrdering(
  update: StockPlanUpdateInput,
  storedBaseline: number,
): { ok: true } | { ok: false; message: string } {
  if (update.targetPrice <= storedBaseline) {
    return { ok: false, message: 'ราคาเป้าหมายต้องสูงกว่าราคาที่บันทึกไว้ตอนสร้างแผน' };
  }
  if (update.invalidationPrice >= storedBaseline) {
    return { ok: false, message: 'ระดับที่แผนไม่เป็นไปตามคาดต้องต่ำกว่าราคาที่บันทึกไว้ตอนสร้างแผน' };
  }
  return { ok: true };
}

/** A horizon must still be in the future, judged against the caller's today. */
export function horizonIsFuture(horizon: string, today: string): boolean {
  const start = Date.parse(`${today}T00:00:00Z`);
  const end = Date.parse(`${horizon}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end > start;
}
