/**
 * EVALUATION. PURE, AND THE ONLY PLACE A RULE MEETS A READING.
 *
 * ===========================================================================
 * WHAT THIS DOES AND WHAT IT DELIBERATELY DOES NOT
 * ===========================================================================
 * It compares rules against readings and returns the hits. It writes nothing,
 * issues no request, and reads no clock of its own — `runOvAlertSweep` is what
 * persists, and keeping the comparison pure is what makes the cooldown provable
 * without a database.
 *
 * The existing `src/lib/alerts` system is a different sweep over a different
 * table with a different delivery path. This module does not extend it, share a
 * type with it, or write to its tables. See `types.ts`.
 *
 * ===========================================================================
 * THE COOLDOWN IS APPLIED HERE, NOT AT THE WRITE
 * ===========================================================================
 * A rule still inside its cooldown produces NO HIT AT ALL rather than a hit the
 * store then declines to write. The difference matters: a caller that received
 * a hit and saw it silently dropped could not tell a suppressed alert from a
 * failed write, and a sweep's summary would count neither honestly.
 *
 * Every duration lives in `cooldown.ts`, one per kind, and nothing else reads
 * them.
 *
 * ===========================================================================
 * A MISSING QUOTE IS NOT A MISS
 * ===========================================================================
 * A symbol whose price did not load produces no hit and no "could not check"
 * row. It is the same rule the detectors in `src/lib/watchlist/what-changed.ts`
 * follow: silence when the inputs are not there, never a hedge. Reporting an
 * unchecked rule as unmet would tell a reader their alert did not fire when the
 * truth is that nobody looked.
 */

import { statusFromSignedValue } from '@/src/lib/presentation/status';
import { signedPercent } from '@/src/lib/portfolio/presentation';
import { ovAlertCooledDown } from './cooldown';
import {
  OV_ALERT_UNIT,
  OV_ALERT_WORD,
  type OvAlertHit,
  type OvAlertRule,
} from './types';

/** The reading one rule is judged against. A structural subset of a quote. */
export interface OvAlertQuote {
  price: number | null;
  /** Today's move, from the shared day-change rule. Never recomputed here. */
  changePercent: number | null;
  /**
   * Whole days to the next scheduled report, from the earnings calendar.
   *
   * Absent on every symbol the calendar could not answer for, which is a normal
   * outcome and not an error — an `earnings` rule on such a symbol is silent.
   */
  earningsDays?: number | null;
}

function usable(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/**
 * Whether one rule is satisfied by one reading.
 *
 * The direction lives in the KIND and the threshold is always positive, so
 * `percent_down` compares the magnitude of a fall against a positive number.
 * Writing it as `changePercent <= threshold` with a negative threshold is the
 * same arithmetic and is the version somebody gets backwards.
 *
 * Exported so a test can walk each boundary by name rather than through the
 * whole feed.
 */
export function ovAlertMatches(rule: OvAlertRule, quote: OvAlertQuote): boolean {
  if (!rule.enabled) return false;
  if (!Number.isFinite(rule.threshold)) return false;

  const unit = OV_ALERT_UNIT[rule.kind];

  if (unit === 'price') {
    if (!usable(quote.price)) return false;
    return rule.kind === 'price_above'
      ? quote.price >= rule.threshold
      : quote.price <= rule.threshold;
  }

  if (unit === 'days') {
    /*
      A report that has not been dated is not a report that is far away. An
      absent count is silence, and a negative one is a date the calendar has not
      caught up with — neither is a match.
    */
    const days = quote.earningsDays;
    if (!usable(days) || days < 0) return false;
    return days <= rule.threshold;
  }

  if (!usable(quote.changePercent)) return false;
  return rule.kind === 'percent_up'
    ? quote.changePercent >= rule.threshold
    : quote.changePercent <= -rule.threshold;
}

/**
 * The sentence a hit prints.
 *
 * States the rule and then the reading, in that order, so a reader can check
 * one against the other: "ราคาขึ้นถึง 150 — ตอนนี้ 152.30". Nothing is
 * interpreted and nothing is suggested.
 */
function describe(rule: OvAlertRule, quote: OvAlertQuote): string {
  const price = usable(quote.price) ? quote.price.toLocaleString('th-TH', {
    maximumFractionDigits: 4,
  }) : '—';
  const unit = OV_ALERT_UNIT[rule.kind];
  if (unit === 'price') {
    const threshold = rule.threshold.toLocaleString('th-TH', { maximumFractionDigits: 4 });
    return `${OV_ALERT_WORD[rule.kind]} ${threshold} — ตอนนี้ ${price}`;
  }
  if (unit === 'days') {
    const days = quote.earningsDays;
    const left = usable(days) ? (days === 0 ? 'วันนี้' : `อีก ${days} วัน`) : '—';
    return `${OV_ALERT_WORD[rule.kind]} ${rule.threshold} วัน — ${left}`;
  }
  const move = usable(quote.changePercent) ? signedPercent(quote.changePercent) : '—';
  return `${OV_ALERT_WORD[rule.kind]} ${rule.threshold}% — ตอนนี้ ${move}`;
}

/**
 * The mark a hit wears.
 *
 * Read off the DAY'S MOVE, not off which rule fired. A `price_below` rule
 * reaching its level on a day the stock is up is a green day and a red mark
 * would contradict the number beside it — the alert is the reader's own
 * threshold, not a judgement about the market. Falls back to `neutral` when
 * there is no move to read, never to a direction.
 */
function levelOf(quote: OvAlertQuote): OvAlertHit['level'] {
  const level = statusFromSignedValue(quote.changePercent);
  return level === 'unknown' ? 'neutral' : level;
}

/**
 * Every rule satisfied right now AND out of its cooldown, in the order given.
 *
 * Input order is preserved rather than sorted: the caller owns the ordering of
 * a reader's own rules, and re-ranking them here — by how far past the
 * threshold each one is, say — would be this module deciding which of a
 * reader's alerts matters most.
 *
 * An empty array is the ordinary outcome and the caller must render nothing for
 * it.
 */
export function evaluateOvAlerts(
  rules: readonly OvAlertRule[],
  quotes: ReadonlyMap<string, OvAlertQuote>,
  now: Date | string = new Date(),
): OvAlertHit[] {
  const observedAt = typeof now === 'string' ? now : now.toISOString();
  return rules.flatMap((rule) => {
    const quote = quotes.get(rule.symbol.trim().toUpperCase());
    if (!quote) return [];
    if (!ovAlertMatches(rule, quote)) return [];
    /*
      Checked AFTER the match on purpose. A rule that does not match is not
      cooling down — it simply is not true — and collapsing the two would leave
      a sweep unable to say which of them kept a reader quiet.
    */
    if (!ovAlertCooledDown(rule, now)) return [];
    /*
      `ovAlertMatches` already proved the price is usable for the price kinds.
      A percent rule can match on a symbol whose price failed to load, and a hit
      with no price is not one this shape can express — so it is dropped rather
      than reported with a zero.
    */
    if (!usable(quote.price)) return [];
    return [{
      ruleId: rule.id,
      symbol: rule.symbol.trim().toUpperCase(),
      kind: rule.kind,
      observedPrice: quote.price,
      observedChangePercent: usable(quote.changePercent) ? quote.changePercent : null,
      observedEarningsDays: OV_ALERT_UNIT[rule.kind] === 'days' && usable(quote.earningsDays)
        ? quote.earningsDays
        : null,
      observedAt,
      valueText: describe(rule, quote),
      level: levelOf(quote),
      /* Filled in by `runOvAlertSweep` once the row exists. Pure here. */
      notificationId: null,
    }];
  });
}
