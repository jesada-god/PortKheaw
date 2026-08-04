'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from 'motion/react';
import { isNavItemActive, primaryNavItems, type PrimaryNavItem } from '@/src/config/navigation';
import { useMediaQuery } from '@/src/hooks/useMediaQuery';
import { useReducedMotion } from '@/src/hooks/useReducedMotion';
import {
  clampTooltipCenter,
  isWithinSlop,
  resolveSlotIndex,
  LONG_PRESS_MS,
  type DockGeometry,
} from './dock-gesture';

/** Resting icon size on a pointer device, in px. Mirrors `.dock__bubble` at lg. */
const BASE_SIZE = 48;
/** Size the icon under the cursor grows to. */
const MAX_SIZE = 60;
/** How far either side of an icon the cursor still lifts it, in px. */
const REACH = 110;
/** Cursor position that means "not over the dock": every icon rests at BASE_SIZE. */
const POINTER_AWAY = Number.POSITIVE_INFINITY;

/**
 * Magnification is a pointer affordance, so it is gated on a real pointer — not
 * on width alone. A touch screen at 1024px reports `hover: none`, and letting it
 * through is how a dock ends up with an item stuck at its hover size after a tap.
 */
const MAGNIFY_QUERY = '(min-width: 1024px) and (hover: hover) and (pointer: fine)';

/** A press being tracked. Lives in a ref: none of it belongs in a render. */
interface PressState {
  pointerId: number;
  startX: number;
  startY: number;
  timer: number;
  /** True once the hold has become a selection gesture. */
  engaged: boolean;
  geometry: DockGeometry | null;
  /** Removes the window-level safety net this press installed. */
  detach: () => void;
}

function DockItem({
  item,
  active,
  pointerX,
  magnify,
}: {
  item: PrimaryNavItem;
  active: boolean;
  pointerX: MotionValue<number>;
  magnify: boolean;
}) {
  const bubble = useRef<HTMLSpanElement>(null);
  const Icon = item.icon;

  /*
   * The whole magnification runs on motion values, which write to the DOM
   * outside React: a mousemove never sets state, so moving across the dock costs
   * no renders. Distance is measured from the live element bounds rather than a
   * cached layout, so it stays correct after a resize or a scroll.
   */
  const distance = useTransform(pointerX, (x) => {
    const bounds = bubble.current?.getBoundingClientRect();
    if (!bounds) return POINTER_AWAY;
    return x - (bounds.left + bounds.width / 2);
  });
  const target = useTransform(distance, [-REACH, 0, REACH], [BASE_SIZE, MAX_SIZE, BASE_SIZE], {
    clamp: true,
  });
  const size = useSpring(target, { stiffness: 280, damping: 28, mass: 0.3 });

  return (
    <Link
      href={item.href}
      aria-label={item.name}
      aria-current={active ? 'page' : undefined}
      className="dock__item"
      data-active={active ? 'true' : undefined}
      /*
       * A mouse press-and-drag across the dock is one of this component's two
       * input paths, and on an <a> the browser answers that gesture by starting
       * a native link drag — which swallows every pointermove that follows.
       */
      draggable={false}
    >
      <span className="dock__glow" aria-hidden="true" />
      {/*
        `motion.span` in both branches so switching to a pointer device after
        hydration re-styles this node instead of remounting it. With
        magnification off the element carries no inline size and the stylesheet
        owns it, which is also what the server renders.
      */}
      <motion.span
        ref={bubble}
        className="dock__bubble"
        style={magnify ? { width: size, height: size } : undefined}
      >
        <Icon aria-hidden="true" strokeWidth={active ? 2.4 : 2} />
      </motion.span>
      {/* Never painted, at any width: the dock shows icons only, and a name that
          appeared under the current one made that slot a different size from its
          four neighbours. Clipped rather than removed so it stays the link's
          accessible name alongside `aria-label`. */}
      <span className="dock__label">{item.name}</span>
      <span className="dock__tip" aria-hidden="true">{item.name}</span>
    </Link>
  );
}

