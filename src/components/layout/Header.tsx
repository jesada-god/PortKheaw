'use client';
import { ArrowLeft, Search, Bell, User } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandLockup } from '@/src/components/brand/BrandLockup';

interface HeaderProps {
  title: string;
  subtitle?: string;
  status?: {
    text: string;
    indicator: 'green' | 'yellow' | 'red';
  };
  backFallbackHref?: string;
  /**
   * A back control that is a LINK to a fixed destination, not a history step.
   *
   * ===========================================================================
   * WHY THERE ARE TWO OF THESE
   * ===========================================================================
   * `backFallbackHref` steps through browser history and only falls back to its
   * href when there is nothing to step to. That is right for a page you always
   * arrive at from one place — a support ticket from the ticket list — because
   * "back" there means "the list I was just looking at, scrolled where I left
   * it".
   *
   * It is wrong for a page a reader can arrive at cold: from a card on another
   * page, from a bookmark, from a link somebody sent them. `router.back()` then
   * sends them OUT of the product, and `window.history.length > 1` is true for
   * a tab that has been used at all, so the fallback never fires. A `Link` says
   * where it goes, survives a middle-click, shows its target on hover, and is
   * the same destination whatever route the reader took to get here.
   *
   * Both render the same control in the same slot with the same accessible
   * name, so a reader meets one back button, not two kinds.
   */
  backHref?: string;
}

type BackRouter = Pick<ReturnType<typeof useRouter>, 'back' | 'replace'>;

export function navigateBackWithFallback(router: BackRouter, fallbackHref: string) {
  if (window.history.length > 1) {
    router.back();
    return;
  }
  router.replace(fallbackHref);
}

export default function Header({
  title,
  subtitle,
  status,
  backFallbackHref,
  backHref,
}: HeaderProps) {
  const router = useRouter();
  /*
    One flag for every layout decision below. A header with either kind of back
    control drops the brand lockup and hides the secondary actions on a
    handset — that was already true of one of them and has nothing to do with
    which mechanism moves the reader.
  */
  const hasBack = Boolean(backFallbackHref || backHref);
  const backClassName = 'flex min-h-11 min-w-11 flex-none items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    const load = () => { void fetch('/api/notifications/unread-count').then((response) => response.json()).then((data) => setUnreadCount(Number(data.count) || 0)).catch(() => undefined); };
    load(); window.addEventListener('notifications-updated', load);
    return () => window.removeEventListener('notifications-updated', load);
  }, []);

  return (
    <header className="sticky top-0 z-40 flex min-h-16 items-center justify-between gap-3 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_86%,transparent)] px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-md transition-colors duration-200 sm:px-6 lg:px-8">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
        {backHref ? (
          <Link href={backHref} aria-label="ย้อนกลับ" className={backClassName}>
            <ArrowLeft aria-hidden="true" size={21} />
          </Link>
        ) : backFallbackHref && (
          <button
            type="button"
            onClick={() => navigateBackWithFallback(router, backFallbackHref)}
            aria-label="ย้อนกลับ"
            className={backClassName}
          >
            <ArrowLeft aria-hidden="true" size={21} />
          </button>
        )}
        {/*
          The lockup sits above the page title on a handset and beside it from
          lg. Stacked is what makes both fit at 320px: the three header actions
          take a fixed 148px on the right, which leaves the brand and a page
          title no room to share a row.
        */}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-4">
          {!hasBack && (
            <>
              <BrandLockup priority />
              <span aria-hidden="true" className="hidden h-7 w-px flex-none bg-[var(--border)] md:block" />
            </>
          )}
          {/* min-w-0: without it this flex item refuses to shrink and `truncate`
              below never engages, so a long title runs under the header actions
              at 320px instead of ellipsing. */}
          <div className="min-w-0">
            <h2 className={hasBack ? 'whitespace-nowrap text-base font-semibold text-[var(--text)] sm:text-lg' : 'truncate text-base font-semibold text-[var(--text)] sm:text-lg'}>{title}</h2>
            {subtitle && <p className="hidden truncate text-xs text-[var(--text-muted)] sm:block">{subtitle}</p>}
          </div>
        </div>

        {status && (
          <div className="ml-4 hidden items-center gap-2 rounded-full bg-[var(--surface-hover)] px-2 py-1 md:flex">
            <span className={`h-2 w-2 rounded-full ${
              status.indicator === 'green' ? 'bg-[var(--positive)]' :
              status.indicator === 'yellow' ? 'bg-[var(--warning)]' : 'bg-[var(--negative)]'
            }`} />
            <span className={`text-[10px] font-bold uppercase tracking-tighter ${
              status.indicator === 'green' ? 'text-[var(--positive)]' :
              status.indicator === 'yellow' ? 'text-[var(--warning)]' : 'text-[var(--negative)]'
            }`}>
              {status.text}
            </span>
          </div>
        )}
      </div>

      <div className={`${hasBack ? 'hidden sm:flex' : 'flex'} shrink-0 items-center gap-4 md:gap-6`}>
        <div
          className="hidden md:block relative cursor-text"
          onClick={() => router.push('/search')}
        >
          <input
            type="text"
            placeholder="ค้นหาหุ้น... (Symbol, Name)"
            className="pointer-events-none min-h-11 w-64 rounded-lg border border-[var(--border-strong)] bg-[var(--input-bg)] px-4 py-2 text-xs text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            readOnly
          />
          <kbd className="absolute right-2 top-1.5 rounded border border-[var(--border)] bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">⌘K</kbd>
        </div>
        <div className="flex items-center gap-2 md:gap-3">
          <button
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] md:hidden"
            onClick={() => router.push('/search')}
            aria-label="ค้นหา"
          >
            <Search size={20} />
          </button>
          <button
            className="relative flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            onClick={() => router.push('/notifications')}
            aria-label={`การแจ้งเตือน${unreadCount > 0 ? `ที่ยังไม่ได้อ่าน ${unreadCount} รายการ` : ''}`}
          >
            <Bell size={20} />
            {unreadCount > 0 && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full border-2 border-[var(--bg)] bg-[var(--accent)]" />
            )}
          </button>
          <button
            className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border-2 border-[var(--accent)] bg-[var(--surface-hover)] text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
            onClick={() => router.push('/profile')}
            aria-label="โปรไฟล์"
          >
            <User size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
