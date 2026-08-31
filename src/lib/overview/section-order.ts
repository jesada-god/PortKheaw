/**
 * THE READING ORDER OF THE OVERVIEW, AS DATA.
 *
 * ===========================================================================
 * WHY THIS IS A LIST AND NOT A SEQUENCE OF JSX
 * ===========================================================================
 * The page has seven sections and each one can be absent — behind a flag, or
 * because it has nothing to say today. Written as JSX that is seven
 * conditionals in a row, and the failure mode is silent: a section that renders
 * `null` inside a wrapper leaves the wrapper's margin behind, so the page grows
 * a gap where a card used to be, and the gap looks like a loading state that
 * never resolves.
 *
 * Ordering the KEYS first and rendering only the ones that survive means an
 * absent section occupies nothing at all — there is no wrapper to leave behind.
 * It also makes the order a value that can be tested over all 128 subsets,
 * which is the only way to know the sequence still holds when a card
 * disappears from the middle rather than from the end.
 *
 * ===========================================================================
 * THE TWO ORDERS
 * ===========================================================================
 * V1 is the page exactly as it shipped. V2 is the requested reading order:
 * Market Status, then what changed, then the watchlist, then the calendar, then
 * the news.
 *
 * What moves between them is small and deliberate. "สิ่งที่เปลี่ยนไป" comes up
 * above the watchlist rows it is derived from — it is the summary, and a
 * summary under its own detail is a footnote. The calendar slots in after the
 * watchlist, where a reader who has just looked at what they own asks what is
 * coming.
 *
 * What does NOT move: the market block still leads, and the portfolio line is
 * still second. Both were argued for in `DashboardClient.tsx` and neither
 * argument is weakened by anything here — a reader is still here for their own
 * money before anybody else's, and everything below the market is still read
 * against it.
 */
/*
 * ===========================================================================
 * WHY `marketToday` EXISTS, AND WHY IT IS IN V1 TOO
 * ===========================================================================
 * "ตลาดวันนี้" used to be a fixed `<section>` rendered ABOVE this list, which
 * meant the one block the page opens with was the one block the ordering flag
 * could not move. Anything that had to go above it, or below it, could not.
 *
 * It is a key now. V1 lists it FIRST, which is exactly where the fixed section
 * used to draw, so the shipped page is unchanged — the flag still has to be the
 * rollback, and a rollback that reorders the top of the page is not one.
 *
 * `events` and `marketEvents` are two different sections and both keys are
 * kept. `marketEvents` is the month grid V1 draws at the bottom; `events` is
 * the merged list V2 draws instead, which carries the macro calendar AND
 * everything `upcoming` used to carry. Neither appears in the other's order.
 */
export type OverviewSectionKey =
  | 'marketToday'
  | 'marketStatus'
  | 'portfolio'
  | 'watchlist'
  | 'whatChanged'
  | 'marketEvents'
  | 'events'
  | 'upcoming'
  | 'news';

/**
 * The page as it shipped.
 *
 * `marketToday` leads because the fixed section it replaces led. `marketStatus`
 * still follows it, `marketEvents` is still last, and `events` — the merged
 * list — is absent entirely: V1 keeps the separate Upcoming card and month grid
 * it always had.
 */
export const OVERVIEW_ORDER_V1: readonly OverviewSectionKey[] = [
  'marketToday',
  'marketStatus',
  'portfolio',
  'watchlist',
  'whatChanged',
  'upcoming',
  'news',
  'marketEvents',
];

/**
 * The requested order, behind `OVERVIEW_V2`.
 *
 * ตลาดวันนี้ → พอร์ต → สิ่งที่เปลี่ยนไป → Watchlist → Events → ข่าว, and the same
 * six on every screen width.
 *
 * `marketStatus` is gone from this order rather than moved: `marketToday`
 * publishes the same six instruments and the same regime, so keeping both would
 * be two readings of one market on one page. `upcoming` is gone for the same
 * reason — `events` carries its rows.
 */
export const OVERVIEW_ORDER_V2: readonly OverviewSectionKey[] = [
  'marketToday',
  'portfolio',
  'whatChanged',
  'watchlist',
  'events',
  'news',
];

export type OverviewSectionPresence = Readonly<Record<OverviewSectionKey, boolean>>;

/**
 * The sections to render, in order, with the absent ones gone entirely.
 *
 * Filtering rather than mapping-to-null is the whole point: the caller receives
 * only keys it will actually draw, so it cannot emit an empty wrapper for one
 * it will not.
 */
export function orderedOverviewSections(
  present: OverviewSectionPresence,
  useV2: boolean,
): OverviewSectionKey[] {
  return (useV2 ? OVERVIEW_ORDER_V2 : OVERVIEW_ORDER_V1).filter((key) => present[key]);
}
