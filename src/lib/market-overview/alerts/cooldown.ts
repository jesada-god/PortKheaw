/**
 * HOW LONG A RULE STAYS QUIET AFTER IT FIRES.
 *
 * ===========================================================================
 * WHY THERE IS A COOLDOWN AT ALL NOW
 * ===========================================================================
 * The first version of this feature evaluated rules on a page read and kept no
 * memory, on the reasoning that a hit is a line on a screen rather than a
 * notification, so repeating it costs nothing. That is true of a line on a
 * screen and false of a row in a table: the sweep now WRITES each hit, and a
 * rule that matches for a week would write a row every fifteen minutes — 672
 * rows saying one thing.
 *
 * So the memory arrived with the write, and it is one number per kind.
 *
 * ===========================================================================
 * ONE TABLE, NOT A NUMBER PER CALL SITE
 * ===========================================================================
 * Cooldowns are exactly the kind of constant that ends up spread across an
 * evaluator, a repository and a route, each with its own idea, and the way that
 * goes wrong is silent — a reader gets told twice and nothing errors. Every
 * duration is here, keyed by kind, and `evaluate.ts` is the only reader.
 *
 * ===========================================================================
 * WHY EARNINGS IS SIX TIMES THE OTHERS
 * ===========================================================================
 * The four price and move kinds describe something that CHANGED. A stock that
 * crossed $150 this morning can cross it again this afternoon and that is a
 * second event worth a second line; four hours is long enough to absorb a price
 * oscillating around a threshold and short enough that a genuine second move
 * the same day still reaches the reader.
 *
 * `earnings` describes something that is STILL TRUE. "NVDA reports within seven
 * days" is true for seven days running, and every sweep in that week would
 * otherwise write the same row. A day is the natural period of a fact measured
 * in days: the reader hears about it once per day until the date passes.
 *
 * The names in the brief map onto the kinds like this — `price_target` is
 * `price_above`, and `big_move` is the two percent kinds — and they share the
 * same four hours because they are the same kind of fact.
 */

import { OV_ALERT_KINDS, type OvAlertKind, type OvAlertRule } from './types';

/** Hours a rule stays quiet after it fires, by kind. */
export const OV_ALERT_COOLDOWN_HOURS: Readonly<Record<OvAlertKind, number>> = {
  /** A date that stays true for days. Once a day is once per fact. */
  earnings: 24,
  /** "price_target" in the brief. */
  price_above: 4,
  price_below: 4,
  /** "big_move" in the brief — one number for both directions. */
  percent_up: 4,
  percent_down: 4,
};

const HOUR_MS = 60 * 60 * 1_000;

/** The cooldown for one kind, in milliseconds. */
export function ovAlertCooldownMs(kind: OvAlertKind): number {
  return OV_ALERT_COOLDOWN_HOURS[kind] * HOUR_MS;
}

/**
 * Whether enough time has passed since this rule last fired.
 *
 * TRUE FOR A RULE THAT HAS NEVER FIRED — `lastFiredAt` is null then, which is
 * the absence of a previous hit rather than a very old one.
 *
 * An UNPARSEABLE `lastFiredAt` is treated as still cooling, not as never having
 * fired. The two failure directions are not symmetric: reading a corrupt
 * timestamp as "go ahead" turns one bad row into a hit on every sweep forever,
 * while reading it as "wait" costs one rule its alerts until somebody looks. The
 * silent failure is the one worth avoiding, so the loud one is chosen.
 */
export function ovAlertCooledDown(
  rule: Pick<OvAlertRule, 'kind' | 'lastFiredAt'>,
  now: Date | string = new Date(),
): boolean {
  if (rule.lastFiredAt === null) return true;
  const last = Date.parse(rule.lastFiredAt);
  if (!Number.isFinite(last)) return false;
  const at = typeof now === 'string' ? Date.parse(now) : now.valueOf();
  if (!Number.isFinite(at)) return false;
  return at - last >= ovAlertCooldownMs(rule.kind);
}

/** Every kind has a duration. A kind added without one is a compile error. */
export function ovAlertKindsWithoutCooldown(): OvAlertKind[] {
  return OV_ALERT_KINDS.filter((kind) => !(kind in OV_ALERT_COOLDOWN_HOURS));
}
