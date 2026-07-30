import 'server-only';

import { createHash } from 'node:crypto';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
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

/**
 * Builds the compact OCC/OSI symbol used by the configured provider as a search
 * hint. The candidate is never accepted on its own: a provider catalogue row
 * must still exact-match all four identity fields before it becomes canonical.
 */
export function occOptionContractCandidate(identity: OptionContractIdentity): string | null {
  const normalized = normalizedIdentity(identity);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized.expirationDate);
  const strike = Number(normalized.strikePrice);
  const strikeMillis = Math.round(strike * 1_000);
  const root = normalized.underlyingSymbol.replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!date || !root || !Number.isFinite(strike) || strike <= 0
    || Math.abs(strike * 1_000 - strikeMillis) > 0.00000001
    || strikeMillis > 99_999_999) {
    return null;
  }
  const [, year, month, day] = date;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)) {
    return null;
  }
  const kind = normalized.optionKind === 'call' ? 'C' : 'P';
  return `${root}${year.slice(2)}${month}${day}${kind}${String(strikeMillis).padStart(8, '0')}`;
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

function exactMatches(chain: OptionsChain, identity: OptionContractIdentity): OptionContract[] {
  const expectedStrike = Number(identity.strikePrice);
  const contracts = identity.optionKind === 'call' ? chain.calls : chain.puts;
  return contracts.filter((contract) =>
    contract.underlyingSymbol.toUpperCase() === identity.underlyingSymbol
    && contract.type === identity.optionKind
    && contract.expiration === identity.expirationDate
    && Math.abs(contract.strike - expectedStrike) < 0.00000001);
}

export function findExactPortfolioOptionContract(
  chain: OptionsChain,
  identity: OptionContractIdentity,
  contractSymbol: string,
): OptionContract | null {
  const normalized = normalizedIdentity(identity);
  const symbol = contractSymbol.trim().toUpperCase();
  const matches = exactMatches(chain, normalized)
    .filter((contract) => contract.contractSymbol.trim().toUpperCase() === symbol);
  return matches.length === 1 ? matches[0] : null;
}

function officialMatch(chain: OptionsChain, identity: OptionContractIdentity): string | null {
  const matches = exactMatches(chain, identity);
  const symbols = [...new Set(matches.map((contract) => contract.contractSymbol.trim().toUpperCase()))]
    .filter((symbol) => portfolioContractSymbolSchema.safeParse(symbol).success);
  const candidate = occOptionContractCandidate(identity);
  if (candidate && symbols.includes(candidate)) return candidate;
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
  const currentStatus = current ? optionContractSymbolStatus(current) : 'unresolved';
  if (current && currentStatus === 'official') {
    return { contractSymbol: current, status: currentStatus };
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

  if (current && portfolioContractSymbolSchema.safeParse(current).success) {
    return { contractSymbol: current, status: currentStatus };
  }
  return {
    contractSymbol: deterministicUnresolvedOptionContractSymbol(normalized),
    status: 'unresolved',
  };
}
