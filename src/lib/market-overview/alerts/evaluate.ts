/**
 * READ-TIME EVALUATION. NOTHING IS SCHEDULED AND NOTHING IS WRITTEN.
 *
 * ===========================================================================
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ===========================================================================
 * A hit exists while the condition is true and the reader is looking. It is a
 * line on a page, not a notification: no row is written, no push is sent, no
 * cron fires, and `vercel.json` is untouched. The consequence — and it is a
 * feature rather than a gap — is that a rule which was satisfied at 3 a.m. and
 * is no longer satisfied at 9 a.m. produces nothing, because there is nobody to
 * tell and no record claiming otherwise.
 *
 * The existing `src/lib/alerts` system is the one that does the other thing:
 * scheduled evaluation, a persisted `last_triggered_at`, a cooldown, a
 * notification row. This module does not extend it, share a type with it, or
 * write to its tables. See `types.ts` for why the two rule shapes are kept
 * apart.
 *
 * ===========================================================================
 * NO COOLDOWN, BECAUSE THERE IS NOTHING TO COOL DOWN
 * ===========================================================================
 * A cooldown stops a reader being told the same thing twice. Telling requires
 * memory, memory requires a write, and a write on a page read is the thing this
 * design refuses. So a rule that is satisfied on two consecutive renders is
 * reported on both, exactly as a price that is above a level on two consecutive
 * renders is above it on both. That is a statement about the market, not a
 * repeated interruption.
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

  if (OV_ALERT_UNIT[rule.kind] === 'price') {
    if (!usable(quote.price)) return false;
    return rule.kind === 'price_above'
      ? quote.price >= rule.threshold
      : quote.price <= rule.threshold;
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
  if (OV_ALERT_UNIT[rule.kind] === 'price') {
    const threshold = rule.threshold.toLocaleString('th-TH', { maximumFractionDigits: 4 });
    return `${OV_ALERT_WORD[rule.kind]} ${threshold} — ตอนนี้ ${price}`;
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
 * Every rule satisfied right now, in the order the rules were given.
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
      observedAt,
      valueText: describe(rule, quote),
      level: levelOf(quote),
    }];
  });
}
