import type { InstrumentClassification } from '@/src/lib/instruments/classification';

const SUPPORTED_EXCHANGES = new Set([
  'NASDAQ',
  'NYSE',
  'NYSE American',
  // SEC/Nasdaq catalogue market-category codes for Nasdaq Global/Capital.
  'G',
  'S',
]);

/**
 * Selects the authoritative US common-stock breadth universe from the generated
 * SEC/exchange catalogue. The classification pipeline has already removed
 * funds, warrants, units, preferred shares and duplicate company share classes;
 * these checks remain explicit here so breadth cannot silently widen later.
 */
export function selectMarketBreadthUniverse(
  instruments: readonly InstrumentClassification[],
): InstrumentClassification[] {
  const selected = new Map<string, InstrumentClassification>();
  for (const instrument of instruments) {
    const symbol = instrument.symbol.trim().toUpperCase();
    if (
      !symbol
      || selected.has(symbol)
      || instrument.assetType !== 'Stock'
      || instrument.verdict !== 'verified'
      || !instrument.rankingEligible
      || !SUPPORTED_EXCHANGES.has(instrument.exchange ?? '')
    ) continue;
    selected.set(symbol, instrument);
  }
  return [...selected.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
}

export const MARKET_BREADTH_UNIVERSE_DESCRIPTION =
  'หุ้นสามัญที่ยังใช้งานจาก NASDAQ, NYSE และ NYSE American ใน SEC/exchange catalogue; ไม่รวม ETF, fund, option, warrant, unit, preferred, OTC, delisted และ test symbols';
