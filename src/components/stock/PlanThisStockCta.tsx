'use client';

import { useRouter } from 'next/navigation';
import { Pencil, Plus } from 'lucide-react';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { plannerAcceptsAsset, type PlannerAssetType } from '@/src/lib/tools/planner-asset-scope';
import { StockPlanFigures, useStockPlanSummary } from '@/src/components/stock/StockPlanSummary';

/**
 * วางแผนเข้า–ออกหุ้นตัวนี้ — the one road from a stock to a plan about it.
 *
 * It closes the Financials tab, after the analyst targets and the key
 * statistics, and nowhere else. Standing on its own between the price header and
 * the tab bar it read as another piece of navigation and as the loudest thing on
 * a page that exists to show a stock; here it is the next step from what the
 * reader has just finished reading — other people's expectations of this
 * instrument, and then their own.
 *
 * It is a card rather than a footer rule with a button pushed to the far edge,
 * because the two halves of it have to be read together: the four labels say what
 * a plan is made of — เข้า, เป้ากำไร, Cut Loss, Risk/Reward — and the button
 * directly under them is where you make one. Read apart, the line was a caption
 * and the button was navigation. The figures are the reader's own saved plan when
 * they have one, and em dashes when they do not; see StockPlanSummary, which owns
 * that read.
 *
 * It carries only the symbol. The Planner resolves its own baseline from the
 * canonical accepted price when it opens, so a quote passed through the URL here
 * would be a second copy that could be stale by the time the form rendered, and
 * the plan would be measured from a number nobody is looking at any more.
 *
 * Two gates, and neither is invented here:
 *
 *   * `plannerAcceptsAsset` — the planner's own scope, keyed on the instrument
 *     resolver's `assetType`. An index reaches this tab (Financials is hidden
 *     only for crypto), and offering to plan one would be offering a workspace
 *     that refuses it on arrival. Nothing classifies by symbol letters here.
 *   * the entitlement matrix — a locked reader gets the same upgrade prompt every
 *     other locked surface opens, naming the plan the matrix returns, rather than
 *     a link into a workspace the server will refuse to render for them. It is
 *     also what decides whether the card reads a saved plan at all.
 */
export function PlanThisStockCta({
  symbol,
  assetType,
  currency,
}: {
  symbol: string;
  /** The resolver's own classification, as Stock Detail already holds it. */
  assetType: string | null;
  /** The currency the header quotes this instrument in, so the figures agree with it. */
  currency: string | null;
}) {
  const router = useRouter();
  const { can, requestUpgrade } = useEntitlement();
  const unlocked = can('planner.stock');
  const summary = useStockPlanSummary(symbol, unlocked, currency);

  /*
   * `unknown` is the planner's fail-safe value for "nobody has classified this",
   * and it is refused — which is exactly what an unresolved `assetType` is.
   */
  if (!plannerAcceptsAsset((assetType ?? 'unknown') as PlannerAssetType).supported) return null;

  const editing = summary.hasPlan;
  const action = editing ? 'แก้ไขแผน' : 'สร้างแผน';

  return (
    <section
      data-testid="stock-detail-plan-section"
      aria-labelledby="stock-detail-plan-heading"
      className="min-w-0 rounded-2xl border border-border bg-bg-card p-4 md:p-5"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg leading-none"
        >
          🎯
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="stock-detail-plan-heading"
            className="min-w-0 break-words text-sm font-semibold text-text-main md:text-base"
          >
            วางแผนเข้า–ออกหุ้นตัวนี้
          </h2>
          <p className="mt-1 min-w-0 break-words text-xs leading-5 text-text-muted">
            กำหนดราคาเข้า • เป้ากำไร • จุดตัดขาดทุน ก่อนเริ่มเทรด
          </p>
        </div>
      </div>

      <StockPlanFigures view={summary} />

      {summary.note && (
        <p data-testid="stock-detail-plan-note" className="mt-3 min-w-0 break-words text-[11px] leading-4 text-text-muted">
          {summary.note}
        </p>
      )}

      <button
        type="button"
        data-testid="stock-detail-plan-cta"
        data-locked={unlocked ? 'false' : 'true'}
        aria-label={`${action}หุ้น ${symbol}`}
        onClick={() => {
          if (unlocked) {
            router.push(`/tools/stock-planner?symbol=${encodeURIComponent(symbol)}`);
            return;
          }
          requestUpgrade({ capability: 'planner.stock', source: 'stock-detail.plan-cta' });
        }}
        className="mt-4 inline-flex min-h-11 w-full min-w-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] sm:w-auto sm:px-6"
      >
        {editing
          ? <Pencil aria-hidden="true" size={16} className="shrink-0" />
          : <Plus aria-hidden="true" size={16} className="shrink-0" />}
        <span className="min-w-0 break-words">{action}</span>
      </button>
    </section>
  );
}

export default PlanThisStockCta;
