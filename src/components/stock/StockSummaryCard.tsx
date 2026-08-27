'use client';

import { ChevronRight } from 'lucide-react';
import { StatusRow } from '@/src/components/ui/StatusLabel';
import type { StockSummaryTarget, StockSummaryView } from '@/src/lib/stock-detail/summary';

/**
 * "สรุปหุ้นนี้" — the compact answer, above the tabs.
 *
 * Three bands, in the order the brief asks them in: what the readings say, then
 * the levels the price is standing between, then one sentence that closes.
 *
 * Every row is a restatement of something an existing section already holds, so
 * every row is a way INTO that section rather than a place the reader has to
 * finish reading here. The card renders nothing at all when no canonical source
 * answered: an empty summary is better than an invented one.
 *
 * WHAT IS NOT HERE. No score, no confidence percentage, and no paragraph. The
 * closing line is one sentence built from the state and the nearest level —
 * both already on this page — and if there is no reading to open it with, there
 * is no line.
 */
export function StockSummaryCard({
  view,
  onOpenSection,
}: {
  view: StockSummaryView;
  /** Switches the page's own tab strip — never a route change. */
  onOpenSection: (target: StockSummaryTarget) => void;
}) {
  const { statuses, levels, closing } = view;
  if (statuses.length === 0 && levels.length === 0 && closing === null) return null;

  return (
    <section
      data-testid="stock-summary-card"
      className="min-w-0 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      {statuses.length > 0 && (
        <div className="grid min-w-0 gap-1">
          {statuses.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onOpenSection(row.target)}
              data-testid={`stock-status-${row.id}`}
              className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] px-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <StatusRow name={row.name} level={row.level} label={row.label} className="min-w-0 flex-1" />
              <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-[var(--text-muted)]" />
            </button>
          ))}
        </div>
      )}

      {levels.length > 0 && (
        /*
          A hairline rather than a second panel. The levels are the same subject
          as the rows above them — this stock, right now — and a bordered box
          around them would claim they were a different one.
        */
        <ul className={`grid min-w-0 gap-1 ${statuses.length > 0 ? 'mt-2 border-t border-[var(--hairline)] pt-2' : ''}`}>
          {levels.map((item) => (
            <li key={item.id} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpenSection(item.target)}
                data-testid={`stock-summary-${item.id}`}
                className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] px-2 text-left text-sm leading-6 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <span className="min-w-0 flex-1 break-words">{item.text}</span>
                <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-[var(--text-muted)]" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {closing && (
        <p
          data-testid="stock-summary-closing"
          className="mt-3 min-w-0 break-words border-t border-[var(--hairline)] pt-3 text-sm leading-6 text-[var(--text)]"
        >
          {closing}
        </p>
      )}
    </section>
  );
}
