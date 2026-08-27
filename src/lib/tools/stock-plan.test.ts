import { describe, expect, it } from 'vitest';
import {
  entryMarkerPercent,
  evaluateStockPlan,
  formatPlanMoney,
  formatPlanPercent,
  formatPlanShares,
  formatRiskRewardRatio,
  parsePlanNumber,
  stockPlanStatus,
  stockPlanSummary,
  STOCK_PLAN_STATUS_LABEL,
  type StockPlanInput,
} from './stock-plan';

const unsized = { mode: 'budget', amount: null } as const;
const plan = (over: Partial<StockPlanInput> = {}): StockPlanInput => ({
  entry: 100, stopLoss: 95.8, target: 110.1, sizing: unsized, ...over,
});

describe('stock plan arithmetic', () => {
  it('turns three prices into risk, reward and the ratio between them', () => {
    const { issues, levels } = evaluateStockPlan(plan());
    expect(issues).toEqual([]);
    expect(levels).not.toBeNull();
    expect(levels!.riskPerShare).toBeCloseTo(4.2, 10);
    expect(levels!.rewardPerShare).toBeCloseTo(10.1, 10);
    expect(levels!.riskPercent).toBeCloseTo(4.2, 10);
    expect(levels!.rewardPercent).toBeCloseTo(10.1, 10);
    expect(levels!.rewardToRisk).toBeCloseTo(10.1 / 4.2, 10);
    expect(formatRiskRewardRatio(levels!.rewardToRisk)).toBe('1 : 2.4');
  });

  it('says the plan in beginner sentences that match the figures exactly', () => {
    const { levels } = evaluateStockPlan(plan());
    expect(stockPlanSummary(levels!)).toEqual([
      'ถ้าราคาลงถึงจุดตัดขาดทุน คุณเสี่ยงประมาณ 4.2%',
      'ถ้าราคาขึ้นถึงเป้าหมาย ผลตอบแทนจากจุดเข้าอยู่ที่ประมาณ 10.1%',
      'แผนนี้ยอมเสี่ยง 1 ส่วน เพื่อหวังผลตอบแทนประมาณ 2.4 ส่วน',
    ]);
  });

  /*
    The whole point of the tool is that it plans rather than advises, and the
    only strings it produces on its own are these. If a directive ever gets
    written into one, this fails before it can reach a reader.
  */
  it('never tells the reader to buy or to sell', () => {
    const { levels } = evaluateStockPlan(plan());
    for (const sentence of stockPlanSummary(levels!)) {
      expect(sentence).not.toMatch(/ควรซื้อ|ซื้อเลย|ควรขาย|ขายเลย|แนะนำให้/);
    }
  });
});

