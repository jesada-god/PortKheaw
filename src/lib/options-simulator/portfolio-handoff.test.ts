import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OptionToolContext } from '@/src/lib/tools/handoff';
import { applyPortfolioOptionHandoff } from './portfolio-handoff';
import { seedWorkspace } from '@/src/components/options-simulator/SimulatorWorkspace';

/*
 * What a position brings with it when a reader taps "จำลองสถานการณ์".
 *
 * The whole point is that they do not retype a contract they already own — so
 * these assert the fields, not the shape. The premium one matters most: their
 * entry premium is their own average from the ledger, and prefilling today's ask
 * instead would answer "what if" about a position they never took.
 */

const CONTEXT: OptionToolContext = {
  type: 'option',
  symbol: 'ASTS',
  optionKind: 'put',
  side: 'long',
  strike: 73,
  expiration: '2026-08-28',
  contracts: 3,
  multiplier: 100,
  premium: 4.25,
  mark: 5.1,
  underlyingPrice: 60.5,
  impliedVolatility: 0.82,
  contractSymbol: 'ASTS260828P00073000',
  portfolioId: '11111111-1111-4111-8111-111111111111',
};

describe('a portfolio option opened in the simulator', () => {
  it('arrives with the whole contract already filled in', () => {
    const workspace = applyPortfolioOptionHandoff(seedWorkspace('what-if'), CONTEXT, '2026-08-14');
    expect(workspace).not.toBeNull();
    const leg = workspace!.legs[0];
    expect(workspace!.symbol).toBe('ASTS');
    expect(workspace!.underlyingPrice).toBe(60.5);
    expect(workspace!.legs).toHaveLength(1);
    expect(leg.kind).toBe('put');
    expect(leg.strike).toBe(73);
    expect(leg.expiration).toBe('2026-08-28');
    expect(leg.quantity).toBe(3);
    expect(leg.multiplier).toBe(100);
    expect(leg.entryPremium).toBe(4.25);
    expect(leg.impliedVolatility).toBe(0.82);
    expect(leg.contractSymbol).toBe('ASTS260828P00073000');
    expect(leg.mark).toBe(5.1);
  });

  it('reads a long position as bought and a short one as sold', () => {
    expect(applyPortfolioOptionHandoff(seedWorkspace('what-if'), CONTEXT, '2026-08-14')!.legs[0].side).toBe('buy');
    const short = applyPortfolioOptionHandoff(seedWorkspace('what-if'), { ...CONTEXT, side: 'short' }, '2026-08-14');
    expect(short!.legs[0].side).toBe('sell');
    expect(short!.strategyType).toBe('Short Put');
  });

  it('names the ledger as the source rather than a market provider that supplied none of it', () => {
    const workspace = applyPortfolioOptionHandoff(seedWorkspace('monte-carlo'), CONTEXT, '2026-08-14')!;
    expect(workspace.dataSource).toBe('portfolio-ledger');
    expect(workspace.dataStatus).toBe('manual');
    expect(workspace.id).toBeUndefined();
    expect(workspace.resultSnapshot).toBeNull();
  });

  it('opens the scenario inside the contract’s own window', () => {
    const workspace = applyPortfolioOptionHandoff(seedWorkspace('what-if'), CONTEXT, '2026-08-14')!;
    expect(workspace.valuationDate).toBe('2026-08-14');
    expect(workspace.scenarios[0].valuationDate > workspace.valuationDate).toBe(true);
    expect(workspace.scenarios[0].valuationDate <= CONTEXT.expiration).toBe(true);
    expect(workspace.scenarios[0].targetPrice).toBe(60.5);
    expect(workspace.monteCarlo.volatility).toBe(0.82);
    expect(workspace.monteCarlo.horizonDays).toBeGreaterThan(0);
  });

  it('leaves an unknown IV at zero rather than inventing one', () => {
    const workspace = applyPortfolioOptionHandoff(
      seedWorkspace('what-if'),
      { ...CONTEXT, impliedVolatility: null },
      '2026-08-14',
    )!;
    // Zero is the "still missing" signal the inputs form and the calculation
    // schemas already refuse — never a number presented as real.
    expect(workspace.legs[0].impliedVolatility).toBe(0);
  });

  it('refuses a contract that cannot be valued, instead of opening a broken workspace', () => {
    for (const today of ['2026-08-28', '2026-09-01', '']) {
      expect(applyPortfolioOptionHandoff(seedWorkspace('what-if'), CONTEXT, today)).toBeNull();
    }
  });
});

describe('how the workspace picks the handoff up', () => {
  const workspace = readFileSync(
    resolve(process.cwd(), 'src/components/options-simulator/SimulatorWorkspace.tsx'),
    'utf8',
  );

  it('validates the URL before believing any of it', () => {
    expect(workspace).toContain('parseOptionToolHandoff(new URLSearchParams(search))');
    expect(workspace).toContain('applyPortfolioOptionHandoff');
    // A refused or malformed handoff falls back to the workspace as it was.
    expect(workspace).toContain('return prefilled ? normalizeUiWorkspace(prefilled, today) : base');
  });

  /*
   * A reader who tapped "จำลองสถานการณ์" on a position asked for THAT contract.
   * Restoring the draft they left behind last week would answer a different
   * question under the position's own name.
   */
  it('lets the position win over a saved draft', () => {
    expect(workspace).toContain("new URLSearchParams(search).has('contract') || hasToolHandoff(search)");
    expect(workspace).toContain('const draft = importing ? null : localStorage.getItem');
  });

  it('goes nowhere near the network for it', () => {
    const effect = workspace.slice(workspace.indexOf('const handoff = parseOptionToolHandoff'), workspace.indexOf('hydrated.current = true'));
    expect(effect).not.toContain('fetch(');
  });
});
