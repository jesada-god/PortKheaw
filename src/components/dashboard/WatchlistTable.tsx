import Link from 'next/link';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { StatusLabel } from '@/src/components/ui/StatusLabel';
import { stockDetailHref } from '@/src/lib/instruments/routes';
import { signedPercent } from '@/src/lib/portfolio/presentation';
import { statusFromSignedValue } from '@/src/lib/presentation/status';
import type { WatchlistRow } from '@/src/lib/watchlist/rows';

/**
 * Watchlist 2.0 on the overview — four columns, and a second line only when
 * there is one to draw.
 *
 * ===========================================================================
 * WHY SUPPORT, VOLUME AND EARNINGS ARE NOT COLUMNS
 * ===========================================================================
 * `src/lib/watchlist/rows.ts` already argues this and the argument is the
 * reason the row type is shaped the way it is: the main row carries what
 * somebody scanning a dozen holdings is scanning FOR, and a column they have to
 * read past costs every other row. Support, resistance, volume and the earnings
 * date are real and are kept — as a secondary line, on the rows that have one.
 *
 * A permanent column for a field that is null on most rows is a column of
 * dashes, and a screen of dashes teaches a reader that the table is broken.
 *
 * ===========================================================================
 * THE ALERT COUNT IS ABSENT, NOT ZERO
 * ===========================================================================
 * `counts` is undefined whenever the alert rules could not be read at all —
 * which is every deployment today, because `overview_alert_rules` has not been
 * applied. An unreadable count draws NOTHING: no number, no dash, no icon. "You
 * have no alerts on this symbol" and "we could not check" are different facts,
 * and a 0 would state the first while meaning the second.
 */

function formatPrice(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return 'ยังไม่มีราคา';
  return `${value.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatLevel(value: number): string {
  return value.toLocaleString('th-TH', { maximumFractionDigits: 4 });
}

function formatVolume(value: number): string {
  return value.toLocaleString('th-TH', { maximumFractionDigits: 0 });
}

/** The second line's parts, in a fixed order, with the absent ones gone. */
function detailParts(row: WatchlistRow): string[] {
  const parts: string[] = [];
  if (row.expanded.support !== null) parts.push(`แนวรับ ${formatLevel(row.expanded.support)}`);
  if (row.expanded.resistance !== null) parts.push(`แนวต้าน ${formatLevel(row.expanded.resistance)}`);
  if (row.expanded.volume !== null) parts.push(`ปริมาณ ${formatVolume(row.expanded.volume)}`);
  if (row.expanded.earningsDays !== null) {
    parts.push(row.expanded.earningsDays === 0
      ? 'ประกาศงบวันนี้'
      : `ประกาศงบอีก ${row.expanded.earningsDays} วัน`);
  }
  return parts;
}

export function WatchlistTable({
  rows,
  counts,
}: {
  rows: readonly WatchlistRow[];
  /** Alert rules per symbol. Undefined means unreadable — draw nothing. */
  counts?: Record<string, number> | null;
}) {
  return (
    <div className="divide-y divide-[var(--border)]" data-testid="overview-watchlist-table">
      {rows.map((row) => {
        const details = detailParts(row);
        const alerts = counts?.[row.symbol];
        return (
          <Link
            key={row.id}
            href={stockDetailHref(row.symbol)}
            data-testid={`overview-watchlist-row-${row.symbol}`}
            className="grid min-h-[64px] min-w-0 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <InstrumentLogo
              symbol={row.symbol}
              companyName={row.companyName}
              logoUrl={row.logoUrl}
              size={32}
              appearance="plain"
            />
            <span className="min-w-0">
              <span className="flex min-w-0 items-baseline gap-2">
                <strong className="figure text-sm font-bold text-[var(--text)]">{row.symbol}</strong>
                <span className="truncate text-[11px] text-[var(--text-muted)]">{row.companyName}</span>
                {/*
                  A count, not a badge. No fill, no bell, no colour — the number
                  of alerts on a symbol is a quantity, and painting it would
                  make it compete with the status marks, which are the only
                  thing on this row that colour is allowed to mean.
                */}
                {typeof alerts === 'number' && alerts > 0 && (
                  <span
                    className="figure shrink-0 text-[11px] text-[var(--text-muted)]"
                    data-testid={`overview-watchlist-alerts-${row.symbol}`}
                  >
                    {alerts} แจ้งเตือน
                  </span>
                )}
              </span>
              {details.length > 0 && (
                <span
                  className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]"
                  data-testid={`overview-watchlist-detail-${row.symbol}`}
                >
                  {details.join(' · ')}
                </span>
              )}
            </span>
            <span className="min-w-0 text-right">
              <span className="figure block whitespace-nowrap text-sm font-bold text-[var(--text)]">
                {formatPrice(row.price, row.currency)}
              </span>
              <span className="mt-0.5 flex flex-wrap items-baseline justify-end gap-x-2">
                <StatusLabel
                  level={statusFromSignedValue(row.day.changePercent)}
                  label={row.day.changePercent === null
                    ? 'ยังไม่มีค่า'
                    : signedPercent(row.day.changePercent)}
                  className="text-xs"
                />
                {/*
                  The trend word the engine published, through the bounded
                  interval. `demoted` is deliberately not shown here — it is a
                  statement about the evidence and it belongs on the row's own
                  page, where there is room to say what it means.
                */}
                <StatusLabel
                  level={row.trend.level}
                  label={row.trend.word}
                  className="text-xs"
                  data-testid={`overview-watchlist-trend-${row.symbol}`}
                />
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/** The skeleton, at the height the rows actually occupy. */
export function WatchlistTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-[var(--border)]" role="status" aria-label="กำลังโหลดรายการติดตาม">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="py-2.5">
          <div className="h-[59px] animate-pulse rounded-[var(--radius-mark)] bg-[var(--surface-elevated)] motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}
