import { describe, expect, it } from 'vitest';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { STATUS_RANK } from '@/src/lib/presentation/status';
import { evaluateMarketStatus, type MarketStatusReading } from './rules';
import { inputStatusLevel, marketStatusCopy } from './presentation';

function readings(moves: Partial<Record<string, number | null>>): MarketStatusReading[] {
  return MARKET_STATUS_INPUTS.map((input) => {
    const percent = moves[input.key] ?? (moves[input.key] === undefined ? 0 : null);
    return {
      key: input.key,
      value: percent === null ? null : 100 * (1 + percent / 100),
      comparisonClose: percent === null ? null : 100,
    };
  });
}

const UP = evaluateMarketStatus(readings({ SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: -15, US10Y: -4, DXY: -1.2 }));
const DOWN = evaluateMarketStatus(readings({ SPX: -1.5, NDX: -1.8, DJI: -1.5, VIX: 15, US10Y: 4, DXY: 1.2 }));
const FLAT = evaluateMarketStatus(readings({}));
/*
  The ten-year missing, not VIX. Both withhold the regime, but the ten-year
  carries the smallest weight in the table, so the score interval stays narrow
  enough to keep a definite label — which is the state this fixture is for:
  status still shown, subtitle withheld. Dropping VIX instead widens the
  interval by a quarter of the table and correctly softens the label to
  SIDEWAYS, which would test two things at once and pin neither.
*/
const NO_REGIME = evaluateMarketStatus(readings({
  SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: -15, US10Y: null, DXY: -1.2,
}));
const INSUFFICIENT = evaluateMarketStatus(readings({ SPX: null }));

const EVERY_STATE = [
  marketStatusCopy(UP),
  marketStatusCopy(DOWN),
  marketStatusCopy(FLAT),
  marketStatusCopy(NO_REGIME),
  marketStatusCopy(INSUFFICIENT),
  marketStatusCopy(UP, '2025-08-29'),
  marketStatusCopy(INSUFFICIENT, '2025-08-29'),
];

describe('the copy contract', () => {
  /*
    CARD_MUST_NOT_SAY is the trading-jargon list. It is scoped to a card that
    explains a reading to somebody who does not trade for a living, which is
    exactly what this card is — so it is held to the same vocabulary as the
    Market Signal card rather than to a looser one of its own.
  */
  it('never reaches for trading jargon', () => {
    for (const copy of EVERY_STATE) {
      for (const word of CARD_MUST_NOT_SAY) {
        expect(`${copy.headline} ${copy.subtitle} ${copy.asOfNote ?? ''}`).not.toContain(word);
      }
    }
  });

  it('never claims a narrator, forecasts, or sells', () => {
    for (const copy of EVERY_STATE) {
      for (const phrase of NEVER_SAY) {
        expect(`${copy.headline} ${copy.subtitle} ${copy.asOfNote ?? ''}`).not.toContain(phrase);
      }
    }
  });

  it('names every instrument in Thai, with no ticker and no jargon', () => {
    for (const input of MARKET_STATUS_INPUTS) {
      for (const word of CARD_MUST_NOT_SAY) {
        expect(input.labelTh).not.toContain(word);
      }
      // The symbol is what the provider is asked for; it is not a reader's word.
      expect(input.labelTh).not.toContain(input.symbol);
    }
  });

  it('always produces a headline and a subtitle — a blank is never a state', () => {
    for (const copy of EVERY_STATE) {
      expect(copy.headline.trim().length).toBeGreaterThan(0);
      expect(copy.subtitle.trim().length).toBeGreaterThan(0);
    }
  });

  it('never prints a score or a percentage of confidence', () => {
    /*
      There IS a weighted score inside the rule table. It measures this
      product's weighting judgement, not the market, and a reader shown "+0.42"
      or "72%" would reasonably read it as a measurement. No digit of it may
      reach the copy — the only numbers on the card are the six real prices,
      printed by the component from the readings themselves.
    */
    for (const copy of EVERY_STATE) {
      expect(copy.headline).not.toMatch(/\d/);
      expect(copy.subtitle).not.toMatch(/%/);
      expect(copy.subtitle).not.toMatch(/[+-]?\d+\.\d+/);
    }
  });
});

