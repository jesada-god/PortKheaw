import {
  fixed,
  fixedDivide,
  fixedMultiply,
  fixedPercent,
  fixedToNumber,
  type Fixed,
} from '../../money/fixed';
import type { MarketSession } from '@/src/lib/market-data/market-session';
import {
  combineDayChangeSources,
  resolveDayChangeBasis,
  type DayChangeBasis,
} from '../day-change';
import type { OptionSide, PortfolioTransaction } from '../types';
import type {
  OptionLedgerSummary,
  OptionPositionSummary,
  OptionQuoteInput,
  OptionTargetCalculation,
  OptionTargetMode,
} from './types';

function ordered(transactions: PortfolioTransaction[]) {
  return [...transactions].sort((left, right) =>
    (left.occurredAtTime ?? left.occurredAt).localeCompare(right.occurredAtTime ?? right.occurredAt)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id));
}

/**
 * A transfer leg carrying a contract, as opposed to one carrying cash or shares.
 * The contract identity is what makes it an option event at all.
 */
function isOptionTransferLeg(transaction: PortfolioTransaction) {
  return (transaction.type === 'transfer_in' || transaction.type === 'transfer_out')
    && Boolean(transaction.contractSymbol);
}

function isOptionTransaction(transaction: PortfolioTransaction) {
  return transaction.type === 'buy_to_open'
    || transaction.type === 'sell_to_close'
    || transaction.type === 'sell_to_open'
    || transaction.type === 'buy_to_close'
    || transaction.type === 'exercise'
    || transaction.type === 'assignment'
    || transaction.type === 'expired'
    || isOptionTransferLeg(transaction);
}

function transactionSide(transaction: PortfolioTransaction): OptionSide {
  if (transaction.type === 'buy_to_open' || transaction.type === 'sell_to_close' || transaction.type === 'exercise') return 'long';
  if (transaction.type === 'sell_to_open' || transaction.type === 'buy_to_close' || transaction.type === 'assignment') return 'short';
  // Expired and transfer legs both state their side on the row, because neither
  // can be inferred from the verb: either side can expire, and either side can
  // be moved.
  if (transaction.optionSide) return transaction.optionSide;
  throw new Error(`${transaction.type} option transaction requires an option side`);
}

export function optionPositionKey(transaction: Pick<PortfolioTransaction,
  'contractSymbol' | 'underlyingSymbol' | 'expirationDate' | 'optionKind' | 'strikePrice' | 'multiplier'>): string {
  if (transaction.contractSymbol) return transaction.contractSymbol.toUpperCase();
  return [
    transaction.underlyingSymbol?.toUpperCase(),
    transaction.expirationDate,
    transaction.optionKind,
    transaction.strikePrice,
    transaction.multiplier ?? '100',
  ].join(':');
}

interface OptionState {
  key: string;
  underlyingSymbol: string;
  contractSymbol: string;
  optionKind: 'call' | 'put';
  side: OptionSide;
  strikePrice: Fixed;
  expirationDate: string;
  multiplier: Fixed;
  contracts: Fixed;
  openingPremiumValue: Fixed;
  remainingCost: Fixed;
  realizedGain: Fixed;
  transactions: PortfolioTransaction[];
}

function money(transaction: PortfolioTransaction, field: 'price' | 'fee'): Fixed {
  if (field === 'price') return fixed(transaction.normalizedPriceUsd ?? transaction.price);
  return fixed(transaction.normalizedFeeUsd ?? transaction.fee);
}

function proportional(value: Fixed, removed: Fixed, available: Fixed): Fixed {
  if (removed === available) return value;
  const product = value * removed;
  return (product + (product >= 0n ? available / 2n : -(available / 2n))) / available;
}

function requireOptionIdentity(transaction: PortfolioTransaction) {
  if (!transaction.underlyingSymbol || !transaction.optionKind || !transaction.strikePrice || !transaction.expirationDate) {
    throw new Error('Option transaction requires underlying, type, strike and expiration');
  }
}

/**
 * Replays every option event from the immutable transaction ledger.
 *
 * Long opening costs and short opening credits include fees, so partial closes
 * retain their correct proportional basis. No Position row is read or mutated.
 */
