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
 * ===========================================================================
 * THE CALENDAR IS A MONTH GRID IN BOTH ORDERS, NOT A LIST IN ONE
 * ===========================================================================
 * V2 used to fill that slot with `events` — the merged list. It is
 * `marketEvents` now, the month grid, on the owner's decision: a grid answers
 * "what does this month look like" at a glance, which is the question the
 * Overview is for, and a list answers "what exactly is coming and does it touch
 * me", which is the question `/market-events` is for. Two pages, two questions,
 * and the Overview gets the shape you can read without reading.
 *
 * What that gives up is the relevance join — `EventsList` marked the rows that
 * touched the reader's own symbols and the grid does not. It is one tap away on
 * the detail page, and it was not worth a list on the Overview.
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
 * kept. `marketEvents` is the month grid, and it is now in BOTH orders — V1
 * draws it last, V2 draws it after the watchlist. `events` is the merged list,
 * and it is in NEITHER: see `STRANDED_SECTION_KEYS` below.
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
 * ตลาดวันนี้ → พอร์ต → สิ่งที่เปลี่ยนไป → Watchlist → ปฏิทินเศรษฐกิจ → ข่าว, and the
 * same six on every screen width.
 *
 * `marketStatus` is gone from this order rather than moved: `marketToday`
 * publishes the same six instruments and the same regime, so keeping both would
 * be two readings of one market on one page. `upcoming` is gone because the
 * calendar slot answers the same question and the grid answers it faster.
 */
export const OVERVIEW_ORDER_V2: readonly OverviewSectionKey[] = [
  'marketToday',
  'portfolio',
  'whatChanged',
  'watchlist',
  'marketEvents',
  'news',
];

/**
 * KEYS NO ORDER WALKS — declared, so a new one cannot arrive unnoticed.
 *
 * `orderedOverviewSections` filters the order array, so a key in neither array
 * is dead: its flag can be on, its data built and its presence true, and the
 * page will still never emit it. That is the exact shape of the `PHASE2_EVENTS`
 * defect, and `section-order.test.ts` fails on any key that is stranded and not
 * named here — which is what makes an accidental strand loud and this one
 * deliberate.
 *
 * `events` is here because V2 draws the month grid instead of the merged list.
 * The key, `EventsList` and everything behind `PHASE2_EVENTS` still compile and
 * still pass their own tests; nothing on the Overview reaches them. **So
 * `PHASE2_EVENTS` is now a flag that changes no pixel in any combination**, and
 * the honest next step is to retire it rather than leave a switch on that does
 * nothing.
 */
export const STRANDED_SECTION_KEYS: readonly OverviewSectionKey[] = ['events'];

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
