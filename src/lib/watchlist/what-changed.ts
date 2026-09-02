/**
 * มีอะไรเปลี่ยน — every detector, every threshold, in one file.
 *
 * ===========================================================================
 * WHY ONE FILE AND ONE TABLE
 * ===========================================================================
 * A "what changed" section is a machine for producing sentences, and the way
 * one of these goes wrong is never a single bad detector. It is that the
 * detectors accumulate: one lives in a component, one in a service, one in a
 * hook, each with its own idea of how big a move has to be before it earns a
 * line, and by the time anybody asks "why did it say this" the answer is spread
 * across four files and two of them disagree.
 *
 * So {@link WHAT_CHANGED_DETECTORS} is the whole feature. Every rule is a row:
 * a name, a NUMBER, the Thai sentence it produces, and how important it is.
 * Adding a rule is adding a row; retuning one is editing a number; and the
 * question "what can this section say" is answered by reading one array.
 *
 * ===========================================================================
 * EVERY THRESHOLD IS A NUMBER, AND THE SENTENCE PRINTS IT
 * ===========================================================================
 * Nothing here says ผิดปกติ, and the ban is not stylistic. That word is a
 * verdict with no stated basis — a reader cannot agree with it, disagree with
 * it, or predict when it will appear, which puts it in the same category as the
 * confidence percentage `trend.ts` refuses and the "most interesting five"
 * ordering `overview-preview.ts` refuses. Each detector below is defined by a
 * comparison against a constant in {@link WHAT_CHANGED_THRESHOLDS}, and each
 * sentence states the measurement that made it fire. A reader who wants to know
 * why a line appeared can read the line.
 *
 * ===========================================================================
 * SILENCE IS THE DEFAULT, NOT THE FAILURE
 * ===========================================================================
 * A detector that cannot read its inputs returns `null`. Not a hedge, not a
 * "ยังไม่มีข้อมูล" row, not a guess from what survived — nothing. That is the
 * one rule that makes the section trustworthy, because the alternative is a
 * card that always has five lines on it and therefore says nothing by being
 * there. A symbol with nothing to report contributes no item, and a watchlist
 * where nothing happened produces an empty array and no section at all.
 *
 * ===========================================================================
 * MONOTONICITY: LOSING AN INPUT MUST NEVER MAKE AN ITEM APPEAR
 * ===========================================================================
 * This is `bounded-score.ts`'s rule, applied to a different question, and it is
 * enforced in two places that are easy to get wrong:
 *
 *  1. A DETECTOR READS A FIXED-LENGTH SUFFIX AND REQUIRES THE FULL LENGTH.
 *     `volume-surge` needs twenty completed bars and is silent on nineteen; it
 *     does not take the median of what arrived. Computing over the available
 *     sample is precisely the averaging mistake `scoreInterval` exists to
 *     prevent — a short history has a different median, and a detector that
 *     accepted one would fire BECAUSE data went missing. Reading a suffix also
 *     means dropping the oldest bars leaves the answer identical until it falls
 *     below the minimum, at which point the detector goes quiet. There is no
 *     history length at which losing a bar turns silence into a sentence.
 *
 *  2. `trend-change` IS SILENT ON A DEMOTED READING. `watchlistTrend` already
 *     runs the interval arithmetic and reports `demoted` when the evidence
 *     would not carry the label the engine reached. A demotion from ขาขึ้น to
 *     ทรงตัว is a statement about the EVIDENCE, not about the market, and a
 *     detector that read it as a trend change would announce a reversal every
 *     time a provider dropped one component. That is the whole bug, in this
 *     feature's shape.
 *
 * No interval arithmetic is written here. The one place it is needed is
 * upstream in `watchlistTrend`, and this module consumes its output — a second
 * implementation of the same rule is exactly what `bounded-score.ts` was
 * extracted to stop.
 *
 * ===========================================================================
 * WHAT THIS NEVER PRODUCES
 * ===========================================================================
 * No score. No percentage of confidence. No ranking of symbols against each
 * other. No suggestion to buy, sell, hold or wait. Every sentence states
 * something that already happened, and the reader decides what it means.
 * {@link WHAT_CHANGED_LIMIT} is a cap on ATTENTION, not a leaderboard: what
 * survives it is decided by the KIND of event, which is a property of the rule
 * table below and not of the market.
 */

import type { StatusLevel } from '@/src/lib/presentation/status';
import { WATCHLIST_TREND_WORD, type WatchlistTrend } from './trend';

