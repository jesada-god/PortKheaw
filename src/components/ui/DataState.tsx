'use client';

import { RefreshCw } from 'lucide-react';
import { cn } from '@/src/utils/cn';
import { Skeleton } from './Skeleton';
import { StatusLabel } from './StatusLabel';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';

/**
 * The four states every data surface has, said the same way on every page.
 *
 * The product already had all four — the overview grew a full set of them, with
 * a retry endpoint behind it — but each surface had reinvented them. Search
 * printed a bare "กำลังค้นหา…" where the rows would go, Key Statistics drew a
 * grey rectangle of its own dimensions, and the error state differed most of
 * all: some surfaces said what went wrong, and one of them said it in the API's
 * own words.
 *
 * THE FOUR, and what separates them:
 *
 *   loading — a request is in flight. A skeleton, never a sentence: a sentence
 *             where the content will be makes the layout jump when it arrives.
 *   empty   — the request succeeded and there is nothing to show. This is an
 *             ANSWER, and it must never be dressed as a failure.
 *   error   — the request did not succeed. One sentence and a retry button.
 *   stale   — there IS data, and it is older than it should be. Not a
 *             replacement for the content: an annotation ON it.
 *
 * `stale` being an annotation rather than a state is the distinction the brief
 * is sharpest about — "ห้ามเอา cache เก่ามาแสดงเหมือนข้อมูลสด". Old data is
 * still worth reading, and hiding it behind a spinner would be worse; what it
 * must not do is look identical to a live reading. So it renders through
 * {@link StaleNote}, beside the content, carrying the time it was last true.
 */
export type DataStateKind = 'loading' | 'empty' | 'error' | 'ready';

/**
 * Send the real failure to the console, and only to the console.
 *
 * An API's own error message is written for whoever wrote the API. It names
 * endpoints, quotes provider slugs, and on a bad day carries a query string —
 * none of which a reader can act on, and some of which should not be on their
 * screen at all. `SearchClient` used to render `payload.error.message` straight
 * into the results panel.
 *
 * So the cause is logged where a developer can reach it and the reader is told,
 * in one sentence, the only two things that are true and useful: it did not
 * load, and they can try again.
 */
export function reportDataError(scope: string, cause: unknown): void {
  console.error(`[${scope}]`, cause);
}

export function DataState({
  state,
  onRetry,
  retrying = false,
  skeleton,
  emptyMessage = 'ไม่มีข้อมูลสำหรับช่วงเวลานี้',
  className,
  children,
}: {
  state: DataStateKind;
  /** Omitted only where there is genuinely nothing to retry. */
  onRetry?: () => void;
  retrying?: boolean;
  /**
   * What the loading state draws. Defaults to three lines, but a surface whose
   * content has a distinctive shape should pass its own — a skeleton whose
   * proportions do not match what replaces it is a layout jump with extra steps.
   */
  skeleton?: React.ReactNode;
  /** Overridden only where "ช่วงเวลานี้" is the wrong noun for what is missing. */
  emptyMessage?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  if (state === 'loading') {
    return (
      <div className={cn('min-w-0', className)} aria-busy="true" aria-live="polite">
        {skeleton ?? (
          <div className="grid gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <p className={cn('min-w-0 break-words py-6 text-center text-sm text-[var(--text-muted)]', className)}>
        {emptyMessage}
      </p>
    );
  }

  if (state === 'error') {
    return (
      <div className={cn('flex min-w-0 flex-col items-center gap-3 py-6 text-center', className)} role="alert">
        {/*
          One sentence, and always this sentence. Whatever the cause — a 500, a
          timeout, a provider refusing, a malformed payload — what the reader can
          do about it is identical, so telling them which one it was buys them
          nothing and occasionally costs them something they should not have seen.
        */}
        <p className="min-w-0 break-words text-sm text-[var(--text-secondary)]">โหลดข้อมูลไม่สำเร็จ</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border)] px-4 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <RefreshCw
              aria-hidden="true"
              size={15}
              className={retrying ? 'animate-spin motion-reduce:animate-none' : ''}
            />
            ลองอีกครั้ง
          </button>
        )}
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * "This is real, and this is when it was last true."
 *
 * Drawn BESIDE stale content rather than instead of it. It carries the
 * timestamp through the one Bangkok formatter — `formatMarketDataAsOf` — so
 * every "ณ" on every page reads the same clock, and it says nothing when there
 * is no timestamp to say: an unqualified "ข้อมูลเก่า" tells a reader their data
 * is wrong without telling them how wrong.
 */
export function StaleNote({ asOf, className }: { asOf: string | null | undefined; className?: string }) {
  const formatted = formatMarketDataAsOf(asOf);
  if (formatted === '—') return null;
  return (
    <StatusLabel
      level="neutral"
      /*
        A dot, not an arrow. "ข้อมูลล่าสุด ..." is a statement about WHEN a
        number was true, and it points nowhere — a flat trend arrow here would
        read as "the price is unchanged", which is a claim this note has never
        made about any price.
      */
      mark="dot"
      label={`ข้อมูลล่าสุด ${formatted}`}
      className={cn('text-xs font-normal', className)}
      data-testid="stale-note"
    />
  );
}
