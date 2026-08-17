import { describe, expect, it } from 'vitest';
import { hasCapability, requiredTierFor } from '@/src/lib/subscription/capabilities';
import { upgradeCopy } from '@/src/lib/subscription/upgrade-copy';
import {
  companyProfileKind,
  resolveAssetPresentationPolicy,
  resolveCompanyProfileLabels,
} from './profile-presentation';
import {
  isCommodityAssetType,
  isContinuousAssetType,
  resolveCommodityMarketSession,
} from './continuous-client';

describe('commodity asset presentation', () => {
  it('classifies a commodity as its own kind, not as a company', () => {
    expect(companyProfileKind('commodity')).toBe('commodity');
    expect(companyProfileKind('COMMODITY')).toBe('commodity');
  });

  /**
   * The point of the policy: a futures contract has no legal entity, so every
   * equity fundamental is withheld rather than filled in with a number about
   * something else. Before the commodity kind existed, an unknown asset type fell
   * through to 'company' and the page would have shown a sector, an industry, a
   * market capitalisation and an options chain for a barrel of oil.
   *
   * `showFinancials` is the one thing that is TRUE here, and it is not a
   * fundamental — it is the tab the technical signal lives in, computed from
   * this contract's own candles. See the policy's own note.
   */
  it('withholds every equity fundamental for a commodity', () => {
    expect(resolveAssetPresentationPolicy('commodity')).toEqual({
      kind: 'commodity',
      showEmployees: false,
      showFiscalYearEnd: false,
      showCountry: false,
      showSectorAndIndustry: false,
      showMarketCapitalization: false,
      showFinancials: true,
      showAnalystTargets: false,
      showKeyStatistics: false,
      showOptionsAnalysis: false,
      technicalOutlookCapability: 'technical.outlook.commodity',
    });
  });

  /**
   * The signal is the whole Financials tab on a contract, so it is sold on the
   * Pro step rather than the Elite one — and it names a SEPARATE capability, so
   * a future move of either row cannot drag the other with it.
   */
  it('opens the commodity signal at Pro without touching the equity row', () => {
    expect(resolveAssetPresentationPolicy('commodity').technicalOutlookCapability)
      .toBe('technical.outlook.commodity');
    expect(requiredTierFor('technical.outlook.commodity')).toBe('pro');

    for (const assetType of ['stock', 'etf', 'crypto', 'index', null]) {
      expect(resolveAssetPresentationPolicy(assetType).technicalOutlookCapability, `${assetType}`)
        .toBe('technical.outlook');
    }
    expect(requiredTierFor('technical.outlook')).toBe('elite');
  });

  /** Basic is refused on a contract, exactly as it is on a stock. */
  it('keeps Basic locked out of the signal on every asset type', () => {
    expect(hasCapability('basic', 'technical.outlook.commodity')).toBe(false);
    expect(hasCapability('basic', 'technical.outlook')).toBe(false);
    expect(hasCapability('pro', 'technical.outlook.commodity')).toBe(true);
    expect(hasCapability('pro', 'technical.outlook')).toBe(false);
    expect(hasCapability('elite', 'technical.outlook.commodity')).toBe(true);
    expect(hasCapability('elite', 'technical.outlook')).toBe(true);
  });

  /** The paywall must name the plan that actually opens it. */
  it('tells a locked reader the commodity signal starts at Pro', () => {
    const copy = upgradeCopy('technical.outlook.commodity');
    expect(copy.lockedLabel).toContain('Pro');
    expect(copy.lockedLabel).not.toContain('Elite');
    expect(upgradeCopy('technical.outlook').lockedLabel).toContain('Elite');
  });

  /**
   * The distinction the split exists for: the tab is kept, and the two equity
   * panels inside it are not. A single `showFinancials` could only say "all
   * three or none", so keeping the signal would have dragged analyst targets and
   * P/E onto a page about a metal.
   */
  it('keeps the Financials tab for the signal while withholding what is in it for a stock', () => {
    const policy = resolveAssetPresentationPolicy('commodity');
    expect(policy.showFinancials).toBe(true);
    expect(policy.showAnalystTargets).toBe(false);
    expect(policy.showKeyStatistics).toBe(false);
  });

  /** A 24/7 pair keeps the behaviour it had: no Financials tab at all. */
  it('leaves crypto without a Financials tab', () => {
    const policy = resolveAssetPresentationPolicy('crypto');
    expect(policy.showFinancials).toBe(false);
    expect(policy.showAnalystTargets).toBe(false);
    expect(policy.showKeyStatistics).toBe(false);
  });

  it('titles the profile card as a contract rather than a company', () => {
    expect(resolveCompanyProfileLabels('th', 'commodity').title).toBe('ข้อมูลสัญญาสินค้าโภคภัณฑ์');
    expect(resolveCompanyProfileLabels('en', 'commodity').title).toBe('Commodity Contract Profile');
  });

  /** Regression: the three kinds that already existed must be unchanged. */
  it('leaves stock, ETF and crypto classification exactly as it was', () => {
    expect(companyProfileKind('stock')).toBe('company');
    expect(companyProfileKind('etf')).toBe('fund');
    expect(companyProfileKind('crypto')).toBe('crypto');
    expect(companyProfileKind(null)).toBe('company');
    expect(companyProfileKind('anything-unknown')).toBe('company');
    const equity = resolveAssetPresentationPolicy('stock');
    expect(equity.showFinancials).toBe(true);
    expect(equity.showAnalystTargets).toBe(true);
    expect(equity.showKeyStatistics).toBe(true);
    expect(equity.showMarketCapitalization).toBe(true);
    expect(equity.showSectorAndIndustry).toBe(true);
    expect(equity.showOptionsAnalysis).toBe(true);
    const fund = resolveAssetPresentationPolicy('etf');
    expect(fund.showFinancials).toBe(true);
    expect(fund.showAnalystTargets).toBe(true);
    expect(fund.showKeyStatistics).toBe(true);
    expect(fund.showOptionsAnalysis).toBe(true);
  });

  it('keeps commodity and continuous as separate client paths', () => {
    expect(isCommodityAssetType('commodity')).toBe(true);
    expect(isCommodityAssetType('crypto')).toBe(false);
    // A commodity must NOT be picked up by the 24/7 path, or its weekend
    // disappears.
    expect(isContinuousAssetType('commodity')).toBe(false);
    expect(isContinuousAssetType('crypto')).toBe(true);
  });

  it('resolves the client session from the same Globex schedule as the server', () => {
    // Monday 10:00 CT.
    const open = resolveCommodityMarketSession(new Date('2026-08-17T15:00:00.000Z'));
    expect(open.session).toBe('REGULAR');
    expect(open.closeReason).toBeNull();
    expect(open.provider.source).toBe('commodity-market-globex');

    // Saturday — closed, and reported as a weekend rather than as 24/7 trading.
    const weekend = resolveCommodityMarketSession(new Date('2026-08-22T18:00:00.000Z'));
    expect(weekend.session).toBe('CLOSED');
    expect(weekend.closeReason).toBe('WEEKEND');

    // The daily halt.
    const halt = resolveCommodityMarketSession(new Date('2026-08-17T21:30:00.000Z'));
    expect(halt.session).toBe('CLOSED');
    expect(halt.closeReason).toBe('NORMAL');
  });

  it('does not throw on an invalid instant', () => {
    const result = resolveCommodityMarketSession(new Date('not-a-date'));
    expect(result.session).toBe('CLOSED');
    expect(result.evaluatedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
