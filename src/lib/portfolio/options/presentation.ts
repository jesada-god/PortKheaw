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

export function optionPositionMarketSymbol(position: Pick<OptionPositionLabelInput,
  'contractSymbol' | 'marketContractSymbol'>): string | null {
  const market = position.marketContractSymbol?.trim().toUpperCase() ?? '';
  if (market && optionContractSymbolStatus(market) === 'official') return market;
  const ledger = position.contractSymbol.trim().toUpperCase();
  return optionContractSymbolStatus(ledger) === 'official' ? ledger : null;
}
