import { describe, expect, it } from 'vitest';
import {
  COMMODITY_CONTRACTS,
  commodityContract,
  isCommoditySymbol,
  toProviderSymbol,
} from './commodities';
import { symbolSchema } from './validation';

describe('commodity contract registry', () => {
  it('names the contract, its venue and its unit for each of the three cards', () => {
    expect(COMMODITY_CONTRACTS).toEqual([
      expect.objectContaining({
        symbol: 'GC-F', providerSymbol: 'GC=F', nameTh: 'ทองคำ',
        exchange: 'COMEX', unitTh: 'ดอลลาร์ต่อทรอยออนซ์',
      }),
      expect.objectContaining({
        symbol: 'SI-F', providerSymbol: 'SI=F', nameTh: 'เงิน',
        exchange: 'COMEX', unitTh: 'ดอลลาร์ต่อทรอยออนซ์',
      }),
      expect.objectContaining({
        symbol: 'CL-F', providerSymbol: 'CL=F', nameTh: 'น้ำมัน WTI',
        exchange: 'NYMEX', unitTh: 'ดอลลาร์ต่อบาร์เรล',
      }),
    ]);
  });

  /**
   * The whole reason the app spells a future `GC-F` instead of `GC=F`: the shared
   * symbol grammar is untouched by this feature, so it has to already accept
   * every canonical commodity symbol.
   */
  it('uses only symbols the shared grammar already accepts', () => {
    for (const contract of COMMODITY_CONTRACTS) {
      expect(symbolSchema.safeParse(contract.symbol).success).toBe(true);
    }
    // And the provider spelling is exactly what that grammar rejects, which is
    // why the translation has to exist at all.
    for (const contract of COMMODITY_CONTRACTS) {
      expect(symbolSchema.safeParse(contract.providerSymbol).success).toBe(false);
    }
  });

  it('resolves a contract case-insensitively and with surrounding space', () => {
    expect(commodityContract(' gc-f ')?.nameTh).toBe('ทองคำ');
    expect(isCommoditySymbol('cl-f')).toBe(true);
  });

  it('translates only a registered contract and leaves every other symbol alone', () => {
    expect(toProviderSymbol('GC-F')).toBe('GC=F');
    expect(toProviderSymbol('SI-F')).toBe('SI=F');
    expect(toProviderSymbol('CL-F')).toBe('CL=F');
    // The regression this gating exists for: an equity, an ETF, a crypto pair and
    // an index must reach the provider exactly as asked for.
    for (const symbol of ['AAPL', 'SPY', 'GLD', 'BTC-USD', '^GSPC', 'BRK.B']) {
      expect(toProviderSymbol(symbol)).toBe(symbol);
    }
  });

  /**
   * A listed ticker really can end in `-F`, so the rewrite must be registry-gated
   * rather than a blanket suffix swap — otherwise an equity request would be
   * silently pointed at a futures contract.
   */
  it('does not rewrite an unregistered symbol that merely ends in -F', () => {
    expect(toProviderSymbol('ZZ-F')).toBe('ZZ-F');
    expect(commodityContract('ZZ-F')).toBeNull();
  });

  it('does not collide with a real listed ticker', () => {
    // WTI is W&T Offshore, GOLD is Gold.com, CL is Colgate-Palmolive, SI is
    // Shoulder Innovations — none of them may be shadowed by a commodity card.
    for (const listed of ['WTI', 'GOLD', 'CL', 'SI', 'GLD', 'SLV', 'USO']) {
      expect(isCommoditySymbol(listed)).toBe(false);
    }
  });
});
