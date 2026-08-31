/**
 * HOW WIDE THE ADVANCE IS, IN THREE WORDS.
 *
 * ===========================================================================
 * THIS BUYS NOTHING. IT READS WHAT WAS ALREADY PAID FOR.
 * ===========================================================================
 * `src/lib/overview/market-breadth.ts` already collects the whole US common-
 * stock universe from Alpaca's multi-symbol snapshot — ~22 batched requests
 * behind a last-good snapshot with a two-minute fresh window — and counts
 * advancers, decliners and unchanged from `dailyBar.c` against `prevDailyBar.c`.
 *
 * This module adds arithmetic to that count and nothing else. It issues no
 * request, holds no cache, and takes no client. `ovBreadthFromMarketBreadth`
 * exists so the adapter from the existing shape lives here rather than being
 * rewritten at each call site.
 *
 * ===========================================================================
 * WHY THERE IS NO MOVING AVERAGE
 * ===========================================================================
 * "% above the 50-day / 200-day" is the figure this kind of card usually leads
 * with, and Phase 2 does not have it. The batch returns two bars per symbol;
 * a 200-day average needs two hundred, which across ~4,285 symbols is a second
 * fan-out of historical requests an order of magnitude larger than the one that
 * already exists. `OvBreadthSnapshot.pctAboveMA50` and `pctAboveMA200` are
 * therefore typed `null` — not `number | null` — so no caller can fill them in
 * from a smaller sample and quietly publish a different statistic under the
 * same name. `MarketBreadth.aboveEma20Percent` has been hardcoded `null` since
 * it shipped, for the same reason and without the type saying so.
 *
 * ===========================================================================
 * WHY THREE WORDS AND NOT THE DIRECTION VOCABULARY
 * ===========================================================================
 * Breadth answers "how many took part", which is not "which way did it go". A
 * market can rise on a handful of names — that is the fact `weak` is here to
 * report, and it can be true on a green day. Reusing `OvMarketStatus` would
 * invite a card to print `down` when it meant `weak`, so the two vocabularies
 * are kept apart on purpose. See `OvBreadthStatus` in `types.ts`.
 */

import type { MarketBreadth } from '@/src/lib/overview/types';
import type { OvBreadthSnapshot, OvBreadthStatus } from './types';

/**
 * Where the count turns into a word.
 *
 * Expressed as advancers over the rows that could be READ, never over the
 * universe — a batch that returned half the market has a smaller denominator,
 * not a market in which half the stocks were flat. Coverage is reported
 * separately by the existing `MarketBreadth.coveragePercent`; conflating the
 * two here would make a provider outage look like a quiet tape.
 *
 * The cut points are the conventional ones for an advance-decline reading and
 * are NOT symmetric around fifty, deliberately:
 *
 *   * `strongAtOrAbove: 60` — three advancers for every two decliners. Below
 *     that an advance is real but not broad, and calling it broad would use up
 *     the strongest word the card has on an ordinary day.
 *   * `weakBelow: 40` — the mirror of the same ratio the other way.
 *
 * Everything between is `weakening`, which is the band a normal session lands
 * in. That is the intended shape: the middle word should be the common one, so
 * that the outer two mean something when they appear.
 */
export const OV_BREADTH_THRESHOLDS = {
  strongAtOrAbove: 60,
  weakBelow: 40,
} as const;

/** Only the four numbers this module needs. A structural subset of `MarketBreadth`. */
export interface OvBreadthInput {
  advancing: number;
  declining: number;
  unchanged: number;
  /** Rows that produced a usable comparison. Advancing + declining + unchanged. */
  validCount: number;
}

/**
 * The three-way reading, or `null` when there is nothing to read.
 *
 * `null` for an empty or negative `validCount` rather than a status: with no
 * rows there is no percentage, and `0 / 0` would resolve to `weak` — a card
 * announcing a narrow market because a provider was down. Silence is the
 * answer to an absent sample here, exactly as it is in `what-changed.ts`.
 *
 * How far the count falls short of being usable at all is NOT judged here.
 * `market-breadth.ts` already owns that question and publishes it as
 * `status: 'ready' | 'partial' | 'stale'`; a second floor in this file would be
 * a second opinion about the same sample.
 */
export function ovBreadth(input: OvBreadthInput): OvBreadthSnapshot | null {
  const { advancing, declining, validCount } = input;
  if (!Number.isFinite(validCount) || validCount <= 0) return null;
  if (!Number.isFinite(advancing) || !Number.isFinite(declining)) return null;
  if (advancing < 0 || declining < 0) return null;

  const advancingPercent = (advancing / validCount) * 100;
  return {
    advancers: advancing,
    decliners: declining,
    advancingPercent,
    pctAboveMA50: null,
    pctAboveMA200: null,
    status: ovBreadthStatus(advancingPercent),
    validCount,
  };
}

/** The band `advancingPercent` falls in. Read as "at least this much". */
export function ovBreadthStatus(advancingPercent: number): OvBreadthStatus {
  if (advancingPercent >= OV_BREADTH_THRESHOLDS.strongAtOrAbove) return 'strong';
  if (advancingPercent < OV_BREADTH_THRESHOLDS.weakBelow) return 'weak';
  return 'weakening';
}

/**
 * The adapter from what the overview already loaded.
 *
 * Takes the whole `MarketBreadth` and reads four fields off it. Written as its
 * own function so that the day a field is renamed upstream, one call site
 * breaks rather than every caller of `ovBreadth`.
 */
export function ovBreadthFromMarketBreadth(
  breadth: MarketBreadth | null,
): OvBreadthSnapshot | null {
  if (!breadth) return null;
  return ovBreadth({
    advancing: breadth.advancing,
    declining: breadth.declining,
    unchanged: breadth.unchanged,
    validCount: breadth.validCount,
  });
}
