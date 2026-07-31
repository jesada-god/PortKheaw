import {
  fixed as decimal,
  fixedDivide as divide,
  fixedMultiply as multiply,
  fixedPercent,
  fixedToNumber as number,
  type Fixed,
} from '../money/fixed';
import { calculateOptionLedger } from './options/calculations';
import type { OptionQuoteInput } from './options/types';
import type { HoldingLot, HoldingSummary, MarketPriceInput, PortfolioSummary, PortfolioTransaction } from './types';

function ordered(transactions: PortfolioTransaction[]) {
  return [...transactions].sort((left, right) =>
    (left.occurredAtTime ?? left.occurredAt).localeCompare(right.occurredAtTime ?? right.occurredAt)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id));
}

interface LotState {
  transactionId: string;
  occurredAt: string;
  originalQuantity: Fixed;
  remainingQuantity: Fixed;
  remainingCost: Fixed;
  fee: Fixed;
  broker: string | null;
}

interface HoldingState {
  quantity: Fixed;
  costBasis: Fixed;
  realizedGain: Fixed;
  lots: LotState[];
  transactions: PortfolioTransaction[];
}

function transactionPrice(transaction: PortfolioTransaction): Fixed {
  return decimal(transaction.normalizedPriceUsd ?? transaction.price);
}

function transactionFee(transaction: PortfolioTransaction): Fixed {
  return decimal(transaction.normalizedFeeUsd ?? transaction.fee);
}

function transactionAmount(transaction: PortfolioTransaction): Fixed {
  return decimal(transaction.normalizedAmountUsd ?? transaction.amount);
}

function proportional(value: Fixed, removed: Fixed, available: Fixed): Fixed {
  if (removed === available) return value;
  const product = value * removed;
  return (product + (product >= 0n ? available / 2n : -(available / 2n))) / available;
}

function reduceLots(lots: LotState[], removedQuantity: Fixed, availableQuantity: Fixed, removedCost: Fixed) {
  let quantityLeft = removedQuantity;
  let costLeft = removedCost;
  const active = lots.filter((lot) => lot.remainingQuantity > 0n);
  active.forEach((lot, index) => {
    const last = index === active.length - 1;
    const quantityPart = last ? quantityLeft : proportional(lot.remainingQuantity, removedQuantity, availableQuantity);
    const costPart = last ? costLeft : proportional(lot.remainingCost, removedQuantity, availableQuantity);
    lot.remainingQuantity -= quantityPart;
    lot.remainingCost -= costPart;
    quantityLeft -= quantityPart;
    costLeft -= costPart;
  });
}

function stockEvent(transaction: PortfolioTransaction): {
  kind: 'buy' | 'sell';
  symbol: string;
  quantity: Fixed;
  price: Fixed;
  fee: Fixed;
  imported: boolean;
} | null {
  if (transaction.type === 'acquisition' || transaction.type === 'disposal' || transaction.type === 'initial_position') {
    if (!transaction.symbol) throw new Error('Asset transaction requires a symbol');
    return {
      kind: transaction.type === 'disposal' ? 'sell' : 'buy',
      symbol: transaction.symbol,
      quantity: decimal(transaction.quantity),
      price: transactionPrice(transaction),
      fee: transactionFee(transaction),
      imported: transaction.type === 'initial_position',
    };
  }
  if (transaction.type !== 'exercise' && transaction.type !== 'assignment') return null;
  if (!transaction.underlyingSymbol || !transaction.optionKind) throw new Error('Option settlement requires an underlying symbol');
  const kind = transaction.optionKind === 'call'
    ? transaction.type === 'exercise' ? 'buy' : 'sell'
    : transaction.type === 'exercise' ? 'sell' : 'buy';
  return {
    kind,
    symbol: transaction.underlyingSymbol,
    quantity: multiply(decimal(transaction.quantity), decimal(transaction.multiplier ?? '100')),
    price: decimal(transaction.strikePrice),
    fee: transactionFee(transaction),
    imported: false,
  };
}

