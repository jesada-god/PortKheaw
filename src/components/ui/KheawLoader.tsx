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

/** Intrinsic size of public/brand/kheaw-loading.png. */
const MASCOT_WIDTH = 360;
const MASCOT_HEIGHT = 352;

export interface KheawLoaderProps {
  /** `page` fills the visible content area; `section` sits inside a card. */
  variant?: 'page' | 'section';
  message?: string;
  /** Apply the CSS-timed 300ms grace. For server-rendered route fallbacks. */
  deferred?: boolean;
  /** Fade out over the content that has just arrived. */
  leaving?: boolean;
  className?: string;
}

export function KheawLoader({
  variant = 'section',
  message = KHEAW_LOADING_MESSAGE,
  deferred = false,
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
          src="/brand/kheaw-loading.png"
          /*
           * Decorative: the status text above says everything the mascot says.
           *
           * `unoptimized` keeps this a plain <img> pointing straight at the
           * committed 45KB asset. Routing a loading indicator through the image
           * optimizer would put a transform on the critical path of exactly the
           * slow pages this component exists to cover.
           */
          alt=""
          aria-hidden="true"
          unoptimized
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
