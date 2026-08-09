import { optionContractSymbolStatus } from './contract-symbol-status';

interface OptionPositionLabelInput {
  underlyingSymbol: string;
  contractSymbol: string;
  marketContractSymbol: string | null;
  optionKind: 'call' | 'put';
  strikePrice: number;
  expirationDate: string;
  contracts: number;
}

export const UNMATCHED_OPTION_MESSAGE = 'ยังจับคู่สัญญากับข้อมูลตลาดไม่ได้';

export function optionPositionTitle(position: Pick<OptionPositionLabelInput,
  'underlyingSymbol' | 'optionKind' | 'strikePrice'>): string {
  return `${position.underlyingSymbol} ${position.optionKind.toUpperCase()} $${position.strikePrice}`;
}

export function optionPositionDescription(position: Pick<OptionPositionLabelInput,
  'expirationDate' | 'contracts'>): string {
  const date = new Date(`${position.expirationDate}T00:00:00.000Z`);
  const expiration = Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('th-TH', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date)
    : position.expirationDate;
  return `หมดอายุ ${expiration} · ${position.contracts} สัญญา`;
}

export type OptionMoneyness = 'ITM' | 'ATM' | 'OTM';

/**
 * Where the underlying is trading relative to the strike, and `null` whenever
 * that cannot be answered.
 *
 * Presentation only: it reads the underlying price the quote pipeline already
 * attached to the position and compares it with the strike. It never guesses at
 * a missing underlying — an unpriced contract shows no badge rather than a
 * confident "OTM" nobody can check. The 0.5% band around the strike is what
 * "at the money" means on the screen; nothing downstream of it is a valuation.
 */
export function optionPositionMoneyness(position: Pick<OptionPositionLabelInput,
  'optionKind' | 'strikePrice'> & { underlyingPrice: number | null }): OptionMoneyness | null {
  const { underlyingPrice, strikePrice } = position;
  if (underlyingPrice === null || !Number.isFinite(underlyingPrice)) return null;
  if (!Number.isFinite(strikePrice) || strikePrice <= 0) return null;
  const distance = (underlyingPrice - strikePrice) / strikePrice;
  if (Math.abs(distance) <= 0.005) return 'ATM';
  const inTheMoney = position.optionKind === 'call' ? distance > 0 : distance < 0;
  return inTheMoney ? 'ITM' : 'OTM';
}

export function optionPositionMarketSymbol(position: Pick<OptionPositionLabelInput,
  'contractSymbol' | 'marketContractSymbol'>): string | null {
  const market = position.marketContractSymbol?.trim().toUpperCase() ?? '';
  if (market && optionContractSymbolStatus(market) === 'official') return market;
  const ledger = position.contractSymbol.trim().toUpperCase();
  return optionContractSymbolStatus(ledger) === 'official' ? ledger : null;
}
