'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Tabs } from '@/src/components/ui/Tabs';
import type { EquityToolContext } from '@/src/lib/tools/handoff';
import {
  formatPlanMoney,
  formatPlanPercent,
  formatPlanShares,
  formatRiskRewardRatio,
  type StockPlanEvaluation,
  type StockPlanField,
  type StockPlanSizingMode,
} from '@/src/lib/tools/stock-plan';

/**
 * ดูรายละเอียด — everything the first screen deliberately does not show.
 *
 * Collapsed by default, and it stays collapsed until the reader asks: the four
 * answers above it are the tool, and this is the depth behind them. Two things
 * live here.
 *
 * **Reference levels the app already computes.** Support and resistance come from
 * `/api/market/chart-levels`, the same classic-pivot service the charts read.
 * They are fetched only when the section is actually opened, so a reader who
 * never expands it costs nothing, and they are omitted entirely when the service
 * has nothing — an absent level is left absent rather than filled in with a
 * placeholder that reads like a number.
 *
 * Fair Value is deliberately not here. This codebase has no canonical valuation
 * service to read one from, and the Planner is not allowed to invent a second
 * one — so the row is omitted rather than approximated from something adjacent.
 *
 * **The position sizing this tool shipped with.** Budget-or-shares, and the money
 * the plan costs and pays at each exit. It is still computed by
 * `evaluateStockPlan`, and still fed by the portfolio handoff. It stays down here
 * because it answers a different question from the four above — how big, rather
 * than whether — and a first screen that asked both asked too much.
 *
 * The entry price it sizes from is asked for on the form now rather than here:
 * ผลตอบแทนจำลอง is measured from it too, and one number two screens depend on
 * cannot live behind a disclosure. It is the same state, so the money below is
 * still priced from the reader's own entry and never from the baseline. So is the
 * budget: typing an amount here and typing it in จำนวนเงินที่ต้องการลงทุน above
 * are the same act, and there is no second amount that can disagree with it.
 */

interface PivotLevels {
  pivot: number;
  resistance: number[];
  support: number[];
}

const SIZING_TABS: Readonly<Record<string, StockPlanSizingMode>> = {
  'เงินที่ต้องการลงทุน': 'budget',
  'จำนวนหุ้น': 'shares',
};
const SIZING_LABEL: Readonly<Record<StockPlanSizingMode, string>> = {
  budget: 'เงินที่ต้องการลงทุน',
  shares: 'จำนวนหุ้น',
};

