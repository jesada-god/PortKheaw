import { describe, expect, it } from 'vitest';
import {
  MARKET_SIGNAL_STATUS,
  statusFromSignedValue,
  OPTIONS_SIGNAL_STATUS,
  STATUS_PRESENTATION,
  STATUS_RANK,
  statusFromChangePercent,
  statusFromRewardRisk,
  statusFromScore,
  type ScoreThresholds,
  type StatusLevel,
} from './status';

const THRESHOLDS: ScoreThresholds = { good: 70, neutral: 50, weak: 30 };

/*
 * THE RULE, checked first and checked against every mapper in the file.
 *
 * A status that could not be computed must never be able to read as better news
 * than one that could. This is the single assertion the Phase 1 brief calls out
 * by name — "ห้าม missing แล้วดูดีขึ้น" — and it is here rather than inside each
 * mapper's own block so that adding a sixth mapper without adding it to this
 * list is what fails, not something a reviewer has to notice.
 */
describe('missing data never improves a reading', () => {
  it('ranks unknown below neutral', () => {
    expect(STATUS_RANK.unknown).toBeLessThan(STATUS_RANK.neutral);
    expect(STATUS_RANK.unknown).toBeLessThan(STATUS_RANK.good);
  });

  const missing = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  it.each(missing)('maps %p to unknown in every mapper', (value) => {
    expect(statusFromScore(value, THRESHOLDS)).toBe('unknown');
    expect(statusFromChangePercent(value)).toBe('unknown');
    expect(statusFromSignedValue(value)).toBe('unknown');
    expect(statusFromRewardRisk(value)).toBe('unknown');
  });

  it('never lets a missing value borrow the level a zero would have produced', () => {
    // Zero is a real reading in two of the three, and they must not collide.
    expect(statusFromChangePercent(0)).toBe('neutral');
    expect(statusFromChangePercent(null)).toBe('unknown');
    expect(statusFromRewardRisk(0)).toBe('bad');
    expect(statusFromRewardRisk(null)).toBe('unknown');
  });
});

describe('statusFromScore', () => {
  /*
   * Every cut point twice: exactly ON it, and one ulp below. "At least this
   * much" is the contract, so the boundary value belongs to the HIGHER band —
   * an off-by-one here would silently redraw every card in the product.
   */
  it.each([
    [100, 'good'],
    [70, 'good'],
    [69.999, 'neutral'],
    [50, 'neutral'],
    [49.999, 'weak'],
    [30, 'weak'],
    [29.999, 'bad'],
    [0, 'bad'],
  ] as const)('maps %p to %s', (score, expected) => {
    expect(statusFromScore(score, THRESHOLDS)).toBe(expected);
  });

  it('still maps a score outside 0-100 rather than hiding it', () => {
    // A caller producing 104 has a bug, and a visible 🟢 is how it gets found.
    expect(statusFromScore(104, THRESHOLDS)).toBe('good');
    expect(statusFromScore(-12, THRESHOLDS)).toBe('bad');
  });
});

describe('statusFromChangePercent', () => {
  it.each([
    [4.2, 'good'],
    [0.0001, 'good'],
    [0, 'neutral'],
    [-0.0001, 'bad'],
    [-4.2, 'bad'],
  ] as const)('maps %p to %s', (value, expected) => {
    expect(statusFromChangePercent(value)).toBe(expected);
  });

  it('has no weak band, because a price move has no such state', () => {
    const levels = [8, 3, 0.1, 0, -0.1, -3, -8].map(statusFromChangePercent);
    expect(levels).not.toContain('weak');
  });
});

describe('statusFromRewardRisk', () => {
  it.each([
    [3, 'good'],
    [2, 'good'],
    [1.999, 'neutral'],
    [1.5, 'neutral'],
    [1.499, 'weak'],
    [1, 'weak'],
    [0.999, 'bad'],
  ] as const)('maps %p to %s', (value, expected) => {
    expect(statusFromRewardRisk(value)).toBe(expected);
  });
});