export function calculateOptionLedger(
  transactions: PortfolioTransaction[],
  quotes: Record<string, OptionQuoteInput | null> = {},
  today = new Date().toISOString().slice(0, 10),
  /*
    Which prices the day figure is allowed to be the difference of. Defaults to
    OPEN so every existing caller — the cash-balance readers, the transfer
    preview, the purchase service — keeps the live behaviour it had before this
    parameter existed and does not have to learn about sessions to ask for a
    cash balance.
  */
  session: MarketSession = 'OPEN',
): OptionLedgerSummary {
  const states = new Map<string, OptionState>();
  let cashFlow = 0n;

  for (const transaction of ordered(transactions)) {
    if (!isOptionTransaction(transaction)) continue;
    requireOptionIdentity(transaction);
    const key = optionPositionKey(transaction);
    const side = transactionSide(transaction);
    const quantity = fixed(transaction.quantity);
    const multiplier = fixed(transaction.multiplier ?? '100');
    const premium = money(transaction, 'price');
    const fee = money(transaction, 'fee');
    const gross = fixedMultiply(fixedMultiply(quantity, multiplier), premium);
    const existing = states.get(key);
    const state: OptionState = existing ?? {
      key,
      underlyingSymbol: transaction.underlyingSymbol!,
      contractSymbol: transaction.contractSymbol ?? key,
      optionKind: transaction.optionKind!,
      side,
      strikePrice: fixed(transaction.strikePrice),
      expirationDate: transaction.expirationDate!,
      multiplier,
      contracts: 0n,
      openingPremiumValue: 0n,
      remainingCost: 0n,
      realizedGain: 0n,
      transactions: [],
    };
    if (state.side !== side && state.contracts !== 0n) throw new Error(`Cannot mix long and short option lots for ${key}`);
    state.side = side;
    state.transactions.push(transaction);

    if (isOptionTransferLeg(transaction)) {
      /*
       * Moving contracts, not trading them.
       *
       * Two quantities travel with the position and both have to, because each
       * answers a different question the destination will be asked. The remaining
       * cost is what the position is *worth having paid* — it drives unrealized
       * gain — and it is carried exactly, from the row, so the two ledgers agree
       * to the last unit. The opening premium value is what the position was
       * *entered at* — it drives the average premium and the breakeven — and it
       * is rebuilt from the unit price the row states. Carrying only the cost
       * would leave the destination with a correct P&L and a breakeven of zero.
       */
      const movedCost = fixed(transaction.transferCostBasisUsd);
      if (transaction.type === 'transfer_in') {
        state.contracts += quantity;
        state.openingPremiumValue += gross;
        state.remainingCost += movedCost;
      } else {
        if (quantity > state.contracts) throw new Error(`Option transfer exceeds available contracts for ${key}`);
        const removedPremium = proportional(state.openingPremiumValue, quantity, state.contracts);
        state.contracts -= quantity;
        state.openingPremiumValue -= removedPremium;
        state.remainingCost -= movedCost;
      }
      states.set(key, state);
      continue;
    }

    if (transaction.type === 'buy_to_open' || transaction.type === 'sell_to_open') {
      const netOpening = transaction.type === 'buy_to_open' ? gross + fee : gross - fee;
      state.contracts += quantity;
      state.openingPremiumValue += gross;
      state.remainingCost += netOpening;
      cashFlow += transaction.type === 'buy_to_open' ? -gross - fee : gross - fee;
    } else {
      if (quantity > state.contracts) throw new Error(`Option close exceeds available contracts for ${key}`);
      const removedCost = proportional(state.remainingCost, quantity, state.contracts);
      const removedPremium = proportional(state.openingPremiumValue, quantity, state.contracts);
      if (transaction.type === 'sell_to_close') {
        const proceeds = gross - fee;
        cashFlow += proceeds;
        state.realizedGain += proceeds - removedCost;
      } else if (transaction.type === 'buy_to_close') {
        const closeCost = gross + fee;
        cashFlow -= closeCost;
        state.realizedGain += removedCost - closeCost;
      } else if (transaction.type === 'exercise') {
        state.realizedGain -= removedCost;
      } else if (transaction.type === 'assignment') {
        state.realizedGain += removedCost;
      } else if (transaction.type === 'expired') {
        state.realizedGain += side === 'long' ? -removedCost : removedCost;
      }
      state.contracts -= quantity;
      state.remainingCost -= removedCost;
      state.openingPremiumValue -= removedPremium;
    }
    states.set(key, state);
  }

  let totalMarketValue = 0n;
  let totalUnrealized = 0n;
  let totalToday = 0n;
  let remainingCost = 0n;
  let hasMissingPrices = false;
  let hasMissingToday = false;
  const positions: OptionPositionSummary[] = [];
  const dayBases: (DayChangeBasis | null)[] = [];

  for (const state of states.values()) {
    const quantity = state.contracts;
    const units = fixedMultiply(quantity, state.multiplier);
    const expired = quantity > 0n && calculateDte(state.expirationDate, today) < 0;
    const status = quantity === 0n ? 'closed' as const : expired ? 'expired' as const : 'open' as const;
    const quote = quotes[state.key] ?? null;
    const missing = status === 'open' && (!quote || quote.mark === null || (state.side === 'short' && quote.ask === null));
    const valuationPrice = status !== 'open'
      ? fixed(0)
      : missing
        ? null
        : fixed(state.side === 'short' ? quote!.ask : quote!.mark);
    const signedMarketValue = valuationPrice === null
      ? null
      : state.side === 'long'
        ? fixedMultiply(units, valuationPrice)
        : -fixedMultiply(units, valuationPrice);
    const unrealized = signedMarketValue === null
      ? null
      : state.side === 'long'
        ? signedMarketValue - state.remainingCost
        : state.remainingCost + signedMarketValue;
    /*
      A position that is closed or expired moved by zero today and has no basis
      to name — there is nothing left to reprice. Only an OPEN position asks
      where its two prices come from.
    */
    const dayBasis = status !== 'open' ? null : resolveDayChangeBasis({
      session,
      price: valuationPrice === null ? null : fixedToNumber(valuationPrice),
      previousClose: quote?.previousClose ?? null,
      snapshot: quote?.daySnapshot ?? null,
    });
    if (status === 'open') dayBases.push(dayBasis);
    const todayChange = status !== 'open'
      ? 0n
      : dayBasis === null
        ? null
        : (state.side === 'long' ? 1n : -1n)
          * fixedMultiply(units, fixed(dayBasis.close) - fixed(dayBasis.prevClose));
    const averagePremium = quantity === 0n
      ? state.transactions
        .filter((item) => item.type === 'buy_to_open' || item.type === 'sell_to_open')
        .reduce((sum, item) => sum + Number(item.normalizedPriceUsd ?? item.price ?? 0), 0)
        / Math.max(1, state.transactions.filter((item) => item.type === 'buy_to_open' || item.type === 'sell_to_open').length)
      : fixedToNumber(fixedDivide(state.openingPremiumValue, units));
    const estimatedClosePrice = status === 'open'
      ? state.side === 'long' ? quote?.bid ?? null : quote?.ask ?? null
      : status === 'expired' ? 0 : null;
    const estimatedCloseValue = estimatedClosePrice === null
      ? null
      : fixedToNumber(fixedMultiply(units, fixed(estimatedClosePrice)));

    if (quantity > 0n) remainingCost += state.remainingCost;
    if (signedMarketValue !== null) totalMarketValue += signedMarketValue;
    if (unrealized !== null) totalUnrealized += unrealized;
    if (todayChange !== null) totalToday += todayChange;
    if (missing) hasMissingPrices = true;
    if (todayChange === null) hasMissingToday = true;

    const average = Number.isFinite(averagePremium) ? averagePremium : 0;
    positions.push({
      key: state.key,
      underlyingSymbol: state.underlyingSymbol,
      contractSymbol: state.contractSymbol,
      marketContractSymbol: quote?.contractSymbol ?? null,
      optionKind: state.optionKind,
      side: state.side,
      strikePrice: fixedToNumber(state.strikePrice),
      expirationDate: state.expirationDate,
      contracts: fixedToNumber(quantity),
      multiplier: fixedToNumber(state.multiplier),
      averagePremium: average,
      remainingCost: fixedToNumber(state.remainingCost),
      realizedGain: fixedToNumber(state.realizedGain),
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      mark: status === 'expired' ? 0 : quote?.mark ?? null,
      estimatedClosePrice,
      marketValue: signedMarketValue === null ? null : fixedToNumber(signedMarketValue),
      estimatedCloseValue,
      todayChange: todayChange === null ? null : fixedToNumber(todayChange),
      todayChangeAsOf: dayBasis?.sessionDate ?? null,
      todayChangeSource: dayBasis?.source ?? null,
      unrealizedGain: unrealized === null ? null : fixedToNumber(unrealized),
      unrealizedGainPercent: unrealized === null ? null : fixedToNumber(fixedPercent(unrealized, state.remainingCost)),
      underlyingPrice: quote?.underlyingPrice ?? null,
      breakeven: fixedToNumber(state.strikePrice) + (state.optionKind === 'call' ? average : -average),
      dte: Math.max(0, calculateDte(state.expirationDate, today)),
      impliedVolatility: quote?.impliedVolatility ?? null,
      delta: quote?.delta ?? null,
      theta: quote?.theta ?? null,
      status,
      quoteSource: quote?.source ?? null,
      quoteAsOf: quote?.asOf ?? null,
      quoteFreshness: status === 'expired' ? 'missing' : quote?.freshness ?? 'missing',
      transactions: state.transactions,
    });
  }

  positions.sort((left, right) =>
    Number(right.status === 'open') - Number(left.status === 'open')
    || left.expirationDate.localeCompare(right.expirationDate)
    || left.contractSymbol.localeCompare(right.contractSymbol));
  const realizedGain = [...states.values()].reduce((sum, state) => sum + state.realizedGain, 0n);
  return {
    positions,
    cashFlow: fixedToNumber(cashFlow),
    realizedGain: fixedToNumber(realizedGain),
    unrealizedGain: hasMissingPrices ? null : fixedToNumber(totalUnrealized),
    marketValue: hasMissingPrices ? null : fixedToNumber(totalMarketValue),
    remainingCost: fixedToNumber(remainingCost),
    todayChange: hasMissingToday ? null : fixedToNumber(totalToday),
    ...(() => {
      const combined = hasMissingToday ? null : combineDayChangeSources(dayBases);
      return {
        todayChangeAsOf: combined?.sessionDate ?? null,
        todayChangeSource: combined?.source ?? null,
      };
    })(),
    hasMissingPrices,
  };
}

