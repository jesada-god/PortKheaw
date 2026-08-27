/**
 * ONE status vocabulary for the whole product.
 *
 * PortKheaw had four of these before this file existed — the market-signal
 * card's `tone` strings, the options-signal card's `dot`/`badgeTone` pair, the
 * overview's service dot, and `DataStatusBadge` — each with its own colours and
 * its own idea of how many levels there are. A reader moving between two pages
 * met the same amber meaning two different things.
 *
 * So there are exactly five levels here and no page may invent a sixth:
 *
 *   good     🟢  ดี / แข็งแรง / ขาขึ้น
 *   neutral  🟡  ปกติ / ระวัง
 *   weak     🟠  อ่อนแรง
 *   bad      🔴  แย่ / ขาลง
 *   unknown  ⚪  ยังไม่มีข้อมูล
 *
 * THE RULE THIS MODULE EXISTS TO HOLD: missing data never reads as good news.
 * Every mapper below returns `unknown` for a value it could not use — never
 * `neutral`, and never the level a zero would have produced. A quote that
 * failed to load and a stock that did not move are not the same fact, and a
 * product that renders them the same way is lying by omission. {@link STATUS_RANK}
 * exists so a test can prove `unknown` never outranks `neutral`.
 *
 * The emoji is a data mark, not decoration: it is the only part of a status
 * that survives being screenshotted, pasted into a chat, or read at arm's
 * length. It is always `aria-hidden` at the render site — {@link StatusLabel}
 * prints the Thai word for assistive technology, which is the part that carries
 * the meaning.
 */

export type StatusLevel = 'good' | 'neutral' | 'weak' | 'bad' | 'unknown';

/**
 * How the five levels order, worst to best, with `unknown` BELOW `neutral`.
 *
 * Only ever used to prove the rule above in tests and to pick the lower of two
 * readings. Nothing in the UI ranks statuses against each other — a page that
 * needed to would be computing a score, which is the thing this replaced.
 */
export const STATUS_RANK: Readonly<Record<StatusLevel, number>> = {
  bad: 0,
  weak: 1,
  unknown: 2,
  neutral: 3,
  good: 4,
};

export interface StatusPresentation {
  /** Decorative at the render site; the label carries the meaning. */
  emoji: string;
  /** The CSS custom property the level paints with. */
  token: string;
  /** The default Thai word, used when a caller has nothing more specific. */
  fallbackLabel: string;
}

export const STATUS_PRESENTATION: Readonly<Record<StatusLevel, StatusPresentation>> = {
  good: { emoji: '🟢', token: '--positive', fallbackLabel: 'แข็งแรง' },
  neutral: { emoji: '🟡', token: '--warning', fallbackLabel: 'ทรงตัว' },
  /*
   * `--caution` rather than a second use of `--warning`. 🟡 and 🟠 are two
   * different sentences — "ปกติ ระวังไว้" and "อ่อนแรงแล้ว" — and painting them
   * the same amber collapses the distinction the five levels were split for.
   */
  weak: { emoji: '🟠', token: '--caution', fallbackLabel: 'อ่อนแรง' },
  bad: { emoji: '🔴', token: '--negative', fallbackLabel: 'อ่อนแอ' },
  unknown: { emoji: '⚪', token: '--text-muted', fallbackLabel: 'ยังไม่มีข้อมูล' },
};

/**
 * Cut points for a 0–100 score, read as "at least this much".
 *
 * Descending and non-overlapping: anything at or above `good` is good, then
 * `neutral`, then `weak`, and everything below `weak` is bad. Stated as data so
 * a caller's thresholds sit next to the thing they describe and a test can walk
 * every boundary without knowing which surface it came from.
 */
export interface ScoreThresholds {
  good: number;
  neutral: number;
  weak: number;
}

/**
 * A 0–100 score, as a status.
 *
 * `null`, `undefined` and any non-finite number are `unknown` — including
 * `NaN`, which is the one that used to reach the screen. Scores outside 0–100
 * are still mapped rather than rejected: a caller that produced 104 has a bug
 * worth seeing as 🟢, not a blank space that hides it.
 */
