/**
 * THE RISK BACKDROP, AS A WORD AND THE REASONS FOR IT.
 *
 * ===========================================================================
 * WHAT IS NEW HERE AND WHAT IS BORROWED
 * ===========================================================================
 * The numbers are borrowed, all of them. The three risk inputs, their weights,
 * their dead bands, the bands that turn a score into a word, and the rule about
 * which two must be readable all live in `src/config/market-status.ts` and are
 * imported rather than restated. A second copy of `VIX weight 3, flat band 3%`
 * would be a second thing to retune, and the day somebody retuned one of them
 * the product would hold two opinions about the same market.
 *
 * What is new is the OUTPUT: `OvRegime` in the Phase 2 vocabulary, and a list
 * of short Thai lines saying which readings produced it. The existing card
 * publishes a regime with no explanation, which is fine for a subtitle and not
 * fine for a section a reader is meant to act on.
 *
 * ===========================================================================
 * REASONS ARE MEASUREMENTS, NOT VERDICTS
 * ===========================================================================
 * Every line is `<instrument> <signed percent>` and nothing else. No line says
 * why an instrument moved, what it means, or what to do — the same rule
 * `what-changed.ts` states for its sentences, and the reason `banned-copy.ts`
 * exists. A reader who disagrees with the word can read the three numbers that
 * produced it and disagree specifically.
 *
 * ===========================================================================
 * MISSING INPUTS WIDEN THE ANSWER, THEY DO NOT MOVE IT
 * ===========================================================================
 * `scoreInterval` / `intervalVerdict` are the shared bounded-score arithmetic,
 * imported for the guarantee they carry: an unreadable input contributes its
 * full weight of uncertainty to BOTH ends of the interval, so losing one can
 * only make a definite claim harder to reach. Averaging over what survived —
 * the obvious alternative — lets the biggest negative contributor drop out and
 * the answer improve, which is the JOBY bug written out at length in
 * `src/lib/market-status/rules.ts`.
 *
 * On top of that sits the availability gate, which is not arithmetic: VIX and
 * the ten-year are required outright, and without either the answer is `null`
 * rather than a softer word.
 */

import {
  MARKET_STATUS_AVAILABILITY,
  MARKET_STATUS_INPUTS,
  MARKET_STATUS_REGIME_BANDS,
} from '@/src/config/market-status';
import { intervalVerdict, scoreInterval } from '@/src/lib/analytics/bounded-score';
import { contributionOf } from '@/src/lib/market-status/rules';
import { signedPercent } from '@/src/lib/portfolio/presentation';
import type { OvIndexKey, OvIndexReading, OvRegime } from './types';

/**
 * How long one reason may be.
 *
 * Forty characters is roughly what fits on one line of a 320px handset beside a
 * status mark. It is enforced by `regime.test.ts` over generated readings
 * rather than by truncation here — a line that had to be cut to fit was the
 * wrong line, and silently trimming it would hide that.
 */
export const OV_REGIME_REASON_MAX_CHARS = 40;

/** The three inputs this module reads. Derived, never restated. */
export const OV_REGIME_INPUTS = MARKET_STATUS_INPUTS.filter((input) => input.group === 'risk');

/** Both of these must be readable or the regime is withheld entirely. */
const REQUIRED = MARKET_STATUS_AVAILABILITY.requiredForRegime as readonly OvIndexKey[];

export interface OvRegimeVerdict {
  /** Null when the required inputs are not all readable. Never guessed. */
  regime: OvRegime | null;
  /** One short Thai line per rule that fired, strongest contribution first. */
  reasons: string[];
}

interface Weighed {
  labelTh: string;
  changePercent: number | null;
  weight: number;
  contribution: number | null;
}

/**
 * The regime, and why.
 *
 * Takes an array rather than a keyed record so a test can hand in two readings
 * and prove the answer is withheld — the shape a caller holds is
 * `OvMarketSnapshot['readings']`, and `Object.values` of it is this.
 */
