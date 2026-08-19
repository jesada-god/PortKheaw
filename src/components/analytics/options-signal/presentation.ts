import type { DisplayDataStatus } from '@/src/components/market-data/DataProvenance';
import type {
  IvLevel,
  IvPricingInput,
  LiquidityGrade,
  OptionsSignalDataState,
  OptionsSignalFactorId,
  OptionsSignalType,
} from '@/src/lib/analytics/options-signal/types';

/**
 * Beginner-facing Thai copy for the Options Signal card. Kept pure and separate
 * from the component so the wording is unit-testable and every signal type is
 * guaranteed by the type system to have copy.
 */

export interface SignalPresentation {
  /** Screen-reader-safe status word; the emoji is decorative only. */
  dot: string;
  title: string;
  headline: string;
  tone: string;
  badgeTone: string;
}

export const OPTIONS_SIGNAL_PRESENTATION = {
  PRIME_CALL: {
    dot: '🟢',
    title: 'PRIME CALL',
    headline: 'หลักฐานฝั่งขาขึ้นหนักแน่นและสอดคล้องกัน',
    tone: 'border-emerald-400/40 bg-emerald-500/10',
    badgeTone: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200',
  },
  CALL_WATCH: {
    dot: '🟡',
    title: 'CALL WATCH',
    headline: 'เอนไปทางขาขึ้น แต่หลักฐานยังไม่ครบพอจะเรียกว่าแข็งแรง',
    tone: 'border-lime-400/30 bg-lime-500/10',
    badgeTone: 'border-lime-400/40 bg-lime-500/15 text-lime-200',
  },
  SIDEWAYS: {
    dot: '⚪',
    title: 'SIDEWAYS',
    headline: 'ยังไม่เลือกทาง การซื้อ Call หรือ Put ฝั่งเดียวเสียเปรียบ',
    tone: 'border-slate-600/40 bg-slate-500/10',
    badgeTone: 'border-slate-500/40 bg-slate-500/15 text-slate-200',
  },
  PUT_WATCH: {
    dot: '🟠',
    title: 'PUT WATCH',
    headline: 'เอนไปทางขาลง แต่หลักฐานยังไม่ครบพอจะเรียกว่าแข็งแรง',
    tone: 'border-orange-400/30 bg-orange-500/10',
    badgeTone: 'border-orange-400/40 bg-orange-500/15 text-orange-200',
  },
  PRIME_PUT: {
    dot: '🔴',
    title: 'PRIME PUT',
    headline: 'หลักฐานฝั่งขาลงหนักแน่นและสอดคล้องกัน',
    tone: 'border-red-500/40 bg-red-500/10',
    badgeTone: 'border-red-500/40 bg-red-500/15 text-red-200',
  },
  IV_WARNING: {
    dot: '⚠️',
    title: 'IV WARNING',
    headline: 'ค่าพรีเมียมแพงมากหรือใกล้ประกาศงบ ความเสี่ยงสูงกว่าปกติ',
    tone: 'border-amber-400/40 bg-amber-500/10',
    badgeTone: 'border-amber-400/40 bg-amber-500/15 text-amber-200',
  },
} as const satisfies Record<OptionsSignalType, SignalPresentation>;

export const FACTOR_COPY = {
  macro: { label: 'Macro', helper: 'ภาพรวมตลาด: SPY และ QQQ ยืนเหนือหรือต่ำกว่า EMA20' },
  trend: { label: 'Trend', helper: 'ราคาหุ้นเทียบเส้นค่าเฉลี่ย EMA20 และ EMA50' },
  momentum: { label: 'Momentum', helper: 'TTM Squeeze บอกการบีบตัว/ปลดล็อก และ RVOL ใช้ยืนยันเท่านั้น' },
  sentiment: { label: 'Options Sentiment', helper: 'Put/Call Ratio จาก Open Interest จริงของ chain' },
  riskReward: { label: 'Risk/Reward', helper: 'ระยะจากราคาปัจจุบันถึงแนวรับและแนวต้านที่ยืนยันแล้ว' },
} as const satisfies Record<OptionsSignalFactorId, { label: string; helper: string }>;

export const IV_LEVEL_LABEL = {
  low: 'ต่ำ',
  normal: 'ปกติ',
  high: 'สูง',
  extreme: 'สูงมาก · เสี่ยง',
} as const satisfies Record<IvLevel, string>;

