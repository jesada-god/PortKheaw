import { describe, expect, it } from 'vitest';
import { calculatePortfolio } from './calculations';
import type { OptionQuoteInput } from './options/types';
import type { PortfolioTransaction, PortfolioTransactionType } from './types';

let sequence = 0;
function tx(type: PortfolioTransactionType, values: Partial<PortfolioTransaction> = {}): PortfolioTransaction {
  sequence += 1;
  const second = String(sequence % 60).padStart(2, '0');
  return {
    id: String(sequence).padStart(3, '0'),
    portfolioId: 'p1',
    type,
    symbol: null,
    quantity: null,
    price: null,
    amount: null,
    fee: null,
    originalCurrency: 'USD',
    occurredAt: '2026-07-01',
    occurredAtTime: `2026-07-01T00:00:${second}.000Z`,
    note: null,
    createdAt: `2026-07-01T00:00:${second}.000Z`,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...values,
  };
}

function option(type: PortfolioTransactionType, values: Partial<PortfolioTransaction> = {}) {
  return tx(type, {
    quantity: '1',
    price: '2',
    fee: '0',
    normalizedPriceUsd: '2',
    normalizedFeeUsd: '0',
    underlyingSymbol: 'NVTS',
    contractSymbol: 'NVTS260821P00012000',
    optionKind: 'put',
    optionSide: type === 'sell_to_open' || type === 'buy_to_close' || type === 'assignment' ? 'short' : 'long',
    strikePrice: '12',
    expirationDate: '2026-08-21',
    multiplier: '100',
    ...values,
  });
}

function optionQuote(values: Partial<OptionQuoteInput> = {}): OptionQuoteInput {
  return {
    bid: 2,
    ask: 2,
    mark: 2,
    previousClose: 2,
    underlyingPrice: 11,
    impliedVolatility: 1.2285,
    delta: -0.65,
    theta: -0.0239,
    source: 'alpaca-options-data',
    asOf: '2026-07-30T15:00:00.000Z',
    freshness: 'delayed',
    ...values,
  };
}