export function statusFromScore(
  score: number | null | undefined,
  thresholds: ScoreThresholds,
): StatusLevel {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unknown';
  if (score >= thresholds.good) return 'good';
  if (score >= thresholds.neutral) return 'neutral';
  if (score >= thresholds.weak) return 'weak';
  return 'bad';
}

/**
 * A day's percentage move, as a status.
 *
 * Exactly zero is `neutral` — the stock genuinely did not move — while a
 * missing percentage is `unknown`. Those two used to render identically on the
 * watchlist, so a row whose quote had failed showed a calm flat status beside
 * rows carrying real prices.
 */
export function statusFromChangePercent(value: number | null | undefined): StatusLevel {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  if (value > 0) return 'good';
  if (value < 0) return 'bad';
  return 'neutral';
}

/**
 * The reward-to-risk of a stated plan, as a status.
 *
 * The cut points are the Planner's own long-standing convention — the tool has
 * always drawn the 1:2 line — and they describe the SHAPE of a plan, never
 * whether it will work. A 1:3 plan on a stock heading the other way is still
 * 🟢 here, which is why the Planner prints
 * {@link OUTLOOK_NOT_PROBABILITY_NOTICE} beside it.
 */
export function statusFromRewardRisk(rewardToRisk: number | null | undefined): StatusLevel {
  if (rewardToRisk === null || rewardToRisk === undefined || !Number.isFinite(rewardToRisk)) {
    return 'unknown';
  }
  if (rewardToRisk >= 2) return 'good';
  if (rewardToRisk >= 1.5) return 'neutral';
  if (rewardToRisk >= 1) return 'weak';
  return 'bad';
}

/**
 * Which level each market-signal state reads as.
 *
 * LEVEL ONLY — the Thai wording stays in `MARKET_SIGNAL_PRESENTATION`, inside
 * the folder whose eslint rule (`market-signal/no-unsourced-frame-word`) holds
 * that card to its own vocabulary. Splitting them this way is deliberate: the
 * thresholds belong in one place, and the copy belongs where the rule can see
 * it.
 *
 * OVEREXTENDED is 🟠 and not 🔴 on purpose. The card's own description says the
 * distance "ยังไม่ได้แปลว่าจะกลับ" — it is a stretched uptrend, not a downtrend,
 * and painting it the same red as STRONG_BEARISH would contradict the sentence
 * printed directly under it.
 */
export const MARKET_SIGNAL_STATUS = {
  STRONG_BULLISH: 'good',
  BULLISH: 'good',
  SIDEWAYS: 'neutral',
  SQUEEZE: 'neutral',
  OVEREXTENDED: 'weak',
  BEARISH: 'bad',
  STRONG_BEARISH: 'bad',
} as const satisfies Record<string, StatusLevel>;

/**
 * Which level each options-signal type reads as.
 *
 * CONFLICTED is 🟠 rather than 🟡 for the reason its own copy already gives:
 * SIDEWAYS and CONFLICTED both sit near 50 and call for opposite reactions, so
 * they must not be able to be confused at a glance.
 *
 * SIDEWAYS moves from the ⚪ it used to wear to 🟡, which is the whole point of
 * having one vocabulary: a quiet tape is a reading the engine MADE, and ⚪ is
 * now reserved for a reading it could not make at all. `insufficient-data` —
 * the payload state that carries `signalType: null` — is what maps to `unknown`,
 * and it does so by having no entry here to look up.
 */
export const OPTIONS_SIGNAL_STATUS = {
  PRIME_CALL: 'good',
  CALL_WATCH: 'neutral',
  SIDEWAYS: 'neutral',
  CONFLICTED: 'weak',
  PUT_WATCH: 'weak',
  /* "ความเสี่ยงสูงกว่าปกติ" — a warning about the premium, not a direction. */
  IV_WARNING: 'weak',
  PRIME_PUT: 'bad',
} as const satisfies Record<string, StatusLevel>;
