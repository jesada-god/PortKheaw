import 'server-only';

import { createHash } from 'node:crypto';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { portfolioContractSymbolSchema } from '../validation';
import {
  UNRESOLVED_OPTION_CONTRACT_PREFIX,
  optionContractSymbolStatus,
  type OptionContractSymbolStatus,
} from './contract-symbol-status';

export interface OptionContractIdentity {
  underlyingSymbol: string;
  optionKind: 'call' | 'put';
  strikePrice: string;
  expirationDate: string;
}

export interface ResolvedOptionContractSymbol {
  contractSymbol: string;
  status: OptionContractSymbolStatus;
}

export type OptionChainLoader = (underlyingSymbol: string, expirationDate: string) => Promise<OptionsChain>;

function normalizedIdentity(identity: OptionContractIdentity): OptionContractIdentity {
  const [integerPart, decimalPart = ''] = identity.strikePrice.trim().split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0';
  const decimal = decimalPart.replace(/0+$/, '');
  return {
    underlyingSymbol: identity.underlyingSymbol.trim().toUpperCase(),
    optionKind: identity.optionKind,
    strikePrice: decimal ? `${integer}.${decimal}` : integer,
    expirationDate: identity.expirationDate,
  };
}

export function deterministicUnresolvedOptionContractSymbol(identity: OptionContractIdentity): string {
  const normalized = normalizedIdentity(identity);
  const fingerprint = [
    normalized.underlyingSymbol,
    normalized.optionKind,
    normalized.strikePrice,
    normalized.expirationDate,
  ].join('|');
  const digest = createHash('sha256').update(fingerprint).digest('hex').slice(0, 32).toUpperCase();
  return `${UNRESOLVED_OPTION_CONTRACT_PREFIX}${digest}`;
}

async function loadOfficialChain(underlyingSymbol: string, expirationDate: string): Promise<OptionsChain> {
  return (await getOptionsMarketDataService().getChain(underlyingSymbol, expirationDate)).data;
}

function officialMatch(chain: OptionsChain, identity: OptionContractIdentity): string | null {
  const expectedStrike = Number(identity.strikePrice);
  const contracts = identity.optionKind === 'call' ? chain.calls : chain.puts;
  const matches = contracts.filter((contract) =>
    contract.underlyingSymbol.toUpperCase() === identity.underlyingSymbol
    && contract.type === identity.optionKind
    && contract.expiration === identity.expirationDate
    && Math.abs(contract.strike - expectedStrike) < 0.00000001);
  const symbols = [...new Set(matches.map((contract) => contract.contractSymbol.trim().toUpperCase()))]
    .filter((symbol) => portfolioContractSymbolSchema.safeParse(symbol).success);
  return symbols.length === 1 ? symbols[0] : null;
}

/**
 * Resolves identity only from the configured option-chain provider. When the
 * provider cannot prove a unique official contract, the ledger receives an
 * explicitly internal deterministic identifier instead of a fabricated OCC
 * symbol.
 */
export async function resolvePortfolioOptionContractSymbol(
  identity: OptionContractIdentity,
  currentContractSymbol?: string | null,
  loadChain: OptionChainLoader = loadOfficialChain,
): Promise<ResolvedOptionContractSymbol> {
  const normalized = normalizedIdentity(identity);
  const current = currentContractSymbol?.trim().toUpperCase() ?? '';
  if (current && optionContractSymbolStatus(current) !== 'unresolved') {
    return { contractSymbol: current, status: optionContractSymbolStatus(current) };
  }

  try {
    const official = officialMatch(
      await loadChain(normalized.underlyingSymbol, normalized.expirationDate),
      normalized,
    );
    if (official) return { contractSymbol: official, status: 'official' };
  } catch {
    // Historical entry remains saveable while the provider is unavailable.
  }

  const unresolved = current && portfolioContractSymbolSchema.safeParse(current).success
    ? current
    : deterministicUnresolvedOptionContractSymbol(normalized);
  return { contractSymbol: unresolved, status: 'unresolved' };
}
