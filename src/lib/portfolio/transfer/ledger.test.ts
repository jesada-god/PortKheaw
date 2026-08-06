import { describe, expect, it } from 'vitest';
import { calculatePortfolio } from '../calculations';
import type { PortfolioTransaction } from '../types';
import { buildTransferPlan, transferableAssets, type TransferLeg } from './plan';

/*
 * What a transfer does to the two ledgers it touches.
 *
 * These build the plan, turn its legs into the rows the database would write,
 * and replay both portfolios through the canonical engine. The claim under test
 * is the one the whole feature rests on: moving a position is not selling it.
 * No gain is realized, no cash moves, and the cost basis that arrives is exactly
 * the cost basis that left — which is what makes the aggregate unchanged.
 */

let sequence = 0;
function nextId() {
  sequence += 1;
  return `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function row(overrides: Partial<PortfolioTransaction> & { type: PortfolioTransaction['type'] }): PortfolioTransaction {
  return {
    id: nextId(),
    portfolioId: 'source',
    symbol: null,
    quantity: null,
    price: null,
    amount: null,
    originalCurrency: 'USD',
    occurredAt: '2026-01-05',
    occurredAtTime: '2026-01-05T05:00:00.000Z',
    note: null,
    createdAt: '2026-01-05T05:00:00.000Z',
    updatedAt: '2026-01-05T05:00:00.000Z',
    ...overrides,
  };
}

/**
 * The rows the RPC writes for one leg, built here from the same plan the server
 * would send. Keeping this in the test rather than in the source is deliberate:
 * it is a restatement of the database's insert, and if the two ever disagree
 * this file is where that shows up.
 */
function legRows(leg: TransferLeg, occurredAtTime: string): { out: PortfolioTransaction; in: PortfolioTransaction } {
  const shared = {
    transferId: leg.transferId,
    transferGroupId: 'group-1',
    occurredAtTime,
    occurredAt: occurredAtTime.slice(0, 10),
    createdAt: occurredAtTime,
    updatedAt: occurredAtTime,
    transferSourceName: 'Source',
    transferDestinationName: 'Destination',
  } as const;

  const body: Partial<PortfolioTransaction> = leg.kind === 'cash'
    ? { amount: leg.costBasisUsd, normalizedAmountUsd: leg.costBasisUsd }
    : leg.kind === 'equity'
      ? {
        symbol: leg.symbol,
        quantity: leg.quantity,
        price: leg.unitCostUsd,
        normalizedPriceUsd: leg.unitCostUsd,
        transferCostBasisUsd: leg.costBasisUsd,
        transferAcquiredAt: leg.acquiredAt,
      }
      : {
        quantity: leg.quantity,
        price: leg.unitCostUsd,
        normalizedPriceUsd: leg.unitCostUsd,
        underlyingSymbol: leg.underlyingSymbol,
        contractSymbol: leg.contractSymbol,
        optionKind: leg.optionKind,
        optionSide: leg.optionSide,
        strikePrice: leg.strikePrice,
        expirationDate: leg.expirationDate,
        multiplier: leg.multiplier,
        transferCostBasisUsd: leg.costBasisUsd,
      };

  return {
    out: row({ type: 'transfer_out', portfolioId: 'source', counterpartyPortfolioId: 'destination', ...shared, ...body }),
    in: row({ type: 'transfer_in', portfolioId: 'destination', counterpartyPortfolioId: 'source', ...shared, ...body }),
  };
}

function applyTransfer(
  sourceLedger: PortfolioTransaction[],
  destinationLedger: PortfolioTransaction[],
  selection: Parameters<typeof buildTransferPlan>[1],
  today = '2026-06-01',
  prices: Record<string, number> = {},
) {
  const assets = transferableAssets(calculatePortfolio(sourceLedger, prices, {}, today));
  const planned = buildTransferPlan(assets, selection, nextId);
  if (!planned.ok) throw new Error(`plan failed: ${planned.error}`);
  const at = '2026-03-01T05:00:00.000Z';
  const source = [...sourceLedger];
  const destination = [...destinationLedger];
  for (const leg of planned.plan.legs) {
    const rows = legRows(leg, at);
    source.push(rows.out);
    destination.push(rows.in);
  }
  return {
    plan: planned.plan,
    source: calculatePortfolio(source, prices, {}, today),
    destination: calculatePortfolio(destination, prices, {}, today),
    beforeSource: calculatePortfolio(sourceLedger, prices, {}, today),
  };
}

const BUY = () => row({ type: 'acquisition', symbol: 'AAPL', quantity: '10', price: '150', fee: '20' });
const DEPOSIT = () => row({ type: 'deposit', amount: '5000' });

describe('an equity transfer', () => {
  it('moves quantity and cost basis without realizing a gain or moving cash', () => {
    const result = applyTransfer(
      [DEPOSIT(), BUY()],
      [],
      { equities: [{ symbol: 'AAPL', quantity: 10 }], options: [], cashUsd: 0 },
    );

    // 10 at 150 plus a 20 fee is a 1520 basis, and all of it leaves.
    expect(result.source.holdings).toEqual([]);
    expect(result.destination.holdings).toHaveLength(1);
    expect(result.destination.holdings[0]).toMatchObject({ symbol: 'AAPL', quantity: 10, costBasis: 1520 });

    // Nothing was sold, so nothing was realized at either end.
    expect(result.source.realizedGain).toBe(0);
    expect(result.destination.realizedGain).toBe(0);

    // The cash stayed exactly where it was.
    expect(result.source.cashBalance).toBe(result.beforeSource.cashBalance);
    expect(result.destination.cashBalance).toBe(0);
  });

  it('leaves the source holding exactly what it kept on a partial move', () => {
    const result = applyTransfer(
      [DEPOSIT(), BUY()],
      [],
      { equities: [{ symbol: 'AAPL', quantity: 4 }], options: [], cashUsd: 0 },
    );
    expect(result.source.holdings[0]).toMatchObject({ symbol: 'AAPL', quantity: 6 });
    expect(result.destination.holdings[0]).toMatchObject({ symbol: 'AAPL', quantity: 4 });
    // 1520 split 4/10 and 6/10, with nothing lost to rounding in between.
    expect(result.source.holdings[0].costBasis + result.destination.holdings[0].costBasis).toBe(1520);
  });

  it('carries the acquisition date rather than restamping it on arrival', () => {
    const result = applyTransfer(
      [DEPOSIT(), BUY()],
      [],
      { equities: [{ symbol: 'AAPL', quantity: 10 }], options: [], cashUsd: 0 },
    );
    expect(result.destination.holdings[0].lots).toHaveLength(1);
    expect(result.destination.holdings[0].lots[0].occurredAt).toBe('2026-01-05T05:00:00.000Z');
  });

  it('merges into an existing destination holding at the blended average cost', () => {
    const existing = row({
      type: 'acquisition', portfolioId: 'destination', symbol: 'AAPL',
      quantity: '10', price: '100', fee: '0',
      occurredAtTime: '2025-06-01T05:00:00.000Z', createdAt: '2025-06-01T05:00:00.000Z',
    });
    const result = applyTransfer(
      [DEPOSIT(), BUY()],
      [existing],
      { equities: [{ symbol: 'AAPL', quantity: 10 }], options: [], cashUsd: 0 },
      '2026-06-01',
      { AAPL: 500 },
    );
    const holding = result.destination.holdings[0];
    expect(holding.quantity).toBe(20);
    // 1000 already there plus the 1520 that arrived, over 20 units. The market
    // price of 500 is deliberately absurd: a transfer that valued the incoming
    // shares at market would put the average cost near it.
    expect(holding.costBasis).toBe(2520);
    expect(holding.averageCost).toBe(126);
  });

  it('keeps the reported gain honest at both ends', () => {
    const result = applyTransfer(
      [DEPOSIT(), BUY()],
      [],
      { equities: [{ symbol: 'AAPL', quantity: 10 }], options: [], cashUsd: 0 },
      '2026-06-01',
      { AAPL: 200 },
    );
    // The destination received a 1520 basis and holds 2000 of stock, so its gain
    // is 480 — not the 2000 it would show if the arriving basis were free.
    expect(result.destination.totalGain).toBe(480);
    expect(result.destination.netTransferredCapital).toBe(1520);
    expect(result.source.netTransferredCapital).toBe(-1520);
  });
});

describe('an option transfer', () => {
  const CONTRACT = 'AAPL261218C00200000';
  const openLong = () => row({
    type: 'buy_to_open', quantity: '10', price: '3', fee: '0',
    underlyingSymbol: 'AAPL', contractSymbol: CONTRACT, optionKind: 'call', optionSide: 'long',
    strikePrice: '200', expirationDate: '2026-12-18', multiplier: '100',
  });

  it('moves open contracts with their remaining cost and their breakeven', () => {
    const source = [DEPOSIT(), openLong()];
    const assets = transferableAssets(calculatePortfolio(source, {}, {}, '2026-06-01'));
    const result = applyTransfer(
      source,
      [],
      { equities: [], options: [{ key: assets.options[0].key, contracts: 10 }], cashUsd: 0 },
    );

    const arrived = result.destination.optionPositions[0];
    expect(arrived.contracts).toBe(10);
    expect(arrived.status).toBe('open');
    // 10 contracts × 100 × $3 = $3000 of premium, carried across intact.
    expect(arrived.remainingCost).toBe(3000);
    expect(arrived.averagePremium).toBe(3);
    expect(arrived.breakeven).toBe(203);
    expect(result.destination.realizedGain).toBe(0);
    expect(result.destination.cashBalance).toBe(0);

    // The source keeps the position as closed history with nothing realized.
    expect(result.source.optionPositions[0].contracts).toBe(0);
    expect(result.source.optionPositions[0].status).toBe('closed');
    expect(result.source.realizedGain).toBe(0);
  });

  it('moves only the contracts left after a partial close', () => {
    const source = [
      DEPOSIT(),
      openLong(),
      row({
        type: 'sell_to_close', quantity: '4', price: '5', fee: '0',
        underlyingSymbol: 'AAPL', contractSymbol: CONTRACT, optionKind: 'call', optionSide: 'long',
        strikePrice: '200', expirationDate: '2026-12-18', multiplier: '100',
        occurredAtTime: '2026-02-01T05:00:00.000Z',
      }),
    ];
    const assets = transferableAssets(calculatePortfolio(source, {}, {}, '2026-06-01'));
    expect(assets.options[0].contracts).toBe(6);

    const result = applyTransfer(
      source,
      [],
      { equities: [], options: [{ key: assets.options[0].key, contracts: 6 }], cashUsd: 0 },
    );
    expect(result.destination.optionPositions[0].contracts).toBe(6);
    expect(result.destination.optionPositions[0].remainingCost).toBe(1800);
    // The close realized 800 before the move, and the move did not add to it.
    expect(result.source.realizedGain).toBe(800);
  });
});

describe('a cash transfer alongside assets', () => {
  it('moves cash and shares in one plan without either affecting the other', () => {
    const result = applyTransfer(
      [DEPOSIT(), BUY()],
      [],
      { equities: [{ symbol: 'AAPL', quantity: 10 }], options: [], cashUsd: 1000 },
    );
    // 5000 deposited less 1520 spent is 3480; 1000 of it moves.
    expect(result.source.cashBalance).toBe(2480);
    expect(result.destination.cashBalance).toBe(1000);
    expect(result.destination.holdings[0].costBasis).toBe(1520);
  });
});

describe('the aggregate', () => {
  it('is unchanged by a transfer, which is the definition of moving something', () => {
    const before = calculatePortfolio([DEPOSIT(), BUY()], { AAPL: 200 }, {}, '2026-06-01');
    const result = applyTransfer(
      [DEPOSIT(), BUY()],
      [],
      { equities: [{ symbol: 'AAPL', quantity: 6 }], options: [], cashUsd: 500 },
      '2026-06-01',
      { AAPL: 200 },
    );
    expect(result.source.totalValue! + result.destination.totalValue!).toBeCloseTo(before.totalValue!, 8);
    expect(result.source.realizedGain + result.destination.realizedGain).toBe(before.realizedGain);
    expect(result.source.totalGain! + result.destination.totalGain!).toBeCloseTo(before.totalGain!, 8);
  });
});
