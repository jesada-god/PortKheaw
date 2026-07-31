'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/src/utils/cn';

const failedLogos = new Set<string>();

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
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const failed = Boolean(logoUrl && (failedUrl === logoUrl || failedLogos.has(logoUrl)));
  useEffect(() => {
    if (!logoUrl || failedLogos.has(logoUrl)) return;
    timeoutRef.current = window.setTimeout(() => {
      failedLogos.add(logoUrl);
      setFailedUrl(logoUrl);
    }, 8_000);
    return () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, [logoUrl]);

  const fail = () => {
    if (logoUrl) failedLogos.add(logoUrl);
    setFailedUrl(logoUrl);
  };
  const style = { width: size, height: size };

  if (!logoUrl || failed) {
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
        src={logoUrl}
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
