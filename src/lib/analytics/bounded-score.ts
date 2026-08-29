/**
 * THE BOUNDED-INTERVAL RULE, in one place.
 *
 * ===========================================================================
 * WHY THIS IS EXTRACTED RATHER THAN COPIED
 * ===========================================================================
 * `src/lib/market-status/rules.ts` worked this out the expensive way, and the
 * comment block at the top of that file is still the full argument. The short
 * version, because a second caller now needs the same guarantee:
 *
 * LOSING AN INPUT MUST NEVER STRENGTHEN THE ANSWER. A card that says SIDEWAYS
 * on six readings may not say UPTREND on five of the same six.
 *
 * Averaging over what survived does NOT give you that, which is the part that
 * looks wrong until you try it. Drop the biggest NEGATIVE contributor and what
 * remains is more positive than the whole was, so the label upgrades itself for
 * having less evidence behind it. That is the JOBY bug, and `rules.test.ts`
 * caught a from-scratch rebuild of it sitting directly underneath a comment
 * about not doing that.
 *
 * What holds instead: a missing input is not a zero and has not left the
 * question. It is a reading whose value is UNKNOWN, so the only honest thing to
 * say is that it lies between its full negative weight and its full positive
 * one. The score is therefore not a point but the interval the known and
 * unknown readings together permit, and a definite claim is made only when the
 * WHOLE interval supports it.
 *
 * Monotonicity is then a property of the arithmetic rather than a hope about
 * it: losing a reading only ever WIDENS the interval, so it can only make a
 * definite claim harder to reach.
 *
 * The hold rule moved to `persistence-hold.ts` for exactly this reason — two
 * rules meant to be one drift apart, one gets a fix and the other keeps the
 * bug, and nothing in the tree says they were supposed to agree. This is the
 * same move for the same reason. The Market Status card's behaviour is
 * unchanged; this is its own arithmetic, lifted verbatim and made generic over
 * what the weights are attached to.
 */

/** One weighted reading, or the fact that it could not be read. */
export interface WeightedContribution {
  /** What this input is worth when it IS readable. Never negative. */
  weight: number;
  /**
   * The input's signed, already-weighted push, or `null` when unreadable.
   *
   * Null and zero are different facts and must stay that way all the way down:
   * zero is a real reading meaning "this did not move", null is the absence of
   * one. Collapsing them is what the interval exists to prevent.
   */
  contribution: number | null;
}

/** The interval the readings permit. `worst === best` exactly when nothing is missing. */
export interface ScoreInterval {
  worst: number;
  best: number;
}

/**
 * The interval the readings permit, over the FULL weight of the inputs given.
 *
 * The denominator is the full table weight, deliberately: it keeps a missing
 * input's uncertainty proportional to what that input was ever worth. Dividing
 * by the AVAILABLE weight instead is precisely what lets three readings speak
 * as loudly as six.
 *
 * Null when the set carries no weight. An interval with no denominator is not a
 * score of zero — and zero would read as the middle band, which is a claim.
 */
export function scoreInterval(
  items: readonly WeightedContribution[],
): ScoreInterval | null {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return null;
  const known = items.reduce((sum, item) => sum + (item.contribution ?? 0), 0);
  const missingWeight = items
    .filter((item) => item.contribution === null)
    .reduce((sum, item) => sum + item.weight, 0);
  return { worst: (known - missingWeight) / total, best: (known + missingWeight) / total };
}

/**
 * The three-way reading of an interval: definite up, definite down, or neither.
 *
 * `above` and `below` are read as "the whole interval clears it". Everything
 * the interval does not wholly support is the middle, which is the answer that
 * absorbs every loss of evidence — so the only transitions a missing input can
 * cause are toward `undecided`, never across it.
 */
export function intervalVerdict(
  interval: ScoreInterval,
  bands: { above: number; below: number },
): 'above' | 'below' | 'undecided' {
  if (interval.worst >= bands.above) return 'above';
  if (interval.best <= bands.below) return 'below';
  return 'undecided';
}