/** Replays the complete transaction ledger in deterministic chronological order. */
export function calculatePortfolio(
  transactions: PortfolioTransaction[],
  marketPrices: Record<string, number | string | MarketPriceInput> = {},
  optionQuotes: Record<string, OptionQuoteInput | null> = {},
  today?: string,
): PortfolioSummary {
  const states = new Map<string, HoldingState>();
  let cash = 0n;
  let netDeposited = 0n;
  let netTransferred = 0n;
  let otherRealized = 0n;

  for (const transaction of ordered(transactions)) {
    const amount = transactionAmount(transaction);
    if (transaction.type === 'deposit') {
      cash += amount;
      netDeposited += amount;
    } else if (transaction.type === 'withdrawal') {
      cash -= amount;
      netDeposited -= amount;
    } else if (transaction.type === 'dividend') {
      cash += amount;
      otherRealized += amount;
    } else if (transaction.type === 'fee') {
      cash -= amount;
      otherRealized -= amount;
    } else if (transaction.type === 'adjustment') {
      cash += amount;
      netDeposited += amount;
    } else if (transaction.type === 'transfer_in') {
      cash += amount;
      netTransferred += amount;
    } else if (transaction.type === 'transfer_out') {
      cash -= amount;
      netTransferred -= amount;
    }

    const event = stockEvent(transaction);
    if (!event) continue;
    const state = states.get(event.symbol) ?? { quantity: 0n, costBasis: 0n, realizedGain: 0n, lots: [], transactions: [] };
    state.transactions.push(transaction);
    const gross = multiply(event.quantity, event.price);

    if (event.kind === 'buy') {
      const acquiredCost = gross + event.fee;
      state.quantity += event.quantity;
      state.costBasis += acquiredCost;
      state.lots.push({
        transactionId: transaction.id,
        occurredAt: transaction.occurredAtTime ?? transaction.occurredAt,
        originalQuantity: event.quantity,
        remainingQuantity: event.quantity,
        remainingCost: acquiredCost,
        fee: event.fee,
        broker: transaction.broker ?? null,
      });
      if (event.imported) {
        const openingCash = transactionAmount(transaction);
        cash += openingCash;
        netDeposited += acquiredCost + openingCash;
      } else {
        cash -= acquiredCost;
      }
    } else {
      if (event.quantity > state.quantity) throw new Error(`Insufficient quantity for ${event.symbol}`);
      const removedCost = event.quantity === state.quantity
        ? state.costBasis
        : proportional(state.costBasis, event.quantity, state.quantity);
      const proceeds = gross - event.fee;
      reduceLots(state.lots, event.quantity, state.quantity, removedCost);
      state.quantity -= event.quantity;
      state.costBasis -= removedCost;
      state.realizedGain += proceeds - removedCost;
      cash += proceeds;
    }
    states.set(event.symbol, state);
  }

  const optionLedger = calculateOptionLedger(transactions, optionQuotes, today);
  cash += decimal(optionLedger.cashFlow);

  let totalMarketValue = 0n;
  let totalTodayChange = 0n;
  let missingEquityPrice = false;
  let missingTodayPrice = false;
  const holdings: HoldingSummary[] = [];
  for (const [symbol, state] of states) {
    if (state.quantity === 0n) continue;
    const rawMarketPrice = marketPrices[symbol];
    const quote = typeof rawMarketPrice === 'object' ? rawMarketPrice : rawMarketPrice == null ? null : { price: rawMarketPrice };
    const parsedPrice = quote == null ? Number.NaN : Number(quote.price);
    const priceMissing = !Number.isFinite(parsedPrice) || parsedPrice <= 0;
    // Provider quotes arrive as IEEE-754 numbers and can expose binary tails
    // (for example 333.42999267578125). Keep ledger strings strict, but round
    // external numeric quotes through the fixed-point number boundary.
    const marketPrice = priceMissing ? null : decimal(parsedPrice);
    const marketValue = marketPrice === null ? null : multiply(state.quantity, marketPrice);
    const parsedPreviousClose = quote?.previousClose == null ? Number.NaN : Number(quote.previousClose);
    const previousClose = Number.isFinite(parsedPreviousClose) && parsedPreviousClose > 0
      ? decimal(parsedPreviousClose)
      : null;
    const todayChange = marketPrice === null || previousClose === null
      ? null
      : multiply(state.quantity, marketPrice - previousClose);
    if (marketValue === null) missingEquityPrice = true;
    else totalMarketValue += marketValue;
    if (todayChange === null) missingTodayPrice = true;
    else totalTodayChange += todayChange;
    const lots: HoldingLot[] = state.lots
      .filter((lot) => lot.remainingQuantity > 0n)
      .map((lot) => ({
        transactionId: lot.transactionId,
        occurredAt: lot.occurredAt,
        originalQuantity: number(lot.originalQuantity),
        remainingQuantity: number(lot.remainingQuantity),
        unitCost: number(divide(lot.remainingCost, lot.remainingQuantity)),
        remainingCost: number(lot.remainingCost),
        fee: number(lot.fee),
        broker: lot.broker,
      }));
    holdings.push({
      symbol,
      quantity: number(state.quantity),
      averageCost: number(divide(state.costBasis, state.quantity)),
      costBasis: number(state.costBasis),
      marketPrice: marketPrice === null ? null : number(marketPrice),
      marketValue: marketValue === null ? null : number(marketValue),
      realizedGain: number(state.realizedGain),
      unrealizedGain: marketValue === null ? null : number(marketValue - state.costBasis),
      allocation: 0,
      priceCached: quote?.cached === true,
      priceStale: quote?.stale === true,
      priceSource: quote?.source ?? null,
      priceAsOf: quote?.asOf ?? null,
      todayChange: todayChange === null ? null : number(todayChange),
      todayChangePercent: todayChange === null || previousClose === null
        ? null
        : number(fixedPercent(marketPrice! - previousClose, previousClose)),
      lots,
      transactions: state.transactions,
    });
  }

  const allocationBasis = number(totalMarketValue);
  for (const holding of holdings) {
    holding.allocation = holding.marketValue === null || allocationBasis === 0 ? 0 : holding.marketValue / allocationBasis * 100;
  }
  holdings.sort((left, right) => (right.marketValue ?? -Infinity) - (left.marketValue ?? -Infinity) || left.symbol.localeCompare(right.symbol));

  const stockCostBasis = [...states.values()].reduce((sum, holding) => sum + holding.costBasis, 0n);
  const stockRealized = [...states.values()].reduce((sum, holding) => sum + holding.realizedGain, 0n);
  const stockUnrealized = holdings.reduce((sum, holding) => sum + decimal(holding.unrealizedGain), 0n);
  const equityMarketValue = missingEquityPrice ? null : totalMarketValue;
  const optionMarketValue = optionLedger.marketValue === null ? null : decimal(optionLedger.marketValue);
  const hasMissingPrices = missingEquityPrice || optionLedger.hasMissingPrices;
  const totalValueFixed = hasMissingPrices ? null : cash + equityMarketValue! + optionMarketValue!;
  const totalGainFixed = totalValueFixed === null ? null : totalValueFixed - netDeposited - netTransferred;
  const totalToday = missingTodayPrice || optionLedger.todayChange === null
    ? null
    : totalTodayChange + decimal(optionLedger.todayChange);
  const previousValue = totalValueFixed === null || totalToday === null ? null : totalValueFixed - totalToday;
  const unrealized = hasMissingPrices
    ? null
    : stockUnrealized + decimal(optionLedger.unrealizedGain);

  return {
    holdings,
    cashBalance: number(cash),
    marketValue: equityMarketValue === null ? null : number(equityMarketValue),
    equityMarketValue: equityMarketValue === null ? null : number(equityMarketValue),
    optionsMarketValue: optionMarketValue === null ? null : number(optionMarketValue),
    optionRemainingCost: optionLedger.remainingCost,
    costBasis: number(stockCostBasis),
    realizedGain: number(stockRealized + otherRealized + decimal(optionLedger.realizedGain)),
    unrealizedGain: unrealized === null ? null : number(unrealized),
    totalValue: totalValueFixed === null ? null : number(totalValueFixed),
    netDepositedCapital: number(netDeposited),
    netTransferredCapital: number(netTransferred),
    totalGain: totalGainFixed === null ? null : number(totalGainFixed),
    totalGainPercent: totalGainFixed === null ? null : number(fixedPercent(totalGainFixed, netDeposited)),
    todayChange: totalToday === null ? null : number(totalToday),
    todayChangePercent: totalToday === null || previousValue === null ? null : number(fixedPercent(totalToday, previousValue)),
    optionPositions: optionLedger.positions,
    hasMissingPrices,
  };
}
