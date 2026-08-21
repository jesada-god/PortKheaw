import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENGINE_REASON_IDS,
  REASON_COPY,
  REASON_IDS_WITHOUT_COPY,
  reasonContextFor,
  reasonText,
  type ReasonBaseContext,
} from './reason-copy';
import { calculateMarketSignal } from '@/src/lib/analytics/market-signal/calculations';
import type { MarketSignalCandle, MarketSignalReason, MarketSignalResult } from '@/src/lib/analytics/market-signal/types';

/*
 * Thai has no spaces between words, so "how many words is this" is not a
 * question `split(' ')` can answer — it would count the phrase breaks this file
 * happens to type and call a 30-word sentence four words long. `Intl.Segmenter`
 * with the Thai locale is the segmentation the platform ships, and it is the
 * same one a browser uses to decide where a line may break, which makes it the
 * right ruler for a length rule about reading.
 */
const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
const wordCount = (text: string): number =>
  [...segmenter.segment(text)].filter((piece) => piece.isWordLike).length;

const MIN_WORDS = 15;
const MAX_WORDS = 35;

/**
 * A payload with every field an entry might read, all of them populated.
 *
 * Populated rather than null on purpose: a null makes an entry return `null`
 * and fall back, which would let a broken sentence pass the sweeps below
 * without ever being built. The null paths get their own test.
 */
const metrics = {
  close: 44.06, ema20: 43.1, ema50: 43.35, ema200: 40.2,
  ema20SlopePct: 1.24, ema50SlopePct: -2.43, ema200SlopePct: 0.31,
  emaCompressionRatio: 0.0616, rsi14: 78.2, macd: 2.1, macdSignal: 1.8,
  macdHistogram: 0.3, histogramExpanding: true, adx14: 24.3, plusDi14: 31, minusDi14: 18,
  relativeVolume20: 1.42, obvTrend: 'rising' as const,
  bollingerUpper: 48, bollingerMiddle: 44, bollingerLower: 40,
  keltnerUpper: 49, keltnerMiddle: 44, keltnerLower: 39,
  squeezeOn: true, atr14: 4.06, ema20DeviationPct: 3.42,
  atrNormalizedDistance: 1.71, nearestSupport: 39.27, nearestResistance: 46.41,
  divergence: 'bearish' as const,
};

const baseContext: ReasonBaseContext = {
  metrics,
  gate: {
    band: 'neutral', conflicts: ['ema_vs_momentum'], forcedNeutral: false,
    earningsProximity: 'soon', daysToEarnings: 10,
    confidenceFactors: { base: 72, completeness: 1, agreement: 0.7, regimeClarity: 0.6, conflict: 0.9, earnings: 0.8 },
  } as never,
  zones: { pendingBreakout: true, pendingBreakdown: false } as never,
  actionable: { notes: ['measured_move_reached'] } as never,
  flags: [],
  reasonIds: [],
  timeframe: '1D',
};

const POLARITIES = ['positive', 'negative', 'information', 'caution'] as const;

