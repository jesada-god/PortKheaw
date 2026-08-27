/**
 * วางแผนหุ้นรายตัว (Stock Planner) — the whole arithmetic, with no React in it.
 *
 * Three prices decide everything the tool says: where the reader plans to buy,
 * where they would cut the loss, and where they would take the profit. Every
 * figure below is derived from those three and the size they choose, so the
 * summary sentences, the metric cards and the little Stop–Entry–Target bar can
 * never disagree — they all read one evaluation.
 *
 * Two rules the module exists to hold:
 *
 *  - **Nothing divides by a number it has not proven.** `entry` is checked to be
 *    finite and above zero before any percentage is taken from it, and the risk
 *    per share is proven positive before the Risk/Reward ratio divides by it, so
 *    no path here can produce Infinity or NaN.
 *  - **It plans, it never advises.** The wording says what the reader's own
 *    numbers imply — how much is at stake, how much is hoped for — and never
 *    whether to act on them.
 */
import { statusFromRewardRisk, type StatusLevel } from '@/src/lib/presentation/status';

/** The one field a message belongs to, so the form can show it in place. */
export type StockPlanField = 'entry' | 'stopLoss' | 'target' | 'size';

/** How the reader expresses position size: by money, or by share count. */
export type StockPlanSizingMode = 'budget' | 'shares';

export interface StockPlanSizing {
  mode: StockPlanSizingMode;
  /** `null` while the reader has not sized the plan — not an error. */
  amount: number | null;
}

export interface StockPlanInput {
  entry: number | null;
  stopLoss: number | null;
  target: number | null;
  sizing: StockPlanSizing;
}

export interface StockPlanIssue {
  field: StockPlanField;
  message: string;
}

/** What the three prices imply, per share and as a share of the entry price. */
export interface StockPlanLevels {
  /** Entry − Stop. Always above zero. */
  riskPerShare: number;
  /** Target − Entry. Always above zero. */
  rewardPerShare: number;
  /** Risk as a percentage of the entry price. */
  riskPercent: number;
  /** Expected return as a percentage of the entry price. */
  rewardPercent: number;
  /** Reward ÷ risk — the `2.4` in "1 : 2.4". Finite by construction. */
  rewardToRisk: number;
}

/** What the plan costs and pays at each of its two exits, at the chosen size. */
export interface StockPlanPosition {
  shares: number;
  /** Money actually committed at the entry price — whole shares only. */
  cost: number;
  /** Negative: what the plan gives up if the stop is reached. */
  lossAtStop: number;
  /** Positive: what the plan makes if the target is reached. */
  profitAtTarget: number;
}

export interface StockPlanEvaluation {
  issues: readonly StockPlanIssue[];
  /** Present only when all three prices are usable together. */
  levels: StockPlanLevels | null;
  /** Present only when the plan is both priced and sized. */
  position: StockPlanPosition | null;
}

/*
  Bounds, so an accidental paste (a phone number into a price box) is answered
  with a sentence rather than with a plan built on it. They are far outside any
  real quote and are about keeping the arithmetic meaningful, not about
  second-guessing a market.
*/
const MAX_PRICE = 1_000_000;
const MAX_BUDGET = 1_000_000_000_000;
const MAX_SHARES = 100_000_000;

/**
 * Read a typed field. Empty means "not answered yet", never zero: a blank box
 * must not be treated as a price of nothing, or the form would start life full
 * of errors the reader has not made.
 */
