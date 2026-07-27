'use client';

import { useState } from 'react';
import Image from 'next/image';
import { ImageOff } from 'lucide-react';
import { cn } from '@/src/utils/cn';
import { shouldRenderNewsImage } from './news-policy';

/**
 * The one news thumbnail in the app: the article's real image when the publisher
 * supplied a usable one, and the system placeholder in every other case
 * (no image, Data Saver, non-HTTPS link, or a request that fails at runtime).
 *
 * The frame is a fixed aspect ratio whether or not an image loads, so a feed never
 * reflows as pictures arrive or fail. `unoptimized` keeps the publisher's own URL:
 * see the `images` note in next.config.ts for why the optimizer is not used.
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
  const [failed, setFailed] = useState(false);
  const renderable = shouldRenderNewsImage(saveData, imageUrl) && !failed;

  return (
    <div
      className={cn(
        'relative aspect-[4/3] w-24 shrink-0 overflow-hidden rounded-lg bg-slate-800 sm:w-28',
        className,
      )}
    >
      {renderable ? (
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
          // A publisher CDN that 404s, hotlink-blocks or times out falls back to the
          // same placeholder instead of leaving a broken-image glyph in the card.
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center text-slate-500"
          aria-hidden="true"
          data-testid="news-thumbnail-placeholder"
        >
          <ImageOff size={20} />
        </div>
      )}
    </div>
  );
}
