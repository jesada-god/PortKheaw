import { describe, expect, it } from 'vitest';
import { calculatePortfolio } from '../calculations';
import type { PortfolioTransaction } from '../types';
import { buildTransferPlan, transferableAssets } from './plan';

/*
 * The one question this file exists to answer: what is still *held*, as opposed
 * to what was once bought.
 *
 * Every case below builds a real ledger, replays it through the canonical engine
 * and asks the transfer layer what it would offer to move. A closed position
 * that still appears here would be offered to a reader as an asset, and moving
 * it would write a transfer for shares nobody owns.
 */

let sequence = 0;
function nextId() {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function row(overrides: Partial<PortfolioTransaction> & { type: PortfolioTransaction['type'] }): PortfolioTransaction {
  const id = nextId();
  return {
    id,
    portfolioId: 'portfolio-source',
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

function buy(symbol: string, quantity: string, price: string, occurredAtTime = '2026-01-05T05:00:00.000Z') {
  return row({ type: 'acquisition', symbol, quantity, price, fee: '0', occurredAtTime });
}

function sell(symbol: string, quantity: string, price: string, occurredAtTime = '2026-02-05T05:00:00.000Z') {
  return row({ type: 'disposal', symbol, quantity, price, fee: '0', occurredAtTime });
}

const CONTRACT = 'AAPL260116C00200000';

function optionRow(
  type: PortfolioTransaction['type'],
  quantity: string,
  price: string,
  side: 'long' | 'short' = 'long',
  occurredAtTime = '2026-01-05T05:00:00.000Z',
  expirationDate = '2026-12-18',
  optionKind: 'call' | 'put' = 'call',
) {
  return row({
    type,
    quantity,
    price,
    fee: '0',
    underlyingSymbol: 'AAPL',
    contractSymbol: CONTRACT,
    optionKind,
    optionSide: side,
    strikePrice: '200',
    expirationDate,
    multiplier: '100',
    occurredAtTime,
  });
}

/** `today` is pinned so "expired" never depends on when the suite is run. */
function assetsFor(transactions: PortfolioTransaction[], today = '2026-06-01') {
  return transferableAssets(calculatePortfolio(transactions, {}, {}, today));
}

describe('what a portfolio can still transfer', () => {
  it('offers nothing for a stock bought and then sold in full', () => {
    const assets = assetsFor([buy('AAPL', '10', '150'), sell('AAPL', '10', '180')]);
    expect(assets.equities).toEqual([]);
    // The proceeds are still there and are still cash, which is a different
    // asset entirely. The closed position is what must not reappear.
    expect(assets.transferableCash).toBe(300);
  });

  it('has nothing to offer at all once a closed position leaves no cash behind', () => {
    const assets = assetsFor([
      row({ type: 'deposit', amount: '1500' }),
      buy('AAPL', '10', '150'),
      sell('AAPL', '10', '150'),
      row({ type: 'withdrawal', amount: '1500', occurredAtTime: '2026-03-05T05:00:00.000Z' }),
    ]);
    expect(assets.equities).toEqual([]);
    expect(assets.cashBalance).toBe(0);
    expect(assets.hasAnything).toBe(false);
  });

  it('offers only the remaining shares after a partial sale', () => {
    const assets = assetsFor([buy('AAPL', '10', '150'), sell('AAPL', '4', '180')]);
    expect(assets.equities).toHaveLength(1);
    expect(assets.equities[0].symbol).toBe('AAPL');
    expect(assets.equities[0].quantity).toBe(6);
  });

  it('refuses a plan for more than is actually held', () => {
    const assets = assetsFor([buy('AAPL', '10', '150'), sell('AAPL', '4', '180')]);
    const result = buildTransferPlan(assets, {
      equities: [{ symbol: 'AAPL', quantity: 7 }],
      options: [],
      cashUsd: 0,
    }, nextId);
    expect(result).toEqual({ ok: false, error: 'quantity-exceeds-open', subject: 'AAPL' });
  });

  it('carries the whole remaining cost basis when the whole position moves', () => {
    // 10 at 150 then 4 sold: 6 left carrying 900 of the original 1500.
    const assets = assetsFor([buy('AAPL', '10', '150'), sell('AAPL', '4', '180')]);
    const result = buildTransferPlan(assets, {
      equities: [{ symbol: 'AAPL', quantity: 6 }],
      options: [],
      cashUsd: 0,
    }, nextId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leg = result.plan.legs.find((item) => item.kind === 'equity');
    expect(leg).toMatchObject({ symbol: 'AAPL', quantity: '6', costBasisUsd: '900' });
    // The whole position leaving means the source keeps no basis at all, which
    // a rounded proportional split cannot be relied on to produce.
    expect(result.plan.movedCostBasis).toBe(900);
  });

  it('splits the cost basis proportionally when only part of a position moves', () => {
    const assets = assetsFor([buy('AAPL', '10', '150')]);
    const result = buildTransferPlan(assets, {
      equities: [{ symbol: 'AAPL', quantity: 4 }],
      options: [],
      cashUsd: 0,
    }, nextId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.legs[0]).toMatchObject({ costBasisUsd: '600', unitCostUsd: '150' });
  });

  it('keeps the earliest still-held acquisition date on the leg', () => {
    const assets = assetsFor([
      buy('AAPL', '5', '100', '2024-03-01T05:00:00.000Z'),
      buy('AAPL', '5', '200', '2026-01-05T05:00:00.000Z'),
    ]);
    const result = buildTransferPlan(assets, {
      equities: [{ symbol: 'AAPL', quantity: 10 }],
      options: [],
      cashUsd: 0,
    }, nextId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.legs[0]).toMatchObject({ acquiredAt: '2024-03-01T05:00:00.000Z' });
  });

  it('offers nothing for an option closed out in full', () => {
    const assets = assetsFor([optionRow('buy_to_open', '10', '3'), optionRow('sell_to_close', '10', '4')]);
    expect(assets.options).toEqual([]);
  });

  it('offers only the contracts left after a partial sell to close', () => {
    const assets = assetsFor([optionRow('buy_to_open', '10', '3'), optionRow('sell_to_close', '4', '4')]);
    expect(assets.options).toHaveLength(1);
    expect(assets.options[0].contracts).toBe(6);
  });

  it('offers nothing for a short position bought back in full', () => {
    const assets = assetsFor([
      optionRow('sell_to_open', '5', '3', 'short'),
      optionRow('buy_to_close', '5', '1', 'short'),
    ]);
    expect(assets.options).toEqual([]);
  });

  /*
   * A short call being assigned would sell the underlying, so it needs shares to
   * deliver; a short put being assigned buys them and needs none. The put is the
   * case that can be written as a ledger on its own, and the rule under test —
   * a settled position is not transferable — is the same either way.
   */
  it.each([
    ['expired', 'expired', 'long', 'call'],
    ['exercised', 'exercise', 'long', 'call'],
    ['assigned', 'assignment', 'short', 'put'],
  ] as const)('offers nothing for a position that was %s', (_label, closingType, side, kind) => {
    const assets = assetsFor([
      optionRow(side === 'short' ? 'sell_to_open' : 'buy_to_open', '3', '2', side, '2026-01-05T05:00:00.000Z', '2026-12-18', kind),
      optionRow(closingType, '3', '0', side, '2026-02-05T05:00:00.000Z', '2026-12-18', kind),
    ]);
    expect(assets.options).toEqual([]);
  });

  it('offers nothing for a contract whose expiration has passed, with or without an expiry row', () => {
    // No closing row at all — the position is open in the ledger and expired on
    // the calendar, which is the case an unrecorded expiry leaves behind.
    const assets = assetsFor(
      [optionRow('buy_to_open', '3', '2', 'long', '2026-01-05T05:00:00.000Z', '2026-02-20')],
      '2026-06-01',
    );
    expect(assets.options).toEqual([]);
  });

  it('keeps a closed position out of the transfer list while its history remains', () => {
    const transactions = [buy('AAPL', '10', '150'), sell('AAPL', '10', '180')];
    const summary = calculatePortfolio(transactions, {}, {}, '2026-06-01');
    expect(transferableAssets(summary).equities).toEqual([]);
    // The history is still there, and so is the gain it realized.
    expect(transactions).toHaveLength(2);
    expect(summary.realizedGain).toBe(300);
  });

  it('never builds a leg for a zero quantity', () => {
    const assets = assetsFor([buy('AAPL', '10', '150'), sell('AAPL', '10', '180')]);
    const result = buildTransferPlan(assets, {
      equities: [{ symbol: 'AAPL', quantity: 0 }],
      options: [],
      cashUsd: 0,
    }, nextId);
    expect(result.ok).toBe(false);
  });

  it('refuses an empty selection rather than writing nothing successfully', () => {
    const assets = assetsFor([buy('AAPL', '10', '150')]);
    expect(buildTransferPlan(assets, { equities: [], options: [], cashUsd: 0 }, nextId))
      .toEqual({ ok: false, error: 'nothing-selected' });
  });
});

describe('cash', () => {
  it('treats a negative balance as nothing to move, and says so', () => {
    const assets = assetsFor([
      row({ type: 'deposit', amount: '100' }),
      buy('AAPL', '10', '150'),
    ]);
    expect(assets.cashBalance).toBe(-1400);
    expect(assets.transferableCash).toBe(0);
    expect(assets.hasNegativeCash).toBe(true);
  });

  it('refuses to move more cash than the portfolio holds', () => {
    const assets = assetsFor([row({ type: 'deposit', amount: '100' })]);
    expect(buildTransferPlan(assets, { equities: [], options: [], cashUsd: 250 }, nextId))
      .toEqual({ ok: false, error: 'cash-exceeds-available' });
  });

  it('counts a shares-only portfolio with negative cash as having something to move', () => {
    const assets = assetsFor([row({ type: 'deposit', amount: '100' }), buy('AAPL', '10', '150')]);
    expect(assets.hasAnything).toBe(true);
    expect(assets.equities).toHaveLength(1);
  });
});

describe('the fingerprint the database re-derives', () => {
  it('records the whole position, not the slice being moved', () => {
    const assets = assetsFor([buy('AAPL', '10', '150')]);
    const result = buildTransferPlan(assets, {
      equities: [{ symbol: 'AAPL', quantity: 4 }],
      options: [],
      cashUsd: 0,
    }, nextId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.expectations).toEqual([{ kind: 'equity', key: 'AAPL', quantity: '10' }]);
  });

  it('signs a short option balance negative, matching the ledger', () => {
    const assets = assetsFor([optionRow('sell_to_open', '5', '3', 'short')]);
    const result = buildTransferPlan(assets, {
      equities: [],
      options: [{ key: assets.options[0].key, contracts: 5 }],
      cashUsd: 0,
    }, nextId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.expectations).toEqual([{ kind: 'option', key: CONTRACT, quantity: '-5' }]);
  });

  it('carries the contract identity in full so a lookalike cannot be substituted', () => {
    const assets = assetsFor([optionRow('buy_to_open', '6', '3')]);
    const result = buildTransferPlan(assets, {
      equities: [],
      options: [{ key: assets.options[0].key, contracts: 6 }],
      cashUsd: 0,
    }, nextId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.legs[0]).toMatchObject({
      kind: 'option',
      contractSymbol: CONTRACT,
      underlyingSymbol: 'AAPL',
      optionKind: 'call',
      optionSide: 'long',
      strikePrice: '200',
      expirationDate: '2026-12-18',
      multiplier: '100',
      quantity: '6',
    });
  });
});