/**
 * Every number the feature is defined by.
 *
 * Collected here rather than inlined so that retuning is a diff a reviewer can
 * read, and so the tests can walk each boundary by naming the constant instead
 * of repeating the literal — a test that hard-codes `2` keeps passing after
 * somebody changes the rule to 2.5.
 */
export const WHAT_CHANGED_THRESHOLDS = {
  /** |ret today| must exceed this many standard deviations to be reported. */
  returnSigmaMultiple: 2,
  /**
   * How many completed daily returns the standard deviation is measured over.
   *
   * REQUIRED IN FULL, never "up to". See the monotonicity note above. Sixty
   * sessions is roughly a quarter — long enough that one violent week does not
   * set the yardstick, short enough that a stock whose character changed a year
   * ago is not still being judged against what it used to be.
   */
  returnSigmaLookbackDays: 60,
  /** Today's volume must exceed this multiple of the median to be reported. */
  volumeMedianMultiple: 2,
  /**
   * How many completed sessions the median volume is taken over.
   *
   * The MEDIAN and not the mean, deliberately. One earnings day at eight times
   * normal volume drags a twenty-day mean up by a third and hides the next
   * three genuine surges behind it; the median does not move. Also required in
   * full.
   */
  volumeMedianLookbackDays: 20,
  /** |open - previous close| as a percentage of the previous close. */
  gapPercent: 2,
  /** A scheduled report this many days away or fewer is reported. */
  earningsWithinDays: 7,
} as const;

/** How many items the whole section may show in one day. */
export const WHAT_CHANGED_LIMIT = 5;

export type WhatChangedDetectorId =
  | 'level-break'
  | 'trend-change'
  | 'return-sigma'
  | 'gap'
  | 'volume-surge'
  | 'earnings-soon';

/** One completed or in-progress daily bar. Arrays of these are oldest first. */
export interface DailyBar {
  /** Exchange-local trading date, `YYYY-MM-DD`. */
  date: string;
  open: number;
  close: number;
  volume: number;
  /** False while the session is still running. The candle service's `partial`, inverted. */
  finalized: boolean;
}

/**
 * Everything the detectors may read about one symbol.
 *
 * Every field is nullable or empty-able, and that is the interface contract:
 * the caller supplies what it HAS, never what it can reconstruct. A caller that
 * filled a gap with a plausible value would defeat every guarantee this module
 * makes, because a detector cannot tell a supplied number from a derived one.
 */
export interface WhatChangedInput {
  symbol: string;
  /**
   * Today's move as a percentage, from the shared day-change rule.
   *
   * NOT recomputed here, and the reason is in `day-change.ts`: the question
   * "which two prices is today's figure the difference of" has four surfaces
   * answering it and had to stop having four answers. This module is a fifth
   * READER, not a fifth decider — it takes `WatchlistDayChange.changePercent`,
   * and the session handling that produced it comes with it.
   */
  dayChangePercent: number | null;
  /**
   * Daily bars, oldest first, INCLUDING the running session.
   *
   * The detectors split this themselves: the newest bar is "today", and the
   * completed bars before it are the sample. Splitting it here rather than at
   * each call site keeps "what counts as today" in one place.
   */
  bars: readonly DailyBar[];
  /** Latest price, for the level cross. */
  price: number | null;
  /** The close of the session before the newest bar, for the level cross. */
  previousClose: number | null;
  /** Nearest level below, as the signal engine published it. */
  support: number | null;
  /** Nearest level above. */
  resistance: number | null;
  /** Today's bounded trend reading, or null when the symbol has none. */
  trend: WatchlistTrend | null;
  /**
   * The level of the most recent EARLIER published reading, or null.
   *
   * Null whenever the comparison cannot be made honestly — no stored history, a
   * history row written before the engine recorded what this needs, or a symbol
   * nobody has looked at before. `trend-change` is then silent, which is the
   * correct answer: "the trend changed" and "there is nothing to compare
   * against" are different sentences and only one of them is true.
   */
  previousTrendLevel: StatusLevel | null;
  /** Whole days to the next scheduled report; null when the calendar had none. */
  earningsDays: number | null;
}

