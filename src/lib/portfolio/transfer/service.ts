import 'server-only';

import { calculatePortfolio } from '../calculations';
import { PortfolioRepository } from '../repository';
import type { PortfolioRecord } from '../types';
import {
  buildTransferPlan,
  transferableAssets,
  type TransferPlan,
  type TransferPlanError,
  type TransferSelection,
  type TransferableAssets,
} from './plan';

/*
 * The server half of an asset move.
 *
 * Its whole job is to be the place amounts come from. The browser sends which
 * positions and how many of each; everything with a currency on it — the cost
 * basis leaving, the basis arriving, the average premium rebuilding a breakeven
 * — is derived here, from a ledger this process loaded, by the same engine the
 * portfolio page is drawn with. There is no path by which a client-supplied
 * number reaches a ledger row.
 *
 * Prices are deliberately absent. A transfer is not valued at market: it moves
 * cost basis. Market value appears in the preview so the reader can see the size
 * of what they are moving, and it is loaded only for that.
 */

export type TransferFailure =
  | { code: 'source-not-found' }
  | { code: 'destination-not-found' }
  | { code: 'same-portfolio' }
  | { code: 'destination-unavailable' }
  | { code: 'plan'; error: TransferPlanError; subject?: string };

export interface TransferContext {
  source: PortfolioRecord;
  destination: PortfolioRecord;
  assets: TransferableAssets;
}

/**
 * Resolves both ends and re-derives what the source holds.
 *
 * A destination that is archived or absent is refused here rather than at the
 * database, so the reader is told which end is the problem instead of being
 * handed one message that covers both.
 */
export function resolveTransferContext(
  portfolios: readonly PortfolioRecord[],
  sourceId: string,
  destinationId: string,
  marketPrices: Parameters<typeof calculatePortfolio>[1] = {},
  optionQuotes: Parameters<typeof calculatePortfolio>[2] = {},
): { ok: true; context: TransferContext } | { ok: false; failure: TransferFailure } {
  if (sourceId === destinationId) return { ok: false, failure: { code: 'same-portfolio' } };
  const source = portfolios.find((item) => item.id === sourceId);
  if (!source || source.deletedAt) return { ok: false, failure: { code: 'source-not-found' } };
  const destination = portfolios.find((item) => item.id === destinationId);
  if (!destination || destination.deletedAt) return { ok: false, failure: { code: 'destination-not-found' } };
  if (destination.archivedAt) return { ok: false, failure: { code: 'destination-unavailable' } };
  return {
    ok: true,
    context: {
      source,
      destination,
      assets: transferableAssets(calculatePortfolio(source.transactions, marketPrices, optionQuotes)),
    },
  };
}

export interface TransferPreview {
  sourceId: string;
  sourceName: string;
  destinationId: string;
  destinationName: string;
  plan: TransferPlan;
  /** Source cash after the move, which may legitimately be negative. */
  sourceCashAfter: number;
  destinationCashAfter: number;
  hasNegativeCash: boolean;
}

export function buildTransferPreview(
  context: TransferContext,
  destinationSummaryCash: number,
  selection: TransferSelection,
  mintId: () => string,
): { ok: true; preview: TransferPreview } | { ok: false; failure: TransferFailure } {
  const result = buildTransferPlan(context.assets, selection, mintId);
  if (!result.ok) {
    return { ok: false, failure: { code: 'plan', error: result.error, subject: result.subject } };
  }
  return {
    ok: true,
    preview: {
      sourceId: context.source.id,
      sourceName: context.source.name,
      destinationId: context.destination.id,
      destinationName: context.destination.name,
      plan: result.plan,
      sourceCashAfter: context.assets.cashBalance - result.plan.cashUsd,
      destinationCashAfter: destinationSummaryCash + result.plan.cashUsd,
      // Reported, never acted on. Moving shares out of a portfolio that owes
      // money does not settle the debt, and the interface has to say so before
      // somebody assumes it did.
      hasNegativeCash: context.assets.hasNegativeCash,
    },
  };
}

/**
 * Writes the plan. One RPC, one transaction, every leg or none.
 *
 * `groupId` is minted with the preview and replayed on confirm, which is what
 * makes a double submit idempotent: the second call finds the first call's rows
 * and reports `alreadyApplied` rather than writing a second set.
 */
export async function commitTransfer(
  repository: PortfolioRepository,
  input: {
    sourceId: string;
    destinationId: string;
    groupId: string;
    plan: TransferPlan;
    occurredAt: string;
    note?: string;
  },
): Promise<{ groupId: string; legsWritten: number; alreadyApplied: boolean }> {
  return repository.transferAssets({
    sourcePortfolioId: input.sourceId,
    destinationPortfolioId: input.destinationId,
    groupId: input.groupId,
    legs: input.plan.legs,
    expectations: input.plan.expectations,
    occurredAt: input.occurredAt,
    note: input.note,
  });
}

export interface PortfolioDeletionSummary {
  id: string;
  name: string;
  type: PortfolioRecord['type'];
  isLegacy: boolean;
  totalValue: number | null;
  cashBalance: number;
  hasNegativeCash: boolean;
  openHoldings: number;
  openOptionPositions: number;
  transactionCount: number;
  /** True when there is something a transfer could still rescue. */
  hasTransferableAssets: boolean;
  /** Live destinations, so the dialog never offers one that would be refused. */
  destinations: { id: string; name: string; type: PortfolioRecord['type'] }[];
  /** Refusals the database will make, surfaced before the reader commits. */
  isLastActive: boolean;
  /** The portfolio that becomes the Basic tier's writable one if this goes. */
  replacementWritableName: string | null;
}

/**
 * Everything the delete dialog states, recomputed from the ledger on open.
 *
 * The page already holds a summary, and this deliberately does not trust it: the
 * dialog is the last thing a reader sees before a portfolio disappears, and the
 * counts it shows must describe the portfolio as it is now, not as it was when
 * the tab was opened an hour ago.
 */
export function buildPortfolioDeletionSummary(
  portfolios: readonly PortfolioRecord[],
  portfolioId: string,
  marketPrices: Parameters<typeof calculatePortfolio>[1] = {},
  optionQuotes: Parameters<typeof calculatePortfolio>[2] = {},
): PortfolioDeletionSummary | null {
  const portfolio = portfolios.find((item) => item.id === portfolioId && !item.deletedAt);
  if (!portfolio) return null;
  const summary = calculatePortfolio(portfolio.transactions, marketPrices, optionQuotes);
  const assets = transferableAssets(summary);

  const live = portfolios.filter((item) => !item.deletedAt);
  const otherActive = live.filter((item) => item.id !== portfolioId && item.archivedAt === null);
  const stockReplacement = otherActive.find((item) => item.type === 'STOCK') ?? null;

  return {
    id: portfolio.id,
    name: portfolio.name,
    type: portfolio.type,
    isLegacy: portfolio.isLegacy,
    totalValue: summary.totalValue,
    cashBalance: summary.cashBalance,
    hasNegativeCash: assets.hasNegativeCash,
    openHoldings: assets.equities.length,
    openOptionPositions: assets.options.length,
    transactionCount: portfolio.transactions.length,
    hasTransferableAssets: assets.hasAnything,
    destinations: otherActive.map((item) => ({ id: item.id, name: item.name, type: item.type })),
    isLastActive: otherActive.length === 0,
    replacementWritableName: portfolio.type === 'STOCK' ? stockReplacement?.name ?? null : null,
  };
}