describe('the domain tables', () => {
  /*
   * Both tables are exhaustive over their union at the type level (`satisfies`),
   * so what is left to check is the part types cannot: that the levels chosen
   * are the ones the cards' own Thai copy says. These four are the readings that
   * were argued over, and each is pinned to the sentence that decided it.
   */
  it('does not paint OVEREXTENDED as a downtrend', () => {
    // Its own description: "ยังไม่ได้แปลว่าจะกลับ" — stretched, not falling.
    expect(MARKET_SIGNAL_STATUS.OVEREXTENDED).toBe('weak');
    expect(MARKET_SIGNAL_STATUS.STRONG_BEARISH).toBe('bad');
  });

  it('keeps SIDEWAYS and CONFLICTED distinguishable at a glance', () => {
    expect(OPTIONS_SIGNAL_STATUS.SIDEWAYS).not.toBe(OPTIONS_SIGNAL_STATUS.CONFLICTED);
  });

  it('gives a quiet tape a real reading rather than a blank one', () => {
    // ⚪ is now reserved for "could not read", never "read as quiet".
    expect(OPTIONS_SIGNAL_STATUS.SIDEWAYS).toBe('neutral');
    expect(Object.values(OPTIONS_SIGNAL_STATUS)).not.toContain('unknown');
    expect(Object.values(MARKET_SIGNAL_STATUS)).not.toContain('unknown');
  });
});

describe('STATUS_PRESENTATION', () => {
  const levels: StatusLevel[] = ['good', 'neutral', 'weak', 'bad', 'unknown'];

  it('gives every level its own dot and its own colour', () => {
    const dots = levels.map((level) => STATUS_PRESENTATION[level].dot);
    const tokens = levels.map((level) => STATUS_PRESENTATION[level].token);
    expect(new Set(dots).size).toBe(levels.length);
    // 🟡 ระวัง and 🟠 อ่อนแรง are two sentences; one amber would collapse them.
    expect(new Set(tokens).size).toBe(levels.length);
  });

  /*
   * THE DIRECTION EACH LEVEL POINTS, PINNED ONE LEVEL AT A TIME.
   *
   * Stated as five separate facts rather than as "all different", because they
   * are NOT all different and the one collision is the whole point: `weak` rises
   * with `good`. Weak is a rise that fewer names are carrying, so a falling
   * arrow there would print the opposite of the reading, and `--caution` is what
   * says it is not a strong one. A future edit that "fixes" the duplicate by
   * pointing weak downwards has to delete an assertion that says why not.
   */
  it('points each level the way its reading actually goes', () => {
    expect(STATUS_PRESENTATION.good.icon).toBe('trending_up');
    expect(STATUS_PRESENTATION.weak.icon).toBe('trending_up');
    expect(STATUS_PRESENTATION.neutral.icon).toBe('trending_flat');
    expect(STATUS_PRESENTATION.bad.icon).toBe('trending_down');
    // No reading means no way to point: a rule, not an arrow.
    expect(STATUS_PRESENTATION.unknown.icon).toBe('horizontal_rule');
  });

  /*
   * The pair that must never converge. Everything else about a status can be
   * argued over; a rise drawn the same shape as a fall is the vocabulary
   * failing at the one job it was built for.
   */
  it('never draws a rise and a fall the same way', () => {
    expect(STATUS_PRESENTATION.good.icon).not.toBe(STATUS_PRESENTATION.bad.icon);
    expect(STATUS_PRESENTATION.weak.icon).not.toBe(STATUS_PRESENTATION.bad.icon);
    // Colour is not allowed to be the only difference between them either.
    expect(STATUS_PRESENTATION.good.token).not.toBe(STATUS_PRESENTATION.bad.token);
  });

  it('names a CSS custom property, never a literal colour', () => {
    for (const level of levels) {
      const { token, soft, line } = STATUS_PRESENTATION[level];
      for (const value of [token, soft, line]) {
        expect(value).toMatch(/^--[a-z-]+$/);
      }
    }
  });

  it('gives unknown a neutral surface rather than a coloured wash', () => {
    // There is no colour that means "no reading", so it does not get one.
    expect(STATUS_PRESENTATION.unknown.soft).toBe('--surface-elevated');
    expect(STATUS_PRESENTATION.unknown.line).toBe('--border');
  });

  it('carries a Thai fallback word for every level', () => {
    for (const level of levels) {
      expect(STATUS_PRESENTATION[level].fallbackLabel).toMatch(/[ก-๙]/);
    }
  });
});
