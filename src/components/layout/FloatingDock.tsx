'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef } from 'react';
import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from 'motion/react';
import { isNavItemActive, primaryNavItems, type PrimaryNavItem } from '@/src/config/navigation';
import { useMediaQuery } from '@/src/hooks/useMediaQuery';
import { useReducedMotion } from '@/src/hooks/useReducedMotion';

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
      aria-current={active ? 'page' : undefined}
      className="dock__item"
      data-active={active ? 'true' : undefined}
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
      {/* Visible under the icon on handsets; clipped to screen readers from lg,
          where the tooltip carries the name visually. Either way it is the
          link's accessible name, so the tooltip is never the only source. */}
      <span className="dock__label">{item.name}</span>
      <span className="dock__tip" aria-hidden="true">{item.name}</span>
    </Link>
  );
}

export default function FloatingDock() {
  const pathname = usePathname();
  const pointerX = useMotionValue(POINTER_AWAY);
  const pointerDevice = useMediaQuery(MAGNIFY_QUERY);
  const reducedMotion = useReducedMotion();
  const magnify = pointerDevice && !reducedMotion;

  return (
    <nav
      aria-label="เมนูหลัก"
      className="dock"
      onMouseMove={magnify ? (event) => pointerX.set(event.clientX) : undefined}
      onMouseLeave={magnify ? () => pointerX.set(POINTER_AWAY) : undefined}
    >
      <ul className="dock__list">
        {primaryNavItems.map((item) => {
          const active = isNavItemActive(pathname, item.href);
          return (
            /*
             * `data-active` on the slot, not only on the link: below lg the
             * current destination widens to fit its name while the other four
             * hold a 44px touch square, and that sizing belongs to the flex
             * child rather than to the link inside it.
             */
            <li key={item.href} className="dock__slot" data-active={active ? 'true' : undefined}>
              <DockItem item={item} active={active} pointerX={pointerX} magnify={magnify} />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
