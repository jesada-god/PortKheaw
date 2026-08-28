'use client';

import type { ReactNode } from 'react';
import { Eye, EyeOff, PencilLine } from 'lucide-react';
import { portfolioReturnToneClass } from '@/src/lib/portfolio/presentation';
import type { SupportedCurrency } from '@/src/lib/market-data/fx/types';

export interface HeroAllocationSlice {
  key: string;
  label: string;
  percent: number;
  /** A CSS colour expression, always a theme token so the bar follows the appearance. */
  color: string;
}

/**
 * The one headline card, used by the tracker home and by a portfolio's detail
 * screen.
 *
 * It carries the four figures somebody opens this app to read — what it is
 * worth, when that was true, what today did, and what the position is up or
 * down overall — and nothing else. Cost basis, net deposits and realised
 * profit are accounting, and accounting lives one tap down in
 * "รายละเอียดพอร์ต".
 *
 * Every number arrives already formatted by the caller's `money`/`signed`
 * helpers, which are the same ones the rest of the portfolio uses, so currency
 * conversion and privacy masking cannot diverge between this card and the rows
 * below it.
 */
export function TrackerHero({
  label,
  value,
  updatedAtLabel,
  todayChange,
  todayChangeLabel,
  todayChangeCaption,
  todayChangeText,
  totalGain,
  totalGainText,
  totalGainLabel = 'กำไร/ขาดทุนรวม',
  currency,
  onCurrencyChange,
  currencyDisabled = false,
  thbDisabled = false,
  showBalances,
  onToggleBalances,
  onEditValue,
  editDisabled = false,
  allocation = [],
  notes,
  footer,
  children,
  testId,
}: {
  label: string;
  value: string;
  updatedAtLabel: string | null;
  todayChange: number | null;
  /** "กำไร/ขาดทุนวันนี้", or the same phrase naming the day the close came from. */
  todayChangeLabel: string;
  /** One sentence saying where the figure came from. Always shown. */
  todayChangeCaption: string;
  todayChangeText: string;
  totalGain: number | null;
  totalGainText: string;
  totalGainLabel?: string;
  currency: SupportedCurrency;
  onCurrencyChange?: (currency: SupportedCurrency) => void;
  currencyDisabled?: boolean;
  thbDisabled?: boolean;
  showBalances: boolean;
  /** Rendered only where the screen has no header of its own to carry it. */
  onToggleBalances?: () => void;
  onEditValue?: () => void;
  editDisabled?: boolean;
  allocation?: HeroAllocationSlice[];
  notes?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return <section
    className="panel-hero overflow-hidden"
    data-testid={testId}
  >
    <div className="p-4 sm:p-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p className="section-eyebrow mb-0">{label}</p>
        {onCurrencyChange && <div className="inline-flex rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-elevated)] p-0.5" aria-label="สกุลเงินที่แสดง">
          {(['USD', 'THB'] as const).map((item) => <button
            key={item}
            type="button"
            disabled={currencyDisabled || (item === 'THB' && thbDisabled)}
            onClick={() => onCurrencyChange(item)}
            className={`min-h-9 rounded-[var(--radius-mark)] px-3 text-xs font-bold transition-colors ${currency === item
              ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40'}`}
          >{item}</button>)}
        </div>}
      </div>

      <div className="mt-2 flex min-w-0 items-center gap-1">
        <h2 className="figure-hero min-w-0 break-all">{value}</h2>
        {onEditValue && <button
          type="button"
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-40"
          disabled={editDisabled}
          onClick={onEditValue}
          aria-label="ปรับยอดพอร์ต"
          data-testid="portfolio-value-edit"
        ><PencilLine size={18} /></button>}
        {onToggleBalances && <button
          type="button"
          className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          onClick={onToggleBalances}
          aria-label={showBalances ? 'ซ่อนยอดเงินทั้งหมด' : 'แสดงยอดเงินชั่วคราว'}
          aria-pressed={!showBalances}
        >{showBalances ? <EyeOff size={19} /> : <Eye size={19} />}</button>}
      </div>

      {updatedAtLabel && <p className="mt-1 text-xs text-[var(--text-muted)]">อัปเดต {updatedAtLabel}</p>}

      {/*
        Two figures, side by side at every width. Masking passes `null` to the
        tone helper on purpose: a green number behind "••••" still says which
        way the portfolio moved.
      */}
      <dl className="mt-4 grid min-w-0 grid-cols-2 gap-3">
        <HeroFigure
          label={todayChangeLabel}
          value={todayChangeText}
          tone={portfolioReturnToneClass(showBalances ? todayChange : null, 'text-[var(--text-secondary)]')}
        />
        <HeroFigure
          label={totalGainLabel}
          value={totalGainText}
          tone={portfolioReturnToneClass(showBalances ? totalGain : null, 'text-[var(--text-secondary)]')}
        />
      </dl>
      {/*
        The caption sits under BOTH figures rather than inside the day tile: it
        is a sentence, and a sentence wrapped into a half-width tile on a handset
        pushes the number it explains off its own line.
      */}
      <p className="mt-2 text-[11px] leading-4 text-[var(--text-muted)]">{todayChangeCaption}</p>

      {allocation.length > 0 && showBalances && <div className="mt-5">
        <div className="flex h-2 min-w-0 overflow-hidden rounded-full bg-[var(--surface-hover)]" aria-hidden="true">
          {allocation.map((slice) => <span
            key={slice.key}
            className="h-full"
            style={{ width: `${slice.percent}%`, backgroundColor: slice.color }}
          />)}
        </div>
        {/* The legend names every slice, so the bar is never the only way to
            read the split. */}
        <ul className="mt-2 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
          {allocation.map((slice) => <li key={slice.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
            {slice.label} {slice.percent.toFixed(0)}%
          </li>)}
        </ul>
      </div>}

      {notes}
      {children}
    </div>
    {footer}
  </section>;
}

function HeroFigure({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div className="min-w-0">
    <dt className="figure-label">{label}</dt>
    {/*
      One rank under the portfolio total, matching the overview's treatment of
      the same two figures. They were `text-sm` — the size of a caption — which
      left the card's headline value with nothing beneath it to rank against.
    */}
    <dd className={`figure-lead mt-1 break-words ${tone}`}>{value}</dd>
  </div>;
}
