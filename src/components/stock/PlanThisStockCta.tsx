'use client';

import { useRouter } from 'next/navigation';
import { Target } from 'lucide-react';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';

/**
 * วางแผนหุ้นนี้ — the one road from a stock to a plan about it.
 *
 * Small on purpose. It sits under the price header as a single line, because a
 * reader arrives at this page to look at a stock and planning is something they
 * may decide to do next — not the thing the page is for.
 *
 * It carries only the symbol. The Planner resolves its own baseline from the
 * canonical accepted price when it opens, so a price passed through the URL here
 * would be a second copy that could be stale by the time the form rendered, and
 * the plan would be measured from a number nobody is looking at any more.
 *
 * A locked reader gets the same upgrade prompt every other locked surface opens,
 * naming the plan the entitlement matrix returns, rather than a link into a
 * workspace the server will refuse to render for them.
 */
export function PlanThisStockCta({ symbol }: { symbol: string }) {
  const router = useRouter();
  const { can, requestUpgrade } = useEntitlement();
  const unlocked = can('planner.stock');

  return (
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
      className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-slate-800 bg-[#151B28] px-3 text-sm font-medium text-slate-200 transition-colors hover:border-[#D4FF00]/50 hover:text-[#D4FF00]"
    >
      <Target aria-hidden="true" size={16} className="shrink-0 text-[#D4FF00]" />
      <span className="min-w-0 break-words">วางแผนหุ้นนี้</span>
    </button>
  );
}

export default PlanThisStockCta;