export function PlanDetails({
  symbol, currency, horizonDate,
  sizingMode, onSizingModeChange, sizeDraft, onSizeChange, evaluation, holding,
}: {
  symbol: string;
  currency: string;
  horizonDate: string | null;
  sizingMode: StockPlanSizingMode;
  onSizingModeChange: (mode: StockPlanSizingMode) => void;
  sizeDraft: string;
  onSizeChange: (value: string) => void;
  evaluation: StockPlanEvaluation;
  holding: EquityToolContext | null;
}) {
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<PivotLevels | null>(null);
  /*
    Which symbol has already been asked for, held in a ref rather than in state.
    As state it was part of this effect's own dependencies, so setting it re-ran
    the effect, which ran the previous run's cleanup, which set that run's
    `cancelled` flag — and the response it was waiting for was thrown away on
    arrival. The levels never appeared and nothing reported an error.

    There is no reset-on-symbol-change effect to go with it: the parent gives
    this component a `key` of the symbol, so a new stock remounts it and both the
    levels and the open/closed state start fresh without a render to undo.
  */
  const requestedFor = useRef<string | null>(null);

  /* Fetched on first open only, and never again for the same symbol. */
  useEffect(() => {
    if (!open || !symbol || requestedFor.current === symbol) return;
    requestedFor.current = symbol;
    const forSymbol = symbol;
    void (async () => {
      try {
        const response = await fetch(`/api/market/chart-levels?symbol=${encodeURIComponent(forSymbol)}&timeframe=1D`);
        if (!response.ok) return;
        const payload = await response.json() as { data?: PivotLevels };
        // Guarded on the symbol rather than on a cleanup flag: a late response
        // for a stock the reader has moved on from is dropped, and one for the
        // stock still on screen is kept however the effect was re-run.
        if (requestedFor.current === forSymbol && payload.data) setLevels(payload.data);
      } catch { /* omitted rather than guessed */ }
    })();
  }, [open, symbol]);

  const { levels: planLevels, position, issues } = evaluation;
  function issueFor(field: StockPlanField): string | null {
    return issues.find((item) => item.field === field)?.message ?? null;
  }

  return (
    <div className="mt-6 min-w-0 border-t border-slate-800 pt-4">
      <button
        type="button"
        data-testid="stock-planner-details-toggle"
        aria-expanded={open}
        aria-controls="stock-planner-details"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full min-w-0 items-center justify-between gap-2 text-sm font-medium text-slate-200"
      >
        <span className="min-w-0 break-words">ดูรายละเอียด</span>
        <ChevronDown
          aria-hidden="true" size={18}
          className={`shrink-0 text-slate-400 transition-transform motion-safe:duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div id="stock-planner-details" data-testid="stock-planner-details" className="mt-4 min-w-0 space-y-5">
          {horizonDate && (
            <div className="min-w-0">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">ระยะเวลาของแผน</h4>
              <p className="mt-1 min-w-0 break-words font-mono text-sm text-slate-200">{horizonDate}</p>
            </div>
          )}

          {levels && (
            <div className="min-w-0" data-testid="stock-planner-sr">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">แนวรับ / แนวต้าน</h4>
              <p className="mt-1 break-words text-[11px] text-slate-500">
                จากบริการแนวรับแนวต้านเดิมของระบบ (Classic Pivot รายวัน) ไม่ใช่การคำนวณใหม่ในเครื่องมือนี้
              </p>
              <dl className="mt-2 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
                <LevelFigure label="แนวต้าน R1" value={formatPlanMoney(levels.resistance[0], currency)} tone="negative" />
                <LevelFigure label="แนวต้าน R2" value={formatPlanMoney(levels.resistance[1], currency)} tone="negative" />
                <LevelFigure label="แนวรับ S1" value={formatPlanMoney(levels.support[0], currency)} tone="positive" />
                <LevelFigure label="แนวรับ S2" value={formatPlanMoney(levels.support[1], currency)} tone="positive" />
              </dl>
            </div>
          )}

          {/* ---- The sizing planner this tool shipped with, unchanged. ---- */}
          <div className="min-w-0">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">ขนาดเงินลงทุน</h4>
            <p className="mt-1 break-words text-[11px] leading-5 text-slate-500">
              ขนาดของแผนนี้ คิดจากราคาเข้าที่คุณกรอกไว้ด้านบน ไม่ใช่ราคาปัจจุบัน
              จะระบุเป็นเงินหรือเป็นจำนวนหุ้นก็ได้
            </p>

            <Tabs
              className="mt-3"
              tabs={Object.keys(SIZING_TABS)}
              activeTab={SIZING_LABEL[sizingMode]}
              onChange={(tab) => onSizingModeChange(SIZING_TABS[tab] ?? 'budget')}
            />

            <div className="mt-3 min-w-0 sm:max-w-xs">
              <label className="block min-w-0" htmlFor="stock-planner-size">
                <span className="text-sm font-medium text-slate-200">{SIZING_LABEL[sizingMode]}</span>
                <input
                  id="stock-planner-size" data-testid="stock-planner-size"
                  className="form-input mt-1.5" inputMode="decimal" autoComplete="off"
                  placeholder={sizingMode === 'budget' ? `เช่น 1,000 (${currency})` : 'เช่น 10'}
                  value={sizeDraft} onChange={(event) => onSizeChange(event.target.value)}
                  aria-invalid={issueFor('size') ? true : undefined}
                />
              </label>
              {issueFor('size') && (
                <p role="alert" className="mt-1 break-words text-xs text-amber-300">{issueFor('size')}</p>
              )}
            </div>

            {planLevels && (
              <dl className="mt-4 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3" data-testid="stock-planner-entry-levels">
                <LevelFigure label="ความเสี่ยงจากจุดเข้า" value={`-${formatPlanPercent(planLevels.riskPercent)}`} tone="negative" />
                <LevelFigure label="ผลตอบแทนจากจุดเข้า" value={`+${formatPlanPercent(planLevels.rewardPercent)}`} tone="positive" />
                <LevelFigure label="Risk / Reward จากจุดเข้า" value={formatRiskRewardRatio(planLevels.rewardToRisk)} />
              </dl>
            )}

            {position && (
              <dl className="mt-3 grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4" data-testid="stock-planner-position">
                <LevelFigure label="จำนวนหุ้นโดยประมาณ" value={formatPlanShares(position.shares)} />
                <LevelFigure label="มูลค่าที่ใช้" value={formatPlanMoney(position.cost, currency)} />
                <LevelFigure label="ขาดทุนหากหลุดแผน" value={formatPlanMoney(position.lossAtStop, currency)} tone="negative" />
                <LevelFigure label="กำไรหากถึงเป้าหมาย" value={formatPlanMoney(position.profitAtTarget, currency)} tone="positive" />
              </dl>
            )}
          </div>

          {holding && holding.symbol === symbol && (
            <div className="min-w-0" data-testid="stock-planner-holding">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">สถานะที่คุณถืออยู่</h4>
              <dl className="mt-2 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
                <LevelFigure label="จำนวนที่ถืออยู่" value={`${formatPlanShares(holding.quantity)}`} />
                <LevelFigure label="ต้นทุนเฉลี่ย" value={formatPlanMoney(holding.averageCost, currency)} />
                <LevelFigure label="มูลค่าปัจจุบัน" value={holding.marketValue === null ? '—' : formatPlanMoney(holding.marketValue, currency)} />
                <LevelFigure
                  label="กำไร/ขาดทุนที่ยังไม่รับรู้"
                  value={holding.unrealizedGain === null ? '—' : formatPlanMoney(holding.unrealizedGain, currency)}
                  tone={holding.unrealizedGain === null ? undefined : holding.unrealizedGain < 0 ? 'negative' : 'positive'}
                />
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LevelFigure({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'negative' }) {
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

export default PlanDetails;
