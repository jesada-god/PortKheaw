'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/src/utils/cn';

const failedLogos = new Set<string>();
const normalizedLogos = new Map<string, string | null>();

export function normalizeInstrumentLogoUrl(value: string | null): string | null {
  if (!value) return null;
  const cached = normalizedLogos.get(value);
  if (cached !== undefined) return cached;
  let normalized: string | null = null;
  try {
    const url = new URL(value.trim());
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
  className,
  priority = false,
}: {
  symbol: string;
  companyName: string;
  logoUrl: string | null;
  size?: number;
  className?: string;
  priority?: boolean;
}) {
  const normalizedLogoUrl = normalizeInstrumentLogoUrl(logoUrl);
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
  const style = { width: size, height: size };

  if (!normalizedLogoUrl || failed) {
    return (
      <span
        role="img"
        aria-label={`โลโก้สำรอง ${companyName || symbol}`}
        style={style}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] text-[11px] font-bold tracking-tight text-[var(--text-secondary)]',
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
        'relative inline-flex shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-white',
        className,
      )}
    >
      <Image
        src={normalizedLogoUrl}
        alt={`โลโก้ ${companyName || symbol}`}
        fill
        sizes={`${size}px`}
        unoptimized
        priority={priority}
        loading={priority ? 'eager' : 'lazy'}
        referrerPolicy="no-referrer"
        className="object-contain p-1"
        onLoad={() => {
          if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }}
        onError={fail}
      />
    </span>
  );
}
