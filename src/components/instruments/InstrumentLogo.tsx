'use client';

import Image from 'next/image';
import { useState, type CSSProperties } from 'react';
import { cn } from '@/src/utils/cn';
import {
  ExpiringFailureMemory,
  LOGO_FAILURE_TTL_MS,
  normalizeLogoUrl,
} from '@/src/lib/instruments/logo-policy';
import { useInstrumentLogoUrl } from './InstrumentLogoProvider';

/**
 * URLs that did not paint in this tab. The memory expires (see
 * `LOGO_FAILURE_TTL_MS`) so a dropped request is not mistaken for a missing
 * file for the rest of the session, and a symbol shown in ten places does not
 * make ten more attempts at a URL that just failed.
 */
const failedLogos = new ExpiringFailureMemory(LOGO_FAILURE_TTL_MS);
const reportedLogos = new Set<string>();

/** The shared rule, re-exported under the name this component is known by. */
export const normalizeInstrumentLogoUrl = normalizeLogoUrl;

/**
 * Tells the server that a persisted logo no longer loads, once per URL per tab.
 *
 * Without this the instrument master would keep handing out a URL that 404s for
 * every reader forever. It is sent, never awaited, and never surfaced: a logo
 * that fails should degrade to a monogram quietly, not turn into an error the
 * reader has to read.
 */
function reportBrokenLogo(symbol: string, url: string): void {
  if (!url.startsWith('https://') || reportedLogos.has(url)) return;
  reportedLogos.add(url);
  void fetch('/api/instruments/logo-invalidate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol, url }),
    keepalive: true,
  }).catch(() => {});
}

function initials(symbol: string): string {
  return symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase() || '?';
}

export function InstrumentLogo({
  symbol,
  companyName,
  logoUrl,
  size = 40,
  mobileSize,
  appearance = 'framed',
  className,
  priority = false,
}: {
  symbol: string;
  companyName: string;
  /**
   * Optional. When absent — or `null`, which is what a caller without the value
   * in scope passes — the logo the page resolved for this symbol is used.
   */
  logoUrl?: string | null;
  size?: number;
  mobileSize?: number;
  appearance?: 'framed' | 'plain';
  className?: string;
  priority?: boolean;
}) {
  const normalizedLogoUrl = useInstrumentLogoUrl(symbol, logoUrl);
  const localLogo = normalizedLogoUrl?.startsWith('/') === true;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = Boolean(normalizedLogoUrl && (
    failedUrl === normalizedLogoUrl || failedLogos.has(normalizedLogoUrl)
  ));

  const fail = () => {
    if (normalizedLogoUrl) {
      failedLogos.remember(normalizedLogoUrl);
      reportBrokenLogo(symbol, normalizedLogoUrl);
    }
    setFailedUrl(normalizedLogoUrl);
  };

  /*
   * The image may already have finished before React attached its handlers —
   * a server-rendered logo, or one served from cache, completes during
   * hydration and its `load` event is gone by the time this component is
   * listening. Reading `complete`/`naturalWidth` once on attach is the only way
   * to tell those two outcomes apart; nothing here polls or times out, because
   * a lazy image that has not started yet is not a failure and must never be
   * replaced by a monogram for being off screen.
   */
  const settleOnAttach = (node: HTMLImageElement | null) => {
    if (!node || !normalizedLogoUrl || !node.complete) return;
    if (node.naturalWidth === 0) fail();
  };
  const style = {
    position: 'relative',
    width: mobileSize ?? size,
    height: mobileSize ?? size,
    '--instrument-logo-desktop-size': `${size}px`,
    '--instrument-logo-mobile-size': `${mobileSize ?? size}px`,
  } as CSSProperties;
  const responsiveSize = 'sm:!size-[var(--instrument-logo-desktop-size)]';
  const plain = appearance === 'plain';

  if (!normalizedLogoUrl || failed) {
    return (
      <span
        role="img"
        aria-label={`โลโก้สำรอง ${companyName || symbol}`}
        style={style}
        className={cn(
          responsiveSize,
          'inline-flex shrink-0 items-center justify-center text-[11px] font-bold tracking-tight text-[var(--text-secondary)]',
          plain
            ? 'bg-transparent'
            : 'rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]',
          className,
        )}
      >
        {initials(symbol)}
      </span>
    );
  }

  return (
    <span
      style={style}
      className={cn(
        responsiveSize,
        'relative inline-flex shrink-0',
        plain
          ? 'bg-transparent'
          : 'overflow-hidden rounded-xl border border-[var(--border)] bg-white',
        className,
      )}
    >
      {localLogo ? (
        <Image
          src={normalizedLogoUrl}
          alt={`โลโก้ ${companyName || symbol}`}
          fill
          sizes={`${size}px`}
          unoptimized
          priority={priority}
          loading={priority ? 'eager' : 'lazy'}
          referrerPolicy="no-referrer"
          className={plain ? 'object-contain' : 'object-contain p-1'}
          ref={settleOnAttach}
          onError={fail}
        />
      ) : (
        // `next/image` calls HTMLImageElement.decode(), which Chromium can
        // reclassify as connect-src when an external image load is interrupted.
        // A native image stays governed by img-src without weakening the CSP.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={normalizedLogoUrl}
          alt={`Logo ${companyName || symbol}`}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={`absolute inset-0 h-full w-full ${plain ? 'object-contain' : 'object-contain p-1'}`}
          ref={settleOnAttach}
          onError={fail}
        />
      )}
    </span>
  );
}
