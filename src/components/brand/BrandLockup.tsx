import Link from 'next/link';
import { TrendingUp } from 'lucide-react';
import { appConfig } from '@/src/config/app';
import { BrandMark } from '@/src/components/brand/BrandMark';
import { cn } from '@/src/utils/cn';

/**
 * The PortKheaw brand lockup: the official Kheaw mark on its black plate, the
 * two-tone wordmark, and the rising-chart arrow that closes it.
 *
 * One accessible name for the whole thing. `aria-label` on the link names it
 * "PortKheaw" once; the mark, the two word halves and the arrow are all
 * decorative renderings of that same name, so each is hidden from the
 * accessibility tree rather than announced again.
 *
 * The wordmark is text, not an image: it inherits the reader's font scaling,
 * stays crisp at any zoom, and — because the plate and the type both have a
 * declared size — reserves its box before the mascot PNG arrives, so the header
 * never shifts as it loads.
 */
export function BrandLockup({
  className,
  priority = false,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Link
      href="/"
      aria-label={appConfig.name}
      className={cn('brand-lockup', className)}
    >
      <span
        className="brand-lockup__plate bg-[var(--brand-mark-bg)]"
        aria-hidden="true"
      >
        <BrandMark priority={priority} className="brand-lockup__mascot" />
      </span>
      <span className="brand-lockup__word" aria-hidden="true">
        <span className="brand-lockup__port">Port</span>
        {/* No space between the halves: they read as one word, coloured in two
            parts, exactly as the brand guide draws it. */}
        <span className="brand-lockup__kheaw">Kheaw</span>
        {/* Sits after the final letter rather than above it — an arrow floating
            over "w" would read as a Thai tone mark to this app's readers. It is
            fixed brand furniture and never tracks a price. */}
        <TrendingUp className="brand-lockup__arrow" aria-hidden="true" />
      </span>
    </Link>
  );
}
