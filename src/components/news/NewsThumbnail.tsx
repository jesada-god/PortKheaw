'use client';

import { useState } from 'react';
import Image from 'next/image';
import { cn } from '@/src/utils/cn';
import { shouldRenderNewsImage } from './news-policy';

/**
 * The one news thumbnail in the app: the article's real image when the publisher
 * supplied a usable one, otherwise no thumbnail at all.
 *
 * `unoptimized` keeps the publisher's own URL: see the `images` note in
 * next.config.ts for why the optimizer is not used. If that request fails, the
 * entire frame is removed so the card content occupies the full width.
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
      <Image
        src={imageUrl as string}
        alt=""
        fill
        sizes="(min-width: 640px) 112px, 96px"
        unoptimized
        loading={priority ? 'eager' : 'lazy'}
        priority={priority}
        referrerPolicy="no-referrer"
        className="object-cover"
        onError={() => setFailedUrl(imageUrl)}
      />
    </div>
  );
}
