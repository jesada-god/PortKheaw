import { fixed, fixedDivide, fixedToString, type Fixed } from '../../money/fixed';
import type { OptionPositionSummary } from '../options/types';
import type { PortfolioSummary } from '../types';

/*
 * What can be moved out of a portfolio, and what moving it costs.
 *
 * Every number here is read from a `PortfolioSummary` — the output of the
 * canonical ledger replay — and never from a transaction list directly. That is
 * the whole point: "has ever been bought" and "is still held" are different
 * questions, and only the replay can answer the second one. A holding sold down
 * to zero simply is not in `summary.holdings`; an option closed, exercised,
 * assigned or expired is in `summary.optionPositions` with a status that is not
 * `open`. Reading the ledger for "did they buy AAPL" would offer to move shares
 * that were sold last year.
 *
 * Pure, and deliberately so. The server calls it to build the plan it writes;
 * the interface calls it to decide whether to offer the move at all. One
 * definition of "transferable", so the button and the write agree.
 */

export interface TransferableEquity {
  symbol: string;
  /** Net open quantity from the replay. Always greater than zero. */
  quantity: number;
  costBasis: number;
  marketValue: number | null;
  /** Earliest still-held acquisition, carried across so the date survives. */
  acquiredAt: string | null;
}

export interface TransferableOption {
  key: string;
  contractSymbol: string;
  underlyingSymbol: string;
  optionKind: 'call' | 'put';
  side: 'long' | 'short';
  strikePrice: number;
  expirationDate: string;
  multiplier: number;
  /** Open contracts after every close, exercise, assignment and expiry. */
  contracts: number;
  remainingCost: number;
  averagePremium: number;
  marketValue: number | null;
}

export interface TransferableAssets {
  equities: TransferableEquity[];
  options: TransferableOption[];
  cashBalance: number;
  /** Zero when the balance is negative: a debt is not an asset to move. */
  transferableCash: number;
  hasNegativeCash: boolean;
  /** False for a portfolio that holds only closed history. */
  hasAnything: boolean;
}

export function transferableAssets(summary: PortfolioSummary): TransferableAssets {
  const equities = summary.holdings
    .filter((holding) => holding.quantity > 0)
    .map((holding) => ({
      symbol: holding.symbol,
      quantity: holding.quantity,
      costBasis: holding.costBasis,
      marketValue: holding.marketValue,
      acquiredAt: holding.lots
        .filter((lot) => lot.remainingQuantity > 0)
        .map((lot) => lot.occurredAt)
        .sort()[0] ?? null,
    }));

  const options = summary.optionPositions
    /*
     * `status === 'open'` is the one test, and it is doing more work than it
     * looks. The ledger replay sets it to `closed` once the contract count
     * reaches zero — which is what a completed sell-to-close, buy-to-close,
     * exercise or assignment leaves behind — and to `expired` once the
     * expiration date has passed, whether or not anybody recorded an expiry
     * row. Every case the product must refuse is that one field.
     */
    .filter((position) => position.status === 'open' && position.contracts > 0)
    .map((position) => ({
      key: position.key,
      contractSymbol: position.contractSymbol,
      underlyingSymbol: position.underlyingSymbol,
      optionKind: position.optionKind,
      side: position.side,
      strikePrice: position.strikePrice,
      expirationDate: position.expirationDate,
      multiplier: position.multiplier,
      contracts: position.contracts,
      remainingCost: position.remainingCost,
      averagePremium: position.averagePremium,
      marketValue: position.marketValue,
    }));

  const cashBalance = summary.cashBalance;
  return {
    equities,
    options,
    cashBalance,
    // A negative balance is a debt, and moving a debt is not moving an asset.
    // It stays exactly where it was incurred; the interface says so rather than
    // silently carrying it or silently clearing it.
    transferableCash: cashBalance > 0 ? cashBalance : 0,
    hasNegativeCash: cashBalance < 0,
    hasAnything: equities.length > 0 || options.length > 0 || cashBalance > 0,
  };
}

/** What the reader asked to move. Quantities only — never amounts. */
export interface TransferSelection {
  equities: { symbol: string; quantity: number }[];
  options: { key: string; contracts: number }[];
  cashUsd: number;
}

