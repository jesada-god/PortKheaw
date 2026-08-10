import type { PortfolioType } from './types';

/**
 * Where one "เพิ่มสินทรัพย์" entry point sends each kind of asset.
 *
 * Nothing here values, prices or accounts for anything — the ledger and every
 * calculation on top of it are untouched. This only answers "which portfolio
 * should receive the row the reader is about to write", so a single call to
 * action can offer both kinds no matter what the portfolio in front of them
 * happens to hold.
 */

export type AddAssetKind = 'stock' | 'option';

export interface AddAssetPortfolio {
  id: string;
  type: PortfolioType;
  archivedAt: string | null;
}

/**
 * Mirrors `public.assert_portfolio_accepts_transaction`: a STOCK portfolio
 * refuses option legs, an OPTION portfolio refuses share transactions, and a
 * LEGACY portfolio predates the split so it takes both. The database is still
 * what enforces this; the interface only uses it to avoid offering a write it
 * already knows would bounce.
 */
export function portfolioAcceptsAsset(type: PortfolioType, kind: AddAssetKind): boolean {
  return kind === 'option' ? type !== 'STOCK' : type !== 'OPTION';
}

/**
 * The portfolio on screen wins when it accepts the kind; otherwise the first
 * active portfolio that does — read in the order the repository returned, which
 * is the order the database resolves its own choices in.
 *
 * `null` means the account has nowhere to put this kind yet. That is a "create a
 * portfolio first" answer rather than a hidden or disabled choice: what a
 * portfolio already holds must never decide what can be added.
 */
export function addAssetDestinationId(
  portfolios: readonly AddAssetPortfolio[],
  kind: AddAssetKind,
  preferredId?: string,
): string | null {
  const usable = portfolios.filter(
    (item) => item.archivedAt === null && portfolioAcceptsAsset(item.type, kind),
  );
  return usable.find((item) => item.id === preferredId)?.id ?? usable[0]?.id ?? null;
}
