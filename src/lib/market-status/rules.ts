import {
  MARKET_STATUS_AVAILABILITY,
  MARKET_STATUS_BANDS,
  MARKET_STATUS_EXEMPTION_PERCENT,
  MARKET_STATUS_INPUTS,
  MARKET_STATUS_PERSISTENCE,
  MARKET_STATUS_REGIME_BANDS,
  type MarketRegime,
  type MarketStatusInput,
  type MarketStatusInputKey,
  type MarketStatusLabel,
} from '@/src/config/market-status';
import { heldLabel, rawRunLength } from '@/src/lib/analytics/persistence-hold';

/**
 * The rule table, evaluated. Pure, deterministic, and the only place a reading
 * becomes a word.
 *
 * ===========================================================================
 * MONOTONICITY — the property this module is built around
 * ===========================================================================
 * LOSING AN INPUT MUST NEVER STRENGTHEN THE ANSWER. If the card says SIDEWAYS
 * with six readings, it may not say UPTREND with five of the same six; if it
 * says WEAK, dropping an input may not upgrade it.
 *
 * That is not an abstract nicety. It is the JOBY bug: a provider returned
 * nothing for one factor, the factor fell out of the average, and the average
 * of what remained was higher than the average of everything — so a symbol got
 * a STRONGER label for having LESS evidence behind it. The failure is invisible
 * from the outside, because a confident label looks exactly the same whether it
 * was earned or arrived at by subtraction.
 *
 * ===========================================================================
 * AVERAGING OVER WHAT SURVIVED DOES NOT FIX IT
 * ===========================================================================
 * The first version of this file scored a ratio over the weight ACTUALLY
 * AVAILABLE, on the reasoning that a missing input's weight leaves the
 * numerator and the denominator together and so cannot move the answer.
 *
 * That is wrong, and the subset sweep in `rules.test.ts` caught it on the tape
 * it was always going to catch it on: equities up while VIX, yields and the
 * dollar were all up too — a market pulling both ways, correctly SIDEWAYS. Drop
 * the VIX reading and the biggest NEGATIVE contributor leaves the average, so
 * what remains is more positive than the whole was, and the card upgraded
 * itself to UPTREND for having less evidence behind it. Which is the JOBY bug,
 * rebuilt from scratch, directly underneath a comment about not doing that.
 *
 * ===========================================================================
 * WHAT ACTUALLY HOLDS: BOUND THE ANSWER, DO NOT AVERAGE IT
 * ===========================================================================
 * A missing input is not a zero, and it has not left the question — it is a
 * reading whose value is UNKNOWN, and the only honest thing to say about it is
 * that it lies somewhere between its full negative weight and its full positive
 * one. So the score is not a point. It is the interval the known readings and
 * the unknown ones together permit:
 *
 *     worst = (known - missingWeight) / totalWeight
 *     best  = (known + missingWeight) / totalWeight
 *
 * and a definite label is claimed only when the WHOLE interval supports it:
 * UPTREND when even the worst case clears the band, WEAK when even the best
 * case falls below it, SIDEWAYS for everything else.
 *
 * Monotonicity is then a property of the arithmetic rather than a hope about
 * it. Losing a reading only ever WIDENS the interval, so it can only make a
 * definite claim harder to reach: UPTREND or WEAK may fall back to SIDEWAYS,
 * and nothing else can happen. Never SIDEWAYS to UPTREND, never WEAK to
 * UPTREND.
 *
 * The denominator is the FULL table weight, deliberately: it keeps a missing
 * input's uncertainty proportional to what that input was ever worth. Dividing
 * by the available weight instead is what let three readings speak as loudly as
 * six.
 *
 * The availability gate on top is a separate guarantee — missing an equity
 * input does not soften the label, it removes it, and the card reports
 * ข้อมูลไม่ครบ. A partial answer dressed as a whole one is the thing being
 * prevented.
 */

/** One instrument's reading, or the fact that it could not be read. */
export interface MarketStatusReading {
  key: MarketStatusInputKey;
  /** The price now, or the completed close when the market is shut. */
  value: number | null;
  /** What `value` is compared against. Null makes the input unreadable. */
  comparisonClose: number | null;
}

