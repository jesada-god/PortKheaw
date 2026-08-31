/**
 * FIVE KINDS OF ALERT, AND WHAT A MATCH LOOKS LIKE.
 *
 * ===========================================================================
 * WHY THIS DOES NOT REUSE `AlertRule`
 * ===========================================================================
 * `src/lib/alerts/logic.ts` exports an `AlertRule` — two fields, the argument
 * of `conditionMatches` — and `src/lib/alerts/types.ts` exports the four
 * `AlertCondition` values behind the notification system. Both are real, both
 * work, and neither is imported here.
 *
 * That is a deliberate constraint rather than an oversight. The two systems
 * answer to different schedules and different tables: the existing one sweeps
 * `price_alerts`, writes a `notifications` row and pushes to a device; this one
 * sweeps `overview_alert_rules` and writes `overview_alert_hits`. Sharing a rule
 * type would make it possible to hand a rule from one to the other's evaluator,
 * and TypeScript would not object, because the shapes overlap.
 *
 * Four of the five kinds are the same comparisons the existing conditions make,
 * named in this module's vocabulary. The comparison itself is a handful of lines
 * in `evaluate.ts` rather than a call to `conditionMatches`, for the same
 * reason: reaching for that function requires translating a kind into a
 * condition, which is exactly the crossing this separation exists to prevent.
 *
 * The fifth, `earnings`, has no counterpart there at all.
 */

import type { StatusLevel } from '@/src/lib/presentation/status';
import type { OverviewAlertKind } from '@/src/types/database';

/**
 * The five comparisons a reader may ask for.
 *
 * Two absolute, two relative, one calendar. The first pairing is the point:
 * `price_above` asks about a level, `percent_up` asks about a move. A reader
 * watching for "$150" and a reader watching for "+5% today" are asking
 * different questions, and a single "target" field that meant either would be
 * ambiguous the moment anybody read the row back.
 *
 * `earnings` asks about a DATE — "tell me when this reports within N days" —
 * and it is in the same union rather than a type of its own because it has the
 * same shape: one positive number, compared against one reading. What differs
 * is only which reading, which `OV_ALERT_UNIT` states.
 */
export type OvAlertKind =
  | 'price_above'
  | 'price_below'
  | 'percent_up'
  | 'percent_down'
  | 'earnings';

export const OV_ALERT_KINDS: readonly OvAlertKind[] = [
  'price_above',
  'price_below',
  'percent_up',
  'percent_down',
  'earnings',
];

/**
 * THE FIVE KINDS ARE WRITTEN DOWN IN FOUR PLACES. THESE TWO LINES PIN TWO OF
 * THEM TOGETHER.
 *
 * The four:
 *
 *   1. `overview_alert_rules_kind_check`                      — the column
 *   2. `overview_alert_hits.kind`'s check                     — the column
 *   3. `create_overview_alert_rule`                           — the writer
 *   4. {@link OvAlertKind} here, and `OverviewAlertKind` in `database.ts`
 *
 * They have drifted once already and it cost the feature a whole kind:
 * `202608310001` widened (1) and (2) to admit `earnings` and left (3) on four,
 * so an `earnings` rule could be stored, evaluated, cooled down and recorded as
 * a hit — and could not be created by anybody. `202608310003` repairs it.
 *
 * Nothing detected that, so each pair is now held together by something that
 * fails rather than by care:
 *
 *   * (1)(2)(3) against each other — `service-path.contract.test.ts` reads all
 *     three lists out of the SQL and compares them.
 *   * (4) against the schema's copy — the two assignments below, which are
 *     mutually exclusive unless the unions are identical. Adding a kind to one
 *     and not the other makes one of them `never` and the build stops.
 *
 * A `Record<OvAlertKind, …>` already forces `OV_ALERT_COOLDOWN_HOURS`,
 * {@link OV_ALERT_UNIT} and {@link OV_ALERT_WORD} to stay exhaustive, so those
 * three need nothing here.
 */
const SCHEMA_KIND_COVERS_DOMAIN: OverviewAlertKind = null as unknown as OvAlertKind;
const DOMAIN_KIND_COVERS_SCHEMA: OvAlertKind = null as unknown as OverviewAlertKind;
void SCHEMA_KIND_COVERS_DOMAIN;
void DOMAIN_KIND_COVERS_SCHEMA;

/**
 * What `threshold` is measured in, so a reader is never shown a price as a
 * percent — or a day count as either.
 *
 * `earnings` is a DAY count and is why this is a three-value union rather than
 * a boolean. "Tell me when NVDA reports within 7 days" is the same shape as the
 * other four — a positive number the reading is compared against — which is
 * what let it join the table instead of needing a rule type of its own.
 */
export const OV_ALERT_UNIT: Readonly<Record<OvAlertKind, 'price' | 'percent' | 'days'>> = {
  price_above: 'price',
  price_below: 'price',
  percent_up: 'percent',
  percent_down: 'percent',
  earnings: 'days',
};

/** The Thai phrase each kind states, with the threshold appended by `evaluate.ts`. */
export const OV_ALERT_WORD: Readonly<Record<OvAlertKind, string>> = {
  price_above: 'ราคาขึ้นถึง',
  price_below: 'ราคาลงถึง',
  percent_up: 'ขึ้นวันนี้ถึง',
  percent_down: 'ลงวันนี้ถึง',
  earnings: 'ประกาศงบภายใน',
};

export interface OvAlertRule {
  id: string;
  /** Upper-cased at the boundary. The join key against the page's quotes. */
  symbol: string;
  kind: OvAlertKind;
  /**
   * A price for the two absolute kinds, a positive percentage for the two
   * relative ones, a whole number of days for `earnings`.
   *
   * ALWAYS POSITIVE, including `percent_down` — the direction is in the kind,
   * not in the sign. A rule storing -5 for "down 5%" would compare against a
   * change percent that is also negative, and the first person to write
   * `changePercent <= threshold` would get it backwards without any test
   * noticing.
   */
  threshold: number;
  enabled: boolean;
  /**
   * Whose rule this is, when the caller is in a position to know.
   *
   * NULL FROM A READER-SCOPED STORE, and that is not a gap: RLS has already
   * narrowed the read to one account, so the id would be the reader's own and
   * carrying it would invite somebody to filter on it — which is the check RLS
   * is doing properly one layer down.
   *
   * Set by the service-role store, which reads every account's rules and has no
   * RLS to lean on. `runOvAlertSweep` groups by this, so a reader-scoped sweep
   * is simply the case where every rule lands in one group.
   */
  userId: string | null;
  /**
   * When this rule last produced a hit, or null when it never has.
   *
   * The cooldown reads it and `record_overview_alert_hit` writes it, in the
   * same statement that writes the hit — see `cooldown.ts` for why a hit
   * without a time is worse than no hit at all.
   */
  lastFiredAt: string | null;
}

export interface OvAlertHit {
  ruleId: string;
  symbol: string;
  kind: OvAlertKind;
  /** The price the match was decided on. Never re-read afterwards. */
  observedPrice: number;
  /** Null for the kinds that do not consult it. */
  observedChangePercent: number | null;
  /** Whole days to the next scheduled report. Null for every non-earnings kind. */
  observedEarningsDays: number | null;
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
  /**
   * The row this hit was written as, or null when it was not persisted.
   *
   * Null is a real state and not a placeholder: `evaluateOvAlerts` is pure and
   * returns hits with no id at all, and only `runOvAlertSweep` — which has a
   * store — fills it in. A caller that needs to know whether a reader has
   * actually been told must check this rather than assume.
   */
  notificationId: string | null;
}
