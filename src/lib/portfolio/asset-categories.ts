import { fixed, fixedToNumber, type Fixed } from '../money/fixed';
import type { OptionPositionSummary } from './options/types';
import type { HoldingSummary } from './types';

/**
 * Grouping only — never a second calculation.
 *
 * Every figure a category shows is a figure `calculatePortfolio` already
 * produced for the holding or the option position inside it. This module sums
 * them the way `aggregatePortfolioSummaries` sums portfolios: with the same
 * fixed-point arithmetic, and with a missing member collapsing the whole sum to
 * `null` rather than being quietly read as zero. There is no stored total here
 * and no snapshot; the categories are recomputed from the ledger-derived
 * summary on every render, exactly like the numbers they are made of.
 *
 * The keys are the asset types this product actually holds. Cash is a balance
 * the ledger keeps, Stock and ETF are the two `asset_type` values the
 * instrument master issues, and Options are the contract positions. Nothing
 * here invents a category the system cannot fill.
 */
export type AssetCategoryKey = 'cash' | 'stock' | 'etf' | 'option';

export const ASSET_CATEGORY_LABELS: Record<AssetCategoryKey, string> = {
  cash: 'เงินสด',
  stock: 'หุ้นสหรัฐฯ',
  etf: 'ETF',
  option: 'ออปชันหุ้นสหรัฐฯ',
};

export interface HoldingEntry {
  portfolioId: string;
  portfolioName: string;
  holding: HoldingSummary;
}

export interface OptionEntry {
  portfolioId: string;
  portfolioName: string;
  position: OptionPositionSummary;
}

export interface CashEntry {
  portfolioId: string;
  portfolioName: string;
  balance: number;
}

export interface AssetCategoryGroup {
  key: AssetCategoryKey;
  label: string;
  /** Assets counted the way the reader counts them: one per holding, one per open contract, one per funded portfolio. */
  count: number;
  value: number | null;
  todayChange: number | null;
  unrealizedGain: number | null;
  /** True when at least one member has no verified price, so the sum is `null` on purpose. */
  hasMissingPrices: boolean;
  holdings: HoldingEntry[];
  positions: OptionEntry[];
  cash: CashEntry[];
}

function sumNullable(values: Array<number | null>): number | null {
  if (values.length === 0) return 0;
  if (values.some((value) => value === null)) return null;
  return fixedToNumber((values as number[]).reduce<Fixed>((total, value) => total + fixed(value), 0n));
}

function sum(values: number[]): number {
  return fixedToNumber(values.reduce<Fixed>((total, value) => total + fixed(value), 0n));
}

/**
 * Which of the two instrument-master asset types a symbol is.
 *
 * Anything the master has not classified reads as a stock, which is the same
 * fallback `getInstrumentMetadata` itself applies — a holding never disappears
 * from the screen because its classification has not synced yet.
 */
export function assetCategoryForSymbol(
  symbol: string,
  assetTypeBySymbol: Record<string, string | null | undefined>,
): Extract<AssetCategoryKey, 'stock' | 'etf'> {
  return (assetTypeBySymbol[symbol] ?? '').toUpperCase() === 'ETF' ? 'etf' : 'stock';
}

export function buildAssetCategories({
  cash,
  holdings,
  options,
  assetTypeBySymbol,
}: {
  cash: CashEntry[];
  holdings: HoldingEntry[];
  options: OptionEntry[];
  assetTypeBySymbol: Record<string, string | null | undefined>;
}): AssetCategoryGroup[] {
  const equityByCategory: Record<'stock' | 'etf', HoldingEntry[]> = { stock: [], etf: [] };
  for (const entry of holdings) {
    equityByCategory[assetCategoryForSymbol(entry.holding.symbol, assetTypeBySymbol)].push(entry);
  }
  // Closed and expired contracts are history, not holdings, so they are not
  // assets to count — the same rule `portfolioAssetCount` already applies.
  const openOptions = options.filter((entry) => entry.position.status === 'open');
  const fundedCash = cash.filter((entry) => entry.balance !== 0);

  const groups: AssetCategoryGroup[] = [
    {
      key: 'cash',
      label: ASSET_CATEGORY_LABELS.cash,
      count: fundedCash.length,
      value: sum(fundedCash.map((entry) => entry.balance)),
      todayChange: 0,
      unrealizedGain: null,
      hasMissingPrices: false,
      holdings: [],
      positions: [],
      cash: fundedCash,
    },
    ...(['stock', 'etf'] as const).map((key) => {
      const entries = equityByCategory[key];
      return {
        key,
        label: ASSET_CATEGORY_LABELS[key],
        count: entries.length,
        value: sumNullable(entries.map((entry) => entry.holding.marketValue)),
        todayChange: sumNullable(entries.map((entry) => entry.holding.todayChange)),
        unrealizedGain: sumNullable(entries.map((entry) => entry.holding.unrealizedGain)),
        hasMissingPrices: entries.some((entry) => entry.holding.marketValue === null),
        holdings: entries,
        positions: [],
        cash: [],
      } satisfies AssetCategoryGroup;
    }),
    {
      key: 'option',
      label: ASSET_CATEGORY_LABELS.option,
      count: openOptions.length,
      value: sumNullable(openOptions.map((entry) => entry.position.marketValue)),
      todayChange: sumNullable(openOptions.map((entry) => entry.position.todayChange)),
      unrealizedGain: sumNullable(openOptions.map((entry) => entry.position.unrealizedGain)),
      hasMissingPrices: openOptions.some((entry) => entry.position.marketValue === null),
      holdings: [],
      positions: openOptions,
      cash: [],
    },
  ];

  // An empty category is not a category. A reader with no ETFs is not told
  // about a zero-value ETF row they never asked for.
  return groups.filter((group) => group.count > 0);
}
