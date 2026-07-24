import { describe, expect, it } from 'vitest';
import { assetBasedValuation, calculateDeterministicDcf, calculateDeterministicWacc, calculateForwardMultiples, capitalStructureSensitivity, compositeValuation, dcfSensitivity, dividendDiscount, enterpriseMultipleValuation, fcfeValuation, fcffDcf, normalizeCapitalExpenditure, pegValuation, priceMultipleValuation, relativeValuation } from './formulas';
const assumptions = { forecastHorizon: 5, revenueGrowth: .05, operatingMargin: .2, taxRate: .2, depreciationPercentRevenue: .03, capexPercentRevenue: .04, workingCapitalPercentRevenue: .01, wacc: .1, terminalGrowth: .03, dilutionRate: 0 };
describe('valuation pure formulas', () => {
  it('calculates NOPAT/FCFF, terminal value, net debt and diluted-share fair value deterministically', () => { const result = fcffDcf({ revenue: 1000, netDebt: 100, dilutedShares: 100, assumptions }); expect(result.fairValue).toBeCloseTo(21.42626, 4); expect(result.inputs.terminalValue).toBeGreaterThan(0); expect(fcffDcf({ revenue: 1000, netDebt: 100, dilutedShares: 100, assumptions }).fairValue).toBe(result.fairValue); });
  it('rejects WACC <= terminal growth and invalid shares', () => { expect(() => fcffDcf({ revenue: 1000, netDebt: 0, dilutedShares: 10, assumptions: { ...assumptions, wacc: .03 } })).toThrow(/WACC/); expect(() => fcffDcf({ revenue: 1000, netDebt: 0, dilutedShares: 0, assumptions })).toThrow(/shares/i); });
  it('supports FCFE, DDM and asset valuation fixtures', () => { expect(fcfeValuation({ currentFcfe: 100, costOfEquity: .1, growth: .02, dilutedShares: 100 }).fairValue).toBeCloseTo(12.75); expect(dividendDiscount({ dividendPerShare: 2, costOfEquity: .1, growth: .02 }).fairValue).toBeCloseTo(25.5); expect(assetBasedValuation({ totalAssets: 1000, totalLiabilities: 400, dilutedShares: 100, adjustment: .9 }).fairValue).toBe(5); });
  it('uses peer median with transparent outlier filtering', () => { const result = relativeValuation({ metricPerShare: 2, peerMultiples: [{ symbol: 'A', multiple: 10 }, { symbol: 'B', multiple: 11 }, { symbol: 'C', multiple: 12 }, { symbol: 'OUT', multiple: 1000 }] }); expect(result.fairValue).toBe(22); expect(result.inputs.peers).not.toContain('OUT'); });
  it('normalizes validated weights and never returns NaN/Infinity', () => { const models = [fcfeValuation({ currentFcfe: 100, costOfEquity: .1, growth: .02, dilutedShares: 100 }), dividendDiscount({ dividendPerShare: 2, costOfEquity: .1, growth: .02 })]; const result = compositeValuation(models, { fcfe: 2, ddm: 1 }); expect(result.models.reduce((sum, model) => sum + model.weight, 0)).toBeCloseTo(1); expect(Number.isFinite(result.centralEstimate)).toBe(true); });
  it('produces bounded WACC/terminal-growth and debt/dilution sensitivity grids', () => { const base = { revenue: 1000, netDebt: 100, dilutedShares: 100, assumptions }; const grid = dcfSensitivity(base, [.09, .1], [.02, .03]); expect(grid).toHaveLength(2); expect(grid[0][0].status).toBe('available'); expect(dcfSensitivity(base, [.03], [.03])[0][0].status).toBe('unavailable'); const capital = capitalStructureSensitivity(base, [0, 100], [0, .02]); expect(capital[0][0].fairValue).toBeGreaterThan(capital[1][0].fairValue); expect(capital[0][0].fairValue).toBeGreaterThan(capital[0][1].fairValue); });
  it('normalizes either CapEx sign exactly once', () => { expect(normalizeCapitalExpenditure(-40)).toBe(40); expect(normalizeCapitalExpenditure(40)).toBe(40); });
  it('validates EV, earnings, book-value, and PEG denominators without zero fallbacks', () => {
    const ev = enterpriseMultipleValuation({ model: 'ev-sales', metric: 1000, totalDebt: 200, cash: 100, dilutedShares: 100, multiples: { conservative: 1, base: 2, optimistic: 3 } });
    expect(ev.scenarios).toEqual({ conservative: 9, base: 19, optimistic: 29 });
    expect(() => enterpriseMultipleValuation({ model: 'ev-ebitda', metric: 0, totalDebt: 0, cash: 0, dilutedShares: 10, multiples: { conservative: 5, base: 7, optimistic: 9 } })).toThrow(/ebitda/i);
    expect(() => priceMultipleValuation({ model: 'pe', metricPerShare: -1, multiples: { conservative: 10, base: 15, optimistic: 20 } })).toThrow(/eps/i);
    expect(() => priceMultipleValuation({ model: 'pb', metricPerShare: 0, multiples: { conservative: 1, base: 1.2, optimistic: 1.4 } })).toThrow(/book/i);
    expect(pegValuation({ eps: 2, forwardGrowthDecimal: 0.2, targetPeg: { conservative: 0.8, base: 1, optimistic: 1.2 } }).inputs.growthPercentPoints).toBe(20);
  });
});

