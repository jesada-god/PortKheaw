import { z } from 'zod';

export const candleIntervalSchema = z.enum([
  '1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m',
  '1h', '2h', '3h', '4h',
  '1D', 'Week', 'Month',
]);

export const candleRangeSchema = z.enum([
  '1d', '5d', '1m', '3m', '6m', 'ytd', '1y', '3y', '5y',
]);

export const candleSessionSchema = z.enum(['regular', 'extended']);
export const candleDataStatusSchema = z.enum([
  'live', 'delayed', 'end-of-day', 'cached', 'stale', 'unavailable',
]);

export type CandleInterval = z.infer<typeof candleIntervalSchema>;
export type CandleRange = z.infer<typeof candleRangeSchema>;
export type CandleSession = z.infer<typeof candleSessionSchema>;
export type CandleDataStatus = z.infer<typeof candleDataStatusSchema>;

export const normalizedCandleSchema = z.object({
  timestamp: z.number().int().positive(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  adjustedClose: z.number().finite().optional(),
  volume: z.number().finite().nonnegative(),
  session: z.enum(['pre', 'regular', 'post']).optional(),
  partial: z.boolean().optional(),
}).superRefine((candle, context) => {
  if (candle.high < Math.max(candle.open, candle.close, candle.low)) {
    context.addIssue({ code: 'custom', path: ['high'], message: 'high is below another OHLC field' });
  }
  if (candle.low > Math.min(candle.open, candle.close, candle.high)) {
    context.addIssue({ code: 'custom', path: ['low'], message: 'low is above another OHLC field' });
  }
});

export type NormalizedCandle = z.infer<typeof normalizedCandleSchema>;

export const normalizedCandleResultSchema = z.object({
  symbol: z.string().min(1),
  provider: z.string().min(1),
  attemptedProviders: z.array(z.string()),
  requestedInterval: candleIntervalSchema,
  actualInterval: candleIntervalSchema,
  sourceInterval: candleIntervalSchema,
  requestedRange: candleRangeSchema,
  actualStart: z.number().int().positive().nullable(),
  actualEnd: z.number().int().positive().nullable(),
  exchangeTimezone: z.string().min(1),
  currency: z.string().nullable(),
  /** Provider-declared display precision (Yahoo `priceHint`), when available. */
  pricePrecision: z.number().int().min(0).max(8).nullable().optional(),
  dataStatus: candleDataStatusSchema,
  delayedByMinutes: z.number().int().nonnegative().nullable(),
  adjusted: z.boolean(),
  aggregated: z.boolean(),
  cacheStatus: z.enum(['miss', 'hit', 'stale']),
  candles: z.array(normalizedCandleSchema),
  warnings: z.array(z.string()),
  fallbackReason: z.string().nullable(),
});

export type NormalizedCandleResult = z.infer<typeof normalizedCandleResultSchema>;

export interface TimeframeCapability {
  interval: CandleInterval;
  supportedRanges: CandleRange[];
  native: boolean;
  aggregationSources?: CandleInterval[];
  maxLookbackDays?: number;
}

export interface ProviderCapabilities {
  intervals: TimeframeCapability[];
  adjustedHistorical: boolean;
  extendedHours: boolean;
}

export interface CandleRequest {
  symbol: string;
  interval: CandleInterval;
  range: CandleRange;
  period1?: number;
  period2?: number;
  adjusted?: boolean;
  session?: CandleSession;
}

export interface NormalizedMarketDataProvider {
  readonly id: string;
  getCapabilities(): ProviderCapabilities;
  getCandles(input: CandleRequest & { sourceInterval: CandleInterval }): Promise<NormalizedCandleResult>;
}

export const candleQuerySchema = z.object({
  symbol: z.string().trim().min(1).max(20)
    .regex(/^(?:\^[A-Za-z0-9]+|[A-Za-z0-9][A-Za-z0-9.\-]*)$/)
    .transform((symbol) => symbol.toUpperCase()),
  interval: candleIntervalSchema.default('1D'),
  range: candleRangeSchema.default('3m'),
  adjusted: z.enum(['true', 'false']).transform((value) => value === 'true').default(true),
  session: candleSessionSchema.default('regular'),
  period1: z.coerce.number().int().positive().optional(),
  period2: z.coerce.number().int().positive().optional(),
}).superRefine((input, context) => {
  if ((input.period1 === undefined) !== (input.period2 === undefined)) {
    context.addIssue({ code: 'custom', path: ['period1'], message: 'period1 and period2 must be supplied together' });
  }
  if (input.period1 !== undefined && input.period2 !== undefined && input.period1 >= input.period2) {
    context.addIssue({ code: 'custom', path: ['period2'], message: 'period2 must be later than period1' });
  }
});