/** Every string the table can produce, across every branch a context selects. */
function everyString(): Array<{ id: string; label: string; text: string }> {
  const out: Array<{ id: string; label: string; text: string }> = [];
  const variants: Array<[string, ReasonBaseContext]> = [
    ['base', baseContext],
    ['rsi-low', { ...baseContext, metrics: { ...metrics, rsi14: 18.4 } }],
    ['adx-strong', { ...baseContext, metrics: { ...metrics, adx14: 44.2, plusDi14: 12, minusDi14: 30 } }],
    ['di-level', { ...baseContext, metrics: { ...metrics, plusDi14: 20, minusDi14: 20 } }],
    ['below-average', { ...baseContext, metrics: { ...metrics, ema20DeviationPct: -5.1 } }],
    ['structure-conflict', { ...baseContext, gate: { ...baseContext.gate, conflicts: ['structure_vs_momentum'] } as never }],
    ['breakdown-pending', { ...baseContext, zones: { pendingBreakout: false, pendingBreakdown: true } as never }],
    ['no-measured-move', { ...baseContext, actionable: { notes: [] } as never }],
    ['divergence-weighted-down', { ...baseContext, flags: [] }],
    ['divergence-full-weight', { ...baseContext, flags: ['bullish_divergence', 'bearish_divergence'] }],
    ['no-gate', { ...baseContext, gate: null }],
    // The two sibling rows that carry `breakoutDirection()`'s answer, so both
    // named sides of `structure-volume-unconfirmed` are swept for length and
    // banned words alongside the unnamed one `baseContext` already produces.
    ['structure-up', { ...baseContext, reasonIds: ['structure-breakout'] }],
    ['structure-down', { ...baseContext, reasonIds: ['structure-breakdown'] }],
    /*
     * `macd-histogram` is the one row built from TWO fields at once, so a
     * single variant sweeps a sixth of it. Its sentence is chosen by
     * `macdHistogram`'s side crossed with `histogramExpanding`, and both of the
     * length words it can print sit on the diagonal — a positive bar is longer
     * when the flag is true, a negative one when it is false — so a variant
     * that moves only the flag would never build the two negative-side
     * sentences at all. All six branches are named here instead.
     */
    ['histogram-fading', { ...baseContext, metrics: { ...metrics, histogramExpanding: false } }],
    ['histogram-uncompared', { ...baseContext, metrics: { ...metrics, histogramExpanding: null } }],
    ['histogram-below-zero', { ...baseContext, metrics: { ...metrics, macdHistogram: -0.3 } }],
    ['histogram-deepening', { ...baseContext, metrics: { ...metrics, macdHistogram: -0.3, histogramExpanding: false } }],
    ['histogram-below-uncompared', { ...baseContext, metrics: { ...metrics, macdHistogram: -0.3, histogramExpanding: null } }],
    ['histogram-at-zero', { ...baseContext, metrics: { ...metrics, macdHistogram: 0 } }],
  ];
  for (const [id, build] of Object.entries(REASON_COPY)) {
    for (const [variant, context] of variants) {
      for (const polarity of POLARITIES) {
        const text = build({ ...context, polarity });
        if (text === null) continue;
        if (out.some((row) => row.text === text)) continue;
        out.push({ id, label: `${id} · ${variant} · ${polarity}`, text });
      }
    }
  }
  return out;
}

