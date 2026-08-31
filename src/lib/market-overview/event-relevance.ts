/**
 * WHICH OF THE READER'S SYMBOLS A MACRO RELEASE REACHES.
 *
 * ===========================================================================
 * COMPUTED AT READ TIME, NEVER STORED
 * ===========================================================================
 * No symbol goes into `src/data/market-events.json`. The file is a
 * transcription of four agencies' published schedules and must stay one: the
 * moment a symbol list is written next to a release, it is a claim that ages
 * silently — the reader sells the stock, the file still says the release
 * affects it, and nothing in the system notices.
 *
 * So the join happens here, on each read, against the symbols the page already
 * holds. It costs one array pass and no request.
 *
 * ===========================================================================
 * WHAT "AFFECTED" IS ALLOWED TO MEAN
 * ===========================================================================
 * It means: this release moves the whole US tape, and these are the US symbols
 * you hold or watch. That is a statement about the BREADTH of a release, which
 * is a published fact about what it measures — a CPI print is an economy-wide
 * number — and about what is in the reader's own lists, which the page knows.
 *
 * It does NOT mean the release will move those symbols, will move them in a
 * particular direction, or will move them more than any other. The shipped
 * calendar's own header refuses exactly that claim, and the refusal survives
 * here: {@link OV_EVENT_SCOPE} says every kind is market-wide and there is no
 * per-symbol weighting, no sector mapping, and no ranking of one holding above
 * another. A reader gets a count and a list, and draws their own conclusion.
 *
 * The table exists as DATA rather than as a hardcoded `true` so that a kind
 * which is genuinely not market-wide has somewhere to land without this file
 * growing a special case.
 */

import type { OvEventCode, OvMarketEvent } from './events';

/**
 * How far each release reaches.
 *
 * All seven are `market-wide` today, and that is a property of what these seven
 * measure — inflation, employment, output, the policy rate — rather than an
 * unfinished table. Nothing in the calendar is company-specific; earnings dates
 * live in `src/lib/analytics/earnings`, are per-company, and are deliberately
 * not part of this feed.
 */
export const OV_EVENT_SCOPE: Readonly<Record<OvEventCode, 'market-wide'>> = {
  CPI: 'market-wide',
  PPI: 'market-wide',
  PCE: 'market-wide',
  NFP: 'market-wide',
  GDP: 'market-wide',
  FOMC: 'market-wide',
  JOBLESS_CLAIMS: 'market-wide',
};

/**
 * How many symbols a row may name before it stops being readable.
 *
 * A reader with sixty holdings does not want sixty tickers in a calendar cell;
 * they want to know it reaches their portfolio and roughly how much of it.
 * `total` carries the full count, so the card can say "และอีก N ตัว" without
 * this module deciding how to phrase it.
 */
export const OV_EVENT_SYMBOL_LIMIT = 8;

export interface OvEventRelevance {
  eventId: string;
  scope: 'market-wide';
  /**
   * The reader's own symbols, de-duplicated, upper-cased and sorted, capped at
   * {@link OV_EVENT_SYMBOL_LIMIT}.
   *
   * Sorted alphabetically and not by any notion of importance. Ordering them by
   * position size or by how much each "reacts" would be the ranking this
   * feature refuses — and the second of those is not something the product
   * measures at all.
   */
  affectedSymbols: string[];
  /** How many symbols matched before the cap. */
  total: number;
}

export interface OvEventRelevanceInput {
  /** Symbols the reader holds. Order is irrelevant; duplicates are fine. */
  portfolioSymbols?: readonly string[];
  /** Symbols the reader watches. Merged with the above — a symbol in both counts once. */
  watchlistSymbols?: readonly string[];
}

function normalize(symbols: OvEventRelevanceInput): string[] {
  const merged = [
    ...(symbols.portfolioSymbols ?? []),
    ...(symbols.watchlistSymbols ?? []),
  ]
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol.length > 0);
  return [...new Set(merged)].sort((left, right) => left.localeCompare(right));
}

/**
 * One event's relevance to one reader.
 *
 * A reader with no symbols gets an empty list and a total of zero, which is the
 * honest answer and which a card must render as "no holdings affected" rather
 * than hiding the event: the release still happens, and a signed-out visitor
 * looking at the calendar is entitled to see it.
 */
export function ovEventRelevance(
  event: OvMarketEvent,
  symbols: OvEventRelevanceInput,
): OvEventRelevance {
  const matched = OV_EVENT_SCOPE[event.code] === 'market-wide' ? normalize(symbols) : [];
  return {
    eventId: event.id,
    scope: OV_EVENT_SCOPE[event.code],
    affectedSymbols: matched.slice(0, OV_EVENT_SYMBOL_LIMIT),
    total: matched.length,
  };
}

/**
 * The same, for a window of events.
 *
 * The symbol list is normalized ONCE and reused across every event rather than
 * per event — with twelve months of jobless-claims rows that is forty passes
 * over the reader's holdings turned into one, and it also guarantees every row
 * names the same symbols in the same order.
 */
export function ovEventRelevanceFor(
  events: readonly OvMarketEvent[],
  symbols: OvEventRelevanceInput,
): Map<string, OvEventRelevance> {
  const matched = normalize(symbols);
  const capped = matched.slice(0, OV_EVENT_SYMBOL_LIMIT);
  return new Map(events.map((event) => {
    const marketWide = OV_EVENT_SCOPE[event.code] === 'market-wide';
    return [event.id, {
      eventId: event.id,
      scope: OV_EVENT_SCOPE[event.code],
      affectedSymbols: marketWide ? capped : [],
      total: marketWide ? matched.length : 0,
    }];
  }));
}
