/**
 * "วันนี้พอร์ตเป็นยังไง?" — one card's worth of facts about today.
 *
 * Every number here is READ, never computed: `PortfolioSummary` already carries
 * today's change for the portfolio, for each holding and for each option
 * position, because the ledger replay in `calculatePortfolio` produced them from
 * the same accepted quotes the rest of the page shows. This module groups and
 * ranks what is already there and nothing else — there is no second valuation
 * path, no re-derivation from prices, and no estimate.
 *
 * What is missing stays missing. A holding whose quote had no previous close has
 * `todayChange === null` and is simply not a candidate; a symbol the instrument
 * master has no sector for takes no part in the sector line; a portfolio with no
 * priced movement at all produces an insight with every field null, which the
 * card renders as nothing rather than as zero.
 */

import type { OptionPositionSummary } from './options/types';
import type { PortfolioSummary } from './types';

/** How soon an option expiry is worth interrupting the reader about. */
export const EXPIRY_HORIZON_DAYS = 7;

export interface DailyInsightMover {
  symbol: string;
  /** Today's contribution in USD. Positive helped, negative dragged. */
  change: number;
}

export interface DailyInsightSector {
  name: string;
  change: number;
  /** Symbols that made up the group, so the detail view can name them. */
  symbols: string[];
}

export interface DailyInsightExpiry {
  contractSymbol: string;
  underlyingSymbol: string;
  /** Whole days to expiration, straight off the option ledger. */
  dte: number;
}

export interface PortfolioDailyInsight {
  /** Today's move for the whole portfolio, or null when it cannot be priced. */
  today: { change: number; changePercent: number | null } | null;
  /** The single largest positive contributor, when one exists. */
  contributor: DailyInsightMover | null;
  /** The single largest negative contributor, when one exists. */
  detractor: DailyInsightMover | null;
  /** The sector whose combined move was largest in absolute terms. */
  sector: DailyInsightSector | null;
  /** Open contracts expiring inside the horizon, soonest first. */
  expiries: DailyInsightExpiry[];
  /** Every priced holding, largest absolute move first — the drill-down. */
  movers: DailyInsightMover[];
  /** False when there is nothing at all to say, so the card can stay away. */
  hasContent: boolean;
}

function mergeHoldings(summary: PortfolioSummary): DailyInsightMover[] {
  /*
   * One row per symbol, not per portfolio. An aggregate summary is the
   * concatenation of every portfolio's holdings, so the same symbol held in two
   * portfolios arrives twice and would otherwise compete with itself for the
   * "helped most" line while understating its real contribution.
   */
  const bySymbol = new Map<string, number>();
  for (const holding of summary.holdings) {
    if (holding.todayChange === null || !Number.isFinite(holding.todayChange)) continue;
    bySymbol.set(holding.symbol, (bySymbol.get(holding.symbol) ?? 0) + holding.todayChange);
  }
  return [...bySymbol]
    .map(([symbol, change]) => ({ symbol, change }))
    .sort((left, right) =>
      Math.abs(right.change) - Math.abs(left.change) || left.symbol.localeCompare(right.symbol));
}

function largestSector(
  movers: readonly DailyInsightMover[],
  sectorBySymbol: Readonly<Record<string, string | null | undefined>>,
): DailyInsightSector | null {
  const groups = new Map<string, { change: number; symbols: string[] }>();
  for (const mover of movers) {
    const sector = sectorBySymbol[mover.symbol];
    // No classification means no claim. A holding the instrument master has not
    // classified is left out of every group rather than pooled into "อื่น ๆ".
    if (!sector) continue;
    const group = groups.get(sector) ?? { change: 0, symbols: [] };
    group.change += mover.change;
    group.symbols.push(mover.symbol);
    groups.set(sector, group);
  }
  const ranked = [...groups]
    .filter(([, group]) => group.change !== 0)
    .sort((left, right) =>
      Math.abs(right[1].change) - Math.abs(left[1].change) || left[0].localeCompare(right[0]));
  const best = ranked[0];
  if (!best) return null;
  return { name: best[0], change: best[1].change, symbols: best[1].symbols };
}

function nearExpiries(positions: readonly OptionPositionSummary[]): DailyInsightExpiry[] {
  return positions
    .filter((position) =>
      position.status === 'open'
      && Number.isFinite(position.dte)
      && position.dte >= 0
      && position.dte <= EXPIRY_HORIZON_DAYS)
    .sort((left, right) => left.dte - right.dte || left.contractSymbol.localeCompare(right.contractSymbol))
    .map((position) => ({
      contractSymbol: position.contractSymbol,
      underlyingSymbol: position.underlyingSymbol,
      dte: position.dte,
    }));
}

export function buildPortfolioDailyInsight({
  summary,
  sectorBySymbol = {},
}: {
  summary: PortfolioSummary;
  /**
   * `sector` off the instrument master, for the symbols the page already
   * priced. Not a lookup this module performs and not a classification it
   * invents — omitted symbols simply do not appear in the sector line.
   */
  sectorBySymbol?: Readonly<Record<string, string | null | undefined>>;
}): PortfolioDailyInsight {
  const movers = mergeHoldings(summary);
  const gainers = movers.filter((mover) => mover.change > 0);
  const losers = movers.filter((mover) => mover.change < 0);
  const today = summary.todayChange === null || !Number.isFinite(summary.todayChange)
    ? null
    : {
      change: summary.todayChange,
      changePercent: summary.todayChangePercent === null || !Number.isFinite(summary.todayChangePercent)
        ? null
        : summary.todayChangePercent,
    };
  const contributor = gainers
    .reduce<DailyInsightMover | null>((best, mover) => best && best.change >= mover.change ? best : mover, null);
  const detractor = losers
    .reduce<DailyInsightMover | null>((worst, mover) => worst && worst.change <= mover.change ? worst : mover, null);
  const sector = largestSector(movers, sectorBySymbol);
  const expiries = nearExpiries(summary.optionPositions);

  return {
    today,
    contributor,
    detractor,
    sector,
    expiries,
    movers,
    hasContent: today !== null || contributor !== null || detractor !== null || expiries.length > 0,
  };
}