describe('nexora-fv-v2 deterministic formulas', () => {
  it('matches a known five-year DCF fixture including terminal value and EV-to-equity bridge', () => {
    const result = calculateDeterministicDcf({
      latestFreeCashFlow: 100,
      growthRates: [0.1],
      cash: 50,
      debt: 20,
      shares: 10,
      wacc: 0.1,
      perpetualGrowth: 0.025,
    });
    expect(result.forecastFreeCashFlows).toEqual([
      expect.closeTo(110),
      expect.closeTo(121),
      expect.closeTo(133.1),
      expect.closeTo(146.41),
      expect.closeTo(161.051),
    ]);
    expect(result.terminalValue).toBeCloseTo(2201.0303333333345, 5);
    expect(result.enterpriseValue).toBeCloseTo(
      result.presentValueFreeCashFlows + result.presentValueTerminalValue,
      10,
    );
    expect(result.equityValue).toBeCloseTo(result.enterpriseValue + 50 - 20, 10);
    expect(result.fairValue).toBeCloseTo(result.equityValue / 10, 10);
  });

  it('validates WACC and applies diluted shares exactly once', () => {
    const wacc = calculateDeterministicWacc({
      riskFreeRate: 0.04,
      beta: 1.2,
      equityRiskPremium: 0.05,
      costDebt: 0.06,
      taxRate: 0.21,
      equityValue: 800,
      debt: 200,
    });
    expect(wacc.costOfEquity).toBeCloseTo(0.1);
    expect(wacc.afterTaxCostOfDebt).toBeCloseTo(0.0474);
    expect(wacc.wacc).toBeCloseTo(0.08948);
    expect(() => calculateDeterministicDcf({
      latestFreeCashFlow: 100,
      growthRates: [0.05],
      cash: 0,
      debt: 0,
      shares: 10,
      wacc: 0.025,
      perpetualGrowth: 0.025,
    })).toThrow(/WACC/);
    const tenShares = calculateDeterministicDcf({
      latestFreeCashFlow: 100,
      growthRates: [0.05],
      cash: 0,
      debt: 0,
      shares: 10,
      wacc: 0.1,
      perpetualGrowth: 0.025,
    });
    const twentyShares = calculateDeterministicDcf({
      latestFreeCashFlow: 100,
      growthRates: [0.05],
      cash: 0,
      debt: 0,
      shares: 20,
      wacc: 0.1,
      perpetualGrowth: 0.025,
    });
    expect(twentyShares.fairValue).toBeCloseTo(tenShares.fairValue / 2);
  });

  it('uses peer median, rejects an outlier, and requires four retained peers', () => {
    const result = calculateForwardMultiples({
      targetForwardEps: 2,
      targetForwardRevenue: 100,
      cash: 10,
      debt: 5,
      shares: 10,
      peers: [
        { symbol: 'A', price: 20, forwardEps: 2, enterpriseValue: 100, forwardRevenue: 10 },
        { symbol: 'B', price: 22, forwardEps: 2, enterpriseValue: 110, forwardRevenue: 10 },
        { symbol: 'C', price: 24, forwardEps: 2, enterpriseValue: 120, forwardRevenue: 10 },
        { symbol: 'D', price: 26, forwardEps: 2, enterpriseValue: 130, forwardRevenue: 10 },
        { symbol: 'OUT', price: 2_000, forwardEps: 2, enterpriseValue: 10_000, forwardRevenue: 10 },
      ],
    });
    expect(result.method).toBe('forward-pe');
    expect(result.peers.map((peer) => peer.symbol)).not.toContain('OUT');
    expect(result.medianMultiple).toBeCloseTo(11.5);
    expect(result.fairValue).toBeCloseTo(23);
    expect(() => calculateForwardMultiples({
      targetForwardEps: 2,
      targetForwardRevenue: 100,
      cash: 0,
      debt: 0,
      shares: 10,
      peers: [
        { symbol: 'A', price: 20, forwardEps: 2, enterpriseValue: 100, forwardRevenue: 10 },
        { symbol: 'B', price: 22, forwardEps: 2, enterpriseValue: 110, forwardRevenue: 10 },
        { symbol: 'C', price: 24, forwardEps: 2, enterpriseValue: 120, forwardRevenue: 10 },
      ],
    })).toThrow(/four|4/i);
  });

  it('switches to Forward EV/Sales only for non-positive target EPS', () => {
    const result = calculateForwardMultiples({
      targetForwardEps: -0.5,
      targetForwardRevenue: 200,
      cash: 30,
      debt: 50,
      shares: 20,
      peers: [
        { symbol: 'A', price: 20, forwardEps: -1, enterpriseValue: 100, forwardRevenue: 50 },
        { symbol: 'B', price: 22, forwardEps: 1, enterpriseValue: 150, forwardRevenue: 50 },
        { symbol: 'C', price: 24, forwardEps: 1, enterpriseValue: 200, forwardRevenue: 50 },
        { symbol: 'D', price: 26, forwardEps: 1, enterpriseValue: 250, forwardRevenue: 50 },
      ],
    });
    expect(result.method).toBe('forward-ev-sales');
    expect(result.medianMultiple).toBeCloseTo(3.5);
    expect(result.targetEnterpriseValue).toBeCloseTo(700);
    expect(result.targetEquityValue).toBeCloseTo(680);
    expect(result.fairValue).toBeCloseTo(34);
  });

  it('rejects missing estimates and all NaN/Infinity paths', () => {
    expect(() => calculateForwardMultiples({
      targetForwardEps: null,
      targetForwardRevenue: 100,
      cash: 0,
      debt: 0,
      shares: 10,
      peers: [],
    })).toThrow(/targetForwardEps/);
    expect(() => calculateDeterministicDcf({
      latestFreeCashFlow: Number.POSITIVE_INFINITY,
      growthRates: [0.05],
      cash: 0,
      debt: 0,
      shares: 10,
      wacc: 0.1,
      perpetualGrowth: 0.025,
    })).toThrow(/finite/);
  });
});
