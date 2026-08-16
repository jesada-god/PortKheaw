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
  /**
   * Who the tool is for, in one short phrase.
   *
   * The index already said what each tool does and which plan it needs; what it
   * never said is whether the reader is the person it was built for. Static
   * editorial copy — it names no metric, reads nothing about the reader, and
   * takes no part in entitlement.
   */
  audience: string;
  /** The one capability that decides the badge, the locked state and the route guard. */
  capability: SubscriptionCapability;
  category: ToolCategory;
  route: string;
  /**
   * What a reader GETS from this tool, said as outcomes rather than feature
   * names. Shown on a LOCKED card, because somebody deciding whether to pay for
   * a tool they cannot open needs to know what it answers, not what it is
   * called.
   *
   * Strictly static educational copy. It is never computed, never derived from
   * the reader's own portfolio, never fetched, and it never reproduces the
   * metric breakdown the paid tool produces — a preview that leaked the answer
   * would be the paywall failing, not the paywall explaining itself.
   */
  valuePreview: readonly string[];
  /**
   * One illustrative sentence, always rendered under a ตัวอย่าง label so it can
   * never be mistaken for a number about the reader's own positions.
   */
  sampleOutcome: string;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    id: 'what-if',
    title: 'ทดลองสถานการณ์ (What-If)',
    assetScope: 'options',
    description: 'ลองเปลี่ยนราคาหุ้น วันที่ และความผันผวน เพื่อดูว่ามูลค่าสัญญาออปชันอาจเปลี่ยนไปอย่างไร',
    audience: 'เหมาะกับคนที่ถือสัญญาออปชันอยู่ และอยากรู้ว่าถ้าราคาเปลี่ยนจะเป็นอย่างไร',
    capability: 'simulator.what_if',
    category: 'วิเคราะห์ Options',
    route: '/tools/what-if',
    valuePreview: [
      'ตอบว่า “ถ้าราคาหุ้นขึ้นหรือลงเท่านี้ สถานะออปชันของคุณจะกำไรหรือขาดทุนเท่าไร”',
      'เลื่อนวันที่ล่วงหน้าเพื่อดูผลของเวลาที่เหลือก่อนหมดอายุ',
      'ปรับความผันผวนที่ตลาดคาด (IV) แล้วเทียบผลลัพธ์ในสถานการณ์ต่าง ๆ',
    ],
    sampleOutcome: 'เช่น ถ้าหุ้นขึ้นตามที่คุณกำหนดภายในสัปดาห์หน้า สถานะนี้จะเปลี่ยนจากขาดทุนเป็นกำไรหรือไม่',
  },
  {
    id: 'monte-carlo',
    title: 'จำลองความเป็นไปได้ (Monte Carlo)',
    assetScope: 'options',
    description: 'จำลองราคาหุ้นหลายพันสถานการณ์ เพื่อดูโอกาสกำไรและความเสี่ยงของสัญญาออปชัน',
    audience: 'เหมาะกับคนที่อยากเห็นช่วงผลลัพธ์และความเสี่ยงก่อนตัดสินใจ ไม่ใช่แค่ตัวเลขเดียว',
    capability: 'simulator.monte_carlo',
    category: 'วิเคราะห์ Options',
    route: '/tools/monte-carlo',
    valuePreview: [
      'ตอบว่า “ผลลัพธ์ที่เป็นไปได้ของสถานะนี้กว้างแค่ไหน” ไม่ใช่แค่ตัวเลขเดียว',
      'แสดงช่วงผลลัพธ์และความน่าจะเป็นจากการจำลองราคาหลายพันเส้นทาง',
      'ช่วยเทียบว่ากรณีแย่ที่สุดที่พอเป็นไปได้ ยังรับไหวหรือไม่',
    ],
    sampleOutcome: 'เช่น จากการจำลองหลายพันเส้นทาง ผลลัพธ์ส่วนใหญ่ตกอยู่ในกรอบกว้างเท่าไร และมีโอกาสได้กำไรกี่เปอร์เซ็นต์',
  },
  {
    id: 'stock-planner',
    title: 'วางแผนหุ้นรายตัว (Stock Planner)',
    assetScope: 'stock',
    description: 'กำหนดเป้าหมาย ระดับความเสี่ยง และดู Risk : Reward ของแผนก่อนตัดสินใจ',
    audience: 'เหมาะกับคนที่สนใจหุ้นหรือ ETF รายตัว และอยากวางแผนก่อนซื้อ',
    capability: 'planner.stock',
    category: 'วิเคราะห์หุ้น',
    route: '/tools/stock-planner',
    valuePreview: [
      'ตอบว่า “จากราคาปัจจุบัน ถึงเป้าหมายที่ตั้งไว้ ห่างกันกี่เปอร์เซ็นต์”',
      'เทียบระยะขึ้นกับระยะลงที่ยอมรับได้ เป็นสัดส่วน Risk : Reward ที่อ่านง่าย',
      'บันทึกแผนไว้ แล้วติดตามว่าราคาล่าสุดห่างจากแผนเดิมแค่ไหน',
    ],
    sampleOutcome: 'เช่น แผนนี้ยอมเสี่ยงกี่ส่วน เพื่อหวังผลตอบแทนกี่ส่วน และเหลือเวลาตามแผนอีกกี่วัน',
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
