/**
 * The Tools index, written once.
 *
 * The card used to carry a hand-typed `tag: 'PRO'`. Both tools wore it, so the
 * index advertised Monte Carlo as a Pro feature while the capability matrix, the
 * paywall and the compute route all held it at Elite — a reader could pay for
 * Pro on the strength of that badge and still be refused at the button.
 *
 * So no tier is written here at all. Each tool names the capability it needs and
 * the plan is derived from the entitlement matrix, which is the same source the
 * gate, the locked state, the upgrade prompt and `guardRouteEntitlement` read.
 * Moving `simulator.monte_carlo` between tiers now moves every one of them.
 */

import { requiredTierFor, type SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

export type ToolCategory = 'ทดลองสถานการณ์' | 'วิเคราะห์ความเสี่ยง';

export interface ToolCatalogEntry {
  id: string;
  title: string;
  description: string;
  /** The one capability that decides the badge, the locked state and the route guard. */
  capability: SubscriptionCapability;
  category: ToolCategory;
  route: string;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    id: 'what-if',
    title: 'ทดลองสถานการณ์ (What-If)',
    description: 'ลองเปลี่ยนราคาหุ้น วันที่ และความผันผวน แล้วดูว่ากำไรหรือขาดทุนของคุณจะเปลี่ยนไปเท่าไร',
    capability: 'simulator.what_if',
    category: 'ทดลองสถานการณ์',
    route: '/tools/what-if',
  },
  {
    id: 'monte-carlo',
    title: 'จำลองความเป็นไปได้ (Monte Carlo)',
    description: 'จำลองราคาหุ้นหลายพันสถานการณ์ เพื่อดูโอกาสได้กำไรและระดับความเสี่ยงของสถานะ',
    capability: 'simulator.monte_carlo',
    category: 'วิเคราะห์ความเสี่ยง',
    route: '/tools/monte-carlo',
  },
];

export const TOOL_CATEGORIES: readonly ToolCategory[] = ['ทดลองสถานการณ์', 'วิเคราะห์ความเสี่ยง'];

/**
 * The plan a tool's badge names. `null` would mean a capability no tier carries,
 * which is a catalog mistake rather than a runtime state — the caller shows no
 * badge rather than inventing one.
 */
export function toolRequiredTier(entry: ToolCatalogEntry): SubscriptionTier | null {
  return requiredTierFor(entry.capability);
}
