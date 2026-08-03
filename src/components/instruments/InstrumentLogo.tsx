'use client';

import Image from 'next/image';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cn } from '@/src/utils/cn';

const failedLogos = new Set<string>();
const normalizedLogos = new Map<string, string | null>();

export function normalizeInstrumentLogoUrl(value: string | null): string | null {
  if (!value) return null;
  const cached = normalizedLogos.get(value);
  if (cached !== undefined) return cached;
  let normalized: string | null = null;
  const trimmed = value.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    normalized = trimmed.split('#', 1)[0] || null;
    normalizedLogos.set(value, normalized);
    return normalized;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      url.hash = '';
      normalized = url.href;
    }
  } catch {
    normalized = null;
  }
  normalizedLogos.set(value, normalized);
  return normalized;
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
  logoUrl: string | null;
  size?: number;
  mobileSize?: number;
  appearance?: 'framed' | 'plain';
  className?: string;
  priority?: boolean;
}) {
  const normalizedLogoUrl = normalizeInstrumentLogoUrl(logoUrl);
  const localLogo = normalizedLogoUrl?.startsWith('/') === true;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const failed = Boolean(normalizedLogoUrl && (
    failedUrl === normalizedLogoUrl || failedLogos.has(normalizedLogoUrl)
  ));
  useEffect(() => {
    if (!normalizedLogoUrl || failedLogos.has(normalizedLogoUrl)) return;
    timeoutRef.current = window.setTimeout(() => {
      failedLogos.add(normalizedLogoUrl);
      setFailedUrl(normalizedLogoUrl);
    }, 8_000);
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, [normalizedLogoUrl]);

  const fail = () => {
    if (normalizedLogoUrl) failedLogos.add(normalizedLogoUrl);
    setFailedUrl(normalizedLogoUrl);
  };
  const loaded = () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
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
          onLoad={loaded}
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
          onLoad={loaded}
          onError={fail}
        />
      )}
    </span>
  );
}
