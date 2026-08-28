import {
  fixed as decimal,
  fixedDivide as divide,
  fixedMultiply as multiply,
  fixedPercent,
  fixedToNumber as number,
  type Fixed,
} from '../money/fixed';
import { portfolioTotalReturnPercent } from './total-return';
import { calculateOptionLedger } from './options/calculations';
import type { OptionQuoteInput } from './options/types';
import type { MarketSession } from '@/src/lib/market-data/market-session';
import {
  combineDayChangeSources,
  resolveDayChangeBasis,
  type DayChangeBasis,
} from './day-change';
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

/**
 * The equity side of an asset transfer, or `null` for anything else.
 *
 * A transfer leg is told apart from a cash leg by having a symbol at all: a cash
 * leg carries an amount and nothing else. The cost it moves is read from
 * `transferCostBasisUsd` rather than recomputed from quantity × price, because
 * the two ends have to agree exactly and a re-derivation at each end can round
 * apart. This is the whole reason that column exists.
 */
function equityTransferLeg(transaction: PortfolioTransaction): {
  direction: 'out' | 'in';
  symbol: string;
  quantity: Fixed;
  cost: Fixed;
} | null {
  if (transaction.type !== 'transfer_in' && transaction.type !== 'transfer_out') return null;
  if (!transaction.symbol) return null;
  return {
    direction: transaction.type === 'transfer_in' ? 'in' : 'out',
    symbol: transaction.symbol,
    quantity: decimal(transaction.quantity),
    cost: decimal(transaction.transferCostBasisUsd),
  };
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
  /*
    Which prices the day figure is the difference of — see `./day-change`.

    Defaults to OPEN so every caller that only wants a cash balance or a cost
    basis keeps working untouched and unchanged. Only the surfaces that actually
    PRINT a day figure resolve a real session and pass it: the overview card,
    the tracker, and the options detail rows.
  */
  session: MarketSession = 'OPEN',
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

    /*
     * Transferred capital moves by the cost basis an asset leg carries, exactly
     * as it moves by the amount a cash leg carries. Without this the destination
     * would count the whole market value of an arriving position as profit it had
     * made, and the source would show the mirror-image loss: a portfolio's gain
     * is measured against what was put into it, and a transfer puts in the basis
     * it brought. Written once for shares and contracts alike, because the rule
     * does not depend on what kind of asset moved.
     */
    if ((transaction.type === 'transfer_in' || transaction.type === 'transfer_out')
      && transaction.transferCostBasisUsd != null) {
      const movedBasis = decimal(transaction.transferCostBasisUsd);
      netTransferred += transaction.type === 'transfer_in' ? movedBasis : -movedBasis;
    }

    /*
     * An asset transfer, which is not a trade.
     *
     * Quantity and cost basis move; cash does not, no gain is realized, and the
     * cash branches above already saw `amount` as null and added nothing. That
     * is the entire behavioural difference between moving a position and selling
     * it in one portfolio to buy it back in another — and it is why a transfer
     * must never be expressed as a disposal plus an acquisition.
     */
    const leg = equityTransferLeg(transaction);
    if (leg) {
      const state = states.get(leg.symbol) ?? { quantity: 0n, costBasis: 0n, realizedGain: 0n, lots: [], transactions: [] };
      state.transactions.push(transaction);
      if (leg.direction === 'in') {
        state.quantity += leg.quantity;
        state.costBasis += leg.cost;
        state.lots.push({
          transactionId: transaction.id,
          // The acquisition date travels with the position. A lot that reset its
          // date on arrival would tell the holder they had just bought something
          // they have held for two years.
          occurredAt: transaction.transferAcquiredAt ?? transaction.occurredAtTime ?? transaction.occurredAt,
          originalQuantity: leg.quantity,
          remainingQuantity: leg.quantity,
          remainingCost: leg.cost,
          fee: 0n,
          broker: transaction.broker ?? null,
        });
      } else {
        if (leg.quantity > state.quantity) throw new Error(`Insufficient quantity for ${leg.symbol}`);
        reduceLots(state.lots, leg.quantity, state.quantity, leg.cost);
        state.quantity -= leg.quantity;
        state.costBasis -= leg.cost;
      }
      states.set(leg.symbol, state);
      continue;
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

  const optionLedger = calculateOptionLedger(transactions, optionQuotes, today, session);
  cash += decimal(optionLedger.cashFlow);

  let totalMarketValue = 0n;
  let totalTodayChange = 0n;
  let missingEquityPrice = false;
  let missingTodayPrice = false;
  const holdings: HoldingSummary[] = [];
  const dayBases: (DayChangeBasis | null)[] = [];
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
    /*
      The day figure is no longer "live price minus whatever previous close the
      quote happened to carry". Outside the regular session the quote usually
      carries none, and the old expression answered that by producing null —
      which the card rendered as a missing row every evening and all weekend.
      `resolveDayChangeBasis` picks the right PAIR of prices for the session and
      says which day the pair belongs to.
    */
    const dayBasis = resolveDayChangeBasis({
      session,
      price: priceMissing ? null : parsedPrice,
      previousClose: quote?.previousClose == null ? null : Number(quote.previousClose),
      snapshot: quote?.daySnapshot ?? null,
    });
    dayBases.push(dayBasis);
    // Both halves cross the fixed-point boundary the same way the market price
    // does above, so a provider's binary tail cannot leak into a money figure.
    const dayClose = dayBasis === null ? null : decimal(dayBasis.close);
    const dayPrevClose = dayBasis === null ? null : decimal(dayBasis.prevClose);
    const todayChange = dayClose === null || dayPrevClose === null
      ? null
      : multiply(state.quantity, dayClose - dayPrevClose);
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
      todayChangePercent: dayClose === null || dayPrevClose === null
        ? null
        : number(fixedPercent(dayClose - dayPrevClose, dayPrevClose)),
      todayChangeAsOf: dayBasis?.sessionDate ?? null,
      todayChangeSource: dayBasis?.source ?? null,
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
  /*
    The base the PORTFOLIO's day percentage is measured against.

    Worth knowing what this is once the day figure can come from a snapshot: the
    total value is always built from the latest prices, while `totalToday` may be
    the difference of two completed closes, so outside the session the base is
    "latest value minus the last session's move" rather than the exact value at
    that session's previous close. The two differ only by whatever moved in
    extended trading, which for a closed market is usually nothing and never
    much.

    Left as it is deliberately. Computing an exact base would mean summing
    quantity × prevClose across both ledgers, and the options ledger does not
    expose its per-position basis — so the alternative is a wider refactor to
    remove a discrepancy smaller than the rounding on the figure it feeds. The
    per-HOLDING percentages above have no such issue: each is computed from its
    own basis's two prices.
  */
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
    totalGainPercent: portfolioTotalReturnPercent(totalGainFixed, netDeposited, netTransferred),
    todayChange: totalToday === null ? null : number(totalToday),
    todayChangePercent: totalToday === null || previousValue === null ? null : number(fixedPercent(totalToday, previousValue)),
    /*
      One attribution for the whole portfolio, reconciled from every position's
      own basis — including the options ledger's already-reconciled one, folded
      in as a single participant so a portfolio that is half snapshot and half
      live cannot be captioned as though it were purely either.

      Null when the figure itself is null: there is no session to name for a
      number that does not exist.
    */
    ...(() => {
      const combined = totalToday === null ? null : combineDayChangeSources([
        ...dayBases,
        optionLedger.todayChangeSource === null ? null : {
          close: 0,
          prevClose: 0,
          sessionDate: optionLedger.todayChangeAsOf,
          source: optionLedger.todayChangeSource,
          provider: null,
        },
      ]);
      return {
        todayChangeAsOf: combined?.sessionDate ?? null,
        todayChangeSource: combined?.source ?? null,
      };
    })(),
    optionPositions: optionLedger.positions,
    hasMissingPrices,
  };
}
