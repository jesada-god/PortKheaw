import { describe, expect, it } from 'vitest';
import { addAssetDestinationId, portfolioAcceptsAsset, type AddAssetPortfolio } from './add-asset';

function portfolio(id: string, type: AddAssetPortfolio['type'], archivedAt: string | null = null): AddAssetPortfolio {
  return { id, type, archivedAt };
}

describe('what a portfolio may receive', () => {
  /*
   * These four rows are `assert_portfolio_accepts_transaction` restated. If the
   * migration's lists ever change, this is what should fail — the interface is
   * explaining a database rule, not inventing one.
   */
  it('mirrors the database: STOCK refuses options, OPTION refuses shares, LEGACY takes both', () => {
    expect(portfolioAcceptsAsset('STOCK', 'stock')).toBe(true);
    expect(portfolioAcceptsAsset('STOCK', 'option')).toBe(false);
    expect(portfolioAcceptsAsset('OPTION', 'option')).toBe(true);
    expect(portfolioAcceptsAsset('OPTION', 'stock')).toBe(false);
    expect(portfolioAcceptsAsset('LEGACY', 'stock')).toBe(true);
    expect(portfolioAcceptsAsset('LEGACY', 'option')).toBe(true);
  });
});

describe('where an added asset lands', () => {
  const portfolios = [
    portfolio('stock-1', 'STOCK'),
    portfolio('stock-2', 'STOCK'),
    portfolio('option-1', 'OPTION'),
  ];

  it('keeps the reader in the portfolio they are looking at when it accepts the kind', () => {
    expect(addAssetDestinationId(portfolios, 'stock', 'stock-2')).toBe('stock-2');
    expect(addAssetDestinationId(portfolios, 'option', 'option-1')).toBe('option-1');
  });

  /*
   * The whole point of one call to action: standing in a stock portfolio must
   * not remove the ability to add an option, and the reverse.
   */
  it('moves to a portfolio that accepts the kind when the one on screen cannot', () => {
    expect(addAssetDestinationId(portfolios, 'option', 'stock-2')).toBe('option-1');
    expect(addAssetDestinationId(portfolios, 'stock', 'option-1')).toBe('stock-1');
  });

  it('never lands a new row in an archived portfolio', () => {
    const archived = [portfolio('option-old', 'OPTION', '2026-01-01T00:00:00.000Z'), portfolio('option-2', 'OPTION')];
    expect(addAssetDestinationId(archived, 'option', 'option-old')).toBe('option-2');
  });

  it('answers null when the account has nowhere to put the kind yet', () => {
    expect(addAssetDestinationId([portfolio('stock-1', 'STOCK')], 'option')).toBeNull();
    expect(addAssetDestinationId([], 'stock')).toBeNull();
  });
});
