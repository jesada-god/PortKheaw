/**
 * FOUR KINDS OF ALERT, AND WHAT A MATCH LOOKS LIKE.
 *
 * ===========================================================================
 * WHY THIS DOES NOT REUSE `AlertRule`
 * ===========================================================================
 * `src/lib/alerts/logic.ts` exports an `AlertRule` — two fields, the argument
 * of `conditionMatches` — and `src/lib/alerts/types.ts` exports the four
 * `AlertCondition` values behind the notification system. Both are real, both
 * work, and neither is imported here.
 *
 * That is a deliberate constraint rather than an oversight. The two systems do
 * different things: the existing one is scheduled, persists a trigger, writes a
 * notification and enforces a cooldown so a reader is not woken twice; this one
 * is evaluated on a page read and persists nothing. Sharing a rule type between
 * them would make it possible to hand a read-time rule to the notification path
 * — where `cooldownMinutes` and `lastTriggeredAt` are load-bearing and absent
 * here — and TypeScript would not object, because the shapes overlap.
 *
 * The four kinds below are the same four comparisons the existing conditions
 * make, named in this module's vocabulary. The comparison itself is four lines
 * in `evaluate.ts` rather than a call to `conditionMatches`, for the same
 * reason: reaching for that function requires translating a kind into a
 * condition, which is exactly the crossing this separation exists to prevent.
 */

import type { StatusLevel } from '@/src/lib/presentation/status';

/**
 * The four comparisons a reader may ask for.
 *
 * Two absolute and two relative, and the pairing is the point: `price_above`
 * asks about a level, `percent_up` asks about a move. A reader watching for
 * "$150" and a reader watching for "+5% today" are asking different questions,
 * and a single "target" field that meant either would be ambiguous the moment
 * anybody read the row back.
 */
export type OvAlertKind = 'price_above' | 'price_below' | 'percent_up' | 'percent_down';

export const OV_ALERT_KINDS: readonly OvAlertKind[] = [
  'price_above',
  'price_below',
  'percent_up',
  'percent_down',
];

/** What `threshold` is measured in, so a reader is never shown a price as a percent. */
export const OV_ALERT_UNIT: Readonly<Record<OvAlertKind, 'price' | 'percent'>> = {
  price_above: 'price',
  price_below: 'price',
  percent_up: 'percent',
  percent_down: 'percent',
};

/** The Thai phrase each kind states, with the threshold appended by `evaluate.ts`. */
export const OV_ALERT_WORD: Readonly<Record<OvAlertKind, string>> = {
  price_above: 'ราคาขึ้นถึง',
  price_below: 'ราคาลงถึง',
  percent_up: 'ขึ้นวันนี้ถึง',
  percent_down: 'ลงวันนี้ถึง',
};

export interface OvAlertRule {
  id: string;
  /** Upper-cased at the boundary. The join key against the page's quotes. */
  symbol: string;
  kind: OvAlertKind;
  /**
   * A price for the two absolute kinds, a positive percentage for the two
   * relative ones.
   *
   * ALWAYS POSITIVE, including `percent_down` — the direction is in the kind,
   * not in the sign. A rule storing -5 for "down 5%" would compare against a
   * change percent that is also negative, and the first person to write
   * `changePercent <= threshold` would get it backwards without any test
   * noticing.
   */
  threshold: number;
  enabled: boolean;
}

export interface OvAlertHit {
  ruleId: string;
  symbol: string;
  kind: OvAlertKind;
  /** The price the match was decided on. Never re-read afterwards. */
  observedPrice: number;
  /** Null for the two price kinds, which do not consult it. */
  observedChangePercent: number | null;
  /** ISO UTC of the render the match was found on. */
  observedAt: string;
  /**
   * One Thai sentence stating the rule and the reading that satisfied it.
   *
   * Built by `evaluate.ts` so the wording sits beside the comparison it
   * describes. No hit ever says what to do about itself.
   */
  valueText: string;
  /** The mark, from the shared five-level vocabulary. */
  level: StatusLevel;
}
