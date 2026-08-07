import Image from 'next/image';
import { cn } from '@/src/utils/cn';

/**
 * The one loading visual in the product: Kheaw bouncing under a speech bubble.
 *
 * Deliberately presentational and server-safe — no hooks, no `'use client'` —
 * because Next's route-level `loading.tsx` files render it during streaming,
 * before any JavaScript has arrived. Timing comes from elsewhere:
 *   - route fallbacks pass `deferred`, which applies the CSS grace in
 *     `app/globals.css`;
 *   - client data loading goes through `KheawLoadingBoundary`, which does not
 *     render this component at all until the same grace has elapsed.
 *
 * Nothing else belongs in the loading area — no logo, no chart, no dots, no
 * footer. The mascot and the message are the whole component.
 */

/** Shown in the bubble. Real text, never baked into the artwork. */
export const KHEAW_LOADING_MESSAGE = 'กำลังโหลดอยู่นะ!';
/** Names the live region for assistive technology. */
export const KHEAW_LOADING_STATUS_LABEL = 'กำลังโหลดข้อมูล';

/**
 * Intrinsic size of public/brand/kheaw-loading.webp.
 *
 * This is also the whole of the answer to "don't download more than you draw".
 * `--kheaw-mascot-size` is `clamp(110px, 34vw, 180px)`, so 180px is the widest
 * the mascot is drawn on any viewport, and the asset is cut to exactly twice
 * that for a 2x device pixel ratio (`OUTPUT_WIDTH` in the generator). A `sizes`
 * prop would add nothing: `unoptimized` means next/image emits no `srcSet`, and
 * it drops `sizes` with it, because there is only ever this one file to fetch.
 */
const MASCOT_WIDTH = 360;
const MASCOT_HEIGHT = 352;

export interface KheawLoaderProps {
  /** `page` fills the visible content area; `section` sits inside a card. */
  variant?: 'page' | 'section';
  message?: string;
  /** Apply the CSS-timed 300ms grace. For server-rendered route fallbacks. */
  deferred?: boolean;
  /**
   * Fetch the mascot eagerly, at high priority, with a `<link rel=preload>`.
   *
   * For route fallbacks only, where the mascot is the first and largest thing
   * on screen and is therefore the page's LCP element. Left off elsewhere: a
   * section loader sits below the fold and has no claim on the preload slot.
   */
  priority?: boolean;
  /** Fade out over the content that has just arrived. */
  leaving?: boolean;
  className?: string;
}

export function KheawLoader({
  variant = 'section',
  message = KHEAW_LOADING_MESSAGE,
  deferred = false,
  priority = false,
  leaving = false,
  className,
}: KheawLoaderProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      /*
       * The bubble text is already inside the live region, so it is what gets
       * announced when the loader appears; this only names the region for
       * anyone navigating to it directly. Adding a second, visually hidden
       * "กำลังโหลดข้อมูล" would announce the same wait twice.
       */
      aria-label={KHEAW_LOADING_STATUS_LABEL}
      data-variant={variant}
      className={cn(
        'kheaw-loader',
        `kheaw-loader--${variant}`,
        deferred && 'kheaw-loader--deferred',
        leaving && 'kheaw-loader--leaving',
        className,
      )}
    >
      <p className="kheaw-loader__bubble">{message}</p>
      <span className="kheaw-loader__stage">
        <Image
          src="/brand/kheaw-loading.webp"
          /*
           * Decorative: the status text above says everything the mascot says.
           *
           * `unoptimized` keeps this a plain <img> pointing straight at the
           * committed 38KB asset. Routing a loading indicator through the image
           * optimizer would put a transform on the critical path of exactly the
           * slow pages this component exists to cover — and the asset is already
           * lossless WebP, cut to the one size it is ever drawn at, so there is
           * nothing left for the optimizer to win.
           */
          alt=""
          aria-hidden="true"
          unoptimized
          /*
           * `priority` is what keeps this off the LCP critical path. next/image
           * defaults to `loading="lazy"`, which hides the mascot from the
           * preload scanner: the browser could not even request it until after
           * the first layout, by which point every low-priority app chunk was
           * already queued ahead of it. Lighthouse measured 1.07s of that pure
           * load delay — 41% of a 2.6s LCP — on a route fallback whose whole
           * job is to be the thing a slow page shows first.
           *
           * This costs no extra bytes: the image is in the fallback markup and
           * was being fetched on every one of these routes already. It only
           * moves the request from "after layout" to "with the stylesheet".
           */
          priority={priority}
          /*
           * `priority` alone only drops `loading="lazy"` and emits the head
           * preload; the element's own hint stays unset. Sending `high` too
           * keeps the mascot ahead of the app chunks that the browser would
           * otherwise let overtake it once the preload has been honoured.
           */
          fetchPriority={priority ? 'high' : undefined}
          width={MASCOT_WIDTH}
          height={MASCOT_HEIGHT}
          draggable={false}
          className="kheaw-loader__mascot select-none"
        />
        <span className="kheaw-loader__shadow" aria-hidden="true" />
      </span>
    </div>
  );
}