export function parsePlanNumber(draft: string): number | null {
  const cleaned = draft.replace(/[,\s]/g, '');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

function priceIssue(value: number | null, field: StockPlanField, label: string): StockPlanIssue | null {
  if (value === null) return { field, message: `กรอก${label}ก่อน จึงจะคำนวณผลได้` };
  if (!Number.isFinite(value) || value <= 0) return { field, message: `${label}ต้องเป็นตัวเลขมากกว่า 0` };
  if (value > MAX_PRICE) return { field, message: `${label}สูงเกินกว่าที่เครื่องมือนี้รองรับ` };
  return null;
}

/**
 * The whole tool, as one function of its inputs.
 *
 * Returns every problem it found rather than the first, so a reader who left two
 * boxes empty is told about both at once instead of one per attempt. `levels`
 * and `position` are filled independently: a priced plan still shows its risk and
 * reward while the size box is empty or wrong.
 */
export function evaluateStockPlan(input: StockPlanInput): StockPlanEvaluation {
  const issues: StockPlanIssue[] = [];

  const entryIssue = priceIssue(input.entry, 'entry', 'ราคาที่สนใจเข้า');
  const stopIssue = priceIssue(input.stopLoss, 'stopLoss', 'จุดตัดขาดทุน');
  const targetIssue = priceIssue(input.target, 'target', 'ราคาเป้าหมาย');
  for (const issue of [entryIssue, stopIssue, targetIssue]) if (issue) issues.push(issue);

  const entry = entryIssue ? null : input.entry as number;
  const stopLoss = stopIssue ? null : input.stopLoss as number;
  const target = targetIssue ? null : input.target as number;

  if (entry !== null && stopLoss !== null && stopLoss >= entry) {
    issues.push({ field: 'stopLoss', message: 'จุดตัดขาดทุนต้องต่ำกว่าราคาที่สนใจเข้า' });
  }
  if (entry !== null && target !== null && target <= entry) {
    issues.push({ field: 'target', message: 'ราคาเป้าหมายต้องสูงกว่าราคาที่สนใจเข้า' });
  }

  const priced = entry !== null && stopLoss !== null && target !== null && stopLoss < entry && target > entry;
  const levels: StockPlanLevels | null = priced
    ? (() => {
      const riskPerShare = entry - stopLoss;
      const rewardPerShare = target - entry;
      return {
        riskPerShare,
        rewardPerShare,
        riskPercent: riskPerShare / entry * 100,
        rewardPercent: rewardPerShare / entry * 100,
        // riskPerShare is proven above zero by `priced`, so this cannot divide by zero.
        rewardToRisk: rewardPerShare / riskPerShare,
      };
    })()
    : null;

  const position = sizePosition(input.sizing, entry, levels, issues);
  return { issues, levels, position };
}

/**
 * Turn a budget or a share count into the plan's real money.
 *
 * Whole shares only: a budget that buys 12.7 shares buys 12, and the cost, the
 * loss and the profit are all quoted for the 12 the reader would actually own —
 * quoting the fraction would overstate every one of them.
 */
function sizePosition(
  sizing: StockPlanSizing,
  entry: number | null,
  levels: StockPlanLevels | null,
  issues: StockPlanIssue[],
): StockPlanPosition | null {
  const { mode, amount } = sizing;
  if (amount === null) return null;

  const limit = mode === 'budget' ? MAX_BUDGET : MAX_SHARES;
  const label = mode === 'budget' ? 'เงินที่ต้องการลงทุน' : 'จำนวนหุ้น';
  if (!Number.isFinite(amount) || amount <= 0) {
    issues.push({ field: 'size', message: `${label}ต้องเป็นตัวเลขมากกว่า 0` });
    return null;
  }
  if (amount > limit) {
    issues.push({ field: 'size', message: `${label}สูงเกินกว่าที่เครื่องมือนี้รองรับ` });
    return null;
  }
  if (entry === null || levels === null) return null;

  const shares = Math.floor(mode === 'budget' ? amount / entry : amount);
  if (shares < 1) {
    issues.push({
      field: 'size',
      message: mode === 'budget'
        ? 'เงินที่ตั้งไว้ยังซื้อได้ไม่ถึง 1 หุ้น ลองเพิ่มเงินลงทุน'
        : 'จำนวนหุ้นต้องอย่างน้อย 1 หุ้น',
    });
    return null;
  }

  return {
    shares,
    cost: shares * entry,
    lossAtStop: -(shares * levels.riskPerShare),
    profitAtTarget: shares * levels.rewardPerShare,
  };
}

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = { USD: '$', THB: '฿' };

/** `$1,234.50`, with the sign in front of the symbol so a loss reads as one. */
export function formatPlanMoney(value: number, currency: string): string {
  if (!Number.isFinite(value)) return 'ไม่มีข้อมูล';
  const normalized = Object.is(value, -0) ? 0 : value;
  const symbol = CURRENCY_SYMBOL[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const amount = Math.abs(normalized).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${normalized < 0 ? '-' : ''}${symbol}${amount}`;
}

/** One decimal, which is as precise as a plan built from round numbers can be. */
export function formatPlanPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return 'ไม่มีข้อมูล';
  const normalized = Object.is(value, -0) ? 0 : value;
  return `${normalized.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

export function formatPlanShares(shares: number): string {
  return `${shares.toLocaleString('en-US')} หุ้น`;
}

/** `1 : 2.4` — risk always normalised to one, because that is how it is read. */
export function formatRiskRewardRatio(rewardToRisk: number): string {
  if (!Number.isFinite(rewardToRisk)) return 'ไม่มีข้อมูล';
  return `1 : ${rewardToRisk.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}

/**
 * THE SHAPE OF THE PLAN, AND STRICTLY NOT ITS PROSPECTS.
 *
 * A plan's status here answers one question: how the reader's own three prices
 * are proportioned against each other. It is 🟢 at 1:2 or better, and 🔴 below
 * 1:1 — the point at which the plan risks more than it reaches for.
 *
 * WHAT IT IS NOT, and the reason the wording is this careful: it is not a
 * judgement of whether the plan will work. A 1:3 plan on a stock in freefall is
 * still 🟢 here, because the ratio is a fact about the numbers and nothing in
 * this module has ever looked at a chart. That is the same line
 * {@link stockPlanSummary} holds and the same one the Planner prints beside the
 * figures.
 *
 * `levels` is `null` whenever the three prices are not usable together, and the
 * status is ⚪ then — never the level a zero would give, which would be 🔴 and
 * would read as a verdict on a plan the reader has not finished stating.
 */
export function stockPlanStatus(levels: StockPlanLevels | null): StatusLevel {
  return statusFromRewardRisk(levels?.rewardToRisk ?? null);
}

/**
 * The status said in the reader's own terms, for the row beside it.
 *
 * Deliberately about proportion rather than quality — "คุ้มค่า" would be the
 * verdict this module refuses to give, so the words describe the ratio: how much
 * the plan reaches for against how much it puts at risk.
 */
export const STOCK_PLAN_STATUS_LABEL: Readonly<Record<StatusLevel, string>> = {
  good: 'หวังผลมากกว่าที่เสี่ยงหลายเท่า',
  neutral: 'หวังผลมากกว่าที่เสี่ยงปานกลาง',
  weak: 'หวังผลมากกว่าที่เสี่ยงไม่มาก',
  bad: 'เสี่ยงมากกว่าที่หวังผล',
  unknown: 'ยังกรอกไม่ครบ',
};

/**
 * The same three figures again, as sentences.
 *
 * A beginner reading "R:R 1 : 2.4" and a beginner reading "ยอมเสี่ยง 1 ส่วน เพื่อ
 * หวังผลตอบแทนประมาณ 2.4 ส่วน" are not always the same person, so the tool says
 * it both ways. Every sentence is conditional — "ถ้าราคาลงถึง…" — and none of
 * them tells the reader what to do about it.
 */
export function stockPlanSummary(levels: StockPlanLevels): readonly string[] {
  const ratio = levels.rewardToRisk.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return [
    `ถ้าราคาลงถึงจุดตัดขาดทุน คุณเสี่ยงประมาณ ${formatPlanPercent(levels.riskPercent)}`,
    `ถ้าราคาขึ้นถึงเป้าหมาย ผลตอบแทนจากจุดเข้าอยู่ที่ประมาณ ${formatPlanPercent(levels.rewardPercent)}`,
    `แผนนี้ยอมเสี่ยง 1 ส่วน เพื่อหวังผลตอบแทนประมาณ ${ratio} ส่วน`,
  ];
}

/**
 * Where Entry sits on the Stop → Target line, as a percentage of its width.
 *
 * Purely for drawing the bar. Clamped away from both ends so the Entry marker
 * and its label never sit on top of the Stop or Target label at 320px, however
 * lopsided the plan is.
 */
export function entryMarkerPercent(levels: StockPlanLevels): number {
  const span = levels.riskPerShare + levels.rewardPerShare;
  const position = levels.riskPerShare / span * 100;
  return Math.min(82, Math.max(18, position));
}
