import type { DisplayDataStatus } from '@/src/components/market-data/DataProvenance';
import type {
  IvLevel,
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

/** Describe the IV basis truthfully — the fallback is never labelled "IV Rank". */
export function ivBasisLabel(basis: 'iv-rank' | 'iv-vs-realized' | null): string {
  if (basis === 'iv-rank') return 'IV Rank';
  if (basis === 'iv-vs-realized') return 'IV เทียบความผันผวนจริง 1 ปี';
  return 'IV Rank';
}
