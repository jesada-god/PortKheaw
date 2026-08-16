'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatPlanMoney } from '@/src/lib/tools/stock-plan';
import {
  evaluatePlanOutlook,
  formatRewardRisk,
  horizonRemainingLabel,
  planToday,
} from '@/src/lib/tools/stock-plan-outlook';
import type { SavedPlanView } from '@/src/components/tools/SavedStockPlans';

/**
 * The four figures the Planner card on Stock Detail shows, and where they come from.
 *
 * This is a read of what the reader has already saved for this symbol — the same
 * `GET /api/stock-plans` the Planner itself lists from, filtered to this stock.
 * Nothing here computes a plan: the Risk/Reward figure is
 * {@link evaluatePlanOutlook} run over the stored row, which is the one
 * evaluation the Planner's own result card and its saved list both read, so the
 * ratio on Stock Detail cannot drift from the ratio inside the tool.
 *
 * When there is no saved plan the four figures are em dashes. The card does not
 * fill the gap with today's quote: the labels name a *plan's* levels, and a
 * number that is not one of them sitting under "ราคาเข้า" would be read as a
 * decision the reader never made. The Planner resolves its own baseline from the
 * canonical accepted price the moment it opens, which is where that number
 * belongs.
 */

/** What an unanswered figure reads as, in one place so all four agree. */
const BLANK = '—';

export interface StockPlanFigure {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
}

export interface StockPlanSummaryView {
  /** True only once a saved plan for this symbol has actually been read back. */
  hasPlan: boolean;
  /** The plan's horizon, when there is a plan. `null` otherwise. */
  note: string | null;
  figures: readonly StockPlanFigure[];
}

const BLANK_FIGURES: readonly StockPlanFigure[] = [
  { label: 'ราคาเข้า', value: BLANK },
  { label: 'เป้ากำไร', value: BLANK, tone: 'positive' },
  { label: 'Cut Loss', value: BLANK, tone: 'negative' },
  { label: 'Risk/Reward', value: BLANK },
];

const EMPTY_VIEW: StockPlanSummaryView = { hasPlan: false, note: null, figures: BLANK_FIGURES };

/**
 * The reader's saved plan for one symbol, as the card renders it.
 *
 * `enabled` is the entitlement decision made by the caller: the route is gated on
 * `planner.stock` and would refuse a locked reader anyway, so asking is only a
 * request that can end in nothing. A failed or refused read leaves the card in
 * its empty state, which is what a reader with no plan sees — the card never
 * reports a network problem as a plan, in either direction.
 */
export function useStockPlanSummary(
  symbol: string,
  enabled: boolean,
  currency: string | null,
): StockPlanSummaryView {
  const [plan, setPlan] = useState<SavedPlanView | null>(null);
  // Resolved once per mount: a horizon is a calendar date, and "เหลืออีก N วัน"
  // must not change under the reader because a render happened after midnight.
  const today = useMemo(() => planToday(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = enabled ? await readSavedPlan(symbol) : null;
      if (!cancelled) setPlan(found);
    })();
    return () => { cancelled = true; };
  }, [symbol, enabled]);

  return useMemo(() => summaryView(plan, currency, today), [plan, currency, today]);
}

/** The reader's live plans, filtered to one symbol. `null` for every failure. */
async function readSavedPlan(symbol: string): Promise<SavedPlanView | null> {
  try {
    const response = await fetch('/api/stock-plans');
    if (!response.ok) return null;
    const payload = await response.json() as { data?: SavedPlanView[] };
    // The list arrives newest first, so the first match is the current plan.
    return payload.data?.find((saved) => saved.symbol === symbol) ?? null;
  } catch { return null; }
}

function summaryView(
  plan: SavedPlanView | null,
  currency: string | null,
  today: string,
): StockPlanSummaryView {
  if (!plan) return EMPTY_VIEW;
  // The same fallback the Planner itself uses while an instrument's currency is
  // still unresolved, rather than a second convention for the same unknown.
  const quoted = currency ?? 'USD';

  /*
    One evaluation, the tool's own. The ratio is not recomputed here — this is the
    same function the Planner's result card runs, over the row as it was stored.
  */
  const { outlook } = evaluatePlanOutlook({
    baselinePrice: plan.baselinePrice,
    targetPrice: plan.targetPrice,
    invalidationPrice: plan.invalidationPrice,
    horizonDate: plan.horizonDate,
    today,
  });

  return {
    hasPlan: true,
    note: `แผนของคุณ · ถึง ${plan.horizonDate} · ${horizonRemainingLabel(plan.horizonDate, today)}`,
    figures: [
      { label: 'ราคาเข้า', value: formatPlanMoney(plan.baselinePrice, quoted) },
      { label: 'เป้ากำไร', value: formatPlanMoney(plan.targetPrice, quoted), tone: 'positive' },
      { label: 'Cut Loss', value: formatPlanMoney(plan.invalidationPrice, quoted), tone: 'negative' },
      { label: 'Risk/Reward', value: outlook ? formatRewardRisk(outlook.rewardRisk) : BLANK },
    ],
  };
}

/**
 * The figures, as a 2×2 on a phone and one row on a desktop.
 *
 * A tone is carried even while the value is an em dash, so the empty card and the
 * filled one are the same card rather than two layouts that swap.
 */
export function StockPlanFigures({ view }: { view: StockPlanSummaryView }) {
  return (
    <dl
      data-testid="stock-detail-plan-figures"
      data-has-plan={view.hasPlan ? 'true' : 'false'}
      className="mt-4 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3"
    >
      {view.figures.map((figure) => (
        <div key={figure.label} className="min-w-0 rounded-xl border border-border bg-bg-base p-3">
          <dt className="min-w-0 break-words text-[11px] leading-4 text-text-muted">{figure.label}</dt>
          <dd className={`mt-1 min-w-0 break-words font-mono text-sm font-semibold ${toneClass(figure)}`}>
            {figure.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A dash is not a gain or a loss, so an empty figure keeps the neutral tone. */
function toneClass(figure: StockPlanFigure): string {
  if (figure.value === BLANK) return 'text-text-muted';
  if (figure.tone === 'positive') return 'text-[var(--positive)]';
  if (figure.tone === 'negative') return 'text-[var(--negative)]';
  return 'text-text-main';
}
