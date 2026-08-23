/**
 * KNOWING LESS MUST NOT LOOK LIKE KNOWING BETTER.
 *
 * `confidence` is sold as "how strong is the evidence". The one thing that
 * sentence forbids is a card that becomes more confident because an input went
 * missing — and the engine had exactly that, in three separate places, none of
 * them tested. This file is the invariant that should have existed from the
 * start, plus honest characterisation of the two paths that still violate it.
 *
 * The three, and what happened to each:
 *
 *   strength    FIXED. Was `Σ|points| ÷ availableWeight` — a divisor that shrank
 *               when a factor left the fraction while the numerator stood still,
 *               so striking an unranked Options Sentiment moved 0.40 -> 0.45.
 *               Now measured against the model's full weight, which cannot move.
 *
 *   agreement   BY DESIGN, and asserted as such below. It is a ratio AMONG the
 *               counted factors, so dropping a dissenting one genuinely raises
 *               it. That is what the word means and forcing it monotone would
 *               forbid the P0-2 correction from having its intended effect.
 *
 *   penalties   STILL WRONG, deliberately left, characterised below and filed.
 *               Losing the earnings calendar deletes a 15-point deduction and
 *               costs nothing anywhere else, so "we do not know when the report
 *               is" scores like "there is no report coming". Fixing it means
 *               choosing what an unknown date is worth, which is a model
 *               decision and not one to smuggle in beside a bug fix.
 */

import { describe, expect, it } from 'vitest';
import { calculateOptionsSignal } from './calculations';
import { OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS } from './config';
import { reportCardInput } from './report-card.fixture';
import { baseInput as putCallFallbackInput } from './putcall-fallback.fixture';
import type { OptionsSignalInput, OptionsSignalResult } from './types';

type SlotId = 'macro' | 'trend' | 'momentum' | 'sentiment' | 'riskReward' | 'pricing' | 'event';

const without = (input: OptionsSignalInput, id: SlotId): OptionsSignalInput => ({
  ...input,
  [id]: { status: 'unavailable', state: 'UNAVAILABLE', reason: 'ทดสอบ: อินพุตหายไป', provider: null, asOf: null },
});

const available = (result: OptionsSignalResult) =>
  (result.status === 'available' ? result : null);

const CASES = [
  ['the reported card', reportCardInput()],
  ['the Put/Call fallback case', putCallFallbackInput()],
] as const;

/** `trend` and `momentum` are `sufficiency.required`: dropping either yields no signal at all. */
const DROPPABLE: SlotId[] = ['macro', 'sentiment', 'riskReward', 'pricing', 'event'];

describe('confidence · an input that disappears can never strengthen a term', () => {
  for (const [name, input] of CASES) {
    const before = available(calculateOptionsSignal(input));
    if (!before) throw new Error(`${name} must produce a signal`);

    for (const id of DROPPABLE) {
      it(`${name}: dropping ${id} does not raise evidence strength`, () => {
        const after = available(calculateOptionsSignal(without(input, id)));
        expect(after).not.toBeNull();
        /*
         * The load-bearing assertion of this file. It holds by CONSTRUCTION now
         * rather than by luck: the denominator is a constant, so removing a
         * factor can only remove absolute points from the numerator.
         */
        expect(after!.diagnostics.evidenceStrength)
          .toBeLessThanOrEqual(before.diagnostics.evidenceStrength);
      });
    }

    it(`${name}: dropping a factor that scored NOTHING cannot raise confidence`, () => {
      /*
       * The clean case, and the one P0-2 actually created. A factor contributing
       * zero points adds nothing to either side of agreement and nothing to the
       * strength numerator, so the only term it can touch is completeness — and
       * completeness only ever falls. Anything else moving here is a bug.
       */
      for (const id of DROPPABLE) {
        const factor = id === 'pricing' || id === 'event'
          ? null
          : before.diagnostics.factors[id];
        if (factor && (factor.points ?? 0) !== 0) continue;
        if (id === 'event') continue; // see the characterisation test below
        const after = available(calculateOptionsSignal(without(input, id)));
        expect(after!.confidenceScore, `dropping ${id} raised confidence`)
          .toBeLessThanOrEqual(before.confidenceScore);
      }
    });
  }
});

