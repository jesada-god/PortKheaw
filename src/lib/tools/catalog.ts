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

/**
 * How the index is grouped, which is by the instrument a tool is for.
 *
 * The previous grouping named the *technique* — "ทดลองสถานการณ์",
 * "วิเคราะห์ความเสี่ยง", "วางแผนการเทรด" — which put the one stock tool in a
 * category of its own next to two options tools, and told a reader holding shares
 * nothing about which of the three could read what they own. Grouping by
 * instrument answers the question they actually arrive with.
 */
export type ToolCategory = 'วิเคราะห์หุ้น' | 'วิเคราะห์ Options';

/**
 * Which instrument a tool is actually for.
 *
 * A beginner opening เครื่องมือ cannot tell from "ทดลองสถานการณ์" that the tool
 * behind it expects an option contract, so they pick it while holding shares and
 * meet a form asking for a strike. The scope is a field rather than a sentence
 * inside each description so the index can print it in one consistent place, and
 * so a stock tool can never quietly ship describing itself as an options one.
 */
export type ToolAssetScope = 'options' | 'stock';

export const TOOL_ASSET_SCOPE_LABEL: Readonly<Record<ToolAssetScope, string>> = {
  options: 'สำหรับสัญญาออปชัน',
  /*
   * ETFs are named here because the planner takes them and a reader holding SPY
   * could not tell from "สำหรับหุ้นรายตัว" that it was meant for them. The scope
   * itself stays `stock`: it is the two-way split between contracts and equities
   * that decides routing, and an ETF is on the equity side of it.
   */
  stock: 'สำหรับหุ้นและ ETF รายตัว',
};

export interface ToolCatalogEntry {
  id: string;
  title: string;
  /** The instrument the tool works on, shown on the card before it is opened. */
  assetScope: ToolAssetScope;
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
    assetScope: 'options',
    description: 'เปลี่ยนราคาหุ้น วันที่ และความผันผวน แล้วดูว่ามูลค่าสัญญาออปชันเปลี่ยนไปเท่าไร',
    capability: 'simulator.what_if',
    category: 'วิเคราะห์ Options',
    route: '/tools/what-if',
  },
  {
    id: 'monte-carlo',
    title: 'จำลองความเป็นไปได้ (Monte Carlo)',
    assetScope: 'options',
    description: 'จำลองราคาหุ้นหลายพันเส้นทาง แล้วดูช่วงผลลัพธ์ของสัญญาออปชัน',
    capability: 'simulator.monte_carlo',
    category: 'วิเคราะห์ Options',
    route: '/tools/monte-carlo',
  },
  {
    id: 'stock-planner',
    title: 'วางแผนหุ้นรายตัว (Stock Planner)',
    assetScope: 'stock',
    description: 'กรอกจุดเข้า จุดตัดขาดทุน และราคาเป้าหมาย แล้วดูกำไรที่คาดหวัง ขาดทุนสูงสุด และ R:R',
    capability: 'planner.stock',
    category: 'วิเคราะห์หุ้น',
    route: '/tools/stock-planner',
  },
];

export const TOOL_CATEGORIES: readonly ToolCategory[] = ['วิเคราะห์หุ้น', 'วิเคราะห์ Options'];

/**
 * The plan a tool's badge names. `null` would mean a capability no tier carries,
 * which is a catalog mistake rather than a runtime state — the caller shows no
 * badge rather than inventing one.
 */
export function toolRequiredTier(entry: ToolCatalogEntry): SubscriptionTier | null {
  return requiredTierFor(entry.capability);
}
