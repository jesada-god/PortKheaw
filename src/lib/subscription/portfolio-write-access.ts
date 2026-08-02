import type { SubscriptionTier } from './subscription-types';

/**
 * Which portfolios a tier may still write to.
 *
 * This mirrors `public.assert_portfolio_writable` so the interface can explain
 * itself before a reader tries something. It is never the enforcement: the
 * database refuses the write regardless of what this returns, and a disagreement
 * shows up as a rejected action rather than as data written by mistake.
 */

export type PortfolioWriteBlock = 'read-only' | 'upgrade';

export interface WritablePortfolioInput {
  id: string;
  type: 'STOCK' | 'OPTION' | 'LEGACY';
  archivedAt: string | null;
}

/**
 * The oldest active stock portfolio, matching the database's
 * `order by created_at, id`. The portfolio repository already returns rows in
 * exactly that order, so position in the list is the tiebreak — the caller must
 * not re-sort before calling this.
 */
export function basicWritableStockPortfolioId(
  portfolios: readonly WritablePortfolioInput[],
): string | null {
  return portfolios.find((item) => item.type === 'STOCK' && item.archivedAt === null)?.id ?? null;
}

/**
 * `null` means the portfolio accepts writes. Otherwise it names why not:
 * `upgrade` for a capability the tier does not have at all, `read-only` for one
 * it has but has run past the limit of.
 */
export function portfolioWriteBlock(
  tier: SubscriptionTier,
  portfolio: WritablePortfolioInput,
  writableStockId: string | null,
): PortfolioWriteBlock | null {
  if (tier !== 'basic') return null;
  if (portfolio.type === 'OPTION') return 'upgrade';
  if (portfolio.type === 'STOCK' && portfolio.id !== writableStockId) return 'read-only';
  return null;
}
