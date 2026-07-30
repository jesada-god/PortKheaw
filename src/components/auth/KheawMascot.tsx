import Image from 'next/image';
import { cn } from '@/src/utils/cn';

/**
 * Kheaw, from the one committed brand asset. The mascot is never redrawn,
 * recoloured or filtered here — silhouette, arrow, eyes, cheeks and mouth come
 * straight from `public/brand/kheaw-mark.png`, which is also what the app
 * header and the installed icons use.
 *
 * `width`/`height` are always emitted so the browser reserves the box before
 * the image arrives; the mascot sits in normal flow on every auth page, so it
 * cannot end up covering a field, an error, or a submit button no matter how
 * the text above it wraps.
 */
const SIZES = {
  sm: 72,
  md: 112,
  lg: 168,
} as const;

export function KheawMascot({
  size = 'md',
  priority = false,
  className,
}: {
  size?: keyof typeof SIZES;
  priority?: boolean;
  className?: string;
}) {
  const pixels = SIZES[size];
  return (
    <Image
      src="/brand/kheaw-mark.png"
      alt=""
      aria-hidden="true"
      width={pixels}
      height={pixels}
      sizes={`${pixels}px`}
      priority={priority}
      className={cn('block shrink-0 select-none object-contain', className)}
      style={{ width: pixels, height: pixels }}
    />
  );
}
