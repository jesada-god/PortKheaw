import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from './catalog';
import {
  parseEquityToolHandoff,
  parseOptionToolHandoff,
  parseToolHandoff,
  toolHandoffHref,
  toolHandoffParams,
  toolsForAssetType,
  type EquityToolContext,
  type OptionToolContext,
} from './handoff';

/*
 * Which tool an asset may reach, and what it may carry there.
 *
 * Two failures are being prevented and they are not the same failure. The
 * routing one is a reader problem: a beginner holding SPY should never be shown
 * a form asking for a strike, and a beginner holding an ASTS Put should never be
 * shown one that reads their $73 strike as a share price. The parsing one is a
 * trust problem: everything here arrives as a URL, so nothing that arrives may
 * be believed without being checked, and nothing that arrives may decide
 * anything but which boxes are prefilled.
 */

const OPTION: OptionToolContext = {
  type: 'option',
  symbol: 'ASTS',
  optionKind: 'put',
  side: 'long',
  strike: 73,
  expiration: '2026-08-28',
  contracts: 1,
  multiplier: 100,
  premium: 4.25,
  mark: 5.1,
  underlyingPrice: 60.5,
  impliedVolatility: 0.82,
  contractSymbol: 'ASTS260828P00073000',
  portfolioId: '11111111-1111-4111-8111-111111111111',
};

const EQUITY: EquityToolContext = {
  type: 'stock',
  symbol: 'AAPL',
  quantity: 25,
  averageCost: 180.25,
  price: 210,
  marketValue: 5_250,
  unrealizedGain: 743.75,
  portfolioId: '22222222-2222-4222-8222-222222222222',
};

function roundTrip(context: OptionToolContext | EquityToolContext) {
  return parseToolHandoff(new URLSearchParams(toolHandoffParams(context).toString()));
}

describe('which tools an asset type may reach', () => {
  it('sends an option to the two option simulators and nowhere else', () => {
    const ids = toolsForAssetType('option').map((tool) => tool.id);
    expect(ids).toEqual(['what-if', 'monte-carlo']);
    expect(ids).not.toContain('stock-planner');
  });

  it('sends a stock and an ETF to the Stock Planner and nowhere else', () => {
    for (const type of ['stock', 'etf'] as const) {
      const ids = toolsForAssetType(type).map((tool) => tool.id);
      expect(ids).toEqual(['stock-planner']);
      expect(ids).not.toContain('what-if');
      expect(ids).not.toContain('monte-carlo');
    }
  });

  it('refuses to build a link from an asset to a tool that cannot read it', () => {
    const planner = TOOL_CATALOG.find((tool) => tool.id === 'stock-planner')!;
    const whatIf = TOOL_CATALOG.find((tool) => tool.id === 'what-if')!;
    expect(toolHandoffHref(planner, OPTION)).toBeNull();
    expect(toolHandoffHref(whatIf, EQUITY)).toBeNull();
    expect(toolHandoffHref(whatIf, OPTION)).toMatch(/^\/tools\/what-if\?/);
    expect(toolHandoffHref(planner, EQUITY)).toMatch(/^\/tools\/stock-planner\?/);
  });

  /*
   * The routing rule is derived from the catalog's own scope rather than a
   * second list here, so a tool cannot change what instrument it is for without
   * changing where it is offered.
   */
  it('derives the rule from the catalog, so the two cannot drift apart', () => {
    for (const tool of TOOL_CATALOG) {
      const reachable = tool.assetScope === 'options'
        ? toolsForAssetType('option')
        : toolsForAssetType('stock');
      expect(reachable).toContain(tool);
    }
  });
});

describe('what survives a trip through the URL', () => {
  it('carries every field the option simulators prefill from', () => {
    expect(roundTrip(OPTION)).toEqual(OPTION);
  });

  it('carries every field the planner prefills from, for a stock and an ETF alike', () => {
    expect(roundTrip(EQUITY)).toEqual(EQUITY);
    const etf = { ...EQUITY, type: 'etf' as const, symbol: 'SPY' };
    expect(roundTrip(etf)).toEqual(etf);
  });

  it('keeps a negative unrealized loss, which is a real number and not a missing one', () => {
    const losing = { ...EQUITY, unrealizedGain: -412.5 };
    expect(roundTrip(losing)).toEqual(losing);
  });
});

describe('what a malformed or hostile URL can do', () => {
  it('produces nothing at all rather than a half-filled context', () => {
    const cases = [
      'from=portfolio&type=option&symbol=ASTS',
      'from=portfolio&type=option&symbol=ASTS&optionKind=put&side=long&strike=abc&expiration=2026-08-28&contracts=1',
      'from=portfolio&type=option&symbol=ASTS&optionKind=put&side=long&strike=73&expiration=not-a-date&contracts=1',
      'from=portfolio&type=option&symbol=ASTS&optionKind=swap&side=long&strike=73&expiration=2026-08-28&contracts=1',
      'from=portfolio&type=stock&symbol=AAPL&quantity=-5',
      'from=portfolio&type=bond&symbol=AAPL&quantity=5',
      'from=portfolio&symbol=AAPL&quantity=5',
      'type=option&symbol=ASTS&optionKind=put&side=long&strike=73&expiration=2026-08-28&contracts=1&multiplier=100&premium=1',
    ];
    for (const query of cases) {
      expect(parseToolHandoff(new URLSearchParams(query))).toBeNull();
    }
  });

  /*
   * The discriminator is the guard. A stock context cannot be read as an option
   * one no matter what else the URL says, so no query parameter can turn shares
   * into a contract or a contract into shares.
   */
  it('cannot turn one asset type into the other', () => {
    const optionParams = toolHandoffParams(OPTION);
    expect(parseEquityToolHandoff(optionParams)).toBeNull();
    expect(parseOptionToolHandoff(optionParams)).not.toBeNull();

    const equityParams = toolHandoffParams(EQUITY);
    expect(parseOptionToolHandoff(equityParams)).toBeNull();
    expect(parseEquityToolHandoff(equityParams)).not.toBeNull();

    // Even an equity URL wearing every option field a caller could bolt on.
    const disguised = new URLSearchParams(equityParams.toString());
    disguised.set('optionKind', 'call');
    disguised.set('strike', '73');
    disguised.set('expiration', '2026-08-28');
    disguised.set('contracts', '1');
    expect(parseOptionToolHandoff(disguised)).toBeNull();
  });

  /*
   * The context prefills inputs and nothing else. There is deliberately no tier,
   * no capability and no entitlement flag in it — the compute routes and the
   * planner's own server page decide access, so there is nothing here to forge.
   */
  it('carries no entitlement of any kind to forge', () => {
    const keys = [...toolHandoffParams(OPTION).keys(), ...toolHandoffParams(EQUITY).keys()];
    for (const forbidden of ['tier', 'capability', 'plan', 'entitlement', 'unlock', 'access']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
