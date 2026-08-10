/**
 * What an upgrade prompt says, per capability.
 *
 * One entry per gated feature, so every locked surface names the same benefit in
 * the same words wherever it appears. The plan a prompt asks for is never typed
 * here — it is derived from the entitlement matrix, so moving a capability
 * between tiers moves the copy with it and the two cannot disagree.
 */

import { requiredTierFor, type SubscriptionCapability } from './capabilities';
import type { SubscriptionTier } from './subscription-types';

export interface UpgradeCopy {
  /** Headline of the prompt: the feature, named the way the UI names it. */
  title: string;
  /** One sentence on what the reader gets — specific to this feature, never generic. */
  benefit: string;
  /** The short line a locked placeholder shows in place of the value. */
  lockedLabel: string;
}

const COPY: Partial<Record<SubscriptionCapability, UpgradeCopy>> = {
  'portfolio.multiple.create': {
    title: 'สร้างหลายพอร์ต',
    benefit: 'แยกพอร์ตตามเป้าหมายหรือกลยุทธ์ได้สูงสุด 10 พอร์ตหุ้น/ETF และ 10 พอร์ตออปชัน',
    lockedLabel: 'สร้างหลายพอร์ตได้ใน Pro',
  },
  'portfolio.options.create': {
    title: 'พอร์ตออปชันและเพิ่มสัญญาเข้าพอร์ต',
    benefit: 'สร้างพอร์ตออปชัน และเพิ่ม Call หรือ Put จาก Options Chain พร้อมคำนวณเงินสด ต้นทุน และ P/L จาก Ledger เดียวกัน',
    lockedLabel: 'พอร์ตออปชันใช้ได้ใน Pro',
  },
  'chart.sr.context': {
    title: 'สถิติความแข็งแกร่งของแนวรับ–แนวต้าน',
    benefit: 'ดูจำนวนครั้งที่ราคาชนแนวนี้ กี่ครั้งที่รับหรือต้านอยู่ กี่ครั้งที่หลุด และการยืนยันจาก VPVR',
    lockedLabel: 'ดูสถิติความแข็งแกร่งใน Pro',
  },
  'chart.vpvr': {
    title: 'VPVR โปรไฟล์ปริมาณซื้อขาย',
    benefit: 'เห็นว่าปริมาณซื้อขายกระจุกตัวที่ราคาไหน พร้อม POC, VAH และ VAL ของช่วงที่กำลังดูอยู่',
    lockedLabel: 'VPVR ใช้ได้ใน Pro',
  },
  'simulator.what_if': {
    title: 'ทดลองสถานการณ์ (What-If)',
    benefit: 'ลองเปลี่ยนราคาหุ้น วันที่ และความผันผวน แล้วดูว่ากำไรหรือขาดทุนของสถานะจะเปลี่ยนไปเท่าไร',
    lockedLabel: 'คำนวณ What-If ได้ใน Pro',
  },
  'simulator.monte_carlo': {
    title: 'จำลองความเป็นไปได้ (Monte Carlo)',
    benefit: 'จำลองราคาหุ้นหลายพันเส้นทาง เพื่อดูโอกาสได้กำไร ระดับความเสี่ยง VaR และ Expected Shortfall',
    lockedLabel: 'เริ่มจำลอง Monte Carlo ได้ใน Elite',
  },
  'options.analytics.walls': {
    title: 'Options Walls (Call Wall, Put Wall, Max Pain)',
    benefit: 'เห็นราคาจริงของจุดที่ Open Interest กระจุกตัว และ Max Pain ของวันหมดอายุที่เลือก',
    lockedLabel: 'ดูค่าจริงได้ใน Elite',
  },
  'options.chain.basic': {
    title: 'Options Chain',
    benefit: 'ดูสัญญาจริงรายแถว ทั้ง strike, วันหมดอายุ, Bid/Ask, Volume และ Open Interest',
    lockedLabel: 'Options Chain ใช้ได้ใน Pro',
  },
  'options.chain.advanced': {
    title: 'Options Chain แบบเต็มรูปแบบ',
    benefit: 'เพิ่ม ATM IV, การกระจุกตัวของ Open Interest และคอลัมน์เชิงลึกบนสัญญาชุดเดียวกัน',
    lockedLabel: 'ข้อมูลเชิงลึกใช้ได้ใน Elite',
  },
  'options.greeks.full': {
    title: 'Full Greeks',
    benefit: 'เห็น Delta, Gamma, Theta, Vega และ Implied Volatility ครบทุกสัญญาจากผู้ให้บริการ',
    lockedLabel: 'Greeks ครบชุดใช้ได้ใน Elite',
  },
  'options.expected_move': {
    title: 'Expected Move',
    benefit: 'เห็นกรอบความผันผวนที่ตลาดคาดถึงวันหมดอายุ พร้อมเพิ่มกรอบนั้นลงบนกราฟได้',
    lockedLabel: 'Expected Move ใช้ได้ใน Elite',
  },
  'options.signal.summary': {
    title: 'Options Signal Engine',
    benefit: 'เห็นทิศทางที่ระบบสรุปได้ พร้อมคะแนนความมั่นใจจากข้อมูลตลาดจริง',
    lockedLabel: 'Options Signal ใช้ได้ใน Pro',
  },
  'options.signal.breakdown': {
    title: 'Signal Breakdown แยกรายปัจจัย',
    benefit: 'เห็นคะแนนของ Macro, Trend, Momentum, Put/Call และ Risk:Reward พร้อมเหตุผลและ Trade Setup',
    lockedLabel: 'ดูรายละเอียดรายปัจจัยได้ใน Elite',
  },
  'technical.outlook': {
    title: 'Technical Outlook · Market Signal',
    benefit: 'เห็นสถานะแนวโน้ม คะแนนทิศทาง ความมั่นใจ และตัวชี้วัดจริงที่ระบบใช้สรุป',
    lockedLabel: 'Technical Outlook ใช้ได้ใน Elite',
  },
  'theme.premium': {
    title: 'ธีมสีพิเศษ',
    benefit: 'เปลี่ยนโทนสีทั้งแอปเป็น Bitswap Cyan, Dokturek Violet, Cosmic Vanilla หรือ Jet Black Orchid ใช้ได้ทั้งโหมดสว่างและมืด',
    lockedLabel: 'ธีมสีนี้ใช้ได้ใน Pro',
  },
};

const FALLBACK: UpgradeCopy = {
  title: 'ฟีเจอร์นี้อยู่ในแพ็กเกจที่สูงขึ้น',
  benefit: 'อัปเกรดเพื่อเปิดใช้งานฟีเจอร์นี้',
  lockedLabel: 'ต้องอัปเกรดแพ็กเกจ',
};

export function upgradeCopy(capability: SubscriptionCapability): UpgradeCopy {
  return COPY[capability] ?? FALLBACK;
}

export const PLAN_DISPLAY_NAME: Record<SubscriptionTier, string> = {
  basic: 'Basic',
  pro: 'Pro',
  elite: 'Elite',
};

/** The plan a locked surface must ask for, read from the matrix. */
export function upgradeTargetTier(capability: SubscriptionCapability): SubscriptionTier {
  return requiredTierFor(capability) ?? 'elite';
}

/** Every capability that has a locked surface must have copy of its own. */
export const capabilitiesWithUpgradeCopy = Object.keys(COPY) as SubscriptionCapability[];
