import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  aggregatePortfolioSensitivity,
  auditResultReconciliation,
  BASIC_PATH_OPTIONS,
  buildProfitLossSummary,
  calendarDaysBetween,
  clampTargetDate,
  convertUsdForDisplay,
  displayValidationMessage,
  engineVolatilityToPercent,
  formatPremiumDigits,
  formatResultNumber,
  formatResultMoney,
  formatSignedPercent,
  isBasicPathOption,
  normalizePercentDraft,
  parseFiniteDraft,
  parsePercentDraft,
  parsePremiumPaste,
  percentVolatilityToEngine,
  premiumFromDigitString,
  profitLossState,
  profitLossStateLabel,
  profitLossToneClass,
  safeProfitLossPercent,
  targetDateError,
  validationMessageParts,
  validationPathUnit,
} from './simulator-ux';

describe('Options Simulator UX helpers', () => {
  it('keeps calendar dates stable without local timezone conversion', () => {
    expect(addCalendarDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(calendarDaysBetween('2026-12-31', '2027-01-02')).toBe(2);
  });

  it('clamps Target Date after valuation and no later than expiration', () => {
    expect(clampTargetDate('2026-07-19', '2026-07-19', '2026-08-19')).toBe('2026-07-20');
    expect(clampTargetDate('2026-09-01', '2026-07-19', '2026-08-19')).toBe('2026-08-19');
    expect(targetDateError('2026-07-19', '2026-07-19', '2026-08-19')).toContain('หลังวันที่ใช้คำนวณ');
    expect(targetDateError('2026-08-20', '2026-07-19', '2026-08-19')).toContain('ไม่เกินวันหมดอายุ');
  });

  it('allows an empty numeric draft and never returns NaN or Infinity', () => {
    expect(parseFiniteDraft('')).toBeNull();
    expect(parseFiniteDraft('1.50')).toBe(1.5);
    expect(parseFiniteDraft('Infinity')).toBeNull();
    expect(parseFiniteDraft('not-a-number')).toBeNull();
  });

  it('supports cents-style Premium typing and currency paste without NaN', () => {
    expect(formatPremiumDigits('1')).toBe('0.01');
    expect(formatPremiumDigits('14')).toBe('0.14');
    expect(formatPremiumDigits('140')).toBe('1.40');
    expect(formatPremiumDigits('1500')).toBe('15.00');
    expect(premiumFromDigitString('140')).toBe(1.4);
    expect(parsePremiumPaste('$1.40')).toBe(1.4);
    expect(parsePremiumPaste('1.40')).toBe(1.4);
    expect(parsePremiumPaste('140')).toBe(1.4);
    expect(parsePremiumPaste('-1.40')).toBeNull();
  });

  it('converts IV once between percentage points and engine decimals', () => {
    const uiPercentagePoints = parsePercentDraft('116.14');
    expect(uiPercentagePoints).toBe(116.14);
    expect(percentVolatilityToEngine(uiPercentagePoints as number)).toBeCloseTo(1.1614, 10);
    expect(engineVolatilityToPercent(1.1614)).toBeCloseTo(116.14, 10);
    expect(percentVolatilityToEngine(engineVolatilityToPercent(1.1614))).toBeCloseTo(1.1614, 10);
    expect(normalizePercentDraft('00114.50')).toBe('114.50');
    expect(normalizePercentDraft('114.501')).toBeNull();
    expect(parsePercentDraft('114.50')).toBe(114.5);
  });

  it('shows the real field name and exposes unit-safe development diagnostics', () => {
    const message = 'legs.0.theta: มูลค่าที่ลดลงต่อวันต้องเป็นตัวเลข';
    expect(displayValidationMessage(message)).toBe('Leg 1 มูลค่าที่ลดลงต่อวัน (Theta): มูลค่าที่ลดลงต่อวันต้องเป็นตัวเลข');
    expect(validationMessageParts(message)).toEqual({ path: 'legs.0.theta', reason: 'มูลค่าที่ลดลงต่อวันต้องเป็นตัวเลข' });
    expect(validationPathUnit('legs.0.entryPremium')).toBe('USD-per-share');
    expect(validationPathUnit('legs.0.impliedVolatility')).toBe('engine-decimal');
    expect(validationPathUnit('scenarios.0.valuationDate')).toBe('calendar-date');
  });

  it('aggregates each leg Greek by side, quantity and multiplier', () => {
    expect(aggregatePortfolioSensitivity([
      { side: 'buy', quantity: 2, multiplier: 100, delta: 0.5, theta: -0.04 },
      { side: 'sell', quantity: 1, multiplier: 50, delta: 0.2, theta: -0.01 },
    ])).toEqual({ delta: 90, theta: -7.5 });
  });

  it('exposes only the approved path counts in the requested order', () => {
    expect(BASIC_PATH_OPTIONS).toEqual([1_000, 5_000, 10_000, 25_000, 50_000]);
    expect(isBasicPathOption(10_000)).toBe(true);
    expect(isBasicPathOption(2_000)).toBe(false);
  });

  it('formats signed USD/THB money once with deterministic two-decimal output', () => {
    expect(formatResultMoney(200.01, 'USD', null, true)).toBe('+$200.01');
    expect(formatResultMoney(-140, 'USD', null, true)).toBe('-$140.00');
    expect(formatResultMoney(-0, 'USD', null)).toBe('$0.00');
    expect(formatResultMoney(1_234.56, 'USD', 35)).toBe('$1,234.56');
    expect(formatResultMoney(1_266.317_142_857, 'THB', 35)).toBe('฿44,321.10');
    expect(formatResultMoney(-140, 'THB', 35, true)).toBe('-฿4,900.00');
    expect(formatResultMoney(100, 'THB', null)).toBe('ไม่มีข้อมูล');
    expect(formatResultMoney(Number.NaN, 'USD', null)).toBe('ไม่มีข้อมูล');
    expect(formatResultMoney(Number.POSITIVE_INFINITY, 'USD', null)).toBe('ไม่มีข้อมูล');
    expect(formatResultNumber(-0)).toBe('0.00');
    expect(formatResultNumber(Number.NaN)).toBe('ไม่มีข้อมูล');
  });

  it('converts display currency without mutating USD chart values or probabilities', () => {
    const usdBins = [-500.125, 0, 750.875];
    const probability = 0.4567;
    const thbBins = usdBins.map((value) => convertUsdForDisplay(value, 'THB', 35));
    expect(thbBins).toEqual([-17_504.375, 0, 26_280.625]);
    expect(usdBins).toEqual([-500.125, 0, 750.875]);
    expect(probability).toBe(0.4567);
    expect(convertUsdForDisplay(-0, 'USD', null)).toBe(0);
  });

  it('formats profit, loss and zero accessibly without relying on color alone', () => {
    expect(safeProfitLossPercent(200.01, 140.007)).toBeCloseTo(142.857, 3);
    expect(formatSignedPercent(142.857)).toBe('+142.86%');
    expect(safeProfitLossPercent(-140, 140)).toBe(-100);
    expect(formatSignedPercent(-100)).toBe('-100.00%');
    expect(safeProfitLossPercent(1, 0)).toBeNull();
    expect(formatSignedPercent(null)).toBe('คำนวณ % ไม่ได้');
    expect(profitLossState(1)).toBe('profit');
    expect(profitLossState(-1)).toBe('loss');
    expect(profitLossState(0)).toBe('break-even');
    expect(profitLossStateLabel('profit')).toBe('กำไร');
    expect(profitLossStateLabel('loss')).toBe('ขาดทุน');
    expect(profitLossStateLabel('break-even')).toBe('คุ้มทุน');
    expect(profitLossToneClass('profit')).toContain('emerald');
    expect(profitLossToneClass('loss')).toContain('red');
    expect(profitLossToneClass('break-even')).toContain('slate');
  });

  it('writes a human summary for profit, loss, break-even and unavailable percentages', () => {
    expect(buildProfitLossSummary(310, 140, 'USD', null)).toBe('กำไร $310.00 คิดเป็น 221.43% ของเงินที่เสี่ยงเริ่มต้น');
    expect(buildProfitLossSummary(-70, 140, 'USD', null)).toBe('ขาดทุน $70.00 คิดเป็น 50.00% ของเงินที่เสี่ยงเริ่มต้น');
    expect(buildProfitLossSummary(0, 140, 'USD', null)).toBe('คุ้มทุน $0.00 คิดเป็น 0.00% ของเงินที่เสี่ยงเริ่มต้น');
    expect(buildProfitLossSummary(10, null, 'USD', null)).toBe('กำไร $10.00 แต่คำนวณเปอร์เซ็นต์ไม่ได้ เพราะไม่มีฐานเงินที่เสี่ยงเริ่มต้นที่มากกว่า 0');
  });

  it('audits value, P&L and sequential impact reconciliation without double-counting Delta', () => {
    const audit = auditResultReconciliation({
      currentValue: 100,
      simulatedValue: 125,
      changeFromCurrent: 25,
      initialCostOrCredit: 80,
      projectedProfitLoss: 45,
      priceImpact: 10,
      timeDecayImpact: 5,
      ivImpact: 10,
      deltaEstimate: 1_000,
    });

    expect(audit.valueChange.status).toBe('matched');
    expect(audit.projectedProfitLoss.status).toBe('matched');
    expect(audit.impactDecomposition.total).toBe(25);
    expect(audit.impactDecomposition.residual).toBe(0);
    expect(audit.impactDecomposition.status).toBe('matched');
    expect(audit.deltaEstimate).toBe(1_000);
  });

  it('exposes Other Impact when estimates do not reconcile and never rounds intermediate values', () => {
    const audit = auditResultReconciliation({
      currentValue: 100.001,
      simulatedValue: 125.009,
      changeFromCurrent: 25.008,
      initialCostOrCredit: 80.004,
      projectedProfitLoss: 45.005,
      priceImpact: 10.001,
      timeDecayImpact: 5.002,
      ivImpact: 9.003,
      deltaEstimate: -100,
    });

    expect(audit.valueChange.status).toBe('matched');
    expect(audit.projectedProfitLoss.status).toBe('matched');
    expect(audit.impactDecomposition.total).toBeCloseTo(24.006, 12);
    expect(audit.impactDecomposition.residual).toBeCloseTo(1.002, 12);
    expect(audit.impactDecomposition.status).toBe('mismatch');
  });
});
