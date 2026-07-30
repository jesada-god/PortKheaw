import 'server-only';

import type { PortfolioTransaction } from './types';
import type { TransactionInput } from './validation';
import {
  resolvePortfolioOptionContractSymbol,
  type OptionChainLoader,
  type OptionContractIdentity,
} from './options/contract-symbol';

const OPTION_TYPES = new Set([
  'buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close', 'exercise', 'assignment', 'expired',
]);

function isOptionInput(input: TransactionInput) {
  return OPTION_TYPES.has(input.type);
}

function optionIdentity(input: TransactionInput): OptionContractIdentity {
  return {
    underlyingSymbol: input.underlyingSymbol!,
    optionKind: input.optionKind!,
    strikePrice: input.strikePrice!,
    expirationDate: input.expirationDate!,
  };
}

function sameOptionIdentity(input: TransactionInput, existing: PortfolioTransaction): boolean {
  return input.underlyingSymbol?.trim().toUpperCase() === existing.underlyingSymbol?.trim().toUpperCase()
    && input.optionKind === existing.optionKind
    && Number(input.strikePrice) === Number(existing.strikePrice)
    && input.expirationDate === existing.expirationDate;
}

export async function preparePortfolioTransactionForCreate(
  input: TransactionInput,
  loadChain?: OptionChainLoader,
): Promise<TransactionInput> {
  const prepared = { ...input, broker: '' };
  if (!isOptionInput(prepared)) return prepared;
  // A hidden symbol is supplied only by a follow-up action from an existing
  // position. Preserve that ledger identity so closes and targets stay attached;
  // canonical market resolution happens independently in the read pipeline.
  if (prepared.contractSymbol?.trim()) return prepared;
  const resolution = await resolvePortfolioOptionContractSymbol(
    optionIdentity(prepared),
    undefined,
    loadChain,
  );
  return { ...prepared, contractSymbol: resolution.contractSymbol };
}

export async function preparePortfolioTransactionForUpdate(
  input: TransactionInput,
  existing: PortfolioTransaction,
  loadChain?: OptionChainLoader,
): Promise<TransactionInput> {
  const prepared = { ...input, broker: existing.broker ?? '' };
  if (!isOptionInput(prepared)) return prepared;
  if (sameOptionIdentity(prepared, existing) && existing.contractSymbol) {
    return { ...prepared, contractSymbol: existing.contractSymbol };
  }
  const resolution = await resolvePortfolioOptionContractSymbol(
    optionIdentity(prepared),
    undefined,
    loadChain,
  );
  return { ...prepared, contractSymbol: resolution.contractSymbol };
}
