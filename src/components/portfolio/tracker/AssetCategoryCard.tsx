'use client';

import { ChevronRight, Layers3, Scale, TrendingUp, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AssetCategoryGroup, AssetCategoryKey } from '@/src/lib/portfolio/asset-categories';
import { portfolioReturnToneClass } from '@/src/lib/portfolio/presentation';

const categoryIcon: Record<AssetCategoryKey, LucideIcon> = {
  cash: Wallet,
  stock: TrendingUp,
  etf: Layers3,
  option: Scale,
};

/**
 * One asset class, read at a glance: what it is, how much of it there is, what
 * it is worth now, and which way it has moved.
 *
 * The whole card is the control. A row of small buttons is what a spreadsheet
 * does; a card somebody taps is what a phone does, and the drill-down is the
 * only thing there is to do here.
 */
export function AssetCategoryCard({ group, valueText, todayText, gainText, onOpen, showBalances }: {
  group: AssetCategoryGroup;
  valueText: string;
  todayText: string;
  gainText: string | null;
  onOpen: () => void;
  showBalances: boolean;
}) {
  const Icon = categoryIcon[group.key];
  return <button
    type="button"
    onClick={onOpen}
    data-testid={`asset-category-${group.key}`}
    className="flex min-h-[4.5rem] w-full min-w-0 items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] sm:p-4"
  >
    <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
      <Icon size={21} />
    </span>
    <span className="min-w-0 flex-1">
      <strong className="block truncate text-base font-bold text-[var(--text)]">{group.label}</strong>
      <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
        {group.count} รายการ
        {group.hasMissingPrices ? ' · บางรายการยังไม่มีราคา' : ''}
      </span>
    </span>
    <span className="min-w-0 shrink-0 text-right">
      <span className="block break-all font-mono text-base font-bold text-[var(--text)]">{valueText}</span>
      <span className={`mt-0.5 block break-all font-mono text-xs font-semibold ${portfolioReturnToneClass(showBalances ? group.todayChange : null, 'text-[var(--text-muted)]')}`}>
        {todayText}
      </span>
      {gainText && <span className={`mt-0.5 block break-all font-mono text-[11px] ${portfolioReturnToneClass(showBalances ? group.unrealizedGain : null, 'text-[var(--text-muted)]')}`}>
        รวม {gainText}
      </span>}
    </span>
    <ChevronRight aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" size={18} />
  </button>;
}
