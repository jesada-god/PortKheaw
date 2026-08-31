/**
 * PHASE 2 VOCABULARY, OWNED HERE AND NOWHERE ELSE.
 *
 * ===========================================================================
 * WHY EVERY NAME CARRIES `Ov`
 * ===========================================================================
 * Four names in this contract already exist in the tree with different values
 * behind them:
 *
 *   MarketRegime    src/config/market-status.ts   'RISK_ON' | 'NEUTRAL' | 'RISK_OFF'
 *   MarketEvent     src/lib/market-events/types.ts  nine fields, zod-derived
 *   AlertRule       src/lib/alerts/logic.ts        two fields, argument of conditionMatches
 *   MarketSnapshot  src/lib/market-data/market-snapshot.ts  (CanonicalMarketSnapshot)
 *
 * TypeScript does not warn when two modules export the same name, so the way
 * that goes wrong is silent: an editor auto-imports the wrong one, the values
 * differ only in case, and a comparison that can never be true compiles
 * cleanly. The prefix makes the two vocabularies impossible to confuse at the
 * call site, and this module deliberately imports NONE of the four — not to
 * translate between them, not to re-export them, not to widen them.
 *
 * ===========================================================================
 * WHAT IS REUSED INSTEAD
 * ===========================================================================
 * Everything that is not one of those four. `StatusLevel` and `MarketSession`
 * are imported outright, because a second five-level status vocabulary or a
 * second four-state session enum is exactly the drift the prefix exists to
 * prevent — the collision rule is about names that already mean something
 * else, not a licence to fork the primitives.
 */

import type { MarketSession } from '@/src/lib/market-data/market-session';
import type { StatusLevel } from '@/src/lib/presentation/status';

/**
 * The three-way answer about the market.
 *
 * There is no fourth value and none may be added, and there is no score beside
 * it on screen — the same two rules `src/config/market-status.ts` states for
 * its own vocabulary, for the same reason: a number printed next to a word is
 * a claim about the weights that produced it, and the weights are judgement.
 *
 * `unclear` is a READING, not an absence. "We could not read the market" is
 * `OvMarketSnapshot.status === 'insufficient'`, a different field, because a
 * card that renders the two identically is lying by omission.
 */
export type OvMarketStatus = 'up' | 'unclear' | 'down';

/** The risk backdrop, read off the risk inputs alone. */
export type OvRegime = 'risk_on' | 'neutral' | 'risk_off';

/**
 * The six instruments the snapshot is built from.
 *
 * Pinned against `MARKET_STATUS_INPUTS` at compile time in `indices.ts` — this
 * union and that table must name the same six or the build fails, which is the
 * cheapest guard available against the two drifting apart.
 */
export type OvIndexKey = 'SPX' | 'NDX' | 'DJI' | 'VIX' | 'US10Y' | 'DXY';

export interface OvIndexReading {
  key: OvIndexKey;
  /** The symbol actually quoted. SPY/QQQ/DIA are proxies; the other three are not. */
  symbol: string;
  /** Plain Thai, no ticker. Copied from the shared input table. */
  labelTh: string;
  /** Set when `symbol` stands in for the thing named. Null when it IS the thing. */
  proxyLabelTh: string | null;
  /** `null` means unreadable. Never `0`, which is a price. */
  value: number | null;
  /** What `value` is compared against, from the shared day-change rule. */
  comparisonClose: number | null;
  changePercent: number | null;
  /** ISO UTC of the quote, or null when it could not be read. */
  asOf: string | null;
}

/**
 * The six readings, the answer, and the provenance needed to disbelieve it.
 *
 * `status: 'insufficient'` is its own state rather than an `OvMarketStatus`
 * value, so a reader of this type cannot accidentally render "ไม่มีข้อมูล" as
 * though it were `unclear`.
 */
export interface OvMarketSnapshot {
  readings: Readonly<Record<OvIndexKey, OvIndexReading>>;
  /** Null exactly when `availability` is `'insufficient'`. */
  status: OvMarketStatus | null;
  availability: 'available' | 'insufficient';
  /** Null when the risk inputs cannot support one. Never guessed. */
  regime: OvRegime | null;
  /** One short Thai line per rule that fired. May be empty. */
  regimeReasons: string[];
  /** Keys that could not be read, in table order. */
  missing: OvIndexKey[];
  session: MarketSession;
  /** Completed trading date the readings are of; null while the market is open. */
  sessionDate: string | null;
  evaluatedAt: string;
  /** True while a background refresh is running behind a last-good snapshot. */
  stale: boolean;
}

/**
 * How wide the advance is, in three words.
 *
 * Deliberately NOT `OvMarketStatus`. Breadth answers "how many stocks took
 * part", which is a different question from "which way did the market go", and
 * giving both the same three words would invite a card to print one where it
 * meant the other. `weakening` has no counterpart in the direction vocabulary
 * for exactly that reason.
 */
export type OvBreadthStatus = 'strong' | 'weakening' | 'weak';

export interface OvBreadthSnapshot {
  advancers: number;
  decliners: number;
  /** Advancers as a percentage of the rows that could be read. */
  advancingPercent: number;
  /**
   * PERMANENTLY NULL IN PHASE 2, and typed `null` rather than `number | null`
   * so nothing can assign one by accident.
   *
   * The batch this is built from — Alpaca's multi-symbol snapshot, already paid
   * for by `src/lib/overview/market-breadth.ts` — returns `dailyBar` and
   * `prevDailyBar` and nothing else. A moving average over ~4,285 symbols means
   * 200 daily bars each, which is a second fan-out of historical requests this
   * phase is not allowed to make. The existing `MarketBreadth.aboveEma20Percent`
   * has been hardcoded `null` since it shipped for the same reason.
   *
   * The fields stay in the shape so the gap is visible in the type rather than
   * missing from it.
   */
  pctAboveMA50: null;
  pctAboveMA200: null;
  status: OvBreadthStatus;
  /** Rows that produced a usable comparison. The denominator of every figure above. */
  validCount: number;
}

/** Which mark each answer wears. The five-level vocabulary, never a sixth. */
export const OV_MARKET_STATUS_LEVEL: Readonly<Record<OvMarketStatus, StatusLevel>> = {
  up: 'good',
  unclear: 'neutral',
  down: 'bad',
};

/** The Thai word each answer prints. One phrase per value, no synonyms. */
export const OV_MARKET_STATUS_WORD: Readonly<Record<OvMarketStatus, string>> = {
  up: 'ตลาดไปทางบวก',
  unclear: 'ยังไม่ชัด',
  down: 'ตลาดไปทางลบ',
};

export const OV_REGIME_WORD: Readonly<Record<OvRegime, string>> = {
  risk_on: 'กล้าเสี่ยง',
  neutral: 'กลาง ๆ',
  risk_off: 'เลี่ยงความเสี่ยง',
};

/**
 * Breadth wears `weak` (🟠) and not `bad` (🔴).
 *
 * A narrow advance is a statement about participation, not about direction —
 * the market can rise on few names — and painting it the same red as a falling
 * tape would put two different facts under one mark.
 */
export const OV_BREADTH_LEVEL: Readonly<Record<OvBreadthStatus, StatusLevel>> = {
  strong: 'good',
  weakening: 'neutral',
  weak: 'weak',
};

export const OV_BREADTH_WORD: Readonly<Record<OvBreadthStatus, string>> = {
  strong: 'ขึ้นกันทั้งตลาด',
  weakening: 'เริ่มแผ่วลง',
  weak: 'ขึ้นแค่ไม่กี่ตัว',
};
