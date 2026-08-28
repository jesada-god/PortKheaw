/**
 * THE HOLD RULE, in one place.
 *
 * ===========================================================================
 * WHY THIS IS EXTRACTED RATHER THAN COPIED
 * ===========================================================================
 * A published label that flips on a single bar is noise wearing the authority
 * of a reading. The Market Signal engine answers that by making a NEW reading
 * wait: it must stand for `minDurationBars` consecutive bars before the card
 * adopts it, and until then the card keeps the last reading that did.
 *
 * The Market Status card needs exactly that rule, and "write it again over
 * there" is how two rules that were meant to be one drift apart — one gets a
 * fix, the other keeps the bug, and nothing in the tree says they were ever
 * supposed to agree. So the loop moved here and both callers call it. The
 * signal engine's behaviour is unchanged; this is its own algorithm, lifted
 * verbatim and made generic over the label type.
 *
 * ===========================================================================
 * THE INVARIANT THAT TRAVELS WITH IT
 * ===========================================================================
 * `docs/signal-handover.md` §6.8 forbids label age from feeding any threshold,
 * and forbids a card implying that an older label is a better one. A hold rule
 * creates a new way to break both: it makes labels last longer, so any age
 * computed over the HELD run would silently grow.
 *
 * Every caller must therefore publish the raw reading alongside the held one
 * and count age over the RAW sequence — {@link rawRunLength} — never over the
 * held run. A card may show the raw age. It may not show the held age, and
 * nothing may branch on either.
 */

/**
 * The most recent label in `sequence` that has stood `minDurationBars`
 * consecutive entries, or `current` when none in the window has.
 *
 * `sequence` is NEWEST FIRST and its first entry is `current`.
 *
 * Defined over the raw sequence alone rather than over what was published
 * yesterday, which is what keeps it bounded: a rule that read its own output
 * would need the whole history to answer for today, and this needs only as far
 * back as the sequence goes.
 *
 * `exempt` skips the wait entirely. Waiting is a bet that a one-entry change is
 * noise; the exemption is for the case where that bet is known to be wrong —
 * the market repriced hard enough that holding yesterday's word would publish a
 * reading the data has already contradicted. What counts as hard enough is the
 * caller's judgement, because it is measured in the caller's own units.
 */
export function heldLabel<T>(
  sequence: readonly T[],
  current: T,
  options: { minDurationBars: number; exempt?: boolean },
): T {
  if (options.exempt) return current;
  const required = options.minDurationBars;
  if (required <= 1) return current;
  for (let offset = 0; offset + required - 1 < sequence.length; offset += 1) {
    let run = 1;
    while (run < required && sequence[offset + run] === sequence[offset]) run += 1;
    if (run >= required) return sequence[offset]!;
  }
  return current;
}

/**
 * How many consecutive entries at the head of `sequence` equal `current`.
 *
 * This is the HONEST age — the one a card is allowed to print — because it is
 * measured over the raw readings and is unaffected by whether the hold rule is
 * currently keeping an older label on screen. Always at least 1: today's
 * reading is itself one entry of the run.
 */
export function rawRunLength<T>(sequence: readonly T[], current: T): number {
  let run = 1;
  while (run < sequence.length && sequence[run] === current) run += 1;
  return run;
}
