'use client';

import { useState } from 'react';
import { cn } from '@/src/utils/cn';
import { shouldRenderNewsImage } from './news-policy';

/**
 * The one news thumbnail in the app: the article's real image when the publisher
 * supplied a usable one, otherwise no thumbnail at all.
 *
 * A native image keeps publisher URLs on the browser's `img-src` path. Using
 * Next/Image for an arbitrary unoptimized publisher URL can cause React/Next to
 * preconnect through `connect-src`, which our strict CSP intentionally blocks.
 * If the image request fails, the entire frame is removed so the card content
 * occupies the full width.
 */
export function NewsThumbnail({
  imageUrl,
  saveData,
  priority = false,
  className,
}: {
  imageUrl: string | null;
  saveData: boolean;
  /** Set on above-the-fold cards; everything else stays lazy. */
  priority?: boolean;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const renderable = shouldRenderNewsImage(saveData, imageUrl)
    && failedUrl !== imageUrl;

  if (!renderable) return null;

  return (
    <div
      className={cn(
        'relative aspect-[4/3] w-24 shrink-0 overflow-hidden rounded-lg bg-slate-800 sm:w-28',
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- provider-supplied news URLs must not turn Vercel into an open image proxy */}
      <img
        src={imageUrl as string}
        alt=""
        width={112}
        height={84}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover"
        onError={() => setFailedUrl(imageUrl)}
      />
    </div>
  );
}
