/**
 * วางแผนหุ้นรายตัว v1 — the plan a reader states, and the little that follows from it.
 *
 * This is the arithmetic behind the Planner's first screen, and it is deliberately
 * the smallest thing that could answer the question. A plan is three prices and a
 * date: where the stock is now, where the reader thinks it is going, and the level
 * at which they would accept that the plan did not work out — by when.
 *
 * Everything the tool says is one of those four restated:
 *
 *   upside     = (target − baseline) / baseline × 100
 *   downside   = (baseline − invalidation) / baseline × 100
 *   rewardRisk = upside / downside
 *
 * Three rules this module exists to hold, all of them about not saying more than
 * the inputs support:
 *
 *  - **The baseline is the market's number, not the reader's.** It arrives from
 *    the canonical accepted price — the same value the Stock Detail header shows —
 *    and the form never lets it be typed. A plan measured from a made-up "current"
 *    price would produce percentages about a market that does not exist.
 *  - **Nothing divides by a number it has not proven.** `baseline` is checked
 *    finite and above zero before any percentage is taken from it, and the
 *    downside is proven above zero before `rewardRisk` divides by it. No path
 *    here returns Infinity or NaN.
 *  - **A distance is not a probability.** `upside` is how far the target is from
 *    today's price, and that is all it is. There is no model here, so there is no
 *    forecast, no confidence, no rating, and no signal — see
 *    {@link OUTLOOK_NOT_PROBABILITY_NOTICE}, which the UI is required to print
 *    next to the figures.
 *
 * v1 plans one direction only: long. `target > baseline > invalidation` is
 * enforced rather than inferred, because a form that quietly accepted an inverted
 * plan would compute a negative "upside" and present it as an opportunity.
 */

/** Which field a message belongs to, so the form can show it in place. */
export type PlanOutlookField = 'baseline' | 'target' | 'invalidation' | 'horizon';

export interface PlanOutlookIssue {
  field: PlanOutlookField;
  message: string;
}

/**
 * The sentence the UI must print beside the figures.
 *
 * Exported as a constant rather than typed into the component so the wording
 * cannot drift away from the arithmetic it qualifies, and so a test can prove it
 * is actually on screen.
 */
export const OUTLOOK_NOT_PROBABILITY_NOTICE =
  'โอกาสขึ้นคือส่วนต่างถึงราคาเป้าหมาย ไม่ใช่ความน่าจะเป็น';

/** The reader's four answers, before any of them has been checked. */
export interface PlanOutlookInput {
  /** The canonical accepted price. Never typed by the reader. */
  baselinePrice: number | null;
  targetPrice: number | null;
  invalidationPrice: number | null;
  /** `YYYY-MM-DD`, exchange-local. */
  horizonDate: string | null;
  /** `YYYY-MM-DD` for today, supplied so this module never reads a clock. */
  today: string;
}

/** What the three prices imply. Every field finite by construction. */
export interface PlanOutlook {
  /** Distance up to the target, as a percentage of the baseline. Above zero. */
  upsidePercent: number;
  /** Distance down to the invalidation level, as a percentage. Above zero. */
  downsidePercent: number;
  /** upside ÷ downside — the `2.4` in "1 : 2.4". Finite by construction. */
  rewardRisk: number;
}

/**
 * The three price levels the reader chose, restated as outcomes.
 *
 * Not a forecast and not a distribution: each row is one of the reader's own
 * numbers with its distance from today's price worked out. There is no fourth
 * scenario because there is no fourth number to build one from.
 */
export type PlanScenarioKind = 'invalidation' | 'flat' | 'target';

export interface PlanScenario {
  kind: PlanScenarioKind;
  label: string;
  price: number;
  /** Change from the baseline, in percent. Negative, zero, positive in order. */
  changePercent: number;
}

export interface PlanOutlookEvaluation {
  issues: readonly PlanOutlookIssue[];
  /** Present only when all three prices are usable together. */
  outlook: PlanOutlook | null;
  /** Present exactly when `outlook` is. Always the same three rows. */
  scenarios: readonly PlanScenario[] | null;
}

