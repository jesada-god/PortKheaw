'use client';

import { Briefcase, ChevronRight, Lock } from 'lucide-react';
import { portfolioReturnToneClass } from '@/src/lib/portfolio/presentation';
import type { PortfolioRecord, PortfolioSummary } from '@/src/lib/portfolio/types';

/**
 * A portfolio as a card rather than as a row of accounting columns.
 *
 * Everything on it is already on the summary the page calculated from the
 * ledger; this only decides what earns space. An empty portfolio still gets a
 * full card with a zero value and an explicit "ยังไม่มีสินทรัพย์" line, because
 * a portfolio somebody has just created and not funded yet is an intentional
 * state, not a broken one.
 */
export function PortfolioSummaryCard({
  portfolio,
  summary,
  assetCount,
  valueText,
  todayLabel,
  todayText,
  totalGainText,
  goalPercent,
  readOnly,
  showBalances,
  onOpen,
}: {
  portfolio: PortfolioRecord;
  summary: PortfolioSummary;
  assetCount: number;
  valueText: string;
  /** The day the figure belongs to — see `HoldingCard`'s `dayLabel`. */
  todayLabel: string;
  todayText: string;
  totalGainText: string;
  goalPercent: number | null;
  readOnly: boolean;
  showBalances: boolean;
  onOpen: () => void;
}) {
  return <button
    type="button"
    onClick={onOpen}
    data-testid={`portfolio-card-${portfolio.id}`}
    className="panel flex w-full min-w-0 flex-col gap-3 p-4 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
  >
    <span className="flex min-w-0 items-start gap-3">
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent-soft)] text-[var(--accent)]">
        <Briefcase size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block break-words text-base font-bold text-[var(--text)]">{portfolio.name}</strong>
        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-[var(--text-muted)]">
          <span>{assetCount > 0 ? `${assetCount} รายการ` : 'ยังไม่มีสินทรัพย์'}</span>
          {portfolio.archivedAt && <span className="rounded-full bg-[var(--surface-hover)] px-2 py-0.5 font-semibold">Archived</span>}
          {readOnly && <span className="inline-flex items-center gap-1 font-semibold text-[var(--warning)]">
            <Lock aria-hidden="true" size={11} /> อ่านอย่างเดียว
          </span>}
        </span>
      </span>
      <ChevronRight aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--text-muted)]" size={18} />
    </span>

    <span className="figure block break-all text-2xl font-extrabold tracking-tight text-[var(--text)]">{valueText}</span>

    <span className="grid min-w-0 grid-cols-2 gap-3">
      <span className="min-w-0">
        <span className="figure-label">{todayLabel}</span>
        <span className={`figure-data mt-0.5 block break-all ${portfolioReturnToneClass(showBalances ? summary.todayChange : null, 'text-[var(--text-secondary)]')}`}>
          {todayText}
        </span>
      </span>
      <span className="min-w-0">
        <span className="figure-label">กำไร/ขาดทุนรวม</span>
        <span className={`figure-data mt-0.5 block break-all ${portfolioReturnToneClass(showBalances ? summary.totalGain : null, 'text-[var(--text-secondary)]')}`}>
          {totalGainText}
        </span>
      </span>
    </span>

    {goalPercent !== null && showBalances && <span className="block">
      <span className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>ความคืบหน้าเป้าหมาย</span>
        <span className="figure font-semibold text-[var(--text-secondary)]">{goalPercent.toFixed(1)}%</span>
      </span>
      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-[var(--radius-mark)] bg-[var(--surface-hover)]">
        <span
          className="block h-full rounded-[var(--radius-mark)] bg-[var(--accent)]"
          style={{ width: `${Math.min(100, Math.max(0, goalPercent))}%` }}
        />
      </span>
    </span>}
  </button>;
}
