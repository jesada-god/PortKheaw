'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, Target } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import {
  formatPortfolioGoalTime,
  type PortfolioGoalCardModel,
  type PortfolioGoalScope,
} from '@/src/lib/portfolio/goal-card';
import {
  PortfolioGoalMascot,
  portfolioGoalAppearance,
  portfolioGoalReturnTone,
  portfolioGoalReturnToneClass,
} from './PortfolioGoalMascot';
import styles from './PortfolioGoalCard.module.css';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';

type Money = (value: number | string | null) => string;

export interface PortfolioGoalOption {
  id: string;
  name: string;
  assetCount: number;
}

export function PortfolioGoalCard({
  model,
  selectedPortfolioName,
  portfolios,
  selectedPortfolioId,
  showBalances,
  isOnline,
  money,
  signed,
  percent,
  onScopeChange,
  onSelectPortfolio,
  onEditGoal,
}: {
  model: PortfolioGoalCardModel;
  selectedPortfolioName: string;
  /** Every portfolio the reader can point the card at, in the page's order. */
  portfolios: PortfolioGoalOption[];
  selectedPortfolioId: string;
  showBalances: boolean;
  isOnline: boolean;
  money: Money;
  signed: (value: number | null) => string;
  percent: (value: number | null) => string;
  onScopeChange: (scope: PortfolioGoalScope) => void;
  onSelectPortfolio: (portfolioId: string) => void;
  onEditGoal: () => void;
}) {
  const moodAppearance = portfolioGoalAppearance[model.mascot.mood];
  const progressText = model.progress.progressPercent === null
    ? '—'
    : showBalances
      ? `${model.progress.progressPercent.toFixed(2)}%`
      : SENSITIVE_VALUE_MASK;
  const hasGoal = model.goal.targetValueUsd !== null;
  const cardStyle = {
    '--goal-accent': moodAppearance.accent,
    '--goal-accent-soft': moodAppearance.soft,
  } as CSSProperties;

  return <section
    aria-labelledby="portfolio-goal-title"
    className={`${styles.card} relative min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[linear-gradient(140deg,var(--surface-elevated),var(--surface))] p-4 shadow-[var(--shadow)] sm:p-5`}
    data-testid="portfolio-goal-card"
    data-scope={model.scope}
    data-today-state={model.today.kind}
    data-mood={model.mascot.mood}
    data-mood-source={model.mascot.source}
    data-special-event={model.mascot.specialEvent ?? 'none'}
    style={cardStyle}
  >
    <header className="relative flex min-w-0 flex-col gap-3 border-b border-[var(--border)] pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--goal-accent)]">Portfolio Goal</p>
        <h3 id="portfolio-goal-title" className="mt-1 text-lg font-bold text-[var(--text)]">เป้าหมายพอร์ต</h3>
        <p className="mt-1 break-words text-xs text-[var(--text-muted)]">
          {model.scope === 'aggregate' ? 'รวมทุกพอร์ต' : selectedPortfolioName}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="inline-flex min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1" aria-label="ขอบเขตเป้าหมายพอร์ต">
          {/*
            The left segment names a portfolio, so it has to be able to change
            which one — it used to only switch scope back to whichever portfolio
            was open elsewhere on the page, which made "พอร์ตที่เลือก" a label
            for a choice the reader could not make from here.
          */}
          <PortfolioScopeSelector
            active={model.scope === 'selected'}
            portfolios={portfolios}
            selectedPortfolioId={selectedPortfolioId}
            onSelect={onSelectPortfolio}
          />
          <button
            type="button"
            aria-pressed={model.scope === 'aggregate'}
            className={`min-h-9 min-w-0 rounded-md px-2.5 text-xs font-bold transition-colors ${model.scope === 'aggregate' ? 'bg-[var(--surface-selected)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
            onClick={() => onScopeChange('aggregate')}
          >พอร์ตรวม</button>
        </div>
        <Button size="sm" variant="outline" disabled={!isOnline} onClick={onEditGoal}>
          <Target aria-hidden="true" size={15} />
          {hasGoal ? 'แก้เป้าหมาย' : 'ตั้งเป้าหมาย'}
        </Button>
      </div>
    </header>

    {/*
      Kheaw sits in his own column from `lg` up, beside the progress rather than
      under it, and spans the metadata row so the mascot and the goal figures
      carry equal weight. Below `lg` the grid collapses to one column and he
      falls under the progress bar — never beside a number he could crowd.
    */}
    {!model.isEmpty ? <div className="relative mt-5 grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,15rem)] lg:items-start">
      <div className="min-w-0" data-testid="portfolio-goal-primary">
        <p className="text-xs font-medium text-[var(--text-muted)]">ความคืบหน้า</p>
        <p className="mt-1 break-words font-mono text-4xl font-black tracking-tight text-[var(--text)] sm:text-5xl">
          {progressText}
        </p>
        <div className="mt-5 grid min-w-0 gap-4 sm:grid-cols-2">
          <GoalMetric label="ยอดปัจจุบัน" value={money(model.currentValue)} />
          <GoalMetric label="เป้าหมาย" value={money(model.goal.targetValueUsd)} helper={!hasGoal ? 'ยังไม่ได้ตั้งเป้าหมาย' : undefined} />
        </div>
        <div
          aria-label={hasGoal ? 'แถบความคืบหน้าเป้าหมายพอร์ต' : 'ยังไม่ได้ตั้งเป้าหมายพอร์ต'}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={hasGoal && showBalances ? model.progressBarPercent : undefined}
          aria-valuetext={hasGoal ? progressText : 'ยังไม่ได้ตั้งเป้าหมาย'}
          className="mt-5 h-2.5 overflow-hidden rounded-full bg-[var(--surface-hover)]"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-[var(--goal-accent)] transition-[width] duration-500 motion-reduce:transition-none"
            data-testid="portfolio-goal-progress-fill"
            style={{ width: `${hasGoal && showBalances ? model.progressBarPercent : 0}%` }}
          />
        </div>
        {model.progress.reason && <p className="mt-2 text-xs text-[var(--warning)]">{model.progress.reason}</p>}
      </div>

      <aside className="min-w-0 text-center lg:row-span-2" data-testid="portfolio-goal-mascot">
        <div className="flex h-28 items-end justify-center sm:h-36 lg:h-44">
          <PortfolioGoalMascot state={model.mascot} />
        </div>
        <div className="min-h-24">
          {model.mascot.source === 'today' && model.today.kind === 'ready' && (
            <p
              className={`mt-3 break-words font-mono text-sm font-bold ${portfolioGoalReturnToneClass(showBalances ? model.today.percent : null, 'text-[var(--text)]')}`}
              data-return-tone={portfolioGoalReturnTone(showBalances ? model.today.percent : null)}
              data-testid="portfolio-goal-return"
            >
              วันนี้ {signed(model.today.amount)} ({percent(model.today.percent)})
            </p>
          )}
          {model.mascot.source === 'total' && (
            <p
              className={`mt-3 break-words font-mono text-sm font-bold ${portfolioGoalReturnToneClass(showBalances ? model.mascot.percent : null, 'text-[var(--text)]')}`}
              data-return-tone={portfolioGoalReturnTone(showBalances ? model.mascot.percent : null)}
              data-testid="portfolio-goal-return"
            >
              ผลตอบแทนรวม ({percent(model.mascot.percent)})
            </p>
          )}
          <p className={`${model.mascot.source === 'none' ? 'mt-3' : 'mt-1'} mx-auto max-w-72 text-sm leading-relaxed text-[var(--text-secondary)]`}>
            {model.mascot.message}
          </p>
        </div>
      </aside>

      <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)] sm:grid-cols-3 lg:col-start-1">
        <MetaMetric label="พอร์ตใช้งาน" value={`${model.activePortfolios}/${model.totalPortfolios}`} />
        <MetaMetric label="สินทรัพย์" value={`${model.assetCount} รายการ`} />
        <MetaMetric
          className="col-span-2 sm:col-span-1"
          label="อัปเดตล่าสุด"
          value={model.latestUpdatedAt ? formatPortfolioGoalTime(model.latestUpdatedAt) : 'ยังไม่มีเวลาที่ตรวจสอบได้'}
        />
      </dl>
    </div> : (
      /*
        A portfolio with nothing in it, which is a state to be met rather than
        reported on. The progress figure, the target, the return and the
        "last updated" line are all withheld — not blanked out — because a 0.00%
        against a goal reads as a portfolio that has gone nowhere rather than one
        that has not started. Kheaw and one sentence, centred, are the whole card.
      */
      <div
        className="relative mt-5 flex min-w-0 flex-col items-center justify-center gap-4 py-6 text-center"
        data-testid="portfolio-goal-empty"
      >
        <div className="flex h-28 items-end justify-center sm:h-36 lg:h-44" data-testid="portfolio-goal-mascot">
          <PortfolioGoalMascot state={model.mascot} />
        </div>
        <p className="mx-auto max-w-72 break-words text-base font-bold leading-relaxed text-[var(--text)]">
          {model.mascot.message}
        </p>
      </div>
    )}
  </section>;
}

/**
 * The "พอร์ตที่เลือก" segment, which both scopes the card and chooses what it is
 * scoped to.
 *
 * It keeps the segmented control's own styling — this is one of two segments in
 * a shared pill, not a select box dropped beside it — and adds only the chevron
 * that says it opens. Pressing it always points the card at a portfolio, so a
 * reader who opens the list and dismisses it still ends up in the scope the
 * button names.
 */
function PortfolioScopeSelector({
  active,
  portfolios,
  selectedPortfolioId,
  onSelect,
}: {
  active: boolean;
  portfolios: PortfolioGoalOption[];
  selectedPortfolioId: string;
  onSelect: (portfolioId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  return <span className="relative inline-flex min-w-0" ref={containerRef}>
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-pressed={active}
      className={`inline-flex min-h-9 min-w-0 items-center gap-1 rounded-md px-2.5 text-xs font-bold transition-colors ${active ? 'bg-[var(--surface-selected)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
      data-testid="portfolio-goal-scope-selected"
      onClick={() => {
        onSelect(selectedPortfolioId);
        setOpen((current) => !current);
      }}
    >
      พอร์ตที่เลือก
      <ChevronDown aria-hidden="true" className={open ? 'rotate-180 transition-transform' : 'transition-transform'} size={13} />
    </button>

    {open && <span
      aria-label="เลือกพอร์ตสำหรับเป้าหมาย"
      className="absolute right-0 top-[calc(100%+0.5rem)] z-20 max-h-64 w-56 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-1 shadow-[var(--shadow)]"
      data-testid="portfolio-goal-portfolio-list"
      role="listbox"
    >
      {portfolios.map((portfolio) => <button
        key={portfolio.id}
        type="button"
        aria-selected={portfolio.id === selectedPortfolioId}
        className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold transition-colors ${portfolio.id === selectedPortfolioId ? 'bg-[var(--surface-selected)] text-[var(--text)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'}`}
        data-testid={`portfolio-goal-option-${portfolio.id}`}
        role="option"
        onClick={() => {
          onSelect(portfolio.id);
          setOpen(false);
          triggerRef.current?.focus();
        }}
      >
        <Check
          aria-hidden="true"
          className={portfolio.id === selectedPortfolioId ? 'shrink-0 text-[var(--goal-accent)]' : 'shrink-0 opacity-0'}
          size={13}
        />
        <span className="min-w-0 flex-1 break-words">{portfolio.name}</span>
        <span className="shrink-0 text-[10px] font-medium text-[var(--text-muted)]">
          {portfolio.assetCount > 0 ? `${portfolio.assetCount} รายการ` : 'ยังไม่มีสินทรัพย์'}
        </span>
      </button>)}
    </span>}
  </span>;
}

function GoalMetric({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return <div className="min-w-0">
    <p className="text-xs font-medium text-[var(--text-muted)]">{label}</p>
    <p className="mt-1 break-words font-mono text-xl font-bold text-[var(--text)] sm:text-2xl">{value}</p>
    {helper && <p className="mt-1 text-xs text-[var(--text-muted)]">{helper}</p>}
  </div>;
}

function MetaMetric({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return <div className={`min-w-0 ${className}`}>
    <dt>{label}</dt>
    <dd className="mt-1 break-words font-medium text-[var(--text-secondary)]">{value}</dd>
  </div>;
}
