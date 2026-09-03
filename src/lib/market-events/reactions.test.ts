import { describe, expect, it } from 'vitest';
import { EVENT_REACTION_MUST_NOT_SAY } from '@/src/lib/presentation/banned-copy';
import {
  BENCHMARK_LABEL_TH,
  REACTION_SAMPLE_LIMIT,
  reactionSentenceTh,
  reactionsFor,
  type ReactionRow,
} from './reactions';
import type { ReleaseTiming } from './release-timing';
import { MARKET_EVENTS } from './calendar';
import type { MarketEvent } from './types';

/**
 * THE ONE SENTENCE THIS FEATURE IS ALLOWED TO WRITE, AND THE LINE IT SITS ON.
 *
 * The numbers are measured; the cause is not. Half of what is below is
 * therefore about arithmetic and ordering, and the other half is about what the
 * module must never manage to say — including through a caller that hands it
 * unusual data.
 */

function event(over: Partial<MarketEvent> & Pick<MarketEvent, 'id' | 'at'>): MarketEvent {
  return {
    kind: 'CPI',
    titleTh: 'เงินเฟ้อผู้บริโภค (CPI)',
    shortTh: 'CPI',
    importance: 'high',
    source: 'BLS',
    referencePeriod: 'ทดสอบ',
    etDisplay: '8:30 a.m. ET',
    ...over,
  };
}

function row(over: Partial<ReactionRow> & Pick<ReactionRow, 'eventId' | 'sessionDate' | 'changePercent'>): ReactionRow {
  return {
    kind: 'CPI',
    previousSessionDate: '2026-01-01',
    close: 100,
    previousClose: 100,
    ...over,
  };
}

/*
 * A fixture, not the shipped file. Every session date below is a stand-in for a
 * publication date, and none of them is offered as a real one — the shipped
 * reaction file is empty and stays empty until somebody transcribes real
 * releases into the calendar. See docs/market-events-backfill.md.
 */
const BUCKETS: Record<ReleaseTiming, ReactionRow[]> = {
  beforeOpen: [
    row({ eventId: 'cpi-a', sessionDate: '2026-06-10', changePercent: 0.42 }),
    row({ eventId: 'cpi-b', sessionDate: '2026-07-14', changePercent: -1.1 }),
    row({ eventId: 'cpi-c', sessionDate: '2026-08-12', changePercent: 0.2 }),
    row({ eventId: 'cpi-d', sessionDate: '2026-05-13', changePercent: 3.3 }),
    row({ eventId: 'nfp-a', sessionDate: '2026-08-07', changePercent: -0.5, kind: 'NFP' }),
  ],
  intraday: [
    row({ eventId: 'fomc-a', sessionDate: '2026-06-17', changePercent: 0.9, kind: 'FOMC' }),
    row({ eventId: 'fomc-b', sessionDate: '2026-07-29', changePercent: -0.3, kind: 'FOMC' }),
    // Deliberately a CPI row in the wrong bucket: a caller must not reach it.
    row({ eventId: 'cpi-misfiled', sessionDate: '2026-08-31', changePercent: 9.9 }),
  ],
  afterClose: [],
};

const CPI = event({ id: 'cpi-now', at: '2026-09-11T12:30:00.000Z' });
const FOMC = event({
  id: 'fomc-now',
  at: '2026-09-16T18:00:00.000Z',
  kind: 'FOMC',
  shortTh: 'FOMC',
  titleTh: 'ผลการประชุม Fed (FOMC)',
  source: 'FED',
});

const view = (subject: MarketEvent, limit?: number) =>
  reactionsFor(subject, { buckets: BUCKETS, ...(limit === undefined ? {} : { limit }) });

describe('the list this builds', () => {
  it('names the most recent publications first, and stops at the limit', () => {
    expect(view(CPI)?.samples.map((sample) => sample.sessionDate))
      .toEqual(['2026-08-12', '2026-07-14', '2026-06-10']);
  });

  it('shows three by default, because that is what the copy claims', () => {
    expect(REACTION_SAMPLE_LIMIT).toBe(3);
    expect(view(CPI)?.samples).toHaveLength(3);
    expect(view(CPI, 2)?.samples.map((sample) => sample.sessionDate))
      .toEqual(['2026-08-12', '2026-07-14']);
  });

  it('signs the change, because the sign of a price change is the whole point', () => {
    expect(view(CPI)?.samples.map((sample) => sample.changeLabel))
      .toEqual(['+0.20%', '-1.10%', '+0.42%']);
  });

  it('dates every number, so a reader can check it against a chart', () => {
    expect(view(CPI)?.samples.map((sample) => sample.dayLabelTh))
      .toEqual(['12 ส.ค. 2569', '14 ก.ค. 2569', '10 มิ.ย. 2569']);
  });

  it('carries the direction for colour, and never as the only channel', () => {
    const samples = view(CPI)!.samples;
    expect(samples.map((sample) => sample.direction)).toEqual(['up', 'down', 'up']);
    // The sign is in the text too, so a reader who cannot see the colour has it.
    for (const sample of samples) {
      expect(sample.changeLabel.startsWith(sample.direction === 'down' ? '-' : '+')).toBe(true);
    }
  });

  it('names what the numbers are of', () => {
    expect(view(CPI)?.benchmarkLabelTh).toBe(BENCHMARK_LABEL_TH);
    expect(view(CPI)?.measureLabelTh).toBe('S&P 500 วันนั้น');
  });

  it('writes the sentence the brief allows and nothing more', () => {
    expect(reactionSentenceTh(view(CPI)!))
      .toBe('ครั้งก่อน ๆ — S&P 500 วันนั้น: +0.20% / -1.10% / +0.42%');
  });
});