describe('what each state says', () => {
  it('reads an advance, a decline and a flat tape as three different sentences', () => {
    expect(marketStatusCopy(UP).headline).toBe('ตลาดกำลังไปต่อ');
    expect(marketStatusCopy(DOWN).headline).toBe('ตลาดแผ่วลง');
    expect(marketStatusCopy(FLAT).headline).toBe('ตลาดทรงตัว');
  });

  it('maps the label to the shared status vocabulary', () => {
    expect(marketStatusCopy(UP).level).toBe('good');
    expect(marketStatusCopy(DOWN).level).toBe('weak');
    expect(marketStatusCopy(FLAT).level).toBe('neutral');
  });

  it('replaces the status with ข้อมูลไม่ครบ rather than showing both', () => {
    const copy = marketStatusCopy(INSUFFICIENT);
    expect(copy.headline).toBe('ข้อมูลไม่ครบ');
    expect(copy.level).toBe('unknown');
    // Not a status word alongside it — the reader is told one thing.
    expect(copy.headline).not.toContain('ตลาดกำลังไปต่อ');
    expect(copy.headline).not.toContain('ตลาดทรงตัว');
  });

  it('carries the regime as a sentence about money, not as an English term', () => {
    const copy = marketStatusCopy(UP);
    expect(copy.subtitle).toContain('เงินไหลเข้าสินทรัพย์เสี่ยง');
    for (const term of ['Risk-On', 'Risk-Off', 'Risk On', 'RISK_ON', 'regime']) {
      expect(copy.subtitle).not.toContain(term);
    }
  });

  it('keeps the status but says WHY the regime is missing, rather than printing a neutral one', () => {
    // Withholding silently would leave "the market has not picked a direction"
    // and "we could not tell" looking identical.
    expect(NO_REGIME.regime).toBeNull();
    expect(NO_REGIME.status).toBe('available');
    const copy = marketStatusCopy(NO_REGIME);
    expect(copy.headline).toBe('ตลาดกำลังไปต่อ');
    expect(copy.subtitle).toContain('ยังอ่านทิศทางการลงทุนไม่ได้');
    expect(copy.subtitle).not.toContain('เงินยังไม่เลือกทาง');
  });

  it('still shows a status when VIX is missing, even though the label softens', () => {
    /*
      The requirement is that losing VIX or the ten-year withholds the SUBTITLE
      and not the status. VIX carries a quarter of the table's weight, so the
      status it leaves behind is the more cautious SIDEWAYS rather than UPTREND
      — a softer claim, which is the honest one, and still a status.
    */
    const noVix = evaluateMarketStatus(readings({
      SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: null, US10Y: -4, DXY: -1.2,
    }));
    expect(noVix.status).toBe('available');
    expect(noVix.regime).toBeNull();
    expect(marketStatusCopy(noVix).headline).not.toBe('ข้อมูลไม่ครบ');
  });

  it('names the day the numbers came from when the market is shut', () => {
    const copy = marketStatusCopy(UP, '2025-08-29');
    expect(copy.asOfNote).toBe('ตัวเลขนี้คือราคาปิดของวันศุกร์ที่ 29 ส.ค. 2025');
  });

  it('carries no day note while the market is open', () => {
    // A live number is about right now; dating it would be wrong, not redundant.
    expect(marketStatusCopy(UP, null).asOfNote).toBeNull();
  });
});

describe('the per-instrument mark reads meaning, not direction', () => {
  it('marks a rising fear gauge as bad news', () => {
    const vix = MARKET_STATUS_INPUTS.find((input) => input.key === 'VIX')!;
    expect(inputStatusLevel(20, vix.polarity, vix.flatBandPercent)).toBe('bad');
    expect(inputStatusLevel(-20, vix.polarity, vix.flatBandPercent)).toBe('good');
  });

  it('marks a rising index as good news', () => {
    const spx = MARKET_STATUS_INPUTS.find((input) => input.key === 'SPX')!;
    expect(inputStatusLevel(1, spx.polarity, spx.flatBandPercent)).toBe('good');
    expect(inputStatusLevel(-1, spx.polarity, spx.flatBandPercent)).toBe('bad');
  });

  it('marks a move inside the dead band as neutral', () => {
    const spx = MARKET_STATUS_INPUTS.find((input) => input.key === 'SPX')!;
    expect(inputStatusLevel(0.05, spx.polarity, spx.flatBandPercent)).toBe('neutral');
  });

  it('marks an unreadable input unknown, which ranks BELOW neutral', () => {
    /*
      The rule the shared status vocabulary exists to hold: missing data must
      never read as calm, and never as good news.
    */
    expect(inputStatusLevel(null, 1, 0.15)).toBe('unknown');
    expect(inputStatusLevel(Number.NaN, 1, 0.15)).toBe('unknown');
    expect(STATUS_RANK.unknown).toBeLessThan(STATUS_RANK.neutral);
    expect(STATUS_RANK.unknown).toBeLessThan(STATUS_RANK.good);
  });
});
