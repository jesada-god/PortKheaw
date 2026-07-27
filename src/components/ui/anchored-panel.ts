/**
 * Viewport-aware placement for panels anchored to a trigger.
 *
 * Both chart popups (the timeframe picker and the toolbar menus) are rendered in
 * a portal at `document.body` and positioned with `position: fixed`, because the
 * chart section is an `overflow-hidden` card: a panel positioned inside it is
 * clipped at the card's edge, and one wide enough to escape widens the page.
 *
 * The rules here are pure arithmetic so they can be unit-tested without a
 * layout engine:
 *  - the panel never leaves the viewport on any edge;
 *  - it flips above the trigger only when there is genuinely more room there;
 *  - its height is capped by the room that actually exists, so the *panel* is
 *    always the scroll container instead of the page.
 */

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface AnchoredPanelPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export interface AnchoredPanelInput {
  rect: AnchorRect;
  viewportWidth: number;
  viewportHeight: number;
  /** Preferred panel width; shrunk when the viewport is narrower. */
  width: number;
  /** Upper bound on the panel height, before the available room is applied. */
  preferredMaxHeight: number;
  /** Smallest height worth opening at; the viewport still wins over it. */
  minHeight?: number;
  /** Which edge of the trigger the panel lines up with when there is room. */
  align?: 'start' | 'end';
  /** Gap between trigger, panel and viewport edges. */
  gap?: number;
}

export const ANCHORED_PANEL_GAP = 8;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

export function resolveAnchoredPanel({
  rect,
  viewportWidth,
  viewportHeight,
  width,
  preferredMaxHeight,
  minHeight = 200,
  align = 'start',
  gap = ANCHORED_PANEL_GAP,
}: AnchoredPanelInput): AnchoredPanelPlacement {
  const room = Math.max(0, viewportHeight - gap * 2);
  const below = viewportHeight - rect.bottom - gap * 2;
  const above = rect.top - gap * 2;
  // Flip only when below is genuinely cramped and above is roomier.
  const flip = below < Math.min(minHeight + 60, preferredMaxHeight) && above > below;
  const available = Math.max(0, flip ? above : below);
  // Never taller than the viewport: a panel that would be clipped by the window
  // is capped instead, and scrolls internally.
  const maxHeight = Math.min(room, Math.max(minHeight, Math.min(preferredMaxHeight, available)));

  const panelWidth = Math.min(width, Math.max(0, viewportWidth - gap * 2));
  const preferredLeft = align === 'end' ? rect.right - panelWidth : rect.left;
  const left = clamp(preferredLeft, gap, viewportWidth - panelWidth - gap);

  const rawTop = flip ? rect.top - gap - maxHeight : rect.bottom + gap;
  const top = clamp(rawTop, gap, viewportHeight - maxHeight - gap);

  return { top, left, width: panelWidth, maxHeight };
}
