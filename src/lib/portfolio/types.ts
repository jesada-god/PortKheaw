export const transactionTypes = [
  'acquisition',
  'disposal',
  'initial_position',
  'dividend',
  'deposit',
  'withdrawal',
  'fee',
  'adjustment',
  'transfer_out',
  'transfer_in',
  'buy_to_open',
  'sell_to_close',
  'sell_to_open',
  'buy_to_close',
  'exercise',
  'assignment',
  'expired',
] as const;

export type PortfolioTransactionType = typeof transactionTypes[number];
export type OptionTransactionType = Extract<PortfolioTransactionType,
  'buy_to_open' | 'sell_to_close' | 'sell_to_open' | 'buy_to_close' | 'exercise' | 'assignment' | 'expired'>;
export type OptionSide = 'long' | 'short';
export type OptionKind = 'call' | 'put';
export type PortfolioType = 'STOCK' | 'OPTION' | 'LEGACY';

export interface PortfolioTransaction {
  id: string;
  portfolioId: string;
  type: PortfolioTransactionType;
  symbol: string | null;
  quantity: string | null;
  price: string | null;
  amount: string | null;
  originalAmount?: string | null;
  originalCurrency?: 'THB' | 'USD';
  fxRateAtTransaction?: string | null;
  normalizedAmountUsd?: string | null;
  normalizedPriceUsd?: string | null;
  fee?: string | null;
  normalizedFeeUsd?: string | null;
  /**
   * How the fee on this row was entered, not a second fee. `fee` is always the
   * whole order's, so every calculation reads that and this reads as 'total' on
   * every row written before the fee box existed.
   */
  feeMode?: 'total' | 'per_contract';
  broker?: string | null;
  occurredAtTime?: string;
  underlyingSymbol?: string | null;
  contractSymbol?: string | null;
  optionKind?: OptionKind | null;
  optionSide?: OptionSide | null;
  strikePrice?: string | null;
  expirationDate?: string | null;
  multiplier?: string | null;
  transferId?: string | null;
  counterpartyPortfolioId?: string | null;
  /**
   * Every leg of one move shares this. A move of three holdings and some cash is
   * eight rows across two portfolios and one `transferGroupId`.
   */
  transferGroupId?: string | null;
  /**
   * The cost basis travelling with an asset leg, in canonical USD, and `null` on
   * a cash leg. Deliberately not `amount`: `amount` is what every cash reader in
   * the codebase treats as money moving, and an asset transfer moves no cash.
   */
  transferCostBasisUsd?: string | null;
  /** When the transferred position was originally acquired, carried across. */
  transferAcquiredAt?: string | null;
  /**
   * Portfolio names as they read at transfer time. They survive the purge of the
   * portfolio they name, which is the only reason a destination can still say
   * where its shares came from once the source is gone.
   */
  transferSourceName?: string | null;
  transferDestinationName?: string | null;
  occurredAt: string;
  note: string | null;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioRecord {
  id: string;
  name: string;
  type: PortfolioType;
  isLegacy: boolean;
  archivedAt: string | null;
  /**
   * Set only on a soft-deleted portfolio, which no ordinary read ever returns.
   * Kept on the record so the one surface that *does* list them — recently
   * deleted — reads the same shape as everything else.
   */
  deletedAt: string | null;
  purgeAfter: string | null;
  targetValueUsd: number | null;
  targetDate: string | null;
  baseCurrency: 'THB' | 'USD';
  transactions: PortfolioTransaction[];
}

/** A portfolio inside its recovery window, listed without its ledger. */
export interface DeletedPortfolioSummary {
  id: string;
  name: string;
  type: PortfolioType;
  deletedAt: string;
  purgeAfter: string;
}

/**
 * What a reset actually cleared. Counted by the database as it deleted, so a
 * second reset of the same portfolio honestly reports zeros rather than
 * repeating the first one's numbers.
 */
export interface PortfolioResetOutcome {
  transactionsRemoved: number;
  optionPositionsRemoved: number;
  optionTargetsRemoved: number;
  goalCleared: boolean;
}

export interface PortfolioGoal {
  targetValueUsd: number | null;
  targetDate: string | null;
}

export interface GoalProgress {
  progressPercent: number | null;
  remainingAmount: number | null;
  status: 'unset' | 'unavailable' | 'negative' | 'tracking' | 'reached';
  reason: string | null;
}

export interface HoldingSummary {
  symbol: string;
  quantity: number;
  averageCost: number;
  costBasis: number;
  marketPrice: number | null;
  marketValue: number | null;
  realizedGain: number;
  unrealizedGain: number | null;
  allocation: number;
  priceCached: boolean;
  priceStale: boolean;
  priceSource: string | null;
  priceAsOf: string | null;
  todayChange: number | null;
  todayChangePercent: number | null;
  lots: HoldingLot[];
  transactions: PortfolioTransaction[];
}

export interface HoldingLot {
  transactionId: string;
  occurredAt: string;
  originalQuantity: number;
  remainingQuantity: number;
  unitCost: number;
  remainingCost: number;
  fee: number;
  broker: string | null;
}

export interface PortfolioSummary {
  holdings: HoldingSummary[];
  cashBalance: number;
  marketValue: number | null;
  costBasis: number;
  realizedGain: number;
  unrealizedGain: number | null;
  totalValue: number | null;
  equityMarketValue: number | null;
  optionsMarketValue: number | null;
  optionRemainingCost: number;
  netDepositedCapital: number;
  netTransferredCapital: number;
  totalGain: number | null;
  totalGainPercent: number | null;
  todayChange: number | null;
  todayChangePercent: number | null;
  optionPositions: import('./options/types').OptionPositionSummary[];
  hasMissingPrices: boolean;
}

export interface MarketPriceInput {
  price: string | number;
  previousClose?: string | number | null;
  cached?: boolean;
  stale?: boolean;
  asOf?: string | null;
  source?: string | null;
}
