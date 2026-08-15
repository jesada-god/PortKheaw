'use client';

import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { formatPlanMoney, formatPlanPercent } from '@/src/lib/tools/stock-plan';
import {
  changeFromBaseline,
  horizonRemainingLabel,
  savedPlanStatus,
  SAVED_PLAN_STATUS_LABEL,
  type SavedPlanStatus,
} from '@/src/lib/tools/stock-plan-outlook';

/**
 * The plans a reader has saved, at the foot of the Planner.
 *
 * Deliberately not a dashboard. It is a list under the tool that made the rows,
 * showing three at a time because a reader who saved eleven plans wants to see
 * the recent ones and then decide, not to scroll past all eleven to reach the
 * form.
 *
 * The status wording is the careful part. Each label is decided by
 * {@link savedPlanStatus} from the plan's own row plus one current price, and
 * every one of them is a statement about *now*: "ถึงระดับเป้าหมายในปัจจุบัน", not
 * "ถึงเป้าหมายแล้ว". The app stores plans, not price histories, so a claim that
 * the stock touched a level at some point since the plan was saved would have
 * nothing behind it — and a reader would reasonably act on it.
 */

export interface SavedPlanView {
  id: string;
  symbol: string;
  baselinePrice: number;
  targetPrice: number;
  invalidationPrice: number;
  horizonDate: string;
  createdAt: string;
}

const STATUS_TONE: Readonly<Record<SavedPlanStatus, string>> = {
  tracking: 'bg-slate-800 text-slate-300',
  'at-target': 'bg-[var(--positive)]/15 text-[var(--positive)]',
  'below-invalidation': 'bg-[var(--negative)]/15 text-[var(--negative)]',
  expired: 'bg-amber-500/15 text-amber-300',
};

const PREVIEW_COUNT = 3;

export function SavedStockPlans({
  plans, prices, today, currency, busyId, onEdit, onDelete,
}: {
  plans: readonly SavedPlanView[];
  /** Current accepted price per symbol, when the planner has one. */
  prices: Readonly<Record<string, number | null>>;
  today: string;
  currency: string;
  /** The plan currently being written, so its own row can show the wait. */
  busyId: string | null;
  onEdit: (plan: SavedPlanView) => void;
  onDelete: (plan: SavedPlanView) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (plans.length === 0) {
    return (
      <p data-testid="saved-plans-empty" className="min-w-0 break-words text-sm text-slate-400">
        ยังไม่มีแผนที่บันทึกไว้ เมื่อวิเคราะห์แผนแล้วกด “บันทึกแผน” แผนจะมาแสดงที่นี่
      </p>
    );
  }

  const visible = expanded ? plans : plans.slice(0, PREVIEW_COUNT);

  return (
    <div className="min-w-0">
      <ul data-testid="saved-plans-list" className="min-w-0 space-y-3">
        {visible.map((plan) => {
          const price = prices[plan.symbol] ?? null;
          const status = savedPlanStatus({
            targetPrice: plan.targetPrice,
            invalidationPrice: plan.invalidationPrice,
            horizonDate: plan.horizonDate,
            currentPrice: price,
            today,
          });
          const drift = changeFromBaseline(plan.baselinePrice, price);
          const confirming = confirmingId === plan.id;
          const busy = busyId === plan.id;
          return (
            <li
              key={plan.id}
              data-testid={`saved-plan-${plan.symbol}`}
              data-status={status}
              className="min-w-0 rounded-xl border border-slate-800 bg-[#0A0E17] p-3"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="min-w-0 break-words text-sm font-bold text-white">{plan.symbol}</p>
                  <p className="min-w-0 break-words text-[11px] text-slate-500">
                    {horizonRemainingLabel(plan.horizonDate, today)} · ถึง {plan.horizonDate}
                  </p>
                </div>
                <span className={`shrink-0 rounded px-2 py-1 text-[10px] font-semibold ${STATUS_TONE[status]}`}>
                  {SAVED_PLAN_STATUS_LABEL[status]}
                </span>
              </div>

              <dl className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
                <PlanFigure label="ราคาตั้งต้น" value={formatPlanMoney(plan.baselinePrice, currency)} />
                <PlanFigure label="เป้าหมาย" value={formatPlanMoney(plan.targetPrice, currency)} tone="positive" />
                <PlanFigure label="ระดับที่แผนไม่เป็นไปตามคาด" value={formatPlanMoney(plan.invalidationPrice, currency)} tone="negative" />
                {/*
                  Measured from the plan's stored baseline against today's accepted
                  price — the two numbers the row already shows, so the reader can
                  check it by eye. Omitted rather than guessed when there is no price.
                */}
                <PlanFigure
                  label="เทียบราคาตั้งต้น"
                  value={drift === null ? 'ไม่มีข้อมูล' : `${drift >= 0 ? '+' : ''}${formatPlanPercent(drift)}`}
                  tone={drift === null ? undefined : drift < 0 ? 'negative' : 'positive'}
                />
              </dl>

              {confirming ? (
                <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words text-xs text-slate-300">ลบแผนนี้ออกจากรายการ?</span>
                  <button
                    type="button"
                    data-testid={`saved-plan-confirm-delete-${plan.symbol}`}
                    disabled={busy}
                    onClick={() => { setConfirmingId(null); onDelete(plan); }}
                    className="min-h-[36px] shrink-0 rounded-lg bg-[var(--negative)]/20 px-3 text-xs font-semibold text-[var(--negative)] disabled:opacity-60"
                  >
                    {busy ? 'กำลังลบ…' : 'ลบแผน'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingId(null)}
                    className="min-h-[36px] shrink-0 rounded-lg border border-slate-700 px-3 text-xs text-slate-300"
                  >
                    ยกเลิก
                  </button>
                </div>
              ) : (
                <div className="mt-3 flex min-w-0 flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid={`saved-plan-edit-${plan.symbol}`}
                    onClick={() => onEdit(plan)}
                    className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs text-slate-200"
                  >
                    <Pencil aria-hidden="true" size={13} /> แก้ไข
                  </button>
                  <button
                    type="button"
                    data-testid={`saved-plan-delete-${plan.symbol}`}
                    onClick={() => setConfirmingId(plan.id)}
                    className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 px-3 text-xs text-slate-400"
                  >
                    <Trash2 aria-hidden="true" size={13} /> ลบ
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {plans.length > PREVIEW_COUNT && (
        <button
          type="button"
          data-testid="saved-plans-toggle"
          onClick={() => setExpanded((value) => !value)}
          className="mt-3 min-h-[44px] break-words text-sm font-medium text-[#D4FF00]"
        >
          {expanded ? 'ย่อรายการ' : `ดูทั้งหมด (${plans.length})`}
        </button>
      )}
    </div>
  );
}

function PlanFigure({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'negative' }) {
  const toneClass = tone === 'positive'
    ? 'text-[var(--positive)]'
    : tone === 'negative' ? 'text-[var(--negative)]' : 'text-slate-200';
  return (
    <div className="min-w-0">
      <dt className="break-words text-[10px] leading-4 text-slate-500">{label}</dt>
      <dd className={`mt-0.5 break-words font-mono text-xs font-semibold ${toneClass}`}>{value}</dd>
    </div>
  );
}

export default SavedStockPlans;