export interface WhatChangedItem {
  detector: WhatChangedDetectorId;
  symbol: string;
  /** Copied from the detector definition so the cap can sort without a lookup. */
  importance: number;
  /**
   * The status level the item's mark is drawn from.
   *
   * The five-level vocabulary in `status.ts`, never a sixth: `good` and `bad`
   * for an event with a direction, `neutral` for one without. Never `unknown` —
   * an item exists only because its inputs were present, so there is no such
   * thing here as an item with no reading behind it.
   */
  level: Exclude<StatusLevel, 'unknown'>;
  /*
   * THERE IS NO `emoji` BESIDE THIS ANY MORE, AND DELIBERATELY SO.
   *
   * The mark is an inline SVG now — geometry, not a character — so it cannot
   * travel in a payload, and it never needed to: `level` is the entire input the
   * mark is computed from, and `WhatChangedCard` reads it through the one shared
   * `StatusMark`. A detector shipping its own glyph was a presentation choice
   * living in a rules file, recomputed once per item, and it made this type the
   * second place a level-to-mark mapping existed.
   */
  /** One short Thai sentence, stating the measurement that made it fire. */
  text: string;
}

/** What a detector returns. The rest of {@link WhatChangedItem} is filled in for it. */
export type DetectorVerdict = Pick<WhatChangedItem, 'level' | 'text'>;

export interface WhatChangedDetector {
  id: WhatChangedDetectorId;
  /** What this detector measures, in Thai. Read by whoever tunes it, shown nowhere. */
  name: string;
  /**
   * How much this KIND of event deserves one of the five slots. Higher wins.
   *
   * Explicit integers rather than array position, so the ordering survives
   * somebody reordering the table for readability, and so each gap is
   * reviewable:
   *
   *   5  a level was crossed — the price is somewhere it was not
   *   4  the published trend changed — the word on the row is different today
   *   3  the day's move was outside its own recent range
   *   2  the open was away from the last close
   *   1  more shares traded than usual
   *   0  a scheduled report is near
   *
   * Earnings sits LAST on purpose, and it is the one worth arguing about. A
   * report seven days out is arguably the most decision-relevant thing on the
   * list — but it is also true tomorrow, and the day after, and for six more
   * days, so ranking it high would let one unchanging fact hold a slot for a
   * week and push out every actual change underneath it. This section is about
   * what changed; a date that was already on the calendar did not.
   */
  importance: number;
  /** Null when the inputs are not all there, or when the threshold was not met. */
  detect(input: WhatChangedInput): DetectorVerdict | null;
}

function usable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: number | null | undefined): value is number {
  return usable(value) && value > 0;
}

/** The newest bar and the completed bars strictly before it, or null. */
function splitBars(bars: readonly DailyBar[]): { today: DailyBar; history: DailyBar[] } | null {
  if (bars.length < 2) return null;
  const today = bars[bars.length - 1]!;
  const history = bars.slice(0, -1);
  /*
    Every earlier bar has to be finalized. A provider that returned two
    unfinished bars is describing something this module has no rule for, and
    silence is the stated answer to that.
  */
  return history.every((bar) => bar.finalized) ? { today, history } : null;
}

/** The last `count` values, or null when there are not that many. Never fewer. */
function suffix<T>(values: readonly T[], count: number): T[] | null {
  return values.length < count ? null : values.slice(values.length - count);
}

/** Sample standard deviation (n-1). Null when the sample is too small or flat. */
export function sampleStandardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  if (!values.every((value) => Number.isFinite(value))) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Number.isFinite(variance) && variance > 0 ? Math.sqrt(variance) : null;
}