/*
  Bounds, so an accidental paste (a phone number into a price box) is answered
  with a sentence rather than with a plan built on it. Far outside any real quote;
  they keep the arithmetic meaningful and are not a view about any market.
*/
const MAX_PRICE = 1_000_000;
/** A plan whose horizon is decades out is a typo, not a plan. */
const MAX_HORIZON_DAYS = 3_650;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function priceIssue(
  value: number | null,
  field: PlanOutlookField,
  label: string,
): PlanOutlookIssue | null {
  if (value === null) return { field, message: `กรอก${label}ก่อน จึงจะวิเคราะห์แผนได้` };
  if (!Number.isFinite(value) || value <= 0) return { field, message: `${label}ต้องเป็นตัวเลขมากกว่า 0` };
  if (value > MAX_PRICE) return { field, message: `${label}สูงเกินกว่าที่เครื่องมือนี้รองรับ` };
  return null;
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`.
 *
 * Compared at UTC midnight rather than with a local `Date`, so the answer cannot
 * change with the reader's time zone: a horizon is a calendar date the plan runs
 * to, and it must mean the same day in Bangkok and in New York.
 */
export function daysBetween(from: string, to: string): number | null {
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

/**
 * The whole first screen, as one function of its inputs.
 *
 * Returns every problem it found rather than the first, so a reader who inverted
 * two prices is told about both at once instead of one per attempt.
 */
export function evaluatePlanOutlook(input: PlanOutlookInput): PlanOutlookEvaluation {
  const issues: PlanOutlookIssue[] = [];

  const baselineIssue = priceIssue(input.baselinePrice, 'baseline', 'ราคาปัจจุบัน');
  const targetIssue = priceIssue(input.targetPrice, 'target', 'ราคาเป้าหมาย');
  const invalidationIssue = priceIssue(input.invalidationPrice, 'invalidation', 'ระดับที่แผนไม่เป็นไปตามคาด');
  for (const issue of [baselineIssue, targetIssue, invalidationIssue]) if (issue) issues.push(issue);

  const baseline = baselineIssue ? null : input.baselinePrice as number;
  const target = targetIssue ? null : input.targetPrice as number;
  const invalidation = invalidationIssue ? null : input.invalidationPrice as number;

  /*
    v1 is long-only, and says so rather than inferring a direction. An inverted
    plan is refused here instead of being computed into a negative "upside" that
    the result card would print with a plus sign in front of it.
  */
  if (baseline !== null && target !== null && target <= baseline) {
    issues.push({ field: 'target', message: 'ราคาเป้าหมายต้องสูงกว่าราคาปัจจุบัน' });
  }
  if (baseline !== null && invalidation !== null && invalidation >= baseline) {
    issues.push({ field: 'invalidation', message: 'ระดับที่แผนไม่เป็นไปตามคาดต้องต่ำกว่าราคาปัจจุบัน' });
  }

  issues.push(...horizonIssues(input.horizonDate, input.today));

  const priced = baseline !== null && target !== null && invalidation !== null
    && target > baseline && invalidation < baseline;
  if (!priced) return { issues, outlook: null, scenarios: null };

  const upsidePercent = (target - baseline) / baseline * 100;
  const downsidePercent = (baseline - invalidation) / baseline * 100;
  const outlook: PlanOutlook = {
    upsidePercent,
    downsidePercent,
    // `downsidePercent` is proven above zero by `priced`, so this cannot divide by zero.
    rewardRisk: upsidePercent / downsidePercent,
  };

  const scenarios: PlanScenario[] = [
    { kind: 'invalidation', label: 'หลุดแผน', price: invalidation, changePercent: -downsidePercent },
    { kind: 'flat', label: 'ทรงตัว', price: baseline, changePercent: 0 },
    { kind: 'target', label: 'ถึงเป้าหมาย', price: target, changePercent: upsidePercent },
  ];

  return { issues, outlook, scenarios };
}

function horizonIssues(horizonDate: string | null, today: string): PlanOutlookIssue[] {
  if (horizonDate === null || horizonDate === '') {
    return [{ field: 'horizon', message: 'เลือกระยะเวลาของแผนก่อน จึงจะวิเคราะห์แผนได้' }];
  }
  if (!DATE_PATTERN.test(horizonDate)) {
    return [{ field: 'horizon', message: 'รูปแบบวันที่ไม่ถูกต้อง' }];
  }
  const days = daysBetween(today, horizonDate);
  if (days === null) return [{ field: 'horizon', message: 'รูปแบบวันที่ไม่ถูกต้อง' }];
  if (days <= 0) return [{ field: 'horizon', message: 'ระยะเวลาของแผนต้องเป็นวันในอนาคต' }];
  if (days > MAX_HORIZON_DAYS) {
    return [{ field: 'horizon', message: 'ระยะเวลาของแผนไกลเกินกว่าที่เครื่องมือนี้รองรับ' }];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Horizon presets                                                             */
/* -------------------------------------------------------------------------- */

export type PlanHorizonPreset = '1m' | '3m' | '6m' | '1y' | 'custom';

/** The default a plan starts on, named once so the form and its test agree. */
export const DEFAULT_HORIZON_PRESET: PlanHorizonPreset = '3m';

export const HORIZON_PRESET_LABEL: Readonly<Record<PlanHorizonPreset, string>> = {
  '1m': '1 เดือน',
  '3m': '3 เดือน',
  '6m': '6 เดือน',
  '1y': '1 ปี',
  custom: 'กำหนดเอง',
};

export const HORIZON_PRESETS: readonly PlanHorizonPreset[] = ['1m', '3m', '6m', '1y', 'custom'];

const PRESET_MONTHS: Readonly<Record<Exclude<PlanHorizonPreset, 'custom'>, number>> = {
  '1m': 1, '3m': 3, '6m': 6, '1y': 12,
};

/**
 * `today` plus a preset's months, as `YYYY-MM-DD`.
 *
 * Month arithmetic is done on UTC parts and then clamped, because "3 months from
 * the 31st" has no 31st to land on in two of the four cases and the platform's
 * own `setMonth` rolls it forward into the next month instead. A plan made on
 * 31 January with a 1-month horizon runs to 28 February, not to 3 March.
 */
export function horizonDateForPreset(preset: PlanHorizonPreset, today: string): string | null {
  if (preset === 'custom') return null;
  if (!DATE_PATTERN.test(today)) return null;
  const [year, month, day] = today.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const targetMonthIndex = (month - 1) + PRESET_MONTHS[preset];
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12) + 1;
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const clamped = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

/** Today as `YYYY-MM-DD` in the exchange's zone, which is the zone a plan runs in. */
export function planToday(now: Date = new Date(), timeZone = 'America/New_York'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/* -------------------------------------------------------------------------- */
/* Saved plan status                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a saved plan can be said to be, using only what is provable right now.
 *
 * There is deliberately no "เคยแตะเป้าหมาย" here. The app stores a plan's levels
 * and its dates, not a price history for the symbol, so a claim that the stock
 * *reached* a level at some point between saving and today would be an assertion
 * with nothing behind it. Every member below is decidable from the plan's own
 * row plus one current price.
 */
export type SavedPlanStatus = 'tracking' | 'at-target' | 'below-invalidation' | 'expired';

export const SAVED_PLAN_STATUS_LABEL: Readonly<Record<SavedPlanStatus, string>> = {
  tracking: 'กำลังติดตาม',
  'at-target': 'ถึงระดับเป้าหมายในปัจจุบัน',
  'below-invalidation': 'ต่ำกว่าระดับแผนในปัจจุบัน',
  expired: 'ครบระยะเวลา',
};

/**
 * The plan's status, in the one order the labels can be justified in.
 *
 * The horizon is checked first because it is decidable from the calendar alone:
 * a plan past its date has run its course whatever the price is doing, and
 * calling it "ถึงระดับเป้าหมาย" today would describe a plan that is over. The two
 * price labels are explicitly *ในปัจจุบัน* — they describe where the price is
 * right now, and neither claims anything about the days in between.
 */
export function savedPlanStatus(input: {
  targetPrice: number;
  invalidationPrice: number;
  horizonDate: string;
  currentPrice: number | null;
  today: string;
}): SavedPlanStatus {
  const remaining = daysBetween(input.today, input.horizonDate);
  if (remaining !== null && remaining <= 0) return 'expired';
  const price = input.currentPrice;
  if (price === null || !Number.isFinite(price) || price <= 0) return 'tracking';
  if (price >= input.targetPrice) return 'at-target';
  if (price <= input.invalidationPrice) return 'below-invalidation';
  return 'tracking';
}

/** Change from the plan's baseline to a current price, in percent. */
export function changeFromBaseline(baselinePrice: number, currentPrice: number | null): number | null {
  if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  if (!Number.isFinite(baselinePrice) || baselinePrice <= 0) return null;
  return (currentPrice - baselinePrice) / baselinePrice * 100;
}

/** "เหลือ 62 วัน" / "ครบระยะเวลาแล้ว" — never a countdown into the negative. */
export function horizonRemainingLabel(horizonDate: string, today: string): string {
  const remaining = daysBetween(today, horizonDate);
  if (remaining === null) return 'ไม่มีข้อมูล';
  if (remaining <= 0) return 'ครบระยะเวลาแล้ว';
  if (remaining === 1) return 'เหลืออีก 1 วัน';
  return `เหลืออีก ${remaining.toLocaleString('en-US')} วัน`;
}

/** `1 : 2.4` — risk normalised to one, because that is how it is read. */
export function formatRewardRisk(rewardRisk: number): string {
  if (!Number.isFinite(rewardRisk)) return 'ไม่มีข้อมูล';
  return `1 : ${rewardRisk.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}
