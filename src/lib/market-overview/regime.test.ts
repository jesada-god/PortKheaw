import { describe, expect, it } from 'vitest';
import { OV_REGIME_INPUTS, OV_REGIME_REASON_MAX_CHARS, ovRegime } from './regime';
import type { OvIndexKey, OvIndexReading } from './types';

/**
 * The property under test is not "does it say risk_on when VIX falls".
 *
 * It is MONOTONICITY: losing a reading may only ever move the answer toward
 * `neutral`, never toward a stronger claim. That is the failure the bounded
 * interval exists to prevent and the one that is invisible from the outside —
 * a confident word looks identical whether it was earned or arrived at by
 * subtraction.
 */

function reading(key: OvIndexKey, changePercent: number | null): OvIndexReading {
  return {
    key,
    symbol: key,
    labelTh: OV_REGIME_INPUTS.find((input) => input.key === key)?.labelTh ?? key,
    proxyLabelTh: null,
    value: changePercent === null ? null : 100,
    comparisonClose: changePercent === null ? null : 100,
    changePercent,
    asOf: null,
  };
}

describe('ovRegime', () => {
  it('reads three falling risk inputs as risk_on', () => {
    // Every one of the three is polarity -1: falling VIX, yields and dollar all
    // push toward risk_on, each at full weight.
    const verdict = ovRegime([
      reading('VIX', -15),
      reading('US10Y', -4),
      reading('DXY', -1.2),
    ]);
    expect(verdict.regime).toBe('risk_on');
  });

  it('reads three rising risk inputs as risk_off', () => {
    const verdict = ovRegime([
      reading('VIX', 15),
      reading('US10Y', 4),
      reading('DXY', 1.2),
    ]);
    expect(verdict.regime).toBe('risk_off');
  });

  it('reads three inputs inside their dead bands as neutral', () => {
    // Each move is real and each is below the band its own instrument is judged
    // by. Three instruments drifting is not a regime.
    const verdict = ovRegime([
      reading('VIX', 1),
      reading('US10Y', 0.5),
      reading('DXY', 0.1),
    ]);
    expect(verdict.regime).toBe('neutral');
    /*
      NAMED, not counted. This read "ทั้งสามตัวยังไม่ขยับเกินเกณฑ์" and was
      printed under a status word produced by all SIX instruments, whose figures
      sit directly above it — so the reader counted six and could not tell which
      three the line meant.
    */
    expect(verdict.reasons).toEqual(['VIX พันธบัตร ดอลลาร์ ยังไม่ขยับเกินเกณฑ์']);
    // At the cap exactly, with nothing to spare. See the assertion over every
    // generated reason at the foot of this file.
    expect([...verdict.reasons[0]!].length).toBe(OV_REGIME_REASON_MAX_CHARS);
  });

  it('withholds the regime when VIX cannot be read', () => {
    const verdict = ovRegime([
      reading('VIX', null),
      reading('US10Y', -4),
      reading('DXY', -1.2),
    ]);
    expect(verdict.regime).toBeNull();
  });

  it('withholds the regime when the ten-year cannot be read', () => {
    const verdict = ovRegime([
      reading('VIX', -15),
      reading('US10Y', null),
      reading('DXY', -1.2),
    ]);
    expect(verdict.regime).toBeNull();
  });

  it('still answers when only the dollar is missing', () => {
    // The dollar is not on `requiredForRegime`: losing it degrades the answer
    // rather than invalidating it.
    const verdict = ovRegime([
      reading('VIX', -15),
      reading('US10Y', -4),
      reading('DXY', null),
    ]);
    expect(verdict.regime).not.toBeNull();
  });

  it('never strengthens the answer when an input goes missing', () => {
    /*
      The exact shape of the JOBY bug, in this module's terms. With all three
      present the readings clear the band; drop the dollar and its full weight
      becomes uncertainty on both sides, so the interval widens past the band
      and the claim falls back rather than surviving on a smaller sample.
    */
    const whole = ovRegime([
      reading('VIX', -15),
      reading('US10Y', 0),
      reading('DXY', -1.2),
    ]);
    const partial = ovRegime([
      reading('VIX', -15),
      reading('US10Y', 0),
      reading('DXY', null),
    ]);
    expect(whole.regime).toBe('risk_on');
    expect(partial.regime).toBe('neutral');
  });

  it('orders reasons by how hard each input pushed', () => {
    const verdict = ovRegime([
      reading('VIX', -15),
      reading('US10Y', -4),
      reading('DXY', -1.2),
    ]);
    // VIX carries weight 3, the dollar 2, the ten-year 1.
    expect(verdict.reasons).toEqual([
      'ความกังวลของตลาด -15.00%',
      'ค่าเงินดอลลาร์ -1.20%',
      'ผลตอบแทนพันธบัตร 10 ปี -4.00%',
    ]);
  });

  it('always names an input it could not read', () => {
    const verdict = ovRegime([
      reading('VIX', -15),
      reading('US10Y', -4),
      reading('DXY', null),
    ]);
    expect(verdict.reasons).toContain('ค่าเงินดอลลาร์ ยังไม่มีข้อมูล');
  });

  it('says nothing about an input that stayed inside its dead band', () => {
    const verdict = ovRegime([
      reading('VIX', -15),
      reading('US10Y', 0.2),
      reading('DXY', -1.2),
    ]);
    expect(verdict.reasons.some((line) => line.startsWith('ผลตอบแทนพันธบัตร'))).toBe(false);
  });

  it('keeps every reason inside one handset line', () => {
    /*
      Swept rather than spot-checked: the labels are fixed but the number is
      not, and a four-digit VIX move is the case that would overflow.
    */
    const percents = [null, -99.99, -15, -4, -1.2, -0.1, 0, 0.1, 1.2, 4, 15, 99.99, 1234.5];
    for (const vix of percents) {
      for (const dxy of percents) {
        const verdict = ovRegime([
          reading('VIX', vix),
          reading('US10Y', 4),
          reading('DXY', dxy),
        ]);
        for (const line of verdict.reasons) {
          expect([...line].length, line).toBeLessThanOrEqual(OV_REGIME_REASON_MAX_CHARS);
        }
      }
    }
  });

  it('reads the three risk inputs from the shared table rather than a copy', () => {
    // If the config ever regroups an input, this module must move with it.
    expect(OV_REGIME_INPUTS.map((input) => input.key)).toEqual(['VIX', 'US10Y', 'DXY']);
    expect(OV_REGIME_INPUTS.every((input) => input.group === 'risk')).toBe(true);
  });
});
