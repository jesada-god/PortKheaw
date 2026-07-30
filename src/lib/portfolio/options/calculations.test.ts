import { describe, expect, it } from 'vitest';
import {
  calculateDte,
  calculateOptionLedger,
  calculateOptionTarget,
  calculateOptionTotalCost,
} from './calculations';
import type { OptionQuoteInput } from './types';
import type { PortfolioTransaction, PortfolioTransactionType } from '../types';

let sequence = 0;
function option(type: PortfolioTransactionType, values: Partial<PortfolioTransaction> = {}): PortfolioTransaction {
  sequence += 1;
  const second = String(sequence).padStart(2, '0');
  return {
    id: `tx-${sequence}`,
    portfolioId: 'p',
    type,
    symbol: null,
    quantity: '1',
    price: '2',
    normalizedPriceUsd: '2',
    amount: null,
    fee: '0',
    normalizedFeeUsd: '0',
    originalCurrency: 'USD',
    occurredAt: '2026-07-01',
    occurredAtTime: `2026-07-01T00:00:${second}.000Z`,
    underlyingSymbol: 'AAPL',
    contractSymbol: 'AAPL260821C00200000',
    optionKind: 'call',
    optionSide: type === 'sell_to_open' || type === 'buy_to_close' || type === 'assignment' ? 'short' : 'long',
    strikePrice: '200',
    expirationDate: '2026-08-21',
    multiplier: '100',
    note: null,
    createdAt: `2026-07-01T00:00:${second}.000Z`,
    updatedAt: `2026-07-01T00:00:${second}.000Z`,
    ...values,
  };
}

function quote(values: Partial<OptionQuoteInput> = {}): OptionQuoteInput {
  return {
    bid: 2,
    ask: 3,
    mark: 2.5,
    previousClose: 2.25,
    underlyingPrice: 205,
    impliedVolatility: 0.35,
    delta: 0.5,
    theta: -0.02,
    source: 'alpaca-options-data',
    asOf: '2026-07-30T15:00:00Z',
    freshness: 'delayed',
    ...values,
  };
}

