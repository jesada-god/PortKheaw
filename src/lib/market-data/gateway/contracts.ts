import { z } from 'zod';
import {
  candleIntervalSchema,
  candleRangeSchema,
  candleSessionSchema,
} from '../candles/contracts';

export const marketDataStatusSchema = z.enum([
  'real-time',
  'delayed',
  'end-of-day',
  'cached',
  'stale',
  'partial',
  'unavailable',
]);

export const resolvedInstrumentSchema = z.object({
  canonicalSymbol: z.string().min(1),
  providerSymbol: z.string().min(1),
  name: z.string().nullable(),
  // `crypto` is never produced by the instrument-master resolver — nothing in
  // `market_instruments` is one. It names the continuous assets the product
  // ships proxies for, so a 24/7 market is not described as an equity.
  // 'commodity' is a futures contract on a physical good — see
  // `market-data/commodities.ts`. Appended rather than mapped onto an existing
  // member because every other value here describes a security, and calling a
  // COMEX contract a 'stock' or an 'index' is what would make the page describe
  // it wrongly. Existing values parse exactly as before.
  assetType: z.enum(['stock', 'etf', 'adr', 'reit', 'fund', 'otc', 'index', 'crypto', 'commodity', 'unknown']),
  exchange: z.string().nullable(),
  mic: z.string().nullable(),
  currency: z.string().nullable(),
  timezone: z.string().min(1),
  active: z.boolean(),
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
});

export const normalizedQuoteSchema = z.object({
  symbol: z.string().min(1),
  price: z.number().finite(),
  previousClose: z.number().finite().nullable(),
  regularClose: z.number().finite().positive().nullable().optional(),
  change: z.number().finite().nullable(),
  changePercent: z.number().finite().nullable(),
  timestamp: z.number().int().positive(),
  provider: z.string().min(1),
  exchange: z.string().nullable(),
  currency: z.string().nullable(),
  status: marketDataStatusSchema.exclude(['partial', 'unavailable']),
  delayedByMinutes: z.number().int().nonnegative().nullable(),
  open: z.number().finite().nullable().optional(),
  high: z.number().finite().nullable().optional(),
  low: z.number().finite().nullable().optional(),
  volume: z.number().finite().nonnegative().nullable().optional(),
});

export const normalizedBarSchema = z.object({
  time: z.number().int().positive(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative(),
  transactions: z.number().int().nonnegative().optional(),
  vwap: z.number().finite().optional(),
  partial: z.boolean(),
}).superRefine((bar, context) => {
  if (bar.high < Math.max(bar.open, bar.close, bar.low)) {
    context.addIssue({ code: 'custom', path: ['high'], message: 'high is below another OHLC field' });
  }
  if (bar.low > Math.min(bar.open, bar.close, bar.high)) {
    context.addIssue({ code: 'custom', path: ['low'], message: 'low is above another OHLC field' });
  }
});

export const normalizedBarsResultSchema = z.object({
  symbol: z.string().min(1),
  provider: z.string().min(1),
  interval: candleIntervalSchema,
  range: candleRangeSchema,
  adjusted: z.boolean(),
  session: candleSessionSchema,
  timezone: z.string().min(1),
  currency: z.string().nullable(),
  firstTimestamp: z.number().int().positive().nullable(),
  lastTimestamp: z.number().int().positive().nullable(),
  asOf: z.number().int().positive().nullable(),
  dataStatus: marketDataStatusSchema,
  delayedByMinutes: z.number().int().nonnegative().nullable().default(null),
  bars: z.array(normalizedBarSchema),
  warnings: z.array(z.string()),
});

export const normalizedMarketSessionSchema = z.object({
  status: z.enum(['pre-market', 'open', 'after-hours', 'closed', 'holiday', 'early-close', 'unknown']),
  exchange: z.string().nullable(),
  timezone: z.string().min(1),
  sessionDate: z.string().nullable(),
  nextOpen: z.number().int().positive().nullable(),
  nextClose: z.number().int().positive().nullable(),
  asOf: z.number().int().positive(),
  provider: z.string().min(1),
  source: z.string().min(1),
  stale: z.boolean(),
  reason: z.string().nullable().default(null),
});

export type ResolvedInstrument = z.infer<typeof resolvedInstrumentSchema>;
export type NormalizedQuote = z.infer<typeof normalizedQuoteSchema>;
export type NormalizedBar = z.infer<typeof normalizedBarSchema>;
export type NormalizedBarsResult = z.infer<typeof normalizedBarsResultSchema>;
export type NormalizedMarketSession = z.infer<typeof normalizedMarketSessionSchema>;
export type MarketDataStatus = z.infer<typeof marketDataStatusSchema>;
export type CandleInterval = z.infer<typeof candleIntervalSchema>;
export type HistoricalRange = z.infer<typeof candleRangeSchema>;
export type MarketSessionMode = z.infer<typeof candleSessionSchema>;

export interface MarketDataGateway {
  resolveInstrument(symbol: string): Promise<ResolvedInstrument>;
  getQuote(input: { instrument: ResolvedInstrument }): Promise<NormalizedQuote>;
  getSession(input: { instrument: ResolvedInstrument }): Promise<NormalizedMarketSession>;
  getBars(input: {
    instrument: ResolvedInstrument;
    interval: CandleInterval;
    range: HistoricalRange;
    adjusted: boolean;
    session: MarketSessionMode;
  }): Promise<NormalizedBarsResult>;
}

export const chartGatewayResponseSchema = z.object({
  instrument: resolvedInstrumentSchema,
  bars: normalizedBarsResultSchema,
});
