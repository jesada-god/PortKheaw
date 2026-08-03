import { z } from 'zod';

export const marketDataStatusSchema = z.enum(['live', 'delayed', 'cached', 'stale']);
export type MarketDataStatus = z.infer<typeof marketDataStatusSchema>;

export const marketTimestampKindSchema = z.enum(['exchange', 'provider', 'receipt']);
export type MarketTimestampKind = z.infer<typeof marketTimestampKindSchema>;

const nullableFinite = z.number().finite().nullable();
const nullableNonnegative = z.number().finite().nonnegative().nullable();
const nullableInteger = z.number().int().nonnegative().nullable();

/**
 * Where a contract's IV/Greeks came from. `provider` means the upstream supplied
 * them; `nexora-derived` means they were solved from the contract's own observed
 * market price and must be labelled as calculated in the UI. `null` means the
 * fields are simply unavailable and render as "—".
 */
export const optionValuationSourceSchema = z.enum(['provider', 'nexora-derived']).nullable();
export type OptionValuationSource = z.infer<typeof optionValuationSourceSchema>;

const optionLedgerContractShape = {
  contractSymbol: z.string().min(1),
  underlyingSymbol: z.string().min(1),
  type: z.enum(['call', 'put']),
  expiration: z.iso.date(),
  strike: z.number().finite().positive(),
  bid: nullableNonnegative,
  ask: nullableNonnegative,
  last: nullableNonnegative,
  mark: nullableNonnegative,
  volume: nullableInteger,
  openInterest: nullableInteger,
  inTheMoney: z.boolean().nullable(),
  multiplier: z.number().finite().positive(),
  currency: z.string().min(3).max(8),
  /** Catalogue provider: the authority for identity, strike, expiration and OI. */
  provider: z.string().min(1),
  /**
   * Quote/trade/Greeks provider, when a separate market-data source was merged
   * onto the catalogue row. Null when only the catalogue answered.
   */
  marketDataProvider: z.string().min(1).nullable().default(null),
  /** Upstream feed the market data came from, e.g. `indicative`. Disclosed, never assumed. */
  marketDataFeed: z.string().min(1).nullable().default(null),
  asOf: z.iso.datetime(),
  /** Settlement date of the end-of-day open interest, as dated by the provider. */
  oiAsOf: z.iso.date().nullable().default(null),
  timestampKind: marketTimestampKindSchema,
  status: marketDataStatusSchema,
  delayedMinutes: z.number().int().nonnegative().nullable().default(null),
};

/**
 * The Pro wire contract. IV, Greeks and their valuation provenance are absent
 * from this schema, so validation cannot add locked field names to a response.
 */
export const optionLedgerContractSchema = z.object(optionLedgerContractShape).superRefine((contract, context) => {
  if (contract.bid !== null && contract.ask !== null && contract.bid > contract.ask) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'bid must not exceed ask' });
  }
});

export const optionContractSchema = z.object({
  ...optionLedgerContractShape,
  impliedVolatility: nullableNonnegative,
  delta: nullableFinite,
  gamma: nullableFinite,
  theta: nullableFinite,
  vega: nullableFinite,
  rho: nullableFinite,
  valuationSource: optionValuationSourceSchema.default(null),
}).superRefine((contract, context) => {
  if (contract.bid !== null && contract.ask !== null && contract.bid > contract.ask) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'bid must not exceed ask' });
  }
});

const optionsChainShape = {
  underlyingSymbol: z.string().min(1),
  spot: z.number().finite().positive(),
  expiration: z.iso.date(),
  expirations: z.array(z.iso.date()),
  provider: z.string().min(1),
  asOf: z.iso.datetime(),
  timestampKind: marketTimestampKindSchema,
  status: marketDataStatusSchema,
  delayedMinutes: z.number().int().nonnegative().nullable(),
  completeness: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  /** Underlying provenance is independent from the options snapshot provenance. */
  underlyingProvider: z.string().min(1).nullable().optional(),
  underlyingAsOf: z.iso.datetime().nullable().optional(),
  underlyingStatus: z.enum(['live', 'delayed', 'cached', 'stale', 'unavailable']).optional(),
};

export const optionsChainSchema = z.object({
  ...optionsChainShape,
  calls: z.array(optionContractSchema),
  puts: z.array(optionContractSchema),
});

export const optionsLedgerChainSchema = z.object({
  ...optionsChainShape,
  calls: z.array(optionLedgerContractSchema),
  puts: z.array(optionLedgerContractSchema),
});

/** The two successful shapes accepted from the entitlement-gated route. */
export const gatedOptionsChainSchema = z.union([optionsChainSchema, optionsLedgerChainSchema]);

export const optionsExpirationsSchema = z.object({
  underlyingSymbol: z.string().min(1),
  expirations: z.array(z.iso.date()),
  provider: z.string().min(1),
  asOf: z.iso.datetime(),
  timestampKind: marketTimestampKindSchema,
  status: marketDataStatusSchema,
  delayedMinutes: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string()),
});

export type OptionContract = z.infer<typeof optionContractSchema>;
export type OptionLedgerContract = z.infer<typeof optionLedgerContractSchema>;
export type OptionsChain = z.infer<typeof optionsChainSchema>;
export type OptionsLedgerChain = z.infer<typeof optionsLedgerChainSchema>;
export type GatedOptionsChain = z.infer<typeof gatedOptionsChainSchema>;
export type OptionsExpirations = z.infer<typeof optionsExpirationsSchema>;

function hydrateLedgerContract(contract: OptionContract | OptionLedgerContract): OptionContract {
  if ('impliedVolatility' in contract) return contract;
  return {
    ...contract,
    impliedVolatility: null,
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
    rho: null,
    valuationSource: null,
  };
}

/**
 * Normalize a gated wire DTO for internal UI consumers. Pro null placeholders
 * are created only after browser parsing; the locked keys were absent on wire.
 */
export function normalizeGatedOptionsChain(chain: GatedOptionsChain): OptionsChain {
  return {
    ...chain,
    calls: chain.calls.map(hydrateLedgerContract),
    puts: chain.puts.map(hydrateLedgerContract),
  };
}

export interface NormalizedOptionContracts {
  underlyingSymbol: string;
  contracts: OptionContract[];
  expirations: string[];
  provider: string;
  asOf: string;
  timestampKind: MarketTimestampKind;
  status: MarketDataStatus;
  delayedMinutes: number | null;
  completeness: number;
  warnings: string[];
  /**
   * True when the provider was queried with a filter that cannot represent a whole
   * chain — e.g. Alpaca's expiration discovery requests calls only, to keep the
   * expiration ladder inside a single unpaginated response. A partial snapshot is
   * valid for listing expirations but must never be served as an options chain,
   * or one side of the book silently disappears.
   */
  partial?: boolean;
}
