/**
 * The watchlist's แนวโน้ม column: one engine reading, one mark, one Thai word.
 *
 * ===========================================================================
 * THIS DOES NOT COMPUTE A TREND. IT READS ONE.
 * ===========================================================================
 * The trend is `calculateMarketSignal`'s, unchanged and unreplicated. A
 * watchlist that scored its own would be a second opinion about the same
 * symbol, and a reader who opened the row's stock page would find two answers
 * with nothing to say which was right.
 *
 * What this module owns is the PROJECTION: seven engine states onto the shared
 * five-level status vocabulary, and the monotonic demotion below.
 *
 * ===========================================================================
 * WHY THERE IS A DEMOTION AT ALL
 * ===========================================================================
 * `aggregateDirectionalScore` sums the five components as `points ?? 0`. A
 * component that could not be computed therefore contributes nothing to a
 * numerator over a FIXED denominator, which sounds safe and is not: drop a
 * component that was pushing -20 and the total rises from 25 to 45. The label
 * strengthens because evidence went missing. That is the JOBY bug in the shape
 * the Market Status card was rebuilt to prevent, and the reason
 * `bounded-score.ts` exists.
 *
 * The engine is deliberately NOT changed here. Its score is load-bearing for
 * the stock page, the history table, P4a's calibration corpus and every
 * threshold measured against them; re-basing it is a signal-engine change with
 * its own evidence requirement, not something a watchlist column gets to do on
 * the way past.
 *
 * So the column takes the engine's own label and then refuses to publish a
 * DEFINITE one the evidence interval does not wholly support:
 *
 *   level = the less definite of (what the engine said, what the interval allows)
 *
 * Losing a component can only widen the interval, so it can only move the
 * column toward ทรงตัว and then toward ยังไม่มีข้อมูล. It can never move it
 * outward into a stronger claim. The demotion is one-directional by
 * construction — it never upgrades the engine either.
 *
 * ===========================================================================
 * WHAT IS NOT HERE, ON PURPOSE
 * ===========================================================================
 * No score, no percentage, no confidence. `evidenceAgreement` measures how well
 * the engine's evidence agrees with itself and reads to anybody as a
 * probability; P4a measured the 90-99 band hitting 53-55%, the same as the
 * 20-29 band. A number like that in a scannable column is a ranking the data
 * does not support, so the column carries a mark and a word and nothing else.
 *
 * No label age either. `docs/signal-handover.md` §6.8 forbids a card implying
 * an older label is a better one, and a column sorted by anything derived from
 * how long a label has stood would be exactly that.
 */

import {
  MARKET_SIGNAL_SCORE_WEIGHTS,
  MARKET_SIGNAL_THRESHOLDS,
  MARKET_SIGNAL_TOTAL_WEIGHT,
} from '@/src/config/signal';
import { intervalVerdict, scoreInterval } from '@/src/lib/analytics/bounded-score';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import { MARKET_SIGNAL_STATUS, type StatusLevel } from '@/src/lib/presentation/status';

/**
 * The bands the interval is read against, on a normalized -1..1 scale.
 *
 * DERIVED, never chosen. `MARKET_SIGNAL_THRESHOLDS.directional` is where the
 * engine draws its own bullish and bearish lines, and this is those same two
 * numbers over the same total weight — the scale the interval is computed in.
 *
 * Written as a derivation rather than as ±0.2 so it cannot drift: somebody
 * retuning the engine's thresholds moves this column with them, which is the
 * only version of this that stays a restatement instead of quietly becoming a
 * second opinion.
 */
export const WATCHLIST_TREND_BANDS = {
  above: MARKET_SIGNAL_THRESHOLDS.directional.bullish / MARKET_SIGNAL_TOTAL_WEIGHT,
  below: MARKET_SIGNAL_THRESHOLDS.directional.bearish / MARKET_SIGNAL_TOTAL_WEIGHT,
} as const;

/**
 * The Thai word for each level, as this column says it.
 *
 * Held to `CARD_MUST_NOT_SAY`: no โซน, no ไซด์เวย์, no โมเมนตัม, no โครงสร้าง.
 * A reader scanning a dozen rows gets a word about the symbol, not a word about
 * how the reading was produced.
 *
 * `weak` and `bad` stay two different sentences for the same reason
 * `STATUS_PRESENTATION` keeps 🟠 and 🔴 apart — OVEREXTENDED is a stretched
 * uptrend, not a downtrend, and painting it the same red as STRONG_BEARISH
 * would contradict the engine's own description of it.
 */
export const WATCHLIST_TREND_WORD: Readonly<Record<StatusLevel, string>> = {
  good: 'ขาขึ้น',
  neutral: 'ทรงตัว',
  weak: 'อ่อนแรง',
  bad: 'ขาลง',
  unknown: 'ยังไม่มีข้อมูล',
};

export interface WatchlistTrend {
  level: StatusLevel;
  /** The Thai word a reader sees. Never empty. */
  word: string;
  /**
   * True when the interval refused a definite label the engine had reached.
   *
   * Surfaced so the expanded row can say WHY a symbol reads ทรงตัว while its
   * stock page says more. "ข้อมูลบางส่วนยังไม่ครบ" is a different fact from a
   * genuinely quiet tape, and a column that rendered them identically would be
   * the omission this whole module is built against.
   */
  demoted: boolean;
}

const UNKNOWN: WatchlistTrend = {
  level: 'unknown',
  word: WATCHLIST_TREND_WORD.unknown,
  demoted: false,
};