export const DATA_STATE_LABEL = {
  LIVE: 'ข้อมูลเรียลไทม์',
  DELAYED: 'ข้อมูลหน่วงเวลา',
  STALE: 'ข้อมูลเก่ากว่าปกติ',
  UNAVAILABLE: 'ไม่มีข้อมูล',
} as const satisfies Record<OptionsSignalDataState, string>;

export function displayStatusOf(state: OptionsSignalDataState): DisplayDataStatus {
  return state === 'LIVE' ? 'live' : state === 'DELAYED' ? 'delayed' : state === 'STALE' ? 'stale' : 'unavailable';
}

/** `+15`, `-8`, or an em dash for a factor that produced no score. */
export function signedPoints(points: number | null): string {
  return points === null ? '—' : `${points > 0 ? '+' : ''}${points}`;
}

/**
 * Describe the IV basis truthfully — the fallback is never labelled "IV Rank",
 * and the realized-volatility fallback names the window it actually used rather
 * than claiming a year it may not have measured.
 */
/**
 * The basis, and the HORIZON the implied volatility was read at.
 *
 * The DTE is not a detail that belongs in the modal alone. An IV without its
 * expiration is a number nobody can place: 103.4% on a two-day contract that
 * holds an earnings report whole and 68.1% on a forty-four-day one that
 * amortises the same report are the same stock on the same afternoon, and only
 * the second is on the horizon this card's realized-volatility window and its
 * own suggested 30-60 day setup are written for. Where the horizon chain cannot
 * be resolved the card falls back to the front expiration, and then this label
 * is the only thing that says so.
 */
export function ivBasisLabel(
  basis: IvPricingInput['basis'] | null,
  realizedWindowDays: number | null = null,
  dte: number | null = null,
): string {
  const contract = dte === null ? '' : ` สัญญา ${dte} วัน`;
  if (basis === 'iv-rank') return `IV Rank${contract}`;
  if (basis === 'iv-percentile') return `IV Percentile (เทียบตัวเอง)${contract}`;
  if (basis === 'iv-vs-realized') {
    const window = realizedWindowDays === null ? '' : ` ${realizedWindowDays} วัน`;
    return `IV${contract} เทียบความผันผวนจริง${window}`;
  }
  return `IV Rank${contract}`;
}

/**
 * What to print where an IV percentile would go.
 *
 * THREE different states, and collapsing any two of them is a lie:
 *
 *   * a number — the percentile is published;
 *   * a COUNTDOWN — the series is short and fills itself in one reading per day,
 *     so "ไม่พร้อมใช้งาน" was the wrong word for it; and
 *   * an OUTAGE — the store cannot be read at all. This one must never wear the
 *     countdown, because the countdown would not be counting: a reader told to
 *     wait 60 days would still be waiting after 600.
 */
export function ivPercentileText(
  percentile: number | null,
  pending: { observations: number; required: number; missingDays: number } | null,
  storeUnavailable = false,
): string {
  if (percentile !== null) return String(percentile);
  if (storeUnavailable) return 'ใช้ไม่ได้ชั่วคราว (อ่านประวัติไม่สำเร็จ)';
  if (pending && pending.missingDays > 0) {
    return `ต้องการข้อมูลอีก ${pending.missingDays} วัน (มีแล้ว ${pending.observations}/${pending.required})`;
  }
  return 'ไม่พร้อมใช้งาน';
}

/** Said once, on the card, when the percentile bases are off for an outage. */
export const HISTORY_DEGRADED_NOTICE = {
  label: 'Percentile ใช้ไม่ได้ชั่วคราว',
  tone: 'border-amber-400/40 bg-amber-500/15 text-amber-200',
  helper: 'อ่านประวัติค่าย้อนหลังของหุ้นตัวนี้ไม่สำเร็จ IV Percentile และ Put/Call Percentile จึงยังใช้ไม่ได้ '
    + 'ไม่ใช่เพราะข้อมูลยังสะสมไม่พอ ระหว่างนี้การ์ดใช้เกณฑ์เทียบความผันผวนจริงแทน',
} as const;

/**
 * The liquidity badge. A few words a beginner can act on, not a raw score.
 *
 * `unknown` is deliberately NEUTRAL in tone rather than a warning colour. It is
 * the answer to "can I get out of this" asked while the book is shut, and
 * dressing that as a red flag would push readers away from chains that are
 * perfectly liquid at 10:00 and merely unquoted at 02:00.
 */