export interface EvaluatedInput {
  input: MarketStatusInput;
  value: number | null;
  changePercent: number | null;
  /**
   * The input's signed push toward UPTREND, already scaled by weight and
   * polarity. Null when the input is unreadable — never zero, which is a real
   * reading meaning "this instrument did not move".
   */
  contribution: number | null;
  readable: boolean;
}

export interface MarketStatusEvaluation {
  status: 'available' | 'insufficient';
  /** The published answer, after the hold rule. Null when insufficient. */
  label: MarketStatusLabel | null;
  /**
   * The answer BEFORE the hold rule.
   *
   * Published for the same reason the signal engine publishes it: any age shown
   * to a reader must be counted over the raw sequence, never over the held run.
   * See `docs/signal-handover.md` §6.8.
   */
  rawLabel: MarketStatusLabel | null;
  /** True when the hold rule is keeping an older label on screen. */
  held: boolean;
  /** Consecutive evaluations `rawLabel` has stood. The only age a card may print. */
  rawRunLength: number;
  /** Set when a large move let a new reading skip the wait. */
  exempt: boolean;
  /** Null when the risk inputs cannot support one — never guessed. */
  regime: MarketRegime | null;
  inputs: EvaluatedInput[];
  /** Which inputs could not be read, in table order. */
  missing: MarketStatusInputKey[];
  /** Why the card cannot show a status. Null when it can. */
  insufficientReason: 'missing-equity-input' | null;
}

/**
 * One input's contribution: a dead band, then a linear ramp, then a cap.
 *
 * Returns null — not zero — for an unreadable input, because the two must stay
 * distinguishable all the way to the availability gate. Zero is a claim that the
 * instrument was flat.
 */
export function contributionOf(
  input: MarketStatusInput,
  changePercent: number | null,
): number | null {
  if (changePercent === null || !Number.isFinite(changePercent)) return null;
  const magnitude = Math.abs(changePercent);
  if (magnitude <= input.flatBandPercent) return 0;
  const span = input.fullWeightPercent - input.flatBandPercent;
  const ramp = span <= 0
    ? 1
    : Math.min(1, (magnitude - input.flatBandPercent) / span);
  const direction = changePercent > 0 ? 1 : -1;
  return direction * input.polarity * input.weight * ramp;
}

function percentChange(reading: MarketStatusReading): number | null {
  const { value, comparisonClose } = reading;
  if (value === null || comparisonClose === null) return null;
  if (!Number.isFinite(value) || !Number.isFinite(comparisonClose)) return null;
  // A non-positive base makes the ratio meaningless rather than large.
  if (comparisonClose <= 0) return null;
  return ((value - comparisonClose) / comparisonClose) * 100;
}

/**
 * The interval the readings permit, over the full weight of the inputs given.
 *
 * `worst` and `best` coincide exactly when everything was readable; every
 * missing input pushes them apart by its own weight, which is the whole of the
 * monotonicity guarantee. Null when the set carries no weight — an interval
 * with no denominator is not a score of zero, and zero would read as SIDEWAYS,
 * which is a claim.
 */
export function scoreBounds(
  evaluated: readonly EvaluatedInput[],
): { worst: number; best: number } | null {
  const total = evaluated.reduce((sum, item) => sum + item.input.weight, 0);
  if (total <= 0) return null;
  const known = evaluated.reduce((sum, item) => sum + (item.contribution ?? 0), 0);
  const missingWeight = evaluated
    .filter((item) => item.contribution === null)
    .reduce((sum, item) => sum + item.input.weight, 0);
  return { worst: (known - missingWeight) / total, best: (known + missingWeight) / total };
}

/** A definite label only when the entire interval supports it. */
function labelForBounds(bounds: { worst: number; best: number }): MarketStatusLabel {
  if (bounds.worst >= MARKET_STATUS_BANDS.uptrendAbove) return 'UPTREND';
  if (bounds.best <= MARKET_STATUS_BANDS.weakBelow) return 'WEAK';
  return 'SIDEWAYS';
}

