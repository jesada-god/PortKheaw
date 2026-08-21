import type {
  MarketSignalHistory,
  MarketSignalHistoryEntry,
  MarketSignalResult,
} from './types';

/**
 * P6 — what the card said, read back.
 *
 * The derivation lives here, apart from the database, because everything
 * interesting about a history is arithmetic on dates and everything boring
 * about it is IO. Splitting them means the rules below are tested against
 * hand-written days rather than against a table somebody has to seed.
 *
 * THE RULE THIS MODULE ENFORCES. Days are recorded when the signal is computed,
 * which happens when a reader opens the card. A symbol nobody opened on Tuesday
 * has no Tuesday. So nothing here fills a gap, counts a gap as agreement, or
 * lets a gap end a run — a label whose only two recorded days are 30 days apart
 * has a run of 30 days, and the strip has to show that it is two days of
 * evidence and not thirty.
 */

const DAY_MS = 86_400_000;

/** Whole calendar days between two `YYYY-MM-DD` strings. */
const daysBetween = (earlier: string, later: string): number =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);

/**
 * Fold recorded days into the block the card reads.
 *
 * `entries` may arrive in any order and may contain gaps; both are handled
 * here so no caller has to remember to sort.
 */
export function summariseHistory(
  entries: readonly MarketSignalHistoryEntry[],
  options: { windowDays: number; recentFlipDays: number },
): MarketSignalHistory | null {
  if (entries.length === 0) return null;

  const ordered = [...entries].sort((left, right) => left.asOf.localeCompare(right.asOf));
  const newest = ordered[ordered.length - 1];

  /*
   * How far back the CURRENT label runs, measured over recorded days only.
   *
   * A run of one is `null` rather than 0: zero reads as "it changed today",
   * which is a claim about yesterday, and one recorded day is not evidence
   * about yesterday at all — yesterday may simply not have been recorded.
   */
  let runStart = ordered.length - 1;
  while (runStart > 0 && ordered[runStart - 1].state === newest.state) runStart -= 1;
  const currentLabelDays = runStart === ordered.length - 1
    ? null
    : daysBetween(ordered[runStart].asOf, newest.asOf);

  /*
   * A flip is a DIFFERENT label seen recently, not a short run.
   *
   * Asking "is the run shorter than three days" would raise the flag on a
   * symbol whose only recorded day is today, where nothing is known to have
   * changed. This asks the question that has an answer: did we actually see a
   * different label inside the window?
   */
  const recentFlip = ordered.some((entry) => entry.state !== newest.state
    && daysBetween(entry.asOf, newest.asOf) <= options.recentFlipDays);

  /*
   * The same run, counted over the reading the hold rule did not touch.
   *
   * P8 keeps a changed label for `MARKET_SIGNAL_PERSISTENCE.minDurationBars`
   * before publishing it, so `currentLabelDays` above is now partly a fact
   * about the hold rule. `docs/signal-handover.md` §6.8 forbids the card
   * presenting a longer-standing label as a better one, and a number the engine
   * itself lengthened is that claim wearing a fact's clothes. This counts the
   * run of `rawState` instead, and the card reads THIS one.
   *
   * `null` rather than a guess in three cases, all of which are the same case:
   * the count cannot be made honestly. A run of one recorded day says nothing
   * about yesterday (same reason as above), and a row written before P8 has no
   * `rawState` at all — so a run that reaches one stops being countable rather
   * than silently treating "not recorded" as "unchanged".
   */
  const rawRunStart = (): number | null => {
    if (newest.rawState === null) return null;
    let index = ordered.length - 1;
    while (index > 0) {
      const earlier = ordered[index - 1];
      if (earlier.rawState === null) return null;
      if (earlier.rawState !== newest.rawState) break;
      index -= 1;
    }
    return index;
  };
  const rawStart = rawRunStart();
  const currentRawLabelDays = rawStart === null || rawStart === ordered.length - 1
    ? null
    : daysBetween(ordered[rawStart].asOf, newest.asOf);

  return {
    entries: ordered,
    windowDays: options.windowDays,
    currentLabelDays,
    currentRawLabelDays,
    recentFlip,
  };
}

/**
 * What one day's row holds.
 *
 * Deliberately narrow. The card's full payload is large and most of it is
 * derivable from the candles at any time; what cannot be recovered afterwards is
 * the LABEL, so that is what is kept, plus the two numbers a reader would want
 * beside it and the flags that qualified it.
 */
export interface MarketSignalSnapshot {
  symbol: string;
  asOf: string;
  state: MarketSignalHistoryEntry['state'];
  /** P8. The reading before the hold rule — what `currentRawLabelDays` counts. */
  rawState: MarketSignalHistoryEntry['rawState'];
  bias: MarketSignalHistoryEntry['bias'];
  zone: MarketSignalHistoryEntry['zone'];
  score: number | null;
  evidenceAgreement: number | null;
  flags: readonly string[];
  /** Which rollout switches were on, so a strip spanning a rollout stays readable. */
  features: Record<string, boolean>;
}

/**
 * Reduce a result to the row that would be written for it, or `null`.
 *
 * `null` for anything that is not a finished reading — an insufficient-data
 * result has no label to record, and writing one would put a day on the strip
 * that the card never actually published.
 *
 * The date is the FINALIZED candle's, never today's. Two readers opening the
 * same symbol either side of a session close would otherwise file two different
 * readings under one date and lose one of them.
 */
export function snapshotOf(
  result: MarketSignalResult,
  features: Record<string, boolean>,
): MarketSignalSnapshot | null {
  if (result.status !== 'available') return null;
  if (!result.latestCandleAt) return null;
  return {
    symbol: result.symbol,
    asOf: result.latestCandleAt.slice(0, 10),
    state: result.state,
    // `?? null` rather than `?? result.state`: a result with no persistence
    // block was not produced by a P8 engine, and recording the published label
    // as though it were the raw one would put a run on the strip nobody read.
    rawState: result.persistence?.rawState ?? null,
    bias: result.bias,
    zone: result.zones?.zone ?? null,
    score: result.score,
    evidenceAgreement: result.evidenceAgreement,
    flags: result.flags,
    features,
  };
}
