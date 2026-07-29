/**
 * Collision layout for in-pane chart labels.
 *
 * Levels that sit a few cents apart land on the same pixel row, so their labels
 * would print on top of each other. The fix is *presentational only*: the line
 * keeps the coordinate its real price maps to (`anchorY`) and only the label
 * text is nudged along the column (`y`). Nothing here may ever be fed back into
 * a price — a label that moved is still labelling the price it came from.
 *
 * The pass is a two-sweep spread: push down from the top so no neighbour is
 * closer than one label height, then pull back up from the bottom so the column
 * stays inside the pane. Pure and coordinate-space agnostic (callers pass device
 * pixels), so it is unit-testable without a canvas.
 */

export interface LabelAnchor {
  id: string;
  /** Coordinate the label's price maps to, in the caller's pixel space. */
  y: number;
}

export interface LabelPlacement extends LabelAnchor {
  /** Position in the input array, so callers zip placements back onto their items. */
  index: number;
  /** The unmoved coordinate of the price. Lines must be drawn here. */
  anchorY: number;
}

export interface LabelColumnOptions {
  /** Height of the drawable pane. */
  height: number;
  /** Vertical space one label occupies, including its breathing room. */
  labelHeight: number;
}

/**
 * Place a column of labels so that none overlaps, dropping the ones whose price
 * is outside the pane. Input order is preserved in the result; the caller zips
 * the placements back onto its own items by index.
 */
export function layoutLabelColumn(
  anchors: readonly LabelAnchor[],
  options: LabelColumnOptions,
): LabelPlacement[] {
  const { height, labelHeight } = options;
  const visible = anchors
    .map((anchor, index) => ({ anchor, index }))
    .filter(({ anchor }) => Number.isFinite(anchor.y) && anchor.y >= 0 && anchor.y <= height);
  if (!visible.length) return [];

  const minimum = labelHeight / 2;
  const maximum = Math.max(minimum, height - labelHeight / 2);
  // Ties keep input order, so a stable set of levels never reshuffles between frames.
  const ordered = [...visible].sort((left, right) => (
    left.anchor.y === right.anchor.y ? left.index - right.index : left.anchor.y - right.anchor.y
  ));

  const placed = ordered.map(({ anchor }) => Math.min(Math.max(anchor.y, minimum), maximum));
  for (let index = 1; index < placed.length; index += 1) {
    placed[index] = Math.max(placed[index], placed[index - 1] + labelHeight);
  }
  for (let index = placed.length - 1; index >= 0; index -= 1) {
    const ceiling = index === placed.length - 1 ? maximum : placed[index + 1] - labelHeight;
    placed[index] = Math.min(placed[index], ceiling);
  }

  const byIndex = new Map<number, LabelPlacement>();
  ordered.forEach(({ anchor, index }, slot) => {
    byIndex.set(index, { id: anchor.id, index, y: placed[slot], anchorY: anchor.y });
  });
  return visible.flatMap(({ index }) => {
    const placement = byIndex.get(index);
    return placement ? [placement] : [];
  });
}