/**
 * HOW STRONG A CLAIM EACH LEVEL MAKES. Not how good the news is.
 *
 * Stated explicitly rather than derived from `STATUS_RANK`, and the first
 * version of this file did derive it — distance from `neutral` — which was
 * wrong in a way worth recording, because it type-checked and read plausibly.
 * `STATUS_RANK` is an ordering from worst to best with `unknown` wedged between
 * `weak` and `neutral`, so it is not symmetric about the middle: `bad` sits 3
 * away from `neutral` and `good` sits 1. Distance in that scale therefore made
 * 🔴 a "more definite" claim than 🟢, which had two consequences —
 * `trendProminence` ranked every falling row above every rising one, and
 * `lessDefinite` would take `good` over `bad` as the safer of the two and
 * publish an uptrend where the interval had said downtrend.
 *
 * The property this column needs is direction-blind: a rise and a fall are
 * equally strong statements, and the only question is how much the reading
 * commits to.
 */
const CLAIM_STRENGTH: Readonly<Record<StatusLevel, number>> = {
  /* No reading at all. Also the floor — see `lessDefinite`. */
  unknown: 0,
  /* A reading that commits to no direction. */
  neutral: 0,
  /* A hedge: losing steam, without calling it a downtrend. */
  weak: 1,
  good: 2,
  bad: 2,
};

/** Which way a level points, so two equally strong opposite claims can be caught. */
function direction(level: StatusLevel): -1 | 0 | 1 {
  if (level === 'good') return 1;
  if (level === 'bad' || level === 'weak') return -1;
  return 0;
}

/**
 * The less definite of two levels.
 *
 * `unknown` is the floor and wins against everything, which is the rule
 * `status.ts` states as "missing data never reads as good news".
 *
 * When the two are equally strong but point OPPOSITE ways, neither is the
 * lesser and the answer is to withhold. That case is unreachable through
 * `watchlistTrend` today — an engine label of BULLISH implies a score at or
 * above its own bullish threshold, which puts the interval's best case above
 * the bearish band by construction — but a rule that silently picked one side
 * of a contradiction would be waiting for the day some future gate makes it
 * reachable.
 */
function lessDefinite(engine: StatusLevel, allowed: StatusLevel): StatusLevel {
  if (engine === 'unknown' || allowed === 'unknown') return 'unknown';
  if (CLAIM_STRENGTH[allowed] < CLAIM_STRENGTH[engine]) return allowed;
  if (CLAIM_STRENGTH[allowed] > CLAIM_STRENGTH[engine]) return engine;
  const [engineWay, allowedWay] = [direction(engine), direction(allowed)];
  return engineWay !== 0 && allowedWay !== 0 && engineWay !== allowedWay ? 'neutral' : engine;
}

/**
 * What the evidence interval permits, independent of what the engine concluded.
 *
 * Each component contributes its own weight, and `points === null` — the
 * engine's own "this component could not be computed" — becomes a null
 * contribution rather than a zero. That is what makes the interval WIDEN on a
 * loss instead of the total shifting toward whichever sign survived.
 *
 * The divisor is `MARKET_SIGNAL_TOTAL_WEIGHT` — the full weight of all five
 * components — never the weight that happened to be available. Dividing by what
 * survived is the averaging mistake `bounded-score.ts` documents.
 *
 * Returns `null` when the breakdown carries no weight at all, which is not a
 * neutral reading and must not be rendered as one.
 */
function permittedLevel(result: MarketSignalResult): StatusLevel | null {
  const interval = scoreInterval(
    Object.entries(result.scoreBreakdown).map(([id, component]) => ({
      weight: MARKET_SIGNAL_SCORE_WEIGHTS[id as keyof typeof MARKET_SIGNAL_SCORE_WEIGHTS]
        / MARKET_SIGNAL_TOTAL_WEIGHT,
      contribution: component.points === null
        ? null
        : component.points / MARKET_SIGNAL_TOTAL_WEIGHT,
    })),
  );
  if (interval === null) return null;
  const verdict = intervalVerdict(interval, WATCHLIST_TREND_BANDS);
  return verdict === 'above' ? 'good' : verdict === 'below' ? 'bad' : 'neutral';
}

/**
 * One symbol's trend, as the column shows it.
 *
 * `null` — an unentitled reader, or a symbol whose signal was never loaded —
 * is `unknown`, not absent. A blank cell in a column of marks reads as "nothing
 * is happening here", and the honest statement is that there is no reading.
 */
export function watchlistTrend(result: MarketSignalResult | null): WatchlistTrend {
  if (result === null || result.status !== 'available') return UNKNOWN;

  const engineLevel = MARKET_SIGNAL_STATUS[result.state];
  const allowed = permittedLevel(result);
  if (allowed === null) return UNKNOWN;

  const level = lessDefinite(engineLevel, allowed);
  return {
    level,
    word: WATCHLIST_TREND_WORD[level],
    demoted: level !== engineLevel,
  };
}

/**
 * How prominently a trend reads, for the mobile card order.
 *
 * "เด่นสุดบน" is how strongly the reading commits, not how good the news is — a
 * symbol going somewhere, either way, is what a reader opening a phone wants at
 * the top, and 🟢 and 🔴 are equally worth seeing. Sorting by `STATUS_RANK`
 * instead would put every falling holding at the bottom of the screen, which is
 * the one thing a watchlist must not do.
 *
 * `unknown` is deliberately the LOWEST prominence rather than sharing ทรงตัว's:
 * a row whose data failed must never sort above a row that has a reading. Ties
 * are broken by the caller, by symbol, so the order is total and stable — a
 * list that reshuffled between renders would be unreadable.
 */
export function trendProminence(level: StatusLevel): number {
  return level === 'unknown' ? -1 : CLAIM_STRENGTH[level];
}
