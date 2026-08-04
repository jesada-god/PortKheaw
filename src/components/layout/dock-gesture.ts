/**
 * Geometry for the dock's press-and-drag selection, kept out of the component.
 *
 * All of it is arithmetic over rectangles: which destination a pointer is over,
 * and where a tooltip may sit without leaving the capsule. Separating it means
 * the hard cases — a release in the gap between two icons, a tooltip wider than
 * the capsule it must stay inside — are testable without a layout engine, which
 * jsdom does not have.
 */

/**
 * How long a press must be held before it becomes a selection gesture.
 *
 * The brief asks for 250–350ms and this sits in the middle. It is only ever a
 * ceiling on the *gesture*, never on a tap: nothing about a plain tap is
 * deferred until this elapses, because the component never calls
 * `preventDefault` on the press and lets the browser's own click reach the
 * link. A tap is exactly as fast as it was before this file existed.
 */
export const LONG_PRESS_MS = 300;

/**
 * How far a pointer may drift while the timer runs and still count as a press.
 *
 * Past this the movement is a scroll or a swipe, not a hold, so the pending
 * gesture is abandoned and the press reverts to an ordinary tap.
 */
export const MOVE_SLOP = 10;

/**
 * How far outside the capsule a drag may stray and still resolve to an icon.
 *
 * A finger tracking along a 62px-tall capsule wanders; without any tolerance the
 * selection would flicker off at the edges. Beyond it the pointer has genuinely
 * left the dock and releasing there must cancel.
 */
export const RELEASE_SLACK = 24;

/** Gap kept between the tooltip and the capsule's ends. */
export const TOOLTIP_MARGIN = 8;

/** The parts of a DOMRect this module reads. */
export interface DockRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
}

/** Snapshot of the capsule and its slots, measured once when a gesture starts. */
export interface DockGeometry {
  readonly dock: DockRect;
  readonly slots: readonly DockRect[];
}

/** Whether a pointer has stayed close enough to its origin to still be a hold. */
export function isWithinSlop(dx: number, dy: number, slop: number = MOVE_SLOP): boolean {
  return Math.abs(dx) <= slop && Math.abs(dy) <= slop;
}

/**
 * The destination a point selects, or `null` when the point is off the dock.
 *
 * Inside the capsule the nearest slot centre wins rather than a strict
 * containment test, so the gaps between icons belong to whichever neighbour is
 * closer instead of blanking the selection as a finger crosses them.
 */
export function resolveSlotIndex(
  x: number,
  y: number,
  geometry: DockGeometry,
  slack: number = RELEASE_SLACK,
): number | null {
  const { dock, slots } = geometry;
  if (slots.length === 0) return null;
  if (x < dock.left - slack || x > dock.right + slack) return null;
  if (y < dock.top - slack || y > dock.bottom + slack) return null;

  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const distance = Math.abs(x - (slot.left + slot.width / 2));
    if (distance < best) {
      best = distance;
      nearest = index;
    }
  }
  return nearest;
}

/**
 * Where to centre the tooltip, in coordinates local to the capsule.
 *
 * `center` is the slot the tooltip names; the return value is that centre pulled
 * far enough inward that a tooltip of `tipWidth` stays inside `trackWidth`. The
 * capsule is itself centred and never touches the viewport edges, so a tooltip
 * kept inside it is a tooltip that cannot overflow the screen.
 *
 * A width of `0` means the element has not been measured yet — the centre is
 * returned untouched rather than clamped against a meaningless bound. A tooltip
 * too wide to fit at all is centred, which is the least-bad placement and the
 * only one that keeps both ends on screen.
 */
export function clampTooltipCenter(
  center: number,
  tipWidth: number,
  trackWidth: number,
  margin: number = TOOLTIP_MARGIN,
): number {
  if (tipWidth <= 0 || trackWidth <= 0) return center;
  const half = tipWidth / 2;
  const min = margin + half;
  const max = trackWidth - margin - half;
  if (min > max) return trackWidth / 2;
  return Math.min(Math.max(center, min), max);
}
