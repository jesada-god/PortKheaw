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
export type OverviewSectionKey =
  | 'marketStatus'
  | 'portfolio'
  | 'watchlist'
  | 'whatChanged'
  | 'marketEvents'
  | 'upcoming'
  | 'news';

/** The page as it shipped. `marketEvents` is new, so it goes last here. */
export const OVERVIEW_ORDER_V1: readonly OverviewSectionKey[] = [
  'marketStatus',
  'portfolio',
  'watchlist',
  'whatChanged',
  'upcoming',
  'news',
  'marketEvents',
];

/** The requested order, behind `OVERVIEW_V2`. */
export const OVERVIEW_ORDER_V2: readonly OverviewSectionKey[] = [
  'marketStatus',
  'portfolio',
  'whatChanged',
  'watchlist',
  'marketEvents',
  'upcoming',
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
