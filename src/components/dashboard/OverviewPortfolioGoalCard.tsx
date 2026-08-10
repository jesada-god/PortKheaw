'use client';

import type { CSSProperties } from 'react';
import {
  formatPortfolioGoalTime,
  type PortfolioGoalCardModel,
} from '@/src/lib/portfolio/goal-card';
import {
  PortfolioGoalMascot,
  portfolioGoalAppearance,
  portfolioGoalReturnTone,
  portfolioGoalReturnToneClass,
} from '@/src/components/portfolio/PortfolioGoalMascot';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';

export function OverviewPortfolioGoalCard({
  model,
  money,
  signed,
  percent,
  showBalances,
}: {
  model: PortfolioGoalCardModel;
  money: (value: number | null) => string;
  signed: (value: number | null) => string;
  percent: (value: number | null) => string;
  showBalances: boolean;
}) {
  const appearance = portfolioGoalAppearance[model.mascot.mood];
  const hasGoal = model.goal.targetValueUsd !== null;
  const progress = model.progress.progressPercent;
  const progressText = progress === null
    ? '—'
    : showBalances ? `${progress.toFixed(2)}%` : SENSITIVE_VALUE_MASK;
  const style = {
    '--goal-accent': appearance.accent,
    '--goal-accent-soft': appearance.soft,
  } as CSSProperties;

  return <section
    aria-labelledby="overview-portfolio-goal-title"
    className="relative min-w-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3"
    data-testid="overview-portfolio-goal-card"
    data-today-state={model.today.kind}
    data-mood={model.mascot.mood}
    data-mood-source={model.mascot.source}
    data-special-event={model.mascot.specialEvent ?? 'none'}
    style={style}
  >
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -bottom-16 -right-16 h-48 w-48 rounded-full bg-[radial-gradient(circle,var(--goal-accent-soft)_0%,transparent_68%)]"
    />
    {model.isEmpty ? (
      /*
        The same withholding as the full card, at tile size: a portfolio holding
        nothing has no progress to draw and no return to state, so Kheaw and the
        one sentence are the tile.
      */
      <div
        className="relative flex min-w-0 flex-col items-center justify-center gap-2 py-3 text-center"
        data-testid="overview-portfolio-goal-empty"
      >
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--goal-accent)]">Portfolio Goal</p>
        <h2 id="overview-portfolio-goal-title" className="sr-only">เป้าหมายพอร์ต</h2>
        <div data-testid="overview-portfolio-goal-mascot">
          <PortfolioGoalMascot compact state={model.mascot} />
        </div>
        <p className="mx-auto max-w-60 break-words text-xs font-bold leading-5 text-[var(--text)]">
          {model.mascot.message}
        </p>
      </div>
    ) : <>
    <div className="relative grid min-w-0 grid-cols-[minmax(0,1fr)_72px] gap-3 sm:grid-cols-[minmax(0,1fr)_88px] lg:grid-cols-[minmax(0,1fr)_104px]">
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--goal-accent)]">Portfolio Goal</p>
        <div className="mt-1 flex min-w-0 items-end justify-between gap-2">
          <h2 id="overview-portfolio-goal-title" className="min-w-0 text-sm font-bold text-[var(--text)]">เป้าหมายพอร์ต</h2>
          <span className="shrink-0 font-mono text-lg font-black text-[var(--text)]">{progressText}</span>
        </div>
        <div
          aria-label={hasGoal ? 'แถบความคืบหน้าเป้าหมายพอร์ต' : 'ยังไม่ได้ตั้งเป้าหมายพอร์ต'}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={hasGoal && showBalances ? model.progressBarPercent : undefined}
          aria-valuetext={hasGoal ? progressText : 'ยังไม่ได้ตั้งเป้าหมาย'}
          className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-selected)]"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-[var(--goal-accent)]"
            style={{ width: `${hasGoal && showBalances ? model.progressBarPercent : 0}%` }}
          />
        </div>
      </div>
      <div className="row-span-2 flex items-start justify-center" data-testid="overview-portfolio-goal-mascot">
        <PortfolioGoalMascot compact state={model.mascot} />
      </div>

      <dl className="grid min-w-0 grid-cols-2 gap-2 text-xs">
        <GoalMetric label="ยอดปัจจุบัน" value={money(model.currentValue)} />
        <GoalMetric
          label="ยอดเป้าหมาย"
          value={hasGoal ? money(model.goal.targetValueUsd) : 'ยังไม่ได้ตั้งเป้าหมาย'}
        />
      </dl>
    </div>

    <div className="relative mt-3 min-h-[6.5rem] rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5">
      {model.mascot.source === 'today' && model.today.kind === 'ready' && <>
        <p className="text-[10px] text-[var(--text-muted)]">Today P/L</p>
        <p
          className={`mt-0.5 break-words font-mono text-sm font-bold ${portfolioGoalReturnToneClass(showBalances ? model.today.percent : null, 'text-[var(--text)]')}`}
          data-return-tone={portfolioGoalReturnTone(showBalances ? model.today.percent : null)}
          data-testid="overview-portfolio-goal-return"
        >
          {signed(model.today.amount)} ({percent(model.today.percent)})
        </p>
      </>}
      {model.mascot.source === 'total' && <>
        <p className="text-[10px] text-[var(--text-muted)]">ผลตอบแทนรวม</p>
        <p
          className={`mt-0.5 break-words font-mono text-sm font-bold ${portfolioGoalReturnToneClass(showBalances ? model.mascot.percent : null, 'text-[var(--text)]')}`}
          data-return-tone={portfolioGoalReturnTone(showBalances ? model.mascot.percent : null)}
          data-testid="overview-portfolio-goal-return"
        >
          {percent(model.mascot.percent)}
        </p>
      </>}
      <p className={`${model.mascot.source === 'none' ? '' : 'mt-1'} text-xs leading-5 text-[var(--text-secondary)]`}>
        {model.mascot.message}
      </p>
    </div>

    <dl className="relative mt-3 grid min-w-0 grid-cols-2 gap-2 border-t border-[var(--border)] pt-3 text-[10px] text-[var(--text-muted)]">
      <GoalMeta label="พอร์ตใช้งาน" value={`${model.activePortfolios}/${model.totalPortfolios}`} />
      <GoalMeta label="สินทรัพย์" value={`${model.assetCount} รายการ`} />
      <GoalMeta
        className="col-span-2"
        label="อัปเดตล่าสุด"
        value={model.latestUpdatedAt
          ? formatPortfolioGoalTime(model.latestUpdatedAt)
          : 'ยังไม่มีเวลาที่ตรวจสอบได้'}
      />
    </dl>
    </>}
  </section>;
}

function GoalMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0">
    <dt className="text-[10px] text-[var(--text-muted)]">{label}</dt>
    <dd className="mt-0.5 break-words font-mono font-bold text-[var(--text)]">{value}</dd>
  </div>;
}

function GoalMeta({ label, value, className = '' }: {
  label: string;
  value: string;
  className?: string;
}) {
  return <div className={`min-w-0 ${className}`}>
    <dt>{label}</dt>
    <dd className="mt-0.5 break-words font-medium text-[var(--text-secondary)]">{value}</dd>
  </div>;
}