export const LIQUIDITY_BADGE = {
  good: { label: 'สภาพคล่องดี', tone: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200' },
  fair: { label: 'สภาพคล่องพอใช้', tone: 'border-amber-400/40 bg-amber-500/15 text-amber-200' },
  thin: { label: 'สภาพคล่องต้องระวัง', tone: 'border-red-500/40 bg-red-500/15 text-red-200' },
  unknown: { label: 'สภาพคล่องประเมินไม่ได้ (ตลาดปิด)', tone: 'border-slate-500/40 bg-slate-500/15 text-slate-200' },
} as const satisfies Record<LiquidityGrade, { label: string; tone: string }>;

/** Sources that disagree by more than the configured window say so, once. */
export const STALE_MIX_BADGE = {
  label: 'STALE-MIX',
  tone: 'border-amber-400/40 bg-amber-500/15 text-amber-200',
  helper: 'แหล่งข้อมูลของสัญญาณนี้มาจากคนละเวลากันเกินเกณฑ์ จึงยึดเวลาที่เก่าที่สุดเป็นเวลาของสัญญาณ',
} as const;

/**
 * The sentence that stops the dialog contradicting itself about direction.
 *
 * Risk:Reward is scored for the side the OTHER FOUR factors lean toward, and
 * that lean is read at an earlier point in the pipeline than the label on the
 * card. Two steps sit between them:
 *
 *   1. the Risk:Reward points themselves join the sum;
 *   2. the trend veto attenuates the whole total toward zero.
 *
 * So a card can honestly print "หลักฐานอื่นชี้ขาขึ้น จึงวัดจากฝั่ง Call" beside a
 * SIDEWAYS badge, and a reader who does not know the order of operations sees
 * two claims about direction that do not agree, four centimetres apart, with
 * nothing on the page reconciling them.
 *
 * The ordering is not a defect and this does not change it. What it changes is
 * that the page now says so, and says it only when the two actually differ — a
 * note that appeared on every card would be noise on the ones that agree, and
 * unread by the time it mattered.
 *
 * Deliberately NOT limited to the veto. The veto is one of the two steps, and it
 * is the one the reader can see a number for, but adding the Risk:Reward points
 * can move the total across the neutral band on its own. Naming only the veto
 * would be a third claim that does not match the arithmetic.
 */
export function riskRewardDirectionNote(input: {
  scoredSide: 'call' | 'put' | null;
  signalType: OptionsSignalType | null;
  underlyingBias: 'bullish' | 'bearish' | 'neutral' | null;
  trendVeto: { applied: boolean; multiplier: number } | null;
}): string | null {
  const { scoredSide, signalType, underlyingBias, trendVeto } = input;
  if (scoredSide === null) return null;
  const expected = scoredSide === 'call' ? 'bullish' : 'bearish';
  if (underlyingBias === null || underlyingBias === expected) return null;

  const side = scoredSide === 'call' ? 'Call' : 'Put';
  const lean = scoredSide === 'call' ? 'ขาขึ้น' : 'ขาลง';
  const badge = signalType === null ? 'ป้ายสุดท้าย' : OPTIONS_SIGNAL_PRESENTATION[signalType].title;
  const because = trendVeto?.applied
    ? `หลังจากนั้นคะแนน R:R ถูกรวมเข้าไป และคะแนนรวมถูกหักด้วยแนวโน้มสวนทาง `
      + `(× ${trendVeto.multiplier.toFixed(2)}) จนเหลือไม่พอจะเรียกทิศทางเดียวกัน`
    : 'หลังจากนั้นคะแนน R:R ถูกรวมเข้าไปด้วย แล้วคะแนนรวมไม่พอจะเรียกทิศทางเดียวกัน';

  return `หมายเหตุ: R:R ข้างบนวัดจากฝั่ง ${side} เพราะปัจจัยอื่นอีก 4 ตัวชี้${lean} `
    + `ในขั้นก่อนหน้า ซึ่งเป็นทิศ "ก่อน" นำคะแนน R:R มารวมและก่อนหักด้วย trend veto · `
    + `${because} ป้ายบนการ์ดจึงเป็น ${badge} · `
    + `ทั้งสองประโยคมาจากคนละขั้นของการคำนวณ ไม่ได้ขัดกัน`;
}