export function ovRegime(readings: readonly OvIndexReading[]): OvRegimeVerdict {
  const byKey = new Map<OvIndexKey, OvIndexReading>(
    readings.map((reading) => [reading.key, reading]),
  );

  const weighed: Weighed[] = OV_REGIME_INPUTS.map((input) => {
    const reading = byKey.get(input.key) ?? null;
    const changePercent = reading?.changePercent ?? null;
    const usable = changePercent !== null && Number.isFinite(changePercent)
      ? changePercent
      : null;
    return {
      labelTh: input.labelTh,
      changePercent: usable,
      weight: input.weight,
      /*
        The shared ramp: dead band, linear rise, cap, signed by polarity. Null
        for an unreadable input and never zero, because zero is the claim that
        the instrument was flat.
      */
      contribution: contributionOf(input, usable),
    };
  });

  const reasons = buildReasons(weighed);

  const readable = new Set(
    readings.filter((reading) => reading.changePercent !== null
      && Number.isFinite(reading.changePercent)).map((reading) => reading.key),
  );
  if (!REQUIRED.every((key) => readable.has(key))) {
    return { regime: null, reasons };
  }

  const bounds = scoreInterval(weighed.map((item) => ({
    weight: item.weight,
    contribution: item.contribution,
  })));
  if (bounds === null) return { regime: null, reasons };

  const verdict = intervalVerdict(bounds, {
    above: MARKET_STATUS_REGIME_BANDS.riskOnAbove,
    below: MARKET_STATUS_REGIME_BANDS.riskOffBelow,
  });
  return {
    regime: verdict === 'above' ? 'risk_on' : verdict === 'below' ? 'risk_off' : 'neutral',
    reasons,
  };
}

/**
 * One line per input that has something to say, biggest push first.
 *
 * An input inside its dead band produces no line, because "moved 0.04%" is not
 * a reason for anything — that is what the dead band is FOR. When none of the
 * three cleared their band the list is a single line saying so, rather than
 * empty: an empty list under a word reads as a card that failed to explain
 * itself, and "nothing moved much" is a real explanation.
 *
 * An unreadable input always gets a line, whatever else fired. It is the one
 * fact that changes how much the word is worth.
 */
function buildReasons(weighed: readonly Weighed[]): string[] {
  const missing = weighed
    .filter((item) => item.changePercent === null)
    .map((item) => `${item.labelTh} ยังไม่มีข้อมูล`);

  const moved = weighed
    .filter((item) => item.changePercent !== null && item.contribution !== 0)
    .sort((left, right) =>
      Math.abs(right.contribution ?? 0) - Math.abs(left.contribution ?? 0))
    .map((item) => `${item.labelTh} ${signedPercent(item.changePercent!)}`);

  if (moved.length === 0 && missing.length === 0) {
    /*
      NAMED, BECAUSE "ทั้งสามตัว" HAD SIX NUMBERS ABOVE IT.

      This line used to read "ทั้งสามตัวยังไม่ขยับเกินเกณฑ์" and sat under a
      status word produced by all SIX instruments, whose figures are printed
      directly above it. A reader counting them found six and no way to know
      which three the sentence meant — so the line read as an explanation of the
      status word, which it has never been: every reason here is about the risk
      trio and nothing else.

      "ยังไม่ขยับเกินเกณฑ์" and not "ยังไม่ขยับ". They did move — VIX prints 2%
      days routinely — they just did not clear their dead bands, and a line that
      said they had not moved would be false about the numbers beside it.

      Forty characters exactly, against `OV_REGIME_REASON_MAX_CHARS`. It is the
      longest line this module can emit and it has no room to spare, which is
      what the cap is for: `regime.test.ts` walks every generated reason against
      it, so the next word added here fails a test rather than a handset.
    */
    return ['VIX พันธบัตร ดอลลาร์ ยังไม่ขยับเกินเกณฑ์'];
  }
  return [...moved, ...missing];
}