/** The median, averaging the two middle values on an even sample. Null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  if (!values.every((value) => Number.isFinite(value))) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** A signed percentage, as the sentences print it. */
function signedPercent(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${Math.abs(value).toFixed(2)}%`;
}

function priceText(value: number): string {
  return value.toLocaleString('th-TH', { maximumFractionDigits: 4 });
}

/**
 * THE WHOLE FEATURE. One row per rule.
 *
 * Position in this array is the tie-break of last resort inside
 * {@link capWhatChanged} and is otherwise meaningless — `importance` decides
 * what survives the cap.
 */
export const WHAT_CHANGED_DETECTORS: readonly WhatChangedDetector[] = [
  {
    id: 'level-break',
    name: 'ราคาข้ามแนวรับหรือแนวต้าน',
    importance: 5,
    /*
      A CROSS, not a position. "price is above resistance" stays true every day
      for as long as it stays there, and a detector written that way would
      repeat one line for a fortnight after the single day it was news. The rule
      is that the previous close was on one side and the price is on the other,
      which is true exactly once per crossing.

      Resistance is tested first. The two cannot both fire on sane inputs —
      support sits below resistance — but fixing an order means a symbol whose
      engine published a crossed pair produces one deterministic line rather
      than a different one per render.
    */
    detect(input) {
      if (!positive(input.price) || !positive(input.previousClose)) return null;
      if (positive(input.resistance)
        && input.previousClose <= input.resistance
        && input.price > input.resistance) {
        return { level: 'good', text: `ราคาขึ้นเหนือแนวต้าน ${priceText(input.resistance)} แล้ว` };
      }
      if (positive(input.support)
        && input.previousClose >= input.support
        && input.price < input.support) {
        return { level: 'bad', text: `ราคาลงต่ำกว่าแนวรับ ${priceText(input.support)} แล้ว` };
      }
      return null;
    },
  },
  {
    id: 'trend-change',
    name: 'แนวโน้มเปลี่ยนระดับ',
    importance: 4,
    /*
      Silent on a demoted reading — see the monotonicity note at the top of this
      file. This is the single most important guard in the module, because
      without it the section announces a reversal whenever a provider drops one
      component, which is both the exact failure the bounded interval exists to
      prevent and the failure that looks most like a real finding.

      Silent on `unknown` on either side too: "เปลี่ยนจากยังไม่มีข้อมูล" is not
      a change in the market, it is the arrival of data.
    */
    detect(input) {
      const current = input.trend;
      const previous = input.previousTrendLevel;
      if (current === null || previous === null) return null;
      if (current.demoted) return null;
      if (current.level === 'unknown' || previous === 'unknown') return null;
      if (current.level === previous) return null;
      return {
        level: current.level === 'good' ? 'good' : current.level === 'neutral' ? 'neutral' : 'bad',
        text: `แนวโน้มเปลี่ยนจาก${WATCHLIST_TREND_WORD[previous]}เป็น${WATCHLIST_TREND_WORD[current.level]}`,
      };
    },
  },
  {
    id: 'return-sigma',
    name: 'การเคลื่อนไหวเกินสองเท่าของความผันผวน 60 วัน',
    importance: 3,
    /*
      Today's figure is `WatchlistDayChange.changePercent` and is not
      recalculated — the session rules that produced it are settled elsewhere.
      What this adds is the yardstick: the standard deviation of the sixty
      COMPLETED daily returns before today, which needs sixty-one bars of
      history and accepts nothing less.

      Today's own return is deliberately outside the sample. Including the bar
      being judged lets a large enough move widen the very yardstick it is
      measured against, which is why `MARKET_SIGNAL_PERSISTENCE` measures its
      own exemptions against the PREVIOUS bar's average range.
    */
    detect(input) {
      if (!usable(input.dayChangePercent)) return null;
      const split = splitBars(input.bars);
      if (split === null) return null;
      const window = suffix(split.history, WHAT_CHANGED_THRESHOLDS.returnSigmaLookbackDays + 1);
      if (window === null) return null;
      const returns: number[] = [];
      for (let index = 1; index < window.length; index += 1) {
        const earlier = window[index - 1]!.close;
        const later = window[index]!.close;
        if (!positive(earlier) || !positive(later)) return null;
        returns.push(((later - earlier) / earlier) * 100);
      }
      const sigma = sampleStandardDeviation(returns);
      if (sigma === null) return null;
      const bound = sigma * WHAT_CHANGED_THRESHOLDS.returnSigmaMultiple;
      if (Math.abs(input.dayChangePercent) <= bound) return null;
      return {
        level: input.dayChangePercent > 0 ? 'good' : 'bad',
        text: `ขยับ ${signedPercent(input.dayChangePercent)} เกินช่วงปกติ ${WHAT_CHANGED_THRESHOLDS.returnSigmaLookbackDays} วัน (±${bound.toFixed(2)}%)`,
      };
    },
  },
  {
    id: 'gap',
    name: 'ราคาเปิดห่างจากราคาปิดก่อนหน้า',
    importance: 2,
    /*
      The open of the newest bar against the close of the one before it. Read
      off the bars rather than off the quote, because the quote this product
      carries has a price and a change but no open — and a gap reconstructed
      from a change is a gap measured against the wrong end of the day.
    */
    detect(input) {
      const split = splitBars(input.bars);
      if (split === null) return null;
      const yesterday = split.history[split.history.length - 1]!;
      if (!positive(split.today.open) || !positive(yesterday.close)) return null;
      const gap = ((split.today.open - yesterday.close) / yesterday.close) * 100;
      if (!usable(gap) || Math.abs(gap) <= WHAT_CHANGED_THRESHOLDS.gapPercent) return null;
      return {
        level: gap > 0 ? 'good' : 'bad',
        text: `เปิดตลาดห่างจากราคาปิดก่อนหน้า ${signedPercent(gap)}`,
      };
    },
  },
  {
    id: 'volume-surge',
    name: 'ปริมาณซื้อขายเกินสองเท่าของค่ากลาง 20 วัน',
    importance: 1,
    /*
      No direction is claimed, so the mark is the neutral one. Heavier trading
      is not good news or bad news — it is more people transacting, which is
      worth knowing and means nothing on its own. A detector that painted it
      green on an up day would be inventing the interpretation this section
      refuses to supply.

      While a session is still running today's figure is partial and reads LOW,
      so this stays quiet until it genuinely clears the bar. Quiet-until-certain
      is the correct direction for the error to fall in.
    */
    detect(input) {
      const split = splitBars(input.bars);
      if (split === null) return null;
      const window = suffix(split.history, WHAT_CHANGED_THRESHOLDS.volumeMedianLookbackDays);
      if (window === null) return null;
      const volumes = window.map((bar) => bar.volume);
      if (!volumes.every(positive)) return null;
      const middle = median(volumes);
      if (!positive(middle) || !positive(split.today.volume)) return null;
      const multiple = split.today.volume / middle;
      if (multiple <= WHAT_CHANGED_THRESHOLDS.volumeMedianMultiple) return null;
      return {
        level: 'neutral',
        text: `ปริมาณซื้อขายวันนี้ ${multiple.toFixed(1)} เท่าของค่ากลาง ${WHAT_CHANGED_THRESHOLDS.volumeMedianLookbackDays} วัน`,
      };
    },
  },
  {
    id: 'earnings-soon',
    name: 'ใกล้วันประกาศผลประกอบการ',
    importance: 0,
    /*
      A date the calendar published, counted in whole days by the earnings
      service. Never estimated from a quarter end — `earnings/types.ts` is
      explicit that a symbol with no scheduled report returns unavailable, and
      an absent count arrives here as null and produces nothing.
    */
    detect(input) {
      const days = input.earningsDays;
      if (!usable(days) || !Number.isInteger(days)) return null;
      if (days < 0 || days > WHAT_CHANGED_THRESHOLDS.earningsWithinDays) return null;
      return {
        level: 'neutral',
        text: days === 0 ? 'ประกาศผลประกอบการวันนี้' : `ประกาศผลประกอบการอีก ${days} วัน`,
      };
    },
  },
];

/** Every detector's verdict on one symbol, in table order. Usually empty. */
export function detectWhatChanged(input: WhatChangedInput): WhatChangedItem[] {
  return WHAT_CHANGED_DETECTORS.flatMap((detector) => {
    const found = detector.detect(input);
    if (found === null) return [];
    return [{
      detector: detector.id,
      symbol: input.symbol,
      importance: detector.importance,
      level: found.level,
      text: found.text,
    }];
  });
}

const DETECTOR_ORDER: ReadonlyMap<WhatChangedDetectorId, number> = new Map(
  WHAT_CHANGED_DETECTORS.map((detector, index) => [detector.id, index]),
);

/**
 * The items that fit, most important kind first.
 *
 * WHAT GETS DROPPED IS THE LEAST IMPORTANT, never a random one and never the
 * tail of whatever order the symbols happened to arrive in. A cap that dropped
 * arbitrarily would make the section's contents depend on the watchlist's
 * internal ordering, so adding an unrelated symbol could silently remove a line
 * about a different one.
 *
 * The order is TOTAL: importance, then symbol, then the detector's position in
 * the table. Two renders of the same inputs produce the same list in the same
 * order — the property `overview-preview.ts` insists on, for the same reason.
 * The final tie-break is table POSITION rather than the id string, so renaming
 * a detector cannot reshuffle a reader's card.
 *
 * Sorts a copy; the caller's array is never mutated.
 */
export function capWhatChanged(
  items: readonly WhatChangedItem[],
  limit: number = WHAT_CHANGED_LIMIT,
): WhatChangedItem[] {
  return [...items]
    .sort((left, right) =>
      right.importance - left.importance
      || left.symbol.localeCompare(right.symbol)
      || (DETECTOR_ORDER.get(left.detector) ?? 0) - (DETECTOR_ORDER.get(right.detector) ?? 0))
    .slice(0, Math.max(0, limit));
}

/**
 * The section's contents for a whole watchlist.
 *
 * An empty array is the ordinary outcome on a quiet day, and the caller must
 * render NOTHING for it — not an empty card, not a line saying nothing changed.
 * A section that is always present teaches a reader to stop seeing it, which
 * costs the days when it does have something to say.
 */
export function whatChanged(
  inputs: readonly WhatChangedInput[],
  limit: number = WHAT_CHANGED_LIMIT,
): WhatChangedItem[] {
  return capWhatChanged(inputs.flatMap(detectWhatChanged), limit);
}
