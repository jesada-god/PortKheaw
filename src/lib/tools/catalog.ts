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
    description: 'ลองเปลี่ยนราคาหุ้น วันที่ และความผันผวน แล้วดูว่ากำไรหรือขาดทุนของคุณจะเปลี่ยนไปเท่าไร',
    capability: 'simulator.what_if',
    category: 'ทดลองสถานการณ์',
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
    description: 'จำลองราคาหุ้นหลายพันสถานการณ์ เพื่อดูโอกาสได้กำไรและระดับความเสี่ยงของสถานะ',
    capability: 'simulator.monte_carlo',
    category: 'วิเคราะห์ความเสี่ยง',
    route: '/tools/monte-carlo',
    valuePreview: [
      'ตอบว่า “ผลลัพธ์ที่เป็นไปได้ของสถานะนี้กว้างแค่ไหน” ไม่ใช่แค่ตัวเลขเดียว',
      'แสดงช่วงผลลัพธ์และความน่าจะเป็นจากการจำลองราคาหลายพันเส้นทาง',
      'ช่วยเทียบว่ากรณีแย่ที่สุดที่พอเป็นไปได้ ยังรับไหวหรือไม่',
    ],
    sampleOutcome: 'เช่น จากการจำลองหลายพันเส้นทาง ผลลัพธ์ส่วนใหญ่ตกอยู่ในกรอบกว้างเท่าไร และมีโอกาสได้กำไรกี่เปอร์เซ็นต์',
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
