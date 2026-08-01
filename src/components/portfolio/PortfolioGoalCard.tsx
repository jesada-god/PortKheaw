'use client';

import type { CSSProperties } from 'react';
import { Target } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import {
  formatPortfolioGoalTime,
  type PortfolioGoalCardModel,
  type PortfolioGoalScope,
} from '@/src/lib/portfolio/goal-card';
import {
  PortfolioGoalMascot,
  portfolioGoalAppearance,
} from './PortfolioGoalMascot';
import styles from './PortfolioGoalCard.module.css';

type Money = (value: number | string | null) => string;

export function PortfolioGoalCard({
  model,
  selectedPortfolioName,
  showBalances,
  isOnline,
  money,
  signed,
  percent,
  onScopeChange,
  onEditGoal,
}: {
  model: PortfolioGoalCardModel;
  selectedPortfolioName: string;
  showBalances: boolean;
  isOnline: boolean;
  money: Money;
  signed: (value: number | null) => string;
  percent: (value: number | null) => string;
  onScopeChange: (scope: PortfolioGoalScope) => void;
  onEditGoal: () => void;
}) {
  const moodAppearance = portfolioGoalAppearance[model.today.mood];
  const progressText = model.progress.progressPercent === null
    ? '—'
    : showBalances
      ? `${model.progress.progressPercent.toFixed(2)}%`
      : '••••';
  const hasGoal = model.goal.targetValueUsd !== null;
  const cardStyle = {
    '--goal-accent': moodAppearance.accent,
    '--goal-accent-soft': moodAppearance.soft,
  } as CSSProperties;

  return <section
    aria-labelledby="portfolio-goal-title"
    className={`${styles.card} relative overflow-hidden rounded-2xl border border-slate-800/80 bg-gradient-to-br from-[#151B28] to-[#0A0E17] p-4 shadow-xl sm:p-5`}
    data-testid="portfolio-goal-card"
    data-scope={model.scope}
    data-today-state={model.today.kind}
    data-mood={model.today.mood}
    style={cardStyle}
  >
    <header className="relative flex min-w-0 flex-col gap-3 border-b border-slate-800/70 pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--goal-accent)]">Portfolio Goal</p>
        <h3 id="portfolio-goal-title" className="mt-1 text-lg font-bold text-white">เป้าหมายพอร์ต</h3>
        <p className="mt-1 break-words text-xs text-slate-400">
          {model.scope === 'aggregate' ? 'รวมทุกพอร์ต' : selectedPortfolioName}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="inline-flex min-w-0 rounded-lg border border-slate-700 bg-slate-950/60 p-1" aria-label="ขอบเขตเป้าหมายพอร์ต">
          {([
            ['selected', 'พอร์ตที่เลือก'],
            ['aggregate', 'พอร์ตรวม'],
          ] as const).map(([scope, label]) => <button
            key={scope}
            type="button"
            aria-pressed={model.scope === scope}
            className={`min-h-9 min-w-0 rounded-md px-2.5 text-xs font-bold transition-colors ${model.scope === scope ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
            onClick={() => onScopeChange(scope)}
          >{label}</button>)}
        </div>
        <Button size="sm" variant="outline" disabled={!isOnline} onClick={onEditGoal}>
          <Target aria-hidden="true" size={15} />
          {hasGoal ? 'แก้เป้าหมาย' : 'ตั้งเป้าหมาย'}
        </Button>
      </div>
    </header>

    <div className="relative mt-5 grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_220px] lg:items-center">
      <div className="min-w-0" data-testid="portfolio-goal-primary">
        <p className="text-xs font-medium text-slate-400">ความคืบหน้า</p>
        <p className="mt-1 break-words font-mono text-4xl font-black tracking-tight text-white sm:text-5xl">
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
          className="mt-5 h-2.5 overflow-hidden rounded-full bg-slate-800"
          role="progressbar"
        >
          <div
            className="h-full rounded-full bg-[var(--goal-accent)] transition-[width] duration-500 motion-reduce:transition-none"
            data-testid="portfolio-goal-progress-fill"
            style={{ width: `${hasGoal && showBalances ? model.progressBarPercent : 0}%` }}
          />
        </div>
        {model.progress.reason && <p className="mt-2 text-xs text-amber-300">{model.progress.reason}</p>}
      </div>

      <aside className="min-w-0 text-center lg:row-span-2" data-testid="portfolio-goal-mascot">
        <div className="flex h-20 items-end justify-center sm:h-24 lg:h-28">
          <PortfolioGoalMascot mood={model.today.mood} />
        </div>
        {model.today.kind === 'ready'
          ? <>
            <p className="mt-3 break-words font-mono text-sm font-bold text-white">
              วันนี้ {signed(model.today.amount)} ({percent(model.today.percent)})
            </p>
            <p className="mx-auto mt-1 max-w-64 text-sm leading-relaxed text-slate-300">{model.today.message}</p>
          </>
          : <>
            <p className="mt-3 font-bold text-white">{model.today.title}</p>
            <p className="mx-auto mt-1 max-w-72 text-sm leading-relaxed text-slate-400">{model.today.message}</p>
          </>}
      </aside>

      <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-800/70 pt-4 text-xs text-slate-400 sm:grid-cols-3 lg:col-start-1">
        <MetaMetric label="พอร์ตใช้งาน" value={`${model.activePortfolios}/${model.totalPortfolios}`} />
        <MetaMetric label="สินทรัพย์" value={`${model.assetCount} รายการ`} />
        <MetaMetric
          className="col-span-2 sm:col-span-1"
          label="อัปเดตล่าสุด"
          value={model.latestUpdatedAt ? formatPortfolioGoalTime(model.latestUpdatedAt) : 'ยังไม่มีเวลาที่ตรวจสอบได้'}
        />
      </dl>
    </div>
  </section>;
}

function GoalMetric({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return <div className="min-w-0">
    <p className="text-xs font-medium text-slate-400">{label}</p>
    <p className="mt-1 break-words font-mono text-xl font-bold text-white sm:text-2xl">{value}</p>
    {helper && <p className="mt-1 text-xs text-slate-500">{helper}</p>}
  </div>;
}

function MetaMetric({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return <div className={`min-w-0 ${className}`}>
    <dt>{label}</dt>
    <dd className="mt-1 break-words font-medium text-slate-300">{value}</dd>
  </div>;
}
