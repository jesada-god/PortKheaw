'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import Image from 'next/image';
import { ArrowUpDown, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import { HOLDING_SORT_LABELS, type HoldingSortKey } from '@/src/lib/portfolio/holdings-sort';
import { gainColor } from '@/src/lib/portfolio/presentation';
import type { PortfolioSummary } from '@/src/lib/portfolio/types';

/**
 * A row that goes somewhere. Used for history and for portfolio management, so
 * both read as one destination rather than as a panel of controls competing
 * with the summary above them.
 */
export function NavRow({ icon, title, detail, href, onClick, testId }: {
  icon: ReactNode;
  title: string;
  detail: string;
  href?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const content = <>
    <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
      {icon}
    </span>
    <span className="min-w-0 flex-1">
      <strong className="block text-sm font-bold text-[var(--text)]">{title}</strong>
      <span className="mt-0.5 block text-xs text-[var(--text-muted)]">{detail}</span>
    </span>
    <ChevronRight aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" size={18} />
  </>;
  const className = 'panel flex min-h-16 w-full min-w-0 items-center gap-3 p-3.5 text-left transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
  if (href) return <Link href={href} className={className} data-testid={testId}>{content}</Link>;
  return <button type="button" onClick={onClick} className={className} data-testid={testId}>{content}</button>;
}

/**
 * The accounting, one tap down.
 *
 * Net deposits, market value, cost basis and realised profit are all still
 * derived from the same summary they always were — they have simply stopped
 * competing with the four figures somebody actually opens the app to read.
 * Nothing is removed; this is where it now lives.
 */
export function AccountingDetails({ summary, open, onToggle, money, signed, note }: {
  summary: PortfolioSummary;
  open: boolean;
  onToggle: () => void;
  money: (value: number | string | null) => string;
  signed: (value: number | null) => string;
  note?: ReactNode;
}) {
  return <section className="panel min-w-0 overflow-hidden" data-testid="portfolio-accounting-details">
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex min-h-16 w-full min-w-0 items-center gap-3 p-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-bold text-[var(--text)]">รายละเอียดพอร์ต</strong>
        <span className="mt-0.5 block text-xs text-[var(--text-muted)]">เงินฝากสุทธิ ต้นทุน มูลค่าตลาด และกำไรที่รับรู้แล้ว</span>
      </span>
      {open
        ? <ChevronUp aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" size={18} />
        : <ChevronDown aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" size={18} />}
    </button>
    {/*
      Accounting, so it is set as accounting: a band of hairline-separated
      cells rather than a loose grid of label/value pairs. Seven figures
      from one ledger belong to one object, and the rules say so while
      costing less vertical room than the gaps they replace.
    */}
    {open && <dl className="data-strip data-strip--4 min-w-0 border-t-[var(--border)]">
      <Figure label="เงินสด" value={money(summary.cashBalance)} />
      <Figure label="เงินฝากสุทธิ (Net deposits)" value={money(summary.netDepositedCapital)} />
      <Figure label="มูลค่าหุ้น" value={money(summary.equityMarketValue)} />
      <Figure label="มูลค่าออปชันสุทธิ" value={money(summary.optionsMarketValue)} />
      <Figure label="ต้นทุนคงเหลือ" value={money(summary.costBasis + summary.optionRemainingCost)} />
      <Figure label="Realized P&L" value={signed(summary.realizedGain)} tone={gainColor(summary.realizedGain)} />
      <Figure
        label="Unrealized P&L"
        value={signed(summary.unrealizedGain)}
        tone={summary.unrealizedGain === null ? 'text-[var(--text-muted)]' : gainColor(summary.unrealizedGain)}
      />
      {note && <div className="data-strip__cell col-span-2 text-xs leading-5 text-[var(--text-muted)] sm:col-span-3 lg:col-span-4">{note}</div>}
    </dl>}
  </section>;
}

function Figure({ label, value, tone = 'text-[var(--text)]' }: { label: string; value: string; tone?: string }) {
  return <div className="data-strip__cell min-w-0">
    <dt className="figure-label">{label}</dt>
    <dd className={`figure-data mt-1 break-all ${tone}`}>{value}</dd>
  </div>;
}

/** Compact sort control. Native `<select>` so a phone gets its own picker. */
export function SortControl({ value, onChange, options, id }: {
  value: HoldingSortKey;
  onChange: (value: HoldingSortKey) => void;
  options: readonly HoldingSortKey[];
  id: string;
}) {
  return <div className="flex min-w-0 items-center gap-2">
    <ArrowUpDown aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" size={15} />
    <label htmlFor={id} className="shrink-0 text-xs text-[var(--text-muted)]">เรียงตาม</label>
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value as HoldingSortKey)}
      className="min-h-10 min-w-0 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--input-bg)] px-2 text-sm font-semibold text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      {options.map((option) => <option key={option} value={option}>{HOLDING_SORT_LABELS[option]}</option>)}
    </select>
  </div>;
}

/**
 * An empty portfolio, drawn as a decision somebody has not made yet rather than
 * as a failure. The mascot is the same artwork the goal card uses, so the state
 * is unmistakably part of this product.
 *
 * It says what is missing and stops there. It used to carry an add button of its
 * own, which meant an empty screen showed the same call to action twice — once
 * in the header and once here. Adding lives in exactly one place on the page, so
 * this state has no action to take and no way to grow one.
 */
export function EmptyAssets({ title, description }: {
  title: string;
  description: string;
}) {
  return <div
    className="flex min-w-0 flex-col items-center rounded-[var(--radius-panel)] border border-dashed border-[var(--border-strong)] p-8 text-center"
    data-testid="portfolio-empty-state"
  >
    <Image
      alt=""
      aria-hidden="true"
      className="h-20 w-auto object-contain"
      height={512}
      sizes="80px"
      src="/brand/03_neutral.png"
      width={512}
    />
    <p className="mt-4 text-base font-bold text-[var(--text)]">{title}</p>
    <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">{description}</p>
  </div>;
}

export function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return <div className="section-head">
    <h3 className="section-head__name truncate">{title}</h3>
    <span aria-hidden="true" className="section-head__rule" />
    {action && <span className="section-head__action">{action}</span>}
  </div>;
}