describe('what it refuses to read', () => {
  it('reads only the release of the same kind', () => {
    expect(view(CPI)?.samples.map((sample) => sample.changePercent)).not.toContain(-0.5);
  });

  /*
   * ===========================================================================
   * THE TWO MEASUREMENTS NEVER MEET
   * ===========================================================================
   * A close-to-close change CONTAINS an 8:30 release and does not contain a
   * 2:00 p.m. one. The misfiled CPI row in the `intraday` bucket is planted so
   * this is proved rather than assumed: a CPI event reads `beforeOpen` and
   * cannot see it, and an FOMC event reads `intraday` and, being FOMC, still
   * cannot — the kind filter and the bucket are two locks, not one.
   */
  it('reads only the bucket the event itself belongs to', () => {
    const cpi = view(CPI)!;
    expect(cpi.timing).toBe('beforeOpen');
    expect(cpi.samples.map((sample) => sample.changePercent)).not.toContain(9.9);

    const fomc = view(FOMC)!;
    expect(fomc.timing).toBe('intraday');
    expect(fomc.samples.map((sample) => sample.sessionDate)).toEqual(['2026-07-29', '2026-06-17']);
    expect(fomc.samples.map((sample) => sample.changePercent)).not.toContain(9.9);
  });

  it('never counts the event itself as one of its own earlier publications', () => {
    const self = event({ id: 'cpi-a', at: '2026-09-11T12:30:00.000Z' });
    expect(reactionsFor(self, { buckets: BUCKETS })?.samples.map((sample) => sample.eventId ?? null))
      .not.toContain('cpi-a');
    expect(reactionsFor(self, { buckets: BUCKETS })?.samples.map((sample) => sample.sessionDate))
      .not.toContain('2026-06-10');
  });
});

describe('when there is nothing to show', () => {
  /*
   * NULL, NOT AN EMPTY VIEW. A heading over a dash invites a reader to wonder
   * what is broken; the answer is that this release has no history recorded,
   * which is not a fault and not worth a line of screen.
   */
  it('answers null rather than an empty block', () => {
    expect(reactionsFor(CPI, { buckets: { beforeOpen: [], intraday: [], afterClose: [] } }))
      .toBeNull();
  });

  it('answers null for a kind the file has nothing for', () => {
    const gdp = event({ id: 'gdp-now', at: '2026-09-24T12:30:00.000Z', kind: 'GDP', shortTh: 'GDP' });
    expect(reactionsFor(gdp, { buckets: BUCKETS })).toBeNull();
  });

  it('answers null for an instant it cannot place in the trading day', () => {
    expect(reactionsFor(event({ id: 'broken', at: 'not-an-instant' }), { buckets: BUCKETS }))
      .toBeNull();
  });

  it('answers null rather than an empty list when asked for none', () => {
    expect(view(CPI, 0)).toBeNull();
  });

  /*
   * THE STATE THE PRODUCT IS ACTUALLY IN. The shipped reaction file is empty
   * because no history has been transcribed into the calendar yet, so the block
   * renders nowhere — and that must be a quiet nothing, not a broken something.
   */
  it('shows nothing at all for every release the shipped calendar currently holds', () => {
    expect(MARKET_EVENTS.length).toBeGreaterThan(0);
    for (const shipped of MARKET_EVENTS) {
      expect(reactionsFor(shipped), shipped.id).toBeNull();
    }
  });
});

describe('the words this block may not say', () => {
  it('says none of them, in any part of the view or the sentence', () => {
    const rendered = [CPI, FOMC]
      .map((subject) => view(subject))
      .filter((built) => built !== null)
      .flatMap((built) => [
        reactionSentenceTh(built),
        built.headingTh,
        built.measureLabelTh,
        built.benchmarkLabelTh,
        ...built.samples.map((sample) => `${sample.dayLabelTh} ${sample.changeLabel}`),
      ])
      .join(' | ');
    expect(rendered.length).toBeGreaterThan(0);
    for (const phrase of EVENT_REACTION_MUST_NOT_SAY) {
      expect(rendered, `the reaction block must not say "${phrase}"`).not.toContain(phrase);
    }
  });

  it('states no tendency and no cause, however the numbers come out', () => {
    const allUp: Record<ReleaseTiming, ReactionRow[]> = {
      beforeOpen: [
        row({ eventId: 'a', sessionDate: '2026-06-10', changePercent: 1 }),
        row({ eventId: 'b', sessionDate: '2026-07-14', changePercent: 1 }),
        row({ eventId: 'c', sessionDate: '2026-08-12', changePercent: 1 }),
      ],
      intraday: [],
      afterClose: [],
    };
    /*
      Three identical positive days is the shape most likely to tempt a summary
      — "ขึ้นทุกครั้ง", an average, a tendency. The view must still be three
      dated numbers and nothing else.
    */
    const built = reactionsFor(CPI, { buckets: allUp })!;
    expect(reactionSentenceTh(built))
      .toBe('ครั้งก่อน ๆ — S&P 500 วันนั้น: +1.00% / +1.00% / +1.00%');
    expect(reactionSentenceTh(built)).not.toMatch(/ทุกครั้ง|เสมอ|ขึ้นตลอด/);
    expect(Object.keys(built)).not.toContain('average');
    expect(Object.keys(built)).not.toContain('summary');
  });
});
