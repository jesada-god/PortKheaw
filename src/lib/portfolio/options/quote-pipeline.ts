import 'server-only';

import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { validMidpoint } from '@/src/lib/market-data/quote-model';
import {
  findExactPortfolioOptionContract,
  resolvePortfolioOptionContractSymbol,
  type OptionChainLoader,
  type OptionContractIdentity,
} from './contract-symbol';
import type { OptionQuoteFreshness, OptionQuoteInput } from './types';

export interface PortfolioOptionQuotePosition {
  key: string;
  underlyingSymbol: string;
  contractSymbol: string;
  optionKind: 'call' | 'put';
  strikePrice: number;
  expirationDate: string;
}

function optionFreshness(status: string): OptionQuoteFreshness {
  if (status === 'live') return 'live';
  if (status === 'cached') return 'cached';
  if (status === 'stale') return 'stale';
  return 'delayed';
}

function identity(position: PortfolioOptionQuotePosition): OptionContractIdentity {
  return {
    underlyingSymbol: position.underlyingSymbol,
    optionKind: position.optionKind,
    strikePrice: String(position.strikePrice),
    expirationDate: position.expirationDate,
  };
}

function quoteFromChain(
  chain: OptionsChain,
  position: PortfolioOptionQuotePosition,
  canonicalSymbol: string,
): OptionQuoteInput | null {
  const contract = findExactPortfolioOptionContract(chain, identity(position), canonicalSymbol);
  if (!contract) return null;
  return {
    contractSymbol: canonicalSymbol,
    bid: contract.bid,
    ask: contract.ask,
    mark: contract.mark ?? validMidpoint(contract.bid, contract.ask),
    previousClose: null,
    underlyingPrice: chain.spot,
    impliedVolatility: contract.impliedVolatility,
    delta: contract.delta,
    theta: contract.theta,
    source: contract.marketDataProvider ?? contract.provider,
    asOf: contract.asOf,
    freshness: optionFreshness(contract.status),
  };
}

/**
 * Loads one cached/single-flighted provider chain per underlying+expiration,
 * resolves internal ledger identities against that catalogue, and keeps the
 * returned quote map keyed by the immutable ledger position key.
 */
export async function loadPortfolioOptionQuotes(
  positions: readonly PortfolioOptionQuotePosition[],
  loadChain?: OptionChainLoader,
): Promise<Record<string, OptionQuoteInput | null>> {
  const quotes: Record<string, OptionQuoteInput | null> = Object.fromEntries(
    positions.map((position) => [position.key, null]),
  );
  if (!loadChain) return quotes;

  const groups = new Map<string, PortfolioOptionQuotePosition[]>();
  for (const position of positions) {
    const key = `${position.underlyingSymbol.trim().toUpperCase()}:${position.expirationDate}`;
    groups.set(key, [...(groups.get(key) ?? []), position]);
  }

  await Promise.all([...groups.values()].map(async (group) => {
    const first = group[0];
    try {
      const chain = await loadChain(
        first.underlyingSymbol.trim().toUpperCase(),
        first.expirationDate,
      );
      await Promise.all(group.map(async (position) => {
        const resolution = await resolvePortfolioOptionContractSymbol(
          identity(position),
          position.contractSymbol,
          async () => chain,
        );
        if (resolution.status !== 'official') return;
        quotes[position.key] = quoteFromChain(chain, position, resolution.contractSymbol);
      }));
    } catch {
      // Null is deliberate: provider failure or no exact match must stay unavailable.
    }
  }));

  return quotes;
}
