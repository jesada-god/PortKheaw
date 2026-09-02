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
 *   good     ↗  ดี / แข็งแรง / ขาขึ้น
 *   neutral  →  ปกติ / ระวัง
 *   weak     ↗  อ่อนแรง        (the arrow still rises; the colour is what warns)
 *   bad      ↘  แย่ / ขาลง
 *   unknown  —  ยังไม่มีข้อมูล
 *
 * THE RULE THIS MODULE EXISTS TO HOLD: missing data never reads as good news.
 * Every mapper below returns `unknown` for a value it could not use — never
 * `neutral`, and never the level a zero would have produced. A quote that
 * failed to load and a stock that did not move are not the same fact, and a
 * product that renders them the same way is lying by omission. {@link STATUS_RANK}
 * exists so a test can prove `unknown` never outranks `neutral`.
 *
 * THE MARK IS A DIRECTION, NOT A DOT, WHEREVER THERE IS A DIRECTION TO SHOW.
 *
 * Every level carries two marks, and a render site picks one of them:
 *
 *   `icon`  a Material Symbols trend glyph, for a status that IS about which
 *           way a price or a market is going. Five coloured circles all had the
 *           same silhouette, so the only thing separating "ขาขึ้น" from "ขาลง"
 *           at a glance was hue — which is exactly what a red/green-blind
 *           reader, a dimmed screen and a greyscale screenshot each take away.
 *           An arrow says the direction in its shape, and the colour then says
 *           how strongly, which is the job colour is actually good at.
 *
 *   `dot`   the original emoji circle, kept for the statuses with NO direction:
 *           a connection state, a data-freshness note, an event's importance,
 *           the shape of a stated plan. An arrow there would point somewhere the
 *           status never claimed to point. {@link StatusLabel} takes
 *           `mark="dot"` for exactly those, and the four call sites that pass it
 *           are the whole list.
 *
 * `weak` deliberately shares `good`'s RISING arrow. Weak means "still up, but
 * fewer names are carrying it" — a falling arrow there would state the opposite
 * of the reading. `--caution` is what says it is not strong, and the word beside
 * it says the rest.
 *
 * WHAT THE SWITCH COST, STATED PLAINLY: an emoji is text, so it used to survive
 * being copied out of the page and pasted into a chat. An inline SVG does not —
 * a paste now carries the words alone. That is a real loss and it is accepted
 * here because the words were always the half that carried the meaning: every
 * mark in this file is `aria-hidden` at the render site and has a Thai phrase
 * printed directly beside it, so a pasted "ขาขึ้นชัดเจน" says everything the
 * pasted "🟢 ขาขึ้นชัดเจน" said. A screenshot — the other case the old comment
 * named — loses nothing at all: the arrow is drawn, not typed.
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

/**
 * The Material Symbols glyphs the five levels draw from, by their official names.
 *
 * Named rather than inlined here because this module is data and has no business
 * holding path geometry; `StatusLabel` owns the outlines, the same way
 * `current-session.ts` names a session icon and `SessionIcon.tsx` draws it.
 */
export type StatusIconName = 'trending_up' | 'trending_flat' | 'trending_down' | 'horizontal_rule';

export interface StatusPresentation {
  /**
   * The direction this level points, for a status that is about a direction.
   * Decorative at the render site; the label carries the meaning.
   */
  icon: StatusIconName;
  /** The same mark as a coloured circle, for a status with no direction to point. */
  dot: string;
  /** The CSS custom property the level's TEXT and mark paint with. */
  token: string;
  /**
   * The wash and the hairline, for the rare block that is entirely about one
   * status — the technical-outlook card is the whole list.
   *
   * Deliberately separate from `token`: a status inside a sentence gets colour
   * and nothing else, and a surface that tinted itself every time a status
   * appeared would put the product straight back into the wall of coloured
   * boxes this vocabulary replaced. `unknown` borrows the neutral surface
   * rather than a wash, because there is no colour that means "no reading".
   */
  soft: string;
  line: string;
  /** The default Thai word, used when a caller has nothing more specific. */
  fallbackLabel: string;
}

export const STATUS_PRESENTATION: Readonly<Record<StatusLevel, StatusPresentation>> = {
  good: { icon: 'trending_up', dot: '🟢', token: '--positive', soft: '--positive-soft', line: '--positive-line', fallbackLabel: 'แข็งแรง' },
  neutral: { icon: 'trending_flat', dot: '🟡', token: '--warning', soft: '--warning-soft', line: '--warning-line', fallbackLabel: 'ทรงตัว' },
  /*
   * `--caution` rather than a second use of `--warning`. 🟡 and 🟠 are two
   * different sentences — "ปกติ ระวังไว้" and "อ่อนแรงแล้ว" — and painting them
   * the same amber collapses the distinction the five levels were split for.
   *
   * `trending_up` and not `trending_down`: weak is a rise that fewer names are
   * carrying, and the one thing it is not is a fall. Two levels sharing an arrow
   * is fine precisely because they do not share a colour — which is why the
   * uniqueness test below is asserted on the token, not on the glyph.
   */
  weak: { icon: 'trending_up', dot: '🟠', token: '--caution', soft: '--caution-soft', line: '--caution-line', fallbackLabel: 'อ่อนแรง' },
  bad: { icon: 'trending_down', dot: '🔴', token: '--negative', soft: '--negative-soft', line: '--negative-line', fallbackLabel: 'อ่อนแอ' },
  /* A rule and not an arrow. There is no reading, so there is no way to point. */
  unknown: { icon: 'horizontal_rule', dot: '⚪', token: '--text-muted', soft: '--surface-elevated', line: '--border', fallbackLabel: 'ยังไม่มีข้อมูล' },
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
  return statusFromSignedValue(value);
}

/**
 * A signed number, as a status — whatever it is a number OF.
 *
 * The arithmetic above never cared about the unit: it reads a sign. The name
 * did care, and that turned out to matter. The overview's portfolio card asked
 * it about a percentage while printing an amount, and
 * `portfolioTotalReturnPercent` returns `null` whenever the invested basis is
 * zero or below — a portfolio funded entirely by transfers — so the card drew
 * "-$746.28" beside ⚪. The loss was real, signed, and on the screen; the mark
 * beside it said there was no reading.
 *
 * So a caller holding two views of one movement can fall back from the finer to
 * the coarser without reaching for a second rule: the percentage when it exists,
 * the amount when it does not, one mapper either way. Exactly zero is `neutral`
 * in both, and a missing value is `unknown` in both — a fallback that invented a
 * direction from an absent number would be the thing this whole module refuses.
 */
export function statusFromSignedValue(value: number | null | undefined): StatusLevel {
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