describe('confidence · agreement rises when a dissenting factor leaves, and that is correct', () => {
  /*
   * Characterised, not forbidden. `agreement` is |Σpoints| ÷ Σ|points| over the
   * counted factors — a statement about the evidence in hand. When the factor
   * that leaves is the one arguing against the rest, what remains genuinely does
   * agree more, and that is precisely the correction P0-2 was made to deliver:
   * an unranked Put/Call was casting a saturated vote with no basis, and
   * agreement was being held down by it.
   *
   * Pinned so that nobody later reads it as the same bug as the strength one and
   * "fixes" it into an average.
   */
  it('the dissenting Risk/Reward is what was holding the Put/Call case apart', () => {
    const base = available(calculateOptionsSignal(putCallFallbackInput()))!;
    const dropped = available(calculateOptionsSignal(without(putCallFallbackInput(), 'riskReward')))!;

    // +6 against a bearish −25/+5 body: the minority voice.
    expect(base.diagnostics.factors.riskReward.points).toBe(6);
    expect(dropped.diagnostics.agreement).toBeGreaterThan(base.diagnostics.agreement);
    // Strength still falls, which is the half that has to stay monotone.
    expect(dropped.diagnostics.evidenceStrength)
      .toBeLessThan(base.diagnostics.evidenceStrength);
  });

  it('and it falls when the factor that leaves was voting WITH the majority', () => {
    // Same operation, opposite sign of contribution, opposite effect. That is
    // what makes it a property of the evidence rather than of data volume.
    const base = available(calculateOptionsSignal(reportCardInput()))!;
    const dropped = available(calculateOptionsSignal(without(reportCardInput(), 'riskReward')))!;
    expect(base.diagnostics.factors.riskReward.points).toBe(1);
    expect(dropped.diagnostics.agreement).toBeLessThan(base.diagnostics.agreement);
    expect(dropped.confidenceScore).toBeLessThan(base.confidenceScore);
  });
});

describe('confidence · KNOWN DEFECT: losing the earnings date deletes its penalty', () => {
  /*
   * Not fixed here, and pinned so it cannot be lost.
   *
   * `earnings-near` deducts 0.15 for a report inside seven days. Take the
   * earnings input away and the deduction simply does not fire — and because
   * `OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS` has no `event` entry, nothing else
   * moves either. So a symbol whose calendar failed to load scores as though it
   * had been checked and found clear, fifteen points above the same symbol whose
   * calendar loaded.
   *
   * The fix is a choice about what an unknown date is worth — a default penalty,
   * a completeness weight, a PRIME block, or some combination — and choosing a
   * number for it is a model decision, not a copy fix. Filed for the owner as
   * issue #4; when it lands, this block becomes the invariant instead of the
   * characterisation of its absence.
   */
  it('confidence JUMPS when the calendar is missing, on both fixtures', () => {
    for (const [, input] of CASES) {
      const before = available(calculateOptionsSignal(input))!;
      const after = available(calculateOptionsSignal(without(input, 'event')))!;

      expect(before.diagnostics.penalties.map((penalty) => penalty.id)).toContain('earnings-near');
      expect(after.diagnostics.penalties.map((penalty) => penalty.id)).not.toContain('earnings-near');
      // The whole 15 points, none of it recovered anywhere.
      expect(after.confidenceScore).toBeGreaterThan(before.confidenceScore);
      expect(after.confidenceScore - before.confidenceScore).toBeGreaterThanOrEqual(14);
      // Every other term is untouched, which is exactly why nothing absorbs it.
      expect(after.diagnostics.agreement).toBeCloseTo(before.diagnostics.agreement, 6);
      expect(after.diagnostics.evidenceStrength).toBeCloseTo(before.diagnostics.evidenceStrength, 6);
      expect(after.diagnostics.completeness.value).toBeCloseTo(before.diagnostics.completeness.value, 6);
    }
  });

  it('names the reason completeness cannot absorb it: there is no event weight', () => {
    // If somebody adds one, this line fails and the test above needs revisiting
    // rather than silently starting to pass for a different reason.
    expect('event' in OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS).toBe(false);
  });
});