export function calculateOptionTarget(
  position: Pick<OptionPositionSummary, 'side' | 'contracts' | 'multiplier' | 'remainingCost' | 'mark'>,
  mode: OptionTargetMode,
  targetValue: number,
  estimatedFee = 0,
): OptionTargetCalculation {
  const units = position.contracts * position.multiplier;
  if (!Number.isFinite(units) || units <= 0) throw new Error('Target requires an open option position');
  if (!Number.isFinite(targetValue) || targetValue < 0 || !Number.isFinite(estimatedFee) || estimatedFee < 0) {
    throw new Error('Invalid option target');
  }
  const targetPremium = mode === 'premium'
    ? targetValue
    : position.side === 'long'
      ? (position.remainingCost * (1 + targetValue / 100) + estimatedFee) / units
      : Math.max(0, (position.remainingCost * (1 - targetValue / 100) - estimatedFee) / units);
  const estimatedProceeds = position.side === 'long'
    ? targetPremium * units - estimatedFee
    : -(targetPremium * units + estimatedFee);
  const estimatedProfit = position.side === 'long'
    ? estimatedProceeds - position.remainingCost
    : position.remainingCost + estimatedProceeds;
  const current = position.mark;
  return {
    targetPremium,
    estimatedProceeds,
    estimatedProfit,
    estimatedProfitPercent: position.remainingCost === 0 ? 0 : estimatedProfit / position.remainingCost * 100,
    distanceFromCurrent: current === null ? null : targetPremium - current,
    distancePercent: current === null || current === 0 ? null : (targetPremium - current) / current * 100,
  };
}

/** Legacy helpers retained while the migration converts old Position rows. */
export function calculateOptionTotalCost(premiumPerShare: string, contracts: string): number {
  return fixedToNumber(fixedMultiply(fixedMultiply(fixed(premiumPerShare), fixed(contracts)), fixed(100)));
}

function utcDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function calculateDte(expirationDate: string, today = new Date().toISOString().slice(0, 10)): number {
  return Math.ceil((utcDay(expirationDate) - utcDay(today)) / 86_400_000);
}