describe('reason copy', () => {
  /*
   * THE CONTRACT THAT MAKES THE REST OF THIS FILE SAFE.
   *
   * The table is a translation layer over payload, and the one way a
   * translation layer fails catastrophically is by swallowing what it cannot
   * translate. An unknown id must render the engine's sentence in full — not an
   * empty string, not a placeholder, not the id.
   */
  it('falls back to the engine sentence for an id it has never seen', () => {
    const reason: MarketSignalReason = {
      id: 'a-reason-invented-next-quarter',
      polarity: 'caution',
      text: 'ข้อความจาก engine ที่ยังไม่มีคำแปล',
      impact: 4,
    };
    expect(reasonText(reason, baseContext)).toBe('ข้อความจาก engine ที่ยังไม่มีคำแปล');
  });

  /*
   * And the same fallback when the id IS known but this payload cannot answer
   * it. `rsi14` needs a reading; a card whose RSI is null must not print a
   * sentence with a hole in it.
   */
  it('falls back when a known id has nothing to build its sentence from', () => {
    const reason: MarketSignalReason = { id: 'rsi14', polarity: 'positive', text: 'RSI14 อยู่ที่ 62', impact: 5 };
    const blind = { ...baseContext, metrics: { ...metrics, rsi14: null } };
    expect(reasonText(reason, blind)).toBe('RSI14 อยู่ที่ 62');
    // …and does translate it when the reading is there.
    expect(reasonText(reason, baseContext)).not.toBe('RSI14 อยู่ที่ 62');
  });

  it('never returns an empty string for any id, translated or not', () => {
    for (const id of [...ENGINE_REASON_IDS, 'something-else-entirely']) {
      const reason: MarketSignalReason = { id, polarity: 'positive', text: 'ข้อความสำรอง', impact: 1 };
      expect(reasonText(reason, baseContext).trim(), `${id} rendered empty`).not.toBe('');
    }
  });

  /*
   * COVERAGE, FROM THE ENGINE RATHER THAN FROM A LIST SOMEBODY MAINTAINS.
   *
   * `ENGINE_REASON_IDS` is typed by hand and would not notice an id added to
   * `calculations.ts` tomorrow. This replays the frozen corpus — the same inputs
   * `snapshot:signal` gates on — through every flag combination and collects the
   * ids that actually come out, so a new one shows up here the day it ships.
   */
  const goldenIds = (): Set<string> => {
    const dir = join(process.cwd(), '__golden__', 'candles');
    const ids = new Set<string>();
    for (const symbol of ['IREN', 'SPY', 'QQQ', 'DIA', 'IWM', 'REMX', 'GC-F', 'SI-F', 'CL-F', 'BTC-USD']) {
      const frozen = JSON.parse(readFileSync(join(dir, `${symbol}.json`), 'utf8')) as {
        symbol: string; source: string; freshness: unknown; candles: MarketSignalCandle[];
      };
      for (const gate of [false, true]) {
        for (const zones of [false, true]) {
          for (const actionable of [false, true]) {
            const result = calculateMarketSignal(frozen.candles, {
              symbol: frozen.symbol,
              source: frozen.source,
              freshness: frozen.freshness as never,
              calculatedAt: '2026-08-15T00:00:00.000Z',
              features: { gate, zones, actionable },
              earnings: { daysToNextReport: 10 },
            });
            for (const reason of result.reasons) ids.add(reason.id);
          }
        }
      }
    }
    return ids;
  };

  /*
   * 80 full engine runs — ten instruments through eight flag combinations — at
   * about 3s of real compute, so it carries its own timeout rather than living
   * under the 5s default and failing on a busy machine. The cost buys the one
   * thing a hand-written list cannot: it sees what the engine ACTUALLY emits.
   *
   * It reaches 16 of the 25 ids. The other nine need frames and actionable
   * states these ten instruments do not happen to be in, which is precisely why
   * the source-reading test below exists too.
   */
  /*
   * WHICH IDS THIS CORPUS CANNOT REACH, written down rather than left implicit.
   *
   * Ten instruments over eight flag combinations produce sixteen of the
   * twenty-five ids. The nine below need states none of them are in: an
   * `atr_band` frame, an actionable leg whose target or invalidation is
   * withheld, a structure break, an RSI past 75/25, or a volume reading that
   * fails confirmation. Leaving that as a footnote meant the corpus test looked
   * like full coverage and was not, so the split is now an assertion.
   *
   * The check is deliberately one-directional. Anything NOT on this list must
   * still be reached — that is the regression guard. An id that starts being
   * reached does not fail: the corpus got better, and the only cost is a stale
   * line here. What cannot happen is one of the sixteen quietly dropping out.
   */
  const IDS_THE_CORPUS_CANNOT_REACH = [
    'rsi-extreme', 'relative-volume', 'structure-breakout', 'structure-breakdown',
    'overextended', 'narrow-range-band', 'invalidation-from-band',
    'no-defensible-target', 'structure-volume-unconfirmed',
  ];

  it('knows every reason id the frozen corpus actually produces', { timeout: 30_000 }, () => {
    const seen = [...goldenIds()].sort();
    expect(seen.length, 'the corpus produced no reasons at all').toBeGreaterThan(5);
    const unlisted = seen.filter((id) => !(ENGINE_REASON_IDS as readonly string[]).includes(id));
    expect(unlisted, 'ids the engine emits that ENGINE_REASON_IDS does not list').toEqual([]);
    const untranslated = seen.filter((id) => !(id in REASON_COPY) && !(id in REASON_IDS_WITHOUT_COPY));
    expect(untranslated, 'ids the engine emits with no copy and no documented reason').toEqual([]);

    // Every id not excused above has to actually show up in the replay.
    const expected = (ENGINE_REASON_IDS as readonly string[])
      .filter((id) => !IDS_THE_CORPUS_CANNOT_REACH.includes(id)).sort();
    const missing = expected.filter((id) => !seen.includes(id));
    expect(missing, 'ids the corpus used to reach and no longer does').toEqual([]);
  });

  /*
   * The nine are only safe because the source-reading test above covers them.
   * If one were ever dropped from `ENGINE_REASON_IDS`, it would fall out of
   * both checks at once and nothing would notice — so it is named here too.
   */
  it('covers the ids the corpus misses through the source list instead', () => {
    for (const id of IDS_THE_CORPUS_CANNOT_REACH) {
      expect((ENGINE_REASON_IDS as readonly string[]).includes(id), `${id} is excused but not listed`).toBe(true);
      expect(id in REASON_COPY || id in REASON_IDS_WITHOUT_COPY, `${id} has no copy`).toBe(true);
    }
  });

  /*
   * The other direction: the hand-written list against the source itself.
   *
   * The corpus check only sees the branches ten instruments happen to take —
   * `no-defensible-target` and `invalidation-from-band` need frames most of them
   * never have. Reading the ids straight out of `calculations.ts` catches the
   * ones the corpus never exercises, which is exactly where an untranslated
   * string would sit unnoticed for months.
   */
  it('lists every reason id that appears in calculations.ts', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'lib', 'analytics', 'market-signal', 'calculations.ts'),
      'utf8',
    );
    const inSource = new Set<string>();
    for (const match of source.matchAll(/id: '([a-z0-9-]+)'/g)) inSource.add(match[1]);
    // Template ids the engine builds rather than writes literally.
    for (const built of ['ema20-slope', 'ema50-slope', 'ema200-slope', 'structure-breakout', 'structure-breakdown', 'bullish-divergence', 'bearish-divergence']) {
      inSource.add(built);
    }
    const missing = [...inSource].filter((id) => !(ENGINE_REASON_IDS as readonly string[]).includes(id)).sort();
    expect(missing, 'reason ids in calculations.ts that ENGINE_REASON_IDS does not list').toEqual([]);
  });

  it('has copy, or a written reason for not having it, for every listed id', () => {
    for (const id of ENGINE_REASON_IDS) {
      const covered = id in REASON_COPY || id in REASON_IDS_WITHOUT_COPY;
      expect(covered, `${id} has neither copy nor an entry in REASON_IDS_WITHOUT_COPY`).toBe(true);
      // An id cannot be in both: that would be a translation the docs claim is missing.
      expect(id in REASON_COPY && id in REASON_IDS_WITHOUT_COPY, `${id} is in both tables`).toBe(false);
    }
  });

  it('explains every untranslated id in words, not as a bare flag', () => {
    for (const [id, why] of Object.entries(REASON_IDS_WITHOUT_COPY)) {
      expect((ENGINE_REASON_IDS as readonly string[]).includes(id), `${id} is excused but not a real id`).toBe(true);
      expect(wordCount(why), `the note for ${id} is too short to be a reason`).toBeGreaterThan(8);
    }
  });

  /*
   * THE LANGUAGE STANDARD, applied to every branch rather than to the examples.
   *
   * A rule enforced on the entries somebody remembered to check is not a rule.
   * `everyString` walks each entry through every context that selects a
   * different sentence, so the bearish half of a pair cannot drift away from the
   * bullish half it was written beside.
   */
  it('keeps every sentence inside the 15-35 word band', () => {
    const rows = everyString();
    expect(rows.length, 'no strings were produced at all').toBeGreaterThan(20);
    for (const { label, text } of rows) {
      const words = wordCount(text);
      expect(words, `${label} is ${words} words: "${text}"`).toBeGreaterThanOrEqual(MIN_WORDS);
      expect(words, `${label} is ${words} words: "${text}"`).toBeLessThanOrEqual(MAX_WORDS);
    }
  });

  /*
   * The same banned list the card is held to. A translation that reaches for
   * "โซน" or "โมเมนตัม" has moved the jargon rather than removed it.
   *
   * The indicator names in brackets are the deliberate exception and are
   * stripped before the sweep: "(RSI)" is a handle a reader can go and look up,
   * not a word they have to know to finish the sentence. Everything outside the
   * brackets has to stand on its own.
   */
  const MUST_NOT_SAY = [
    'โซน', 'ไซด์เวย์', 'เบรก', 'breakout', 'breakdown', 'sideways',
    'หลุด', 'พลิกกลับ', 'ตกกลับ', 'โมเมนตัม', 'วอลุ่ม', 'โครงสร้าง',
    'swing', 'divergence', 'pivot', 'confirmed', 'Histogram',
    // The Latin spellings above were not enough: "จุดสวิง" shipped for a day
    // because "swing" in Thai letters matched none of them. A transliteration
    // is the jargon moved, not removed.
    'สวิง', 'ไดเวอร์เจนซ์', 'เทรนด์',
  ];

  it('keeps every sentence clear of the terms the card bans', () => {
    for (const { label, text } of everyString()) {
      const outsideBrackets = text.replaceAll(/\([^)]*\)/g, '');
      for (const banned of MUST_NOT_SAY) {
        expect(outsideBrackets, `"${banned}" is in ${label}: "${text}"`).not.toContain(banned);
      }
    }
  });

  /*
   * Rule 1, checked rather than trusted: a row that prints a reading has to
   * print what the reading is judged against. These are the four that carry a
   * bare number, and each names its own threshold — read from the config, so
   * the sentence cannot outlive the rule it quotes.
   */
  it('gives every printed reading a threshold to be judged against', () => {
    const withThreshold: Array<[string, string[]]> = [
      ['rsi14', ['50']],
      ['rsi-extreme', ['75', '25']],
      ['adx-dmi', ['25']],
      ['relative-volume', ['1.2']],
      ['structure-volume-unconfirmed', ['1.2']],
    ];
    for (const [id, thresholds] of withThreshold) {
      const variants = everyString().filter((row) => row.id === id);
      expect(variants.length, `${id} produced nothing`).toBeGreaterThan(0);
      for (const { label, text } of variants) {
        expect(thresholds.some((value) => text.includes(value)), `${label} prints no threshold: "${text}"`).toBe(true);
      }
    }
  });

  /*
   * "แท่ง" is the engine's unit and stays; what it MEANS on the timeframe in
   * front of the reader is added beside it, and only where it is true.
   */
  it('says what a bar is on a daily card, and does not guess on any other', () => {
    const daily = REASON_COPY['pending-zone-break']({ ...baseContext, polarity: 'caution' })!;
    expect(daily).toContain('5 แท่ง (วันทำการ)');
    const weekly = REASON_COPY['pending-zone-break']({ ...baseContext, timeframe: '1W', polarity: 'caution' })!;
    expect(weekly).toContain('5 แท่ง');
    expect(weekly).not.toContain('วันทำการ');
  });

  /*
   * THE ONE FACT THE TABLE RECONSTRUCTS RATHER THAN READS.
   *
   * The engine appends a "weighted low" qualifier when RSI sits mid-range, and
   * withholds the chip on the complement of the same condition. So gate present
   * + chip absent IS that case, exactly — no parsing, no payload change. If the
   * engine ever decouples the two, this test is what notices.
   */
  it('keeps the divergence qualifier the engine appends, and only when it applies', () => {
    const weightedDown = REASON_COPY['bearish-divergence']({ ...baseContext, flags: [], polarity: 'caution' })!;
    expect(weightedDown).toContain('ให้น้ำหนักต่ำ');
    expect(weightedDown).toContain('78.2');

    const fullWeight = REASON_COPY['bearish-divergence']({ ...baseContext, flags: ['bearish_divergence'], polarity: 'caution' })!;
    expect(fullWeight).not.toContain('ให้น้ำหนักต่ำ');

    // Gate off means the engine never appends it, whatever the chips say.
    const gateOff = REASON_COPY['bearish-divergence']({ ...baseContext, gate: null, flags: [], polarity: 'caution' })!;
    expect(gateOff).not.toContain('ให้น้ำหนักต่ำ');
  });

  /*
   * Rule 2 on the pairs that describe a state: the sentence has to say what the
   * state means, not only what it looks like. Every directional entry ends in a
   * clause that tells the reader which way it counts.
   */
  it('tells the reader what each state means, not only what it looks like', () => {
    const directional = ['ema-structure', 'macd-signal', 'swing-structure', 'structure-breakout', 'structure-breakdown'];
    for (const id of directional) {
      for (const polarity of ['positive', 'negative'] as const) {
        const text = REASON_COPY[id]({ ...baseContext, polarity });
        if (text === null) continue;
        expect(text, `${id} · ${polarity} describes a picture and stops`).toMatch(/—|จึง|แปลว่า/);
      }
    }
  });
});

