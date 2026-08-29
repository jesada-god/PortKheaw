/**
 * The five rows the Overview shows, and WHY those five.
 *
 * ===========================================================================
 * THE ORDER IS STATED, NOT DISCOVERED
 * ===========================================================================
 * A preview has to leave symbols out, so something chooses. The rule this
 * product refuses is "the most interesting five" — an ordering nobody can
 * predict before they see it, reproduce afterwards, or argue with. It is the
 * same objection that keeps a confidence percentage off the trend column: a
 * ranking implies a basis, and an unexplainable basis is worse than no ranking.
 *
 * So there are exactly two rules and both are printable in a sentence:
 *
 *   1. WHAT THE READER PINNED, oldest pin first.
 *   2. THEN EVERYTHING ELSE, oldest in the list first.
 *
 * with `symbol` breaking every tie so the order is TOTAL. Two renders of the
 * same list produce the same five rows in the same order, on any device, for
 * any reader — which is the property "deterministic" actually has to mean if
 * somebody is going to trust the card.
 *
 * "Oldest first" and not newest: a preview that reshuffled every time somebody
 * added a symbol would never be the same card twice, and the row a reader has
 * watched for a year is not less theirs than the one they added this morning.
 *
 * ===========================================================================
 * WHY THIS IS NOT THE PAGE'S ORDER
 * ===========================================================================
 * The watchlist page's own mobile list sorts by trend prominence — see
 * `sortRowsByTrend` — and that is a DIFFERENT question deliberately answered
 * differently. On the page a reader has arrived to look at their symbols and
 * every one of them is reachable by scrolling, so leading with the ones that
 * are moving costs nothing. On the Overview the cut is real: rows six and
 * beyond do not exist on that card, so an order that moved with the market
 * would silently change WHICH symbols a reader is aware of, day to day, without
 * their having chosen any of it. Pinning is how they choose.
 *
 * ===========================================================================
 * FIVE IS A LIMIT, NOT A LAYOUT
 * ===========================================================================
 * `OVERVIEW_PREVIEW_LIMIT` is applied here, on the data, before anything is
 * rendered. A wide screen shows the same five as a phone. The alternative —
 * rendering everything and hiding the tail in CSS — puts every symbol a reader
 * watches into the HTML of a page that is not the watchlist, and makes "how
 * many are shown" a property of the viewport rather than of the product.
 */

/** How many rows the Overview preview shows. A cap on the data, on every screen. */
export const OVERVIEW_PREVIEW_LIMIT = 5;

/** The minimum a row needs for the preview to place it. */
export interface PreviewCandidate {
  symbol: string;
  /** ISO instant the symbol was added to the list. */
  createdAt: string;
  /** Whether the reader chose this row for the preview. */
  pinned: boolean;
}

/**
 * Compare two candidates by the stated rule. Exported so the ordering can be
 * asserted directly rather than only through its output.
 */
export function comparePreviewCandidates(left: PreviewCandidate, right: PreviewCandidate): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  return left.createdAt.localeCompare(right.createdAt)
    || left.symbol.localeCompare(right.symbol);
}

/**
 * The preview rows, in order, cut to {@link OVERVIEW_PREVIEW_LIMIT}.
 *
 * Sorts a copy; the caller's array is never mutated. Generic over the row so
 * this can order whatever the Overview happens to be carrying — it needs three
 * fields and reads nothing else, and in particular reads NOTHING about price or
 * trend, which is what keeps the order independent of the market.
 */
export function overviewPreview<T extends PreviewCandidate>(rows: readonly T[]): T[] {
  return [...rows].sort(comparePreviewCandidates).slice(0, OVERVIEW_PREVIEW_LIMIT);
}

/**
 * Whether the "ดูทั้งหมด" link has anything more to show.
 *
 * The link is always rendered — it is how a reader reaches the page — but a
 * card that says there is more when there is not is a small lie that a reader
 * catches immediately, so the count is passed rather than assumed.
 */
export function previewHasMore(total: number): boolean {
  return total > OVERVIEW_PREVIEW_LIMIT;
}

/**
 * Which list the Overview draws from.
 *
 * Mirrors `public.get_or_create_default_watchlist` exactly: the chosen list if
 * it is chosen and still present, otherwise the oldest. The two have to agree —
 * the page and the Overview showing different lists as "yours" is the kind of
 * disagreement nobody reports as a bug because each screen looks correct on its
 * own — so the tie-break here is `createdAt` then `id`, the same one the
 * function's `order by created_at, id` uses.
 *
 * Returns null only for an account with no lists at all, which the database
 * function will not leave a signed-in reader in.
 */
export function resolveOverviewWatchlist<T extends { id: string; createdAt: string }>(
  lists: readonly T[],
  chosenId: string | null,
): T | null {
  if (lists.length === 0) return null;
  const chosen = chosenId === null ? undefined : lists.find((list) => list.id === chosenId);
  if (chosen) return chosen;
  return [...lists].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0]!;
}
