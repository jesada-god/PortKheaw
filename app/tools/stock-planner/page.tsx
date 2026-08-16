import { Target } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { LockedNotice } from '@/src/components/subscription/EntitlementGate';
import { StockPlannerWorkspace } from '@/src/components/tools/StockPlannerWorkspace';
import { recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';
import { hasCapability } from '@/src/lib/subscription/capabilities';
import { resolvePageEntitlement } from '@/src/lib/subscription/page-entitlement';
import { upgradeCopy } from '@/src/lib/subscription/upgrade-copy';

const CAPABILITY = 'planner.stock' as const;

/**
 * The Stock Planner's entitlement is decided here, on the server.
 *
 * The two options tools can rely on their compute routes to refuse a locked
 * reader, because the numbers they show cannot be produced without one. This
 * tool's arithmetic is small enough to run in the browser, so there is no
 * request to refuse — which means a client-side gate would be the only thing
 * standing between a Basic reader and the whole feature, and a client-side gate
 * is not a gate.
 *
 * So the workspace is never rendered, never sent in the RSC payload, and never
 * present in the bundle a locked reader receives. They get the shared locked
 * notice instead, which opens the same upgrade prompt every other locked
 * surface opens, naming the plan the entitlement matrix returns.
 */
export default async function StockPlannerPage() {
  const entitlement = await resolvePageEntitlement();
  if (hasCapability(entitlement.effectiveAccessTier, CAPABILITY)) {
    // Recorded inside the entitled branch: a refused reader opened the paywall,
    // not the tool, and the funnel already has `paywall_blocked` for that.
    void recordBetaFunnelEvent({ event: 'tool_opened', featureKey: 'stock-planner' }).catch(() => {});
    return <StockPlannerWorkspace />;
  }

  const copy = upgradeCopy(CAPABILITY);
  return (
    <div className="min-w-0">
      <Header title="วางแผนหุ้น" subtitle="กำหนดจุดเข้า จุดตัดขาดทุน และราคาเป้าหมายของหุ้นรายตัว" backFallbackHref="/tools" />
      <div className="w-full min-w-0 max-w-full p-4 md:p-8">
        <section
          data-testid="stock-planner-locked"
          className="min-w-0 rounded-2xl border border-slate-800 bg-[#151B28] p-6 shadow-xl"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400">
            <Target aria-hidden="true" size={24} />
          </div>
          <h1 className="mt-4 min-w-0 break-words text-lg font-bold text-white">{copy.title}</h1>
          <p className="mt-2 min-w-0 break-words text-sm leading-relaxed text-slate-400">{copy.benefit}</p>
          <LockedNotice capability={CAPABILITY} source="tools.stock-planner.page" className="mt-5" />
        </section>
      </div>
    </div>
  );
}