describe('the dialog renders the table, not the payload', () => {
  const result = {
    metrics, timeframe: '1D', flags: [], gate: null, zones: null, actionable: null,
    // Required on a real payload, and `reasonContextFor` reads it for the
    // sibling-row direction, so the fixture carries it like every other
    // non-optional field above.
    reasons: [],
  } as unknown as MarketSignalResult;

  it('shows the written sentence where there is one and the engine string otherwise', () => {
    const context = reasonContextFor(result);
    const translated = reasonText(
      { id: 'obv-trend', polarity: 'positive', text: 'OBV มีแนวโน้มสูงขึ้น', impact: 3 },
      context,
    );
    expect(translated).toContain('ปริมาณซื้อขายสะสมเพิ่มขึ้น');
    expect(translated).not.toBe('OBV มีแนวโน้มสูงขึ้น');

    /*
     * The other half: a row with no entry still reaches the reader in full.
     *
     * This used to be `macd-histogram`, the one id that kept the engine's words
     * on purpose. It has copy now, and `REASON_IDS_WITHOUT_COPY` is empty — so
     * there is no real id left to stand for the fallback, and pinning the test
     * to one that HAS copy would only re-check the line above. An id the table
     * has never heard of is the same code path and cannot go stale.
     */
    const kept = reasonText(
      { id: 'macd-crossover-next-quarter', polarity: 'positive', text: 'MACD Histogram เป็นบวกและขยายตัว', impact: 3 },
      context,
    );
    expect(kept).toBe('MACD Histogram เป็นบวกและขยายตัว');

    // And the row that was the fallback until this change now translates.
    const nowTranslated = reasonText(
      { id: 'macd-histogram', polarity: 'positive', text: 'MACD Histogram เป็นบวกและขยายตัว', impact: 3 },
      context,
    );
    expect(nowTranslated).not.toBe('MACD Histogram เป็นบวกและขยายตัว');
    expect(nowTranslated).toContain('ยาวกว่าแท่งก่อนหน้า');
  });
});
