import { z } from 'zod';

export const marketDataStatusSchema = z.enum(['live', 'delayed', 'cached', 'stale']);
export type MarketDataStatus = z.infer<typeof marketDataStatusSchema>;

export const marketTimestampKindSchema = z.enum(['exchange', 'provider', 'receipt']);
export type MarketTimestampKind = z.infer<typeof marketTimestampKindSchema>;

const nullableFinite = z.number().finite().nullable();
const nullableNonnegative = z.number().finite().nonnegative().nullable();
const nullableInteger = z.number().int().nonnegative().nullable();

export const optionContractSchema = z.object({
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
  impliedVolatility: nullableNonnegative,
  delta: nullableFinite,
  gamma: nullableFinite,
  theta: nullableFinite,
  vega: nullableFinite,
  rho: nullableFinite,
  inTheMoney: z.boolean().nullable(),
  multiplier: z.number().finite().positive(),
  currency: z.string().min(3).max(8),
  provider: z.string().min(1),
  asOf: z.iso.datetime(),
  timestampKind: marketTimestampKindSchema,
  status: marketDataStatusSchema,
}).superRefine((contract, context) => {
  if (contract.bid !== null && contract.ask !== null && contract.bid > contract.ask) {
    context.addIssue({ code: 'custom', path: ['bid'], message: 'bid must not exceed ask' });
  }
});

export const optionsChainSchema = z.object({
  underlyingSymbol: z.string().min(1),
  spot: z.number().finite().positive(),
  expiration: z.iso.date(),
  expirations: z.array(z.iso.date()),
  calls: z.array(optionContractSchema),
  puts: z.array(optionContractSchema),
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
});

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
export type OptionsChain = z.infer<typeof optionsChainSchema>;
export type OptionsExpirations = z.infer<typeof optionsExpirationsSchema>;

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
