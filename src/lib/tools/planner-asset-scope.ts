/**
 * Which instruments the Stock Planner v1 will plan, and why it refuses the rest.
 *
 * The planner's whole arithmetic assumes one thing about its subject: that a
 * single share price is the thing being planned, that it can be above or below a
 * level, and that a calendar horizon means something for it. Everything that
 * assumption does not hold for is refused here, at the edge, rather than being
 * quietly computed into numbers that read as if they were about a stock.
 *
 * The classification is the instrument resolver's own `assetType` — the same
 * field the rest of the market pipeline routes on. Nothing here guesses from the
 * letters in a symbol, because a guess is exactly how an option contract or a
 * 24/7 pair ends up planned as if it were equity.
 *
 * `unknown` is refused rather than allowed. A fail-safe scope has to fail toward
 * refusing: an instrument nobody has classified is precisely the one whose
 * semantics cannot be vouched for.
 */

import type { ResolvedInstrument } from '@/src/lib/market-data/gateway/contracts';

export type PlannerAssetType = ResolvedInstrument['assetType'];

/**
 * The equity-shaped types. ADRs, REITs, listed funds and OTC issues are all
 * things with a share price that a long plan reads correctly, so they are in;
 * the spec's "Equity + ETF" is the two names a reader would use for this set.
 */
const SUPPORTED: readonly PlannerAssetType[] = ['stock', 'etf', 'adr', 'reit', 'fund', 'otc'];

export type PlannerAssetDecision =
  | { supported: true }
  | { supported: false; message: string };

/** Why each refused class is refused, said in the reader's terms. */
const REFUSAL: Readonly<Partial<Record<PlannerAssetType, string>>> = {
  crypto: 'เครื่องมือวางแผนนี้ (v1) ยังไม่รองรับคริปโท เพราะเป็นตลาดที่ซื้อขายต่อเนื่องตลอด 24 ชั่วโมง จึงใช้ระยะเวลาแบบเดียวกับหุ้นไม่ได้',
  index: 'เครื่องมือวางแผนนี้ (v1) ยังไม่รองรับดัชนี เพราะไม่ใช่หลักทรัพย์ที่ถือเป็นรายตัวได้ ลองวางแผนด้วย ETF ที่อ้างอิงดัชนีนั้นแทน',
  unknown: 'เครื่องมือวางแผนนี้ (v1) รองรับเฉพาะหุ้นและ ETF รายตัว และยังไม่สามารถยืนยันประเภทของสินทรัพย์นี้ได้',
};

const FALLBACK_REFUSAL = 'เครื่องมือวางแผนนี้ (v1) รองรับเฉพาะหุ้นและ ETF รายตัว';

export function plannerAcceptsAsset(assetType: PlannerAssetType): PlannerAssetDecision {
  if (SUPPORTED.includes(assetType)) return { supported: true };
  return { supported: false, message: REFUSAL[assetType] ?? FALLBACK_REFUSAL };
}

/**
 * The option case, which never travels as an `assetType` at all.
 *
 * An option reaches a tool as a portfolio handoff, and `parseEquityToolHandoff`
 * already refuses one. This message exists so the planner can say the same thing
 * in its own words if a contract is ever routed here another way.
 */
export const PLANNER_OPTION_REFUSAL =
  'เครื่องมือวางแผนนี้ (v1) ยังไม่รองรับสัญญาออปชัน ลองใช้ ทดลองสถานการณ์ (What-If) สำหรับสัญญาออปชัน';
