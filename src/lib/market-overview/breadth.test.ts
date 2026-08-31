import { describe, expect, it } from 'vitest';
import { OV_BREADTH_THRESHOLDS, ovBreadth, ovBreadthFromMarketBreadth, ovBreadthStatus } from './breadth';
import type { MarketBreadth } from '@/src/lib/overview/types';

describe('ovBreadthStatus', () => {
  it('walks both cut points by name rather than by literal', () => {
    /*
      Naming the constants is what stops this test passing after somebody
      retunes the thresholds — a test written against `60` keeps passing when
      the rule becomes 65, which makes it a test of nothing.
    */
    expect(ovBreadthStatus(OV_BREADTH_THRESHOLDS.strongAtOrAbove)).toBe('strong');
    expect(ovBreadthStatus(OV_BREADTH_THRESHOLDS.strongAtOrAbove - 0.01)).toBe('weakening');
    expect(ovBreadthStatus(OV_BREADTH_THRESHOLDS.weakBelow)).toBe('weakening');
    expect(ovBreadthStatus(OV_BREADTH_THRESHOLDS.weakBelow - 0.01)).toBe('weak');
  });

  it('puts the extremes where they belong', () => {
    expect(ovBreadthStatus(100)).toBe('strong');
    expect(ovBreadthStatus(0)).toBe('weak');
  });
});

describe('ovBreadth', () => {
  it('reports advancers as a share of what could be read', () => {
    const snapshot = ovBreadth({ advancing: 700, declining: 250, unchanged: 50, validCount: 1000 });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.advancingPercent).toBe(70);
    expect(snapshot!.status).toBe('strong');
    expect(snapshot!.advancers).toBe(700);
    expect(snapshot!.decliners).toBe(250);
    expect(snapshot!.validCount).toBe(1000);
  });

  it('leaves both moving-average figures null', () => {
    /*
      Phase 2 has no source for these — the batch this is built from returns two
      bars per symbol. The type says `null` rather than `number | null` so this
      cannot be filled in from a smaller sample; the assertion is here so a
      change of mind has to be deliberate in two places.
    */
    const snapshot = ovBreadth({ advancing: 700, declining: 250, unchanged: 50, validCount: 1000 });
    expect(snapshot!.pctAboveMA50).toBeNull();
    expect(snapshot!.pctAboveMA200).toBeNull();
  });

  it('is silent rather than weak when nothing could be read', () => {
    // `0 / 0` would resolve to `weak` — a card announcing a narrow market
    // because a provider was down.
    expect(ovBreadth({ advancing: 0, declining: 0, unchanged: 0, validCount: 0 })).toBeNull();
  });

  it('is silent on impossible counts', () => {
    expect(ovBreadth({ advancing: -1, declining: 5, unchanged: 0, validCount: 4 })).toBeNull();
    expect(ovBreadth({ advancing: Number.NaN, declining: 5, unchanged: 0, validCount: 4 })).toBeNull();
    expect(ovBreadth({ advancing: 1, declining: 5, unchanged: 0, validCount: Number.NaN })).toBeNull();
  });

  it('reads a narrow advance as weak even though it is an advance', () => {
    // The whole reason breadth has its own vocabulary: this can be true on a
    // green day, and `down` would be the wrong word for it.
    const snapshot = ovBreadth({ advancing: 300, declining: 650, unchanged: 50, validCount: 1000 });
    expect(snapshot!.status).toBe('weak');
  });
});

describe('ovBreadthFromMarketBreadth', () => {
  const breadth: MarketBreadth = {
    advancing: 520,
    declining: 400,
    unchanged: 80,
    validCount: 1000,
    universeCount: 4285,
    returnedCount: 4200,
    failedCount: 3285,
    staleCount: 0,
    upDownRatio: 1.3,
    breadthPercent: 52,
    coveragePercent: 23.3,
    aboveEma20Percent: null,
    updatedAt: '2026-08-28T20:00:00.000Z',
    evaluatedAt: '2026-08-28T20:05:00.000Z',
    durationMs: 4200,
    tradingDate: '2026-08-28',
    session: 'regular',
    source: 'alpaca-multi-snapshot',
    feed: 'delayed_sip',
    status: 'partial',
    universeDescription: 'test universe',
  };

  it('reads four fields off the snapshot the overview already loaded', () => {
    const snapshot = ovBreadthFromMarketBreadth(breadth);
    expect(snapshot).toEqual({
      advancers: 520,
      decliners: 400,
      advancingPercent: 52,
      pctAboveMA50: null,
      pctAboveMA200: null,
      status: 'weakening',
      validCount: 1000,
    });
  });

  it('does not second-guess the existing partial/stale judgement', () => {
    /*
      `status: 'partial'` upstream means the sample was thin. This module still
      answers, because how thin is too thin is a question `market-breadth.ts`
      already owns — a second floor here would be a second opinion about one
      sample.
    */
    expect(ovBreadthFromMarketBreadth(breadth)!.status).toBe('weakening');
  });

  it('passes an absent snapshot straight through', () => {
    expect(ovBreadthFromMarketBreadth(null)).toBeNull();
  });
});