describe('portfolio transaction-ledger accounting', () => {
  it('does not turn deposits or withdrawals into P&L', () => {
    const result = calculatePortfolio([
      tx('deposit', { amount: '300', normalizedAmountUsd: '300' }),
      tx('withdrawal', { amount: '25', normalizedAmountUsd: '25' }),
    ]);
    expect(result).toMatchObject({
      cashBalance: 275,
      netDepositedCapital: 275,
      totalValue: 275,
      totalGain: 0,
      totalGainPercent: 0,
    });
  });

  it('uses weighted average across lots and capitalizes acquisition fees', () => {
    const result = calculatePortfolio([
      tx('acquisition', { symbol: 'AAPL', quantity: '10', price: '10', normalizedPriceUsd: '10', fee: '2', normalizedFeeUsd: '2' }),
      tx('acquisition', { symbol: 'AAPL', quantity: '5', price: '20', normalizedPriceUsd: '20', fee: '3', normalizedFeeUsd: '3' }),
    ], { AAPL: { price: 25, previousClose: 24, source: 'provider', asOf: '2026-07-30T15:00:00Z' } });
    expect(result.holdings[0]).toMatchObject({
      quantity: 15,
      averageCost: 13.66666667,
      costBasis: 205,
      marketValue: 375,
      unrealizedGain: 170,
    });
    expect(result.holdings[0].lots).toHaveLength(2);
  });

  it('handles a partial close with realized and unrealized P&L', () => {
    const result = calculatePortfolio([
      tx('deposit', { amount: '200', normalizedAmountUsd: '200' }),
      tx('acquisition', { symbol: 'MSFT', quantity: '10', price: '12.5', normalizedPriceUsd: '12.5', fee: '0', normalizedFeeUsd: '0' }),
      tx('disposal', { symbol: 'MSFT', quantity: '4', price: '20', normalizedPriceUsd: '20', fee: '2', normalizedFeeUsd: '2' }),
    ], { MSFT: { price: 15, previousClose: 14 } });
    expect(result).toMatchObject({ cashBalance: 153, realizedGain: 28, costBasis: 75, unrealizedGain: 15 });
    expect(result.holdings[0]).toMatchObject({ quantity: 6, marketValue: 90, todayChange: 6 });
  });

  it('recalculates from scratch after editing or deleting an old transaction', () => {
    const first = tx('acquisition', { symbol: 'AAPL', quantity: '10', price: '10', normalizedPriceUsd: '10', fee: '0', normalizedFeeUsd: '0' });
    const second = tx('acquisition', { symbol: 'AAPL', quantity: '10', price: '30', normalizedPriceUsd: '30', fee: '0', normalizedFeeUsd: '0' });
    expect(calculatePortfolio([first, second], { AAPL: 30 }).holdings[0].averageCost).toBe(20);
    expect(calculatePortfolio([{ ...first, price: '20', normalizedPriceUsd: '20' }, second], { AAPL: 30 }).holdings[0].averageCost).toBe(25);
    expect(calculatePortfolio([second], { AAPL: 30 }).holdings[0].averageCost).toBe(30);
  });

  it('keeps USD ledger amounts stable while THB remains only an original/display unit', () => {
    const thb = tx('deposit', {
      amount: '3600',
      originalAmount: '3600',
      originalCurrency: 'THB',
      fxRateAtTransaction: '36',
      normalizedAmountUsd: '100',
    });
    const result = calculatePortfolio([thb]);
    expect(result.cashBalance).toBe(100);
    expect(result.netDepositedCapital).toBe(100);
    expect(thb.amount).toBe('3600');
    expect(thb.fxRateAtTransaction).toBe('36');
  });

  it('does not substitute cost or zero for a missing quote and discloses stale quotes', () => {
    const ledger = [tx('acquisition', { symbol: 'AAPL', quantity: '1', price: '10', normalizedPriceUsd: '10', fee: '0', normalizedFeeUsd: '0' })];
    const missing = calculatePortfolio(ledger);
    expect(missing.holdings[0]).toMatchObject({ marketPrice: null, marketValue: null, unrealizedGain: null });
    expect(missing.totalValue).toBeNull();
    expect(missing.hasMissingPrices).toBe(true);

    const stale = calculatePortfolio(ledger, { AAPL: { price: 12, previousClose: 11, stale: true, cached: true, source: 'alpha-vantage', asOf: '2026-07-29T20:00:00Z' } });
    expect(stale.holdings[0]).toMatchObject({ marketPrice: 12, priceStale: true, priceSource: 'alpha-vantage', unrealizedGain: 2 });
  });

  it('passes the mandatory $274.04 option regression without fabricating +$200', () => {
    const ledger = [
      tx('deposit', { amount: '274.04', normalizedAmountUsd: '274.04' }),
      option('buy_to_open'),
    ];
    const result = calculatePortfolio(ledger, {}, { NVTS260821P00012000: optionQuote() }, '2026-07-30');
    expect(result).toMatchObject({
      cashBalance: 74.04,
      optionsMarketValue: 200,
      totalValue: 274.04,
      optionRemainingCost: 200,
      unrealizedGain: 0,
      totalGain: 0,
      totalGainPercent: 0,
    });
    expect(result.optionPositions[0]).toMatchObject({ remainingCost: 200, unrealizedGain: 0 });
  });

  it('settles exercise and assignment into underlying stock through ledger events', () => {
    const exercised = calculatePortfolio([
      tx('deposit', { amount: '20200', normalizedAmountUsd: '20200' }),
      option('buy_to_open', { optionKind: 'call', strikePrice: '200', contractSymbol: 'AAPL260821C00200000', underlyingSymbol: 'AAPL' }),
      option('exercise', { optionKind: 'call', strikePrice: '200', contractSymbol: 'AAPL260821C00200000', underlyingSymbol: 'AAPL', price: '0', normalizedPriceUsd: '0' }),
    ], { AAPL: { price: 205, previousClose: 204 } }, {}, '2026-07-30');
    expect(exercised).toMatchObject({ cashBalance: 0, realizedGain: -200, unrealizedGain: 500, totalGain: 300 });
    expect(exercised.holdings[0]).toMatchObject({ symbol: 'AAPL', quantity: 100, costBasis: 20000 });

    const assigned = calculatePortfolio([
      tx('deposit', { amount: '20000', normalizedAmountUsd: '20000' }),
      option('sell_to_open', { optionKind: 'put', strikePrice: '200', contractSymbol: 'AAPL260821P00200000', underlyingSymbol: 'AAPL' }),
      option('assignment', { optionKind: 'put', strikePrice: '200', contractSymbol: 'AAPL260821P00200000', underlyingSymbol: 'AAPL', price: '0', normalizedPriceUsd: '0' }),
    ], { AAPL: { price: 205, previousClose: 204 } }, {}, '2026-07-30');
    expect(assigned).toMatchObject({ cashBalance: 200, realizedGain: 200, unrealizedGain: 500, totalGain: 700 });
    expect(assigned.holdings[0]).toMatchObject({ symbol: 'AAPL', quantity: 100, costBasis: 20000 });
  });
});
