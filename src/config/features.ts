export function featureFlagEnabled(value: string | undefined, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === 'true';
}

export function technicalIndicatorsEnabled() {
  return featureFlagEnabled(process.env.FEATURE_TECHNICAL_INDICATORS);
}

export function advancedChartTypesEnabled() {
  return featureFlagEnabled(process.env.FEATURE_ADVANCED_CHART_TYPES);
}

export function extendedIndicatorsEnabled() {
  return featureFlagEnabled(process.env.FEATURE_EXTENDED_INDICATORS);
}

export function supportResistanceEnabled() {
  return featureFlagEnabled(process.env.FEATURE_SUPPORT_RESISTANCE);
}

/**
 * The Market Status card on the overview.
 *
 * DEFAULT OFF, and `featureFlagEnabled` is called without a default on purpose:
 * an unset variable is OFF. The card can be merged and deployed at any point and
 * a reader sees the overview exactly as it was, because nothing new is reachable
 * until an owner sets the variable — releasing stays a separate, human act from
 * shipping. Never default it to true, and never delete it once released: the
 * flag IS the rollback.
 */
export function marketStatusCardEnabled() {
  return featureFlagEnabled(process.env.MARKET_STATUS_CARD);
}

/**
 * The rebuilt watchlist — the trend column, the expandable row, and the
 * Overview preview that reads from a chosen list.
 *
 * DEFAULT OFF, and `featureFlagEnabled` is called without a default for the
 * same reason `marketStatusCardEnabled` is: an unset variable is OFF, so this
 * can be merged and deployed at any point and a reader sees the watchlist
 * exactly as it was. Releasing stays a separate, human act from shipping.
 *
 * The flag covers the READING surfaces only. The multiple-watchlist tables and
 * the RPCs behind them are NOT gated — a schema that exists conditionally is a
 * schema nobody can reason about, and the migration backfills every existing
 * reader a list either way. What the flag decides is whether anybody is shown
 * a way to make a second one.
 */
export function watchlistV2Enabled() {
  return featureFlagEnabled(process.env.WATCHLIST_V2);
}

/**
 * The "มีอะไรเปลี่ยน" section on the watchlist.
 *
 * DEFAULT OFF, for the third time and for the same reason `marketStatusCardEnabled`
 * and `watchlistV2Enabled` give: an unset variable is OFF, so the detectors can
 * be merged and deployed while a reader sees the watchlist exactly as it was.
 * Releasing stays a separate, human act from shipping, and the flag is the
 * rollback.
 *
 * It gates the COST as well as the pixels. The section reads daily bars for
 * every symbol that has a signal, and that load lives behind this check in
 * `loadWatchlistView` — so a reader with the card off does not pay for history
 * nothing is going to render.
 */
export function whatChangedCardEnabled() {
  return featureFlagEnabled(process.env.WHAT_CHANGED_CARD);
}

/**
 * The macro events calendar — the month grid on the overview and the feed at
 * `/market-events`.
 *
 * DEFAULT OFF, for the reason the three flags above give: an unset variable is
 * OFF, so this ships without changing what a reader sees, and releasing stays a
 * separate human act. It gates BOTH surfaces from one switch on purpose — a
 * card that links to a page the flag has turned off is a dead end, and two
 * flags is two ways to build one.
 *
 * It costs no provider call either way. The calendar is a static JSON file in
 * the bundle, so the flag is deciding pixels and a route, not spend.
 */
export function marketEventsCardEnabled() {
  return featureFlagEnabled(process.env.MARKET_EVENTS_CARD);
}

/**
 * The scope filter over the overview news feed — ทั้งหมด / พอร์ต / Watchlist / ตลาด.
 *
 * DEFAULT OFF. With it off the feed is the market-wide one that shipped, byte
 * for byte; with it on the same page asks for the reader's own symbols instead,
 * which is a different request to the SAME endpoint rather than an additional
 * one.
 */
export function newsFilterEnabled() {
  return featureFlagEnabled(process.env.NEWS_FILTER);
}

/**
 * The overview's reading order.
 *
 * DEFAULT OFF, and it reorders sections that already exist — it adds no card,
 * loads nothing new, and every section it moves is one the page was already
 * rendering. The flag is the rollback for a judgement about sequence, which is
 * exactly the kind of change that wants one: nothing about it fails loudly, so
 * turning it off has to be as cheap as turning it on.
 */
export function overviewV2Enabled() {
  return featureFlagEnabled(process.env.OVERVIEW_V2);
}

export function keyStatisticsEnabled() { return featureFlagEnabled(process.env.FEATURE_KEY_STATISTICS); }
export function optionsStatisticsEnabled() { return featureFlagEnabled(process.env.FEATURE_OPTIONS_STATISTICS); }
export function analystConsensusEnabled() {
  return featureFlagEnabled(process.env.FEATURE_ANALYST_CONSENSUS, true);
}

/**
 * THE PHASE 2 FOUNDATION FLAGS — four surfaces, four switches, all default OFF.
 *
 * Same contract as the six above, and `featureFlagEnabled` is called without a
 * default for the same reason: an unset variable is OFF, so every module under
 * `src/lib/market-overview` can be merged and deployed while a reader sees the
 * product exactly as it was. Releasing stays a separate, human act from
 * shipping, and turning one off again IS the rollback.
 *
 * One flag per surface rather than a single `PHASE2` switch, because the four
 * cost different things and would be released on different days. Only the first
 * of them buys anything at all.
 */

/**
 * The six-instrument market snapshot, the status word and the regime reasons.
 *
 * THE ONLY ONE OF THE FOUR THAT SPENDS. On, it reads six quotes — the same six
 * `MARKET_STATUS_CARD` reads, through the same endpoint, but behind a shared
 * sixty-second cache and a last-good snapshot, so a burst of readers costs one
 * round rather than one round each. Read before any promise is constructed in
 * all three entry points of `src/lib/market-overview/indices.ts`.
 */
export function phase2MarketSnapshotEnabled() {
  return featureFlagEnabled(process.env.PHASE2_MARKET_SNAPSHOT);
}

/**
 * The Phase 2 change feed.
 *
 * Costs NOTHING new. It renames items the watchlist detectors already produced
 * behind `WHAT_CHANGED_CARD` — a pure mapping with a dedupe, no request, no
 * clock, no history read. This flag decides whether the renamed feed is shown,
 * never whether the detectors run.
 */
export function phase2WhatChangedEnabled() {
  return featureFlagEnabled(process.env.PHASE2_WHAT_CHANGED);
}

/**
 * The twelve-month macro calendar and its relevance join.
 *
 * Costs NOTHING. The calendar is a static JSON file already in the bundle and
 * the symbol join is one array pass over lists the page already holds, so this
 * is a render switch rather than a spending one.
 */
export function phase2EventsEnabled() {
  return featureFlagEnabled(process.env.PHASE2_EVENTS);
}

/**
 * Read-time alert rules.
 *
 * Costs one indexed row read per render when on, and nothing when off. It never
 * schedules, never writes and never notifies — the scheduled system behind
 * `/api/cron/alerts` is separate and is not affected by this flag in either
 * position.
 */
export function phase2AlertsEnabled() {
  return featureFlagEnabled(process.env.PHASE2_ALERTS);
}