export type TransferLeg =
  | { kind: 'cash'; transferId: string; quantity: string; costBasisUsd: string }
  | {
    kind: 'equity';
    transferId: string;
    symbol: string;
    quantity: string;
    unitCostUsd: string;
    costBasisUsd: string;
    acquiredAt: string | null;
  }
  | {
    kind: 'option';
    transferId: string;
    contractSymbol: string;
    underlyingSymbol: string;
    optionKind: 'call' | 'put';
    optionSide: 'long' | 'short';
    strikePrice: string;
    expirationDate: string;
    multiplier: string;
    quantity: string;
    unitCostUsd: string;
    costBasisUsd: string;
    acquiredAt: string | null;
  };

/** One entry per position touched, re-derived by the database before writing. */
export type TransferExpectation =
  | { kind: 'equity'; key: string; quantity: string }
  | { kind: 'option'; key: string; quantity: string };

export interface TransferPlanLine {
  kind: 'cash' | 'equity' | 'option';
  label: string;
  detail: string;
  quantity: number;
  costBasis: number;
  marketValue: number | null;
  /** True when the whole position moves and the source keeps nothing. */
  whole: boolean;
}

export interface TransferPlan {
  legs: TransferLeg[];
  expectations: TransferExpectation[];
  lines: TransferPlanLine[];
  movedCostBasis: number;
  movedMarketValue: number | null;
  cashUsd: number;
}

export type TransferPlanError =
  | 'nothing-selected'
  | 'unknown-position'
  | 'quantity-exceeds-open'
  | 'quantity-not-positive'
  | 'cash-exceeds-available';

export type TransferPlanResult =
  | { ok: true; plan: TransferPlan }
  | { ok: false; error: TransferPlanError; subject?: string };

/**
 * Splits a cost basis proportionally, the same way the ledger replay does when
 * a position is partly disposed of — and, critically, returns the *whole*
 * remaining basis when the whole position moves rather than a rounded fraction
 * of it. A position that leaves entirely must leave nothing behind, and
 * `basis * quantity / quantity` is not reliably `basis` in fixed-point.
 */
function proportionalBasis(basis: Fixed, moved: Fixed, available: Fixed): Fixed {
  if (moved >= available) return basis;
  const product = basis * moved;
  return (product + (product >= 0n ? available / 2n : -(available / 2n))) / available;
}

/**
 * Turns a selection into the exact rows the database will write.
 *
 * The caller supplies `mintId` so the leg identifiers are stable for one plan:
 * the same plan submitted twice carries the same ids and the same group, which
 * is what makes a double submit land on the first write instead of beside it.
 */
