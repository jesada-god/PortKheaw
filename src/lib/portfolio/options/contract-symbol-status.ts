export const UNRESOLVED_OPTION_CONTRACT_PREFIX = 'UNRESOLVED-';
export const LEGACY_OPTION_CONTRACT_PREFIX = 'LEGACY-';

export type OptionContractSymbolStatus = 'official' | 'unresolved' | 'legacy';

export function optionContractSymbolStatus(contractSymbol: string): OptionContractSymbolStatus {
  const normalized = contractSymbol.trim().toUpperCase();
  if (normalized.startsWith(UNRESOLVED_OPTION_CONTRACT_PREFIX)) return 'unresolved';
  if (normalized.startsWith(LEGACY_OPTION_CONTRACT_PREFIX)) return 'legacy';
  return 'official';
}

export function isUnresolvedOptionContractSymbol(contractSymbol: string): boolean {
  return optionContractSymbolStatus(contractSymbol) === 'unresolved';
}

export function isInternalOptionContractSymbol(contractSymbol: string): boolean {
  return optionContractSymbolStatus(contractSymbol) !== 'official';
}