describe('option transaction-ledger calculations', () => {
  it('applies multiplier and opening fee to cash and remaining cost', () => {
    const result = calculateOptionLedger([
      option('buy_to_open', { quantity: '2', price: '1.25', normalizedPriceUsd: '1.25', fee: '1.5', normalizedFeeUsd: '1.5' }),
    ], { AAPL260821C00200000: quote({ bid: 1.2, ask: 1.3, mark: 1.25 }) }, '2026-07-30');
    expect(calculateOptionTotalCost('1.25', '2')).toBe(250);
    expect(result).toMatchObject({ cashFlow: -251.5, remainingCost: 251.5, marketValue: 250, unrealizedGain: -1.5 });
  });

  it('values the legacy NVTS ledger position from a real Mark without changing its identity', () => {
    const legacy = 'LEGACY-C307F481-B34C-4FE3-97';
    const result = calculateOptionLedger([
      option('buy_to_open', {
        underlyingSymbol: 'NVTS',
        contractSymbol: legacy,
        optionKind: 'put',
        strikePrice: '12',
        price: '2',
        normalizedPriceUsd: '2',
        expirationDate: '2026-08-21',
      }),
    ], {
      [legacy]: quote({
        contractSymbol: 'NVTS260821P00012000',
        mark: 1.93,
      }),
    }, '2026-07-31');

    expect(result).toMatchObject({
      cashFlow: -200,
      remainingCost: 200,
      marketValue: 193,
      unrealizedGain: -7,
    });
    expect(result.positions[0]).toMatchObject({
      contractSymbol: legacy,
      marketContractSymbol: 'NVTS260821P00012000',
      marketValue: 193,
      unrealizedGain: -7,
    });
  });

  it('uses Bid for a long close estimate and Ask for a short buyback liability', () => {
    const long = calculateOptionLedger([option('buy_to_open')], { AAPL260821C00200000: quote() }, '2026-07-30').positions[0];
    expect(long).toMatchObject({ mark: 2.5, marketValue: 250, estimatedClosePrice: 2, estimatedCloseValue: 200 });

    const short = calculateOptionLedger([option('sell_to_open')], { AAPL260821C00200000: quote() }, '2026-07-30').positions[0];
    expect(short).toMatchObject({ mark: 2.5, marketValue: -300, estimatedClosePrice: 3, estimatedCloseValue: 300, unrealizedGain: -100 });
  });

  it('preserves proportional cost through a partial close and separates realized/unrealized P&L', () => {
    const result = calculateOptionLedger([
      option('buy_to_open', { quantity: '3', price: '2', normalizedPriceUsd: '2', fee: '3', normalizedFeeUsd: '3' }),
      option('sell_to_close', { quantity: '1', price: '3', normalizedPriceUsd: '3', fee: '1', normalizedFeeUsd: '1' }),
    ], { AAPL260821C00200000: quote({ mark: 2.5, bid: 2.4, ask: 2.6 }) }, '2026-07-30');
    expect(result).toMatchObject({ cashFlow: -304, realizedGain: 98, remainingCost: 402, marketValue: 500, unrealizedGain: 98 });
    expect(result.positions[0]).toMatchObject({ contracts: 2, averagePremium: 2, remainingCost: 402 });
  });

  it('derives expired state and records explicit expiration for long and short positions', () => {
    const autoExpired = calculateOptionLedger([
      option('buy_to_open', { expirationDate: '2026-07-20' }),
    ], {}, '2026-07-30');
    expect(autoExpired.positions[0]).toMatchObject({ status: 'expired', marketValue: 0, unrealizedGain: -200 });

    const long = calculateOptionLedger([
      option('buy_to_open'),
      option('expired', { price: '0', normalizedPriceUsd: '0', optionSide: 'long' }),
    ], {}, '2026-07-30');
    expect(long.positions[0]).toMatchObject({ status: 'closed', contracts: 0, realizedGain: -200 });

    const short = calculateOptionLedger([
      option('sell_to_open'),
      option('expired', { price: '0', normalizedPriceUsd: '0', optionSide: 'short' }),
    ], {}, '2026-07-30');
    expect(short.positions[0]).toMatchObject({ status: 'closed', contracts: 0, realizedGain: 200 });
  });

  it('supports exercise and assignment lifecycle closes', () => {
    const exercise = calculateOptionLedger([
      option('buy_to_open'),
      option('exercise', { price: '0', normalizedPriceUsd: '0' }),
    ], {}, '2026-07-30');
    expect(exercise.positions[0]).toMatchObject({ status: 'closed', realizedGain: -200 });

    const assignment = calculateOptionLedger([
      option('sell_to_open'),
      option('assignment', { price: '0', normalizedPriceUsd: '0' }),
    ], {}, '2026-07-30');
    expect(assignment.positions[0]).toMatchObject({ status: 'closed', realizedGain: 200 });
  });

  it('calculates target premium and target profit after closing fee', () => {
    const position = calculateOptionLedger([option('buy_to_open')], { AAPL260821C00200000: quote({ mark: 2 }) }, '2026-07-30').positions[0];
    expect(calculateOptionTarget(position, 'premium', 3, 1)).toMatchObject({
      targetPremium: 3,
      estimatedProceeds: 299,
      estimatedProfit: 99,
      estimatedProfitPercent: 49.5,
      distanceFromCurrent: 1,
      distancePercent: 50,
    });
    expect(calculateOptionTarget(position, 'profit_percent', 25, 1).targetPremium).toBeCloseTo(2.51, 8);
  });

  it('calculates DTE by calendar day', () => {
    expect(calculateDte('2026-07-31', '2026-07-18')).toBe(13);
  });
});
