'use client';

import { ChevronRight, ListChecks } from 'lucide-react';
import type { StockSummaryItem, StockSummaryTarget } from '@/src/lib/stock-detail/summary';

/**
 * "สรุปหุ้นนี้" — the compact answer, above the tabs.
 *
 * Every row is a restatement of something an existing section already holds, so
 * every row is a way INTO that section rather than a place the reader has to
 * finish reading here. The card renders nothing at all when no canonical source
 * answered: an empty summary is better than an invented one.
 */
export function StockSummaryCard({
  items,
  onOpenSection,
}: {
  items: readonly StockSummaryItem[];
  /** Switches the page's own tab strip — never a route change. */
  onOpenSection: (target: StockSummaryTarget) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section
      data-testid="stock-summary-card"
      className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <h2 className="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--text)]">
        <ListChecks aria-hidden="true" size={16} className="shrink-0 text-[var(--accent)]" />
        สรุปหุ้นนี้
      </h2>
      <ul className="mt-3 grid min-w-0 gap-2">
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onOpenSection(item.target)}
              data-testid={`stock-summary-${item.id}`}
              className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-2 text-left text-sm leading-6 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
            >
              <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-[var(--accent)]" />
              <span className="min-w-0 flex-1 break-words">{item.text}</span>
              <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-[var(--text-muted)]" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
