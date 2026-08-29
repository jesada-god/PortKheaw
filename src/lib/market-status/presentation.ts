import type { StatusLevel } from '@/src/lib/presentation/status';
import type { MarketRegime, MarketStatusLabel } from '@/src/config/market-status';
import { thaiSessionDate } from '@/src/lib/portfolio/day-change-label';
import type { MarketStatusEvaluation } from './rules';

/**
 * The words on the Market Status card.
 *
 * ===========================================================================
 * WRITTEN FOR SOMEBODY WHO OWNS SHARES, NOT SOMEBODY WHO TRADES FOR A LIVING
 * ===========================================================================
 * `CARD_MUST_NOT_SAY` bans the vocabulary that only means something to a reader
 * who already knows what the card is about to tell them — โซน, ไซด์เวย์, เบรก,
 * โมเมนตัม, วอลุ่ม, โครงสร้าง and the rest. Nothing here reaches for one, and
 * that constraint shaped the copy rather than being checked after it:
 *
 *   * SIDEWAYS is "ทรงตัว" — not "ไซด์เวย์", which is the English word in Thai
 *     letters and explains nothing to anybody who did not already know it.
 *   * WEAK is "แผ่วลง", an ordinary Thai word for losing steam.
 *   * The regime is not "Risk-On/Risk-Off". It is what risk-on MEANS: money
 *     moving toward or away from riskier assets.
 *
 * The English regime names stay out of the reader's sentence entirely. They are
 * in the type because that is what the concept is called, not because it is
 * something to print.
 *
 * ===========================================================================
 * NO SCORE, NO PERCENTAGE, NO AGE THAT IS NOT THE RAW ONE
 * ===========================================================================
 * Nothing in this module formats the internal ratio, and nothing formats a
 * confidence. The only number that reaches a reader is a real price, printed by
 * the card itself. If an age is ever shown it must be `rawRunLength` — see the
 * invariant on `persistence-hold.ts`.
 */

const LABEL_COPY: Record<MarketStatusLabel, { text: string; level: StatusLevel }> = {
  /*
    "ขาขึ้น" for good and "แผ่วลง" for weak, matching the shared status
    vocabulary in `presentation/status.ts` — the same word means the same colour
    everywhere in the product.
  */
  UPTREND: { text: 'ตลาดกำลังไปต่อ', level: 'good' },
  WEAK: { text: 'ตลาดแผ่วลง', level: 'weak' },
  SIDEWAYS: { text: 'ตลาดทรงตัว', level: 'neutral' },
};

/**
 * The regime, as a sentence rather than a term.
 *
 * Each says what the money is doing, because that is the observation; "Risk-On"
 * is a label for it that a reader has to be taught first.
 */
const REGIME_COPY: Record<MarketRegime, string> = {
  RISK_ON: 'เงินไหลเข้าสินทรัพย์เสี่ยง',
  NEUTRAL: 'เงินยังไม่เลือกทาง',
  RISK_OFF: 'เงินไหลออกจากสินทรัพย์เสี่ยง',
};

export interface MarketStatusCopy {
  /** The headline word. Always present, even when the status is withheld. */
  headline: string;
  level: StatusLevel;
  /**
   * The line under the headline.
   *
   * Carries the regime when it could be established, and says what is missing
   * when it could not. Never empty and never a placeholder: an absent subtitle
   * would leave the reader unable to tell "neutral" from "not computed".
   */
  subtitle: string;
  /** Set when the numbers are a completed close rather than a live market. */
  asOfNote: string | null;
}

/**
 * Which day the numbers belong to, in words.
 *
 * Reuses `thaiSessionDate` — the same formatter the portfolio day figure uses —
 * so a reader who sees "วันศุกร์ที่ 29 ส.ค. 2025" on one card and a date on
 * another is reading one convention, and a DST or locale fix lands in both.
 */
function asOfNoteFor(sessionDate: string | null): string | null {
  if (sessionDate === null) return null;
  const formatted = thaiSessionDate(sessionDate);
  return formatted === null ? null : `ตัวเลขนี้คือราคาปิดของ${formatted}`;
}

/**
 * Everything the card prints, from one evaluation.
 *
 * `sessionDate` is the completed trading date the readings came from, or null
 * while the market is open and the numbers are live.
 */
export function marketStatusCopy(
  evaluation: MarketStatusEvaluation,
  sessionDate: string | null = null,
): MarketStatusCopy {
  const asOfNote = asOfNoteFor(sessionDate);

  if (evaluation.status === 'insufficient' || evaluation.label === null) {
    /*
      "ข้อมูลไม่ครบ" REPLACES the status; it is never shown beside one. The
      subtitle names how many readings are missing rather than saying nothing,
      because "incomplete" without a scale reads as "broken" — and this is a
      recoverable, usually brief state.
    */
    return {
      headline: 'ข้อมูลไม่ครบ',
      level: 'unknown',
      subtitle: `ยังอ่านค่าได้ไม่ครบ ${evaluation.missing.length} รายการ จึงยังบอกภาพรวมตลาดไม่ได้`,
      asOfNote,
    };
  }

  const copy = LABEL_COPY[evaluation.label];
  return {
    headline: copy.text,
    level: copy.level,
    /*
      The regime is withheld, not guessed, when its own inputs are missing —
      and the reason is stated. Falling back to the equity readings would print
      a sentence about where money is flowing that was derived from something
      else entirely.
    */
    subtitle: evaluation.regime === null
      ? 'ยังอ่านทิศทางการลงทุนไม่ได้ เพราะข้อมูลบางส่วนยังไม่มา'
      : REGIME_COPY[evaluation.regime],
    asOfNote,
  };
}

/**
 * The status mark for one instrument's own move.
 *
 * Polarity is applied here as well as in the score, so a VIX that rose shows the
 * mark its MEANING deserves rather than the one its arrow does. A card that
 * printed 🟢 beside a jump in the fear gauge would be colouring the number
 * instead of reading it.
 *
 * `unknown` for an unreadable input, never `neutral` — the rule the shared
 * status vocabulary exists to hold: missing data must not read as calm.
 */
export function inputStatusLevel(
  changePercent: number | null,
  polarity: 1 | -1,
  flatBandPercent: number,
): StatusLevel {
  if (changePercent === null || !Number.isFinite(changePercent)) return 'unknown';
  if (Math.abs(changePercent) <= flatBandPercent) return 'neutral';
  return changePercent * polarity > 0 ? 'good' : 'bad';
}