/**
 * The risk backdrop, read off the risk inputs alone and bounded the same way.
 *
 * VIX and the ten-year are required outright — see
 * `MARKET_STATUS_AVAILABILITY.requiredForRegime`. The dollar may be missing, and
 * when it is, its weight widens the interval rather than dropping out of an
 * average, so the subtitle degrades toward "has not picked a direction" instead
 * of being decided by whichever two happened to load.
 */
function regimeOf(evaluated: readonly EvaluatedInput[]): MarketRegime | null {
  const required = MARKET_STATUS_AVAILABILITY.requiredForRegime;
  const readable = new Set(evaluated.filter((item) => item.readable).map((item) => item.input.key));
  if (!required.every((key) => readable.has(key))) return null;
  const bounds = scoreBounds(evaluated.filter((item) => item.input.group === 'risk'));
  if (bounds === null) return null;
  if (bounds.worst >= MARKET_STATUS_REGIME_BANDS.riskOnAbove) return 'RISK_ON';
  if (bounds.best <= MARKET_STATUS_REGIME_BANDS.riskOffBelow) return 'RISK_OFF';
  return 'NEUTRAL';
}

/**
 * Evaluate the table.
 *
 * `history` is previous raw labels, NEWEST FIRST and NOT including today's.
 * Absent or empty means no hold rule can apply and today's reading publishes
 * immediately — which is the correct behaviour for a first render, not a
 * degraded one.
 */
export function evaluateMarketStatus(
  readings: readonly MarketStatusReading[],
  history: readonly MarketStatusLabel[] = [],
): MarketStatusEvaluation {
  const byKey = new Map(readings.map((reading) => [reading.key, reading]));

  const inputs: EvaluatedInput[] = MARKET_STATUS_INPUTS.map((input) => {
    const reading = byKey.get(input.key) ?? null;
    const changePercent = reading === null ? null : percentChange(reading);
    const contribution = contributionOf(input, changePercent);
    return {
      input,
      value: reading?.value ?? null,
      changePercent,
      contribution,
      readable: contribution !== null,
    };
  });

  const missing = inputs.filter((item) => !item.readable).map((item) => item.input.key);

  /*
    The gate runs before anything is computed from what remains. An equity input
    missing means the headline cannot be stated, and no combination of the other
    five substitutes for it — so the card says so instead of answering a
    different question well.
  */
  const readable = new Set(inputs.filter((item) => item.readable).map((item) => item.input.key));
  if (!MARKET_STATUS_AVAILABILITY.requiredForLabel.every((key) => readable.has(key))) {
    return {
      status: 'insufficient',
      label: null,
      rawLabel: null,
      held: false,
      rawRunLength: 0,
      exempt: false,
      // Withheld too: the subtitle sits under a status that is not being shown.
      regime: null,
      inputs,
      missing,
      insufficientReason: 'missing-equity-input',
    };
  }

  const bounds = scoreBounds(inputs);
  // Unreachable while the gate above holds — the table always carries weight —
  // but expressed rather than asserted.
  if (bounds === null) {
    return {
      status: 'insufficient',
      label: null,
      rawLabel: null,
      held: false,
      rawRunLength: 0,
      exempt: false,
      regime: null,
      inputs,
      missing,
      insufficientReason: 'missing-equity-input',
    };
  }

  const rawLabel = labelForBounds(bounds);
  /*
    The broadest equity input decides whether today skips the wait. Using the
    combined score instead would let the exemption fire on a day when nothing
    moved much but several small pushes lined up, which is the noise the hold
    rule exists to absorb.
  */
  const broad = inputs.find((item) => item.input.key === 'SPX')?.changePercent ?? null;
  const exempt = broad !== null && Math.abs(broad) >= MARKET_STATUS_EXEMPTION_PERCENT;

  const sequence = [rawLabel, ...history];
  const label = heldLabel(sequence, rawLabel, {
    minDurationBars: MARKET_STATUS_PERSISTENCE.minDurationBars,
    exempt,
  });

  return {
    status: 'available',
    label,
    rawLabel,
    held: label !== rawLabel,
    rawRunLength: rawRunLength(sequence, rawLabel),
    exempt,
    regime: regimeOf(inputs),
    inputs,
    missing,
    insufficientReason: null,
  };
}