export function buildTransferPlan(
  assets: TransferableAssets,
  selection: TransferSelection,
  mintId: () => string,
): TransferPlanResult {
  const legs: TransferLeg[] = [];
  const expectations: TransferExpectation[] = [];
  const lines: TransferPlanLine[] = [];
  let movedCostBasis = 0n;
  let movedMarketValue = 0n;
  let missingMarketValue = false;

  for (const request of selection.equities) {
    const holding = assets.equities.find((item) => item.symbol === request.symbol);
    if (!holding) return { ok: false, error: 'unknown-position', subject: request.symbol };
    if (!(request.quantity > 0)) return { ok: false, error: 'quantity-not-positive', subject: request.symbol };
    if (request.quantity > holding.quantity) {
      return { ok: false, error: 'quantity-exceeds-open', subject: request.symbol };
    }
    const available = fixed(holding.quantity);
    const moving = fixed(request.quantity);
    const basis = proportionalBasis(fixed(holding.costBasis), moving, available);
    const whole = moving >= available;
    const value = holding.marketValue === null
      ? null
      : whole ? fixed(holding.marketValue) : proportionalBasis(fixed(holding.marketValue), moving, available);
    if (value === null) missingMarketValue = true;
    else movedMarketValue += value;
    movedCostBasis += basis;

    legs.push({
      kind: 'equity',
      transferId: mintId(),
      symbol: holding.symbol,
      quantity: fixedToString(moving),
      // Display only. The basis above is the authority; a unit price recomputed
      // at either end would round the two ledgers apart.
      unitCostUsd: fixedToString(fixedDivide(basis, moving)),
      costBasisUsd: fixedToString(basis),
      acquiredAt: holding.acquiredAt,
    });
    // The fingerprint records what the *whole* position looked like, not the
    // slice being moved: the question it has to answer later is "is this still
    // the position I previewed?", and a partial sale changes the whole and not
    // the slice.
    expectations.push({ kind: 'equity', key: holding.symbol, quantity: fixedToString(available) });
    lines.push({
      kind: 'equity',
      label: holding.symbol,
      detail: `${request.quantity} หน่วย`,
      quantity: request.quantity,
      costBasis: Number(fixedToString(basis)),
      marketValue: value === null ? null : Number(fixedToString(value)),
      whole,
    });
  }

  for (const request of selection.options) {
    const position = assets.options.find((item) => item.key === request.key);
    if (!position) return { ok: false, error: 'unknown-position', subject: request.key };
    if (!(request.contracts > 0)) {
      return { ok: false, error: 'quantity-not-positive', subject: position.contractSymbol };
    }
    if (request.contracts > position.contracts) {
      return { ok: false, error: 'quantity-exceeds-open', subject: position.contractSymbol };
    }
    const available = fixed(position.contracts);
    const moving = fixed(request.contracts);
    const basis = proportionalBasis(fixed(position.remainingCost), moving, available);
    const whole = moving >= available;
    const value = position.marketValue === null
      ? null
      : whole ? fixed(position.marketValue) : proportionalBasis(fixed(position.marketValue), moving, available);
    if (value === null) missingMarketValue = true;
    else movedMarketValue += value;
    movedCostBasis += basis;

    legs.push({
      kind: 'option',
      transferId: mintId(),
      contractSymbol: position.contractSymbol,
      underlyingSymbol: position.underlyingSymbol,
      optionKind: position.optionKind,
      optionSide: position.side,
      strikePrice: String(position.strikePrice),
      expirationDate: position.expirationDate,
      multiplier: String(position.multiplier),
      quantity: fixedToString(moving),
      // The average premium per share, which is what rebuilds the destination's
      // breakeven. Not a price quote and not the cost — those are the other two
      // numbers on this leg.
      unitCostUsd: fixedToString(fixed(position.averagePremium)),
      costBasisUsd: fixedToString(basis),
      acquiredAt: null,
    });
    // Signed, matching the database: a short position is a negative balance, and
    // comparing an unsigned count would let a short and a long of the same size
    // look identical.
    expectations.push({
      kind: 'option',
      key: position.contractSymbol,
      quantity: fixedToString(position.side === 'short' ? -available : available),
    });
    lines.push({
      kind: 'option',
      label: position.contractSymbol,
      detail: `${request.contracts} สัญญา`,
      quantity: request.contracts,
      costBasis: Number(fixedToString(basis)),
      marketValue: value === null ? null : Number(fixedToString(value)),
      whole,
    });
  }

  if (selection.cashUsd > 0) {
    if (selection.cashUsd > assets.transferableCash) {
      return { ok: false, error: 'cash-exceeds-available' };
    }
    const amount = fixed(selection.cashUsd);
    legs.push({
      kind: 'cash',
      transferId: mintId(),
      quantity: fixedToString(amount),
      costBasisUsd: fixedToString(amount),
    });
    lines.push({
      kind: 'cash',
      label: 'เงินสด',
      detail: 'ย้ายเงินสดระหว่างพอร์ต',
      quantity: selection.cashUsd,
      costBasis: selection.cashUsd,
      marketValue: selection.cashUsd,
      whole: selection.cashUsd >= assets.transferableCash,
    });
  }

  if (legs.length === 0) return { ok: false, error: 'nothing-selected' };

  const cashUsd = selection.cashUsd > 0 ? selection.cashUsd : 0;
  return {
    ok: true,
    plan: {
      legs,
      expectations,
      lines,
      movedCostBasis: Number(fixedToString(movedCostBasis)),
      movedMarketValue: missingMarketValue ? null : Number(fixedToString(movedMarketValue + fixed(cashUsd))),
      cashUsd,
    },
  };
}
