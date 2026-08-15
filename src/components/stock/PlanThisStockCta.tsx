'use client';

import { useRouter } from 'next/navigation';
import { Target } from 'lucide-react';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { plannerAcceptsAsset, type PlannerAssetType } from '@/src/lib/tools/planner-asset-scope';

/**
 * วางแผนหุ้นนี้ — the one road from a stock to a plan about it.
 *
 * It closes the Financials tab, after the analyst targets and the key
 * statistics, and nowhere else. Standing on its own between the price header and
 * the tab bar it read as another piece of navigation and as the loudest thing on
 * a page that exists to show a stock; here it is the next step from what the
 * reader has just finished reading — other people's expectations of this
 * instrument, and then their own.
 *
 * It carries only the symbol. The Planner resolves its own baseline from the
 * canonical accepted price when it opens, so a price passed through the URL here
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
 *     a link into a workspace the server will refuse to render for them.
 */
export function PlanThisStockCta({
  symbol,
  assetType,
}: {
  symbol: string;
  /** The resolver's own classification, as Stock Detail already holds it. */
  assetType: string | null;
}) {
  const router = useRouter();
  const { can, requestUpgrade } = useEntitlement();
  const unlocked = can('planner.stock');

  /*
   * `unknown` is the planner's fail-safe value for "nobody has classified this",
   * and it is refused — which is exactly what an unresolved `assetType` is.
   */
  if (!plannerAcceptsAsset((assetType ?? 'unknown') as PlannerAssetType).supported) return null;

  return (
    <section
      data-testid="stock-detail-plan-section"
      aria-labelledby="stock-detail-plan-heading"
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-border pt-4"
    >
      <div className="min-w-0 flex-1">
        <h2 id="stock-detail-plan-heading" className="text-sm font-semibold text-text-main">วางแผนหุ้นนี้</h2>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          กำหนดราคาเป้าหมายและระดับความเสี่ยงของหุ้นตัวนี้
        </p>
      </div>
      <button
        type="button"
        data-testid="stock-detail-plan-cta"
        data-locked={unlocked ? 'false' : 'true'}
        aria-label={`วางแผนหุ้น ${symbol}`}
        onClick={() => {
          if (unlocked) {
            router.push(`/tools/stock-planner?symbol=${encodeURIComponent(symbol)}`);
            return;
          }
          requestUpgrade({ capability: 'planner.stock', source: 'stock-detail.plan-cta' });
        }}
        className="inline-flex min-h-11 min-w-0 shrink-0 items-center gap-2 rounded-xl border border-border bg-bg-card px-3 text-sm font-medium text-text-main transition-colors hover:border-primary/50 hover:text-primary"
      >
        <Target aria-hidden="true" size={16} className="shrink-0 text-primary" />
        <span className="min-w-0 break-words">วางแผนหุ้นนี้</span>
      </button>
    </section>
  );
}

export default PlanThisStockCta;