describe('stock plan refusals', () => {
  it('refuses a stop at or above the entry, and a target at or below it', () => {
    const above = evaluateStockPlan(plan({ stopLoss: 100 }));
    expect(above.levels).toBeNull();
    expect(above.issues).toContainEqual({ field: 'stopLoss', message: 'จุดตัดขาดทุนต้องต่ำกว่าราคาที่สนใจเข้า' });

    const below = evaluateStockPlan(plan({ target: 100 }));
    expect(below.levels).toBeNull();
    expect(below.issues).toContainEqual({ field: 'target', message: 'ราคาเป้าหมายต้องสูงกว่าราคาที่สนใจเข้า' });
  });

  /*
    An entry of zero is the divide-by-zero this module must never perform: the
    percentages take entry as their denominator and the ratio takes the risk per
    share. Both are refused before they are used, so nothing downstream ever
    receives Infinity or NaN to format.
  */
  it.each([
    ['zero', 0],
    ['negative', -10],
    ['not a number', Number.NaN],
    ['absurd', 5_000_000],
  ])('refuses a %s entry price instead of dividing by it', (_label, entry) => {
    const { issues, levels, position } = evaluateStockPlan(plan({ entry, sizing: { mode: 'budget', amount: 1000 } }));
    expect(levels).toBeNull();
    expect(position).toBeNull();
    expect(issues.some((issue) => issue.field === 'entry')).toBe(true);
    for (const issue of issues) expect(issue.message).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('reports every empty price at once rather than one per attempt', () => {
    const { issues } = evaluateStockPlan({ entry: null, stopLoss: null, target: null, sizing: unsized });
    expect(issues.map((issue) => issue.field)).toEqual(['entry', 'stopLoss', 'target']);
  });

  it('treats an unanswered size as unanswered, not as zero', () => {
    const { issues, position } = evaluateStockPlan(plan());
    expect(position).toBeNull();
    expect(issues).toEqual([]);
  });
});

describe('stock plan sizing', () => {
  it('buys whole shares with the budget and prices both exits from them', () => {
    const { position } = evaluateStockPlan(plan({ sizing: { mode: 'budget', amount: 5000 } }));
    // 5000 / 100 = 50 shares exactly.
    expect(position!.shares).toBe(50);
    expect(position!.cost).toBe(5000);
    expect(position!.lossAtStop).toBeCloseTo(-210, 8);
    expect(position!.profitAtTarget).toBeCloseTo(505, 8);
  });

  it('rounds a budget down to the shares it actually buys', () => {
    const { position } = evaluateStockPlan(plan({ sizing: { mode: 'budget', amount: 1270 } }));
    expect(position!.shares).toBe(12);
    expect(position!.cost).toBe(1200);
  });

  it('accepts a share count directly and floors a fractional one', () => {
    const { position } = evaluateStockPlan(plan({ sizing: { mode: 'shares', amount: 10.9 } }));
    expect(position!.shares).toBe(10);
    expect(position!.cost).toBe(1000);
    expect(position!.lossAtStop).toBeCloseTo(-42, 10);
    expect(position!.profitAtTarget).toBeCloseTo(101, 10);
  });

  it('explains a budget too small for one share instead of showing zero shares', () => {
    const { position, issues } = evaluateStockPlan(plan({ sizing: { mode: 'budget', amount: 40 } }));
    expect(position).toBeNull();
    expect(issues).toContainEqual({ field: 'size', message: 'เงินที่ตั้งไว้ยังซื้อได้ไม่ถึง 1 หุ้น ลองเพิ่มเงินลงทุน' });
  });

  it('keeps the priced plan readable even when the size is wrong', () => {
    const { levels, position } = evaluateStockPlan(plan({ sizing: { mode: 'shares', amount: -5 } }));
    expect(levels).not.toBeNull();
    expect(position).toBeNull();
  });
});

describe('stock plan presentation', () => {
  it.each([
    ['', null],
    ['  ', null],
    ['1,250.5', 1250.5],
    ['abc', Number.NaN],
  ])('reads the draft %s', (draft, expected) => {
    const parsed = parsePlanNumber(draft);
    if (expected === null) expect(parsed).toBeNull();
    else if (Number.isNaN(expected)) expect(Number.isNaN(parsed as number)).toBe(true);
    else expect(parsed).toBe(expected);
  });

  it('formats money, percentages and share counts the way the cards read them', () => {
    expect(formatPlanMoney(1234.5, 'USD')).toBe('$1,234.50');
    expect(formatPlanMoney(-210, 'USD')).toBe('-$210.00');
    expect(formatPlanMoney(-0, 'THB')).toBe('฿0.00');
    expect(formatPlanMoney(10, 'EUR')).toBe('EUR 10.00');
    expect(formatPlanMoney(Number.NaN, 'USD')).toBe('ไม่มีข้อมูล');
    expect(formatPlanPercent(4.2)).toBe('4.2%');
    expect(formatPlanShares(1500)).toBe('1,500 หุ้น');
  });

  it('keeps the Entry marker clear of both ends however lopsided the plan is', () => {
    const balanced = evaluateStockPlan(plan({ entry: 100, stopLoss: 90, target: 110 })).levels!;
    expect(entryMarkerPercent(balanced)).toBeCloseTo(50, 10);
    const tinyRisk = evaluateStockPlan(plan({ entry: 100, stopLoss: 99.9, target: 200 })).levels!;
    expect(entryMarkerPercent(tinyRisk)).toBe(18);
    const tinyReward = evaluateStockPlan(plan({ entry: 100, stopLoss: 10, target: 100.1 })).levels!;
    expect(entryMarkerPercent(tinyReward)).toBe(82);
  });
});

describe('the status of a stated plan', () => {
  const levelsFor = (stopLoss: number, target: number) =>
    evaluateStockPlan(plan({ entry: 100, stopLoss, target })).levels;

  it('reads the ratio, at the cut points the tool has always drawn', () => {
    // 1:3, 1:2, 1:1.75, 1:1.25, 1:0.5 — one on each side of every boundary.
    expect(stockPlanStatus(levelsFor(90, 130))).toBe('good');
    expect(stockPlanStatus(levelsFor(90, 120))).toBe('good');
    expect(stockPlanStatus(levelsFor(90, 117.5))).toBe('neutral');
    expect(stockPlanStatus(levelsFor(90, 112.5))).toBe('weak');
    expect(stockPlanStatus(levelsFor(90, 105))).toBe('bad');
  });

  /*
   * A plan the reader has not finished stating is ⚪, never 🔴.
   *
   * `levels` is null until all three prices are usable together, and a form that
   * turned "you have not filled this in" into "this plan risks more than it
   * reaches for" would be delivering a verdict on numbers nobody has entered.
   */
  it('does not deliver a verdict on a plan that is not stated yet', () => {
    expect(stockPlanStatus(null)).toBe('unknown');
    expect(stockPlanStatus(evaluateStockPlan(plan({ target: null })).levels)).toBe('unknown');
    expect(stockPlanStatus(evaluateStockPlan(plan({ stopLoss: 120 })).levels)).toBe('unknown');
  });

  it('describes the proportion and never whether the plan is a good one', () => {
    for (const label of Object.values(STOCK_PLAN_STATUS_LABEL)) {
      /*
       * The tool states what the numbers imply, and never whether to act on
       * them. These are the words that would cross that line — the bare "ควร"
       * is deliberately NOT among them, because "ปานกลาง" and "พอสมควร" contain
       * it while advising nothing, and a substring check would have quietly
       * banned every ordinary adverb in the language.
       */
      expect(label).not.toMatch(/คุ้มค่า|ควรซื้อ|ควรเข้า|ควรขาย|น่าสนใจ|แนะนำ/);
    }
    expect(STOCK_PLAN_STATUS_LABEL.bad).toContain('เสี่ยงมากกว่า');
    expect(STOCK_PLAN_STATUS_LABEL.unknown).toContain('ยังกรอกไม่ครบ');
  });
});