export default function FloatingDock() {
  const pathname = usePathname();
  const router = useRouter();
  const pointerX = useMotionValue(POINTER_AWAY);
  const pointerDevice = useMediaQuery(MAGNIFY_QUERY);
  const reducedMotion = useReducedMotion();
  const magnify = pointerDevice && !reducedMotion;

  const dockRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const press = useRef<PressState | null>(null);
  /*
   * A press that became a gesture has already navigated by the time the browser
   * gets round to synthesising its click. Without this the release would count
   * twice: once from `router.push` and once from the link the finger let go on.
   */
  const swallowClick = useRef(false);

  /** Which destination the drag is currently over. `null` when no gesture runs. */
  const [pressedIndex, setPressedIndex] = useState<number | null>(null);

  const measure = useCallback((): DockGeometry | null => {
    const dock = dockRef.current;
    if (!dock) return null;
    const slots = Array.from(dock.querySelectorAll<HTMLElement>('[data-dock-slot]'));
    if (slots.length === 0) return null;
    return {
      dock: dock.getBoundingClientRect(),
      slots: slots.map((slot) => slot.getBoundingClientRect()),
    };
  }, []);

  /**
   * Ends the gesture and leaves nothing behind — no timer, no capture, no
   * highlight. `press` is cleared first so the `lostpointercapture` that
   * releasing triggers finds no gesture to end a second time.
   */
  const endPress = useCallback(() => {
    const current = press.current;
    if (!current) return;
    press.current = null;
    window.clearTimeout(current.timer);
    current.detach();
    setPressedIndex(null);
    if (current.engaged) {
      const dock = dockRef.current;
      try {
        if (dock?.hasPointerCapture(current.pointerId)) dock.releasePointerCapture(current.pointerId);
      } catch {
        /* The pointer is already gone; there is nothing left to release. */
      }
    }
  }, []);

  /* A gesture must not outlive the component — an unmount mid-press would
     otherwise leave a timer holding a reference to dead state. */
  useEffect(() => endPress, [endPress]);

  /*
   * The tooltip is placed imperatively rather than through state so a drag costs
   * one render per icon crossed instead of one per pointermove. It runs before
   * paint, and it measures the tooltip it is about to move, so the clamp works
   * on the width the reader will actually see.
   */
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const geometry = press.current?.geometry;
    if (!tip || pressedIndex === null || !geometry) return;
    const slot = geometry.slots[pressedIndex];
    if (!slot) return;
    const center = slot.left + slot.width / 2 - geometry.dock.left;
    tip.style.left = `${clampTooltipCenter(center, tip.offsetWidth, geometry.dock.width)}px`;
  }, [pressedIndex]);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    // A right or middle press opens a menu or a new tab. Neither is ours.
    if (event.button > 0) return;
    swallowClick.current = false;
    endPress();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    /*
     * Nothing here defers the tap. The press is not captured and its default is
     * not prevented, so the browser's own click on the link fires at the moment
     * it always did; this timer only decides whether a *hold* additionally
     * becomes a selection gesture.
     */
    const timer = window.setTimeout(() => {
      const current = press.current;
      if (!current || current.pointerId !== pointerId) return;
      const geometry = measure();
      const index = geometry ? resolveSlotIndex(startX, startY, geometry) : null;
      if (geometry === null || index === null) {
        endPress();
        return;
      }
      current.engaged = true;
      current.geometry = geometry;
      try {
        dockRef.current?.setPointerCapture(pointerId);
      } catch {
        /* Capture is an optimisation for tracking outside the capsule; the
           gesture still works from the events that reach us without it. */
      }
      setPressedIndex(index);
    }, LONG_PRESS_MS);

    /*
     * The safety net, and only ever a net: it cancels, it never navigates.
     *
     * A touch pointer is implicitly captured by the element it went down on, so
     * every move and the release come back here on their own. A mouse is not.
     * Press on the capsule, drag away and let go somewhere else and this
     * component would otherwise hear nothing more — leaving a live timer that
     * goes on to open a selection nobody is still touching. These listeners are
     * attached for the life of one press and removed with it.
     *
     * They sit on `window`, above the React root, so the handlers on the capsule
     * have always run by the time they fire; on a release the dock has dealt
     * with itself already and there is no press left for this to find.
     */
    const abort = (event: Event) => {
      const current = press.current;
      const moved = event as PointerEvent;
      if (!current || current.pointerId !== moved.pointerId) return;
      if (event.type === 'pointermove') {
        if (current.engaged) return;
        if (isWithinSlop(moved.clientX - current.startX, moved.clientY - current.startY)) return;
      }
      endPress();
    };
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
      window.addEventListener(type, abort);
    }
    const detach = () => {
      for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
        window.removeEventListener(type, abort);
      }
    };

    press.current = { pointerId, startX, startY, timer, engaged: false, geometry: null, detach };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const current = press.current;
    if (!current || current.pointerId !== event.pointerId) return;

    if (!current.engaged) {
      /* Still inside the hold window. Drift this large is a scroll or a swipe,
         so the pending gesture is dropped and the press stays a plain tap. */
      if (!isWithinSlop(event.clientX - current.startX, event.clientY - current.startY)) endPress();
      return;
    }

    if (!current.geometry) return;
    setPressedIndex(resolveSlotIndex(event.clientX, event.clientY, current.geometry));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const current = press.current;
    if (!current || current.pointerId !== event.pointerId) return;

    // Never engaged: this was a tap, and the link's own click is on its way.
    if (!current.engaged || !current.geometry) {
      endPress();
      return;
    }

    const index = resolveSlotIndex(event.clientX, event.clientY, current.geometry);
    swallowClick.current = true;
    endPress();
    // Released off the dock — the reader backed out, so nothing happens.
    if (index === null) return;
    router.push(primaryNavItems[index].href);
  };

  /* Scrolling, a system gesture, or the pointer being taken away. All of them
     abandon the selection rather than acting on wherever it happened to be. */
  const onPointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    const current = press.current;
    if (!current || current.pointerId !== event.pointerId) return;
    endPress();
  };

  const onClickCapture = (event: React.MouseEvent<HTMLElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    /*
     * `detail === 0` is a keyboard activation, which never follows a drag and
     * must always be allowed through — Enter on a focused link is the only way
     * some readers use this menu at all.
     */
    if (event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <nav
      ref={dockRef}
      aria-label="เมนูหลัก"
      className="dock"
      data-pressing={pressedIndex === null ? undefined : 'true'}
      onMouseMove={magnify ? (event) => pointerX.set(event.clientX) : undefined}
      onMouseLeave={magnify ? () => pointerX.set(POINTER_AWAY) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
      onClickCapture={onClickCapture}
      /* A held press is a menu gesture here, not a request for the platform's
         context menu — but only once it has been recognised as one. */
      onContextMenu={(event) => { if (press.current?.engaged) event.preventDefault(); }}
    >
      <ul className="dock__list">
        {primaryNavItems.map((item, index) => {
          const active = isNavItemActive(pathname, item.href);
          return (
            /*
             * Every slot is the same width, active or not. `data-active` marks
             * the current destination and `data-pressed` the one a drag is over;
             * both are colour, and neither resizes anything, so crossing the dock
             * cannot shuffle the icons under the reader's finger.
             */
            <li
              key={item.href}
              className="dock__slot"
              data-dock-slot=""
              data-active={active ? 'true' : undefined}
              data-pressed={pressedIndex === index ? 'true' : undefined}
            >
              <DockItem item={item} active={active} pointerX={pointerX} magnify={magnify} />
            </li>
          );
        })}
      </ul>
      {/*
        One tooltip for the whole capsule, positioned per slot, rather than five
        that each have to solve the screen edge on their own. It sits above the
        dock and takes no pointer events, so it can never cover the icon it names
        or intercept the release that chooses it.
      */}
      {pressedIndex !== null && (
        <span ref={tipRef} className="dock__drag-tip" aria-hidden="true">
          {primaryNavItems[pressedIndex].name}
        </span>
      )}
    </nav>
  );
}
