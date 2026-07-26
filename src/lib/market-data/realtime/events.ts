import { z } from 'zod';

/**
 * Transport-agnostic, normalized real-time market events.
 *
 * Every provider-specific wire shape (Finnhub in production, legacy adapters in tests)
 * is mapped to one of these before it crosses a module boundary. Timestamps are
 * always integer **unix milliseconds** and symbols are always upper-cased so the
 * aggregator, the subscription registry and the browser client never have to
 * reason about provider quirks or nanosecond RFC-3339 strings.
 *
 * These events describe market data only. The control/handshake protocol spoken
 * between the browser and the Gateway lives in `./protocol`.
 */

const finitePositive = z.number().finite().positive();
const finiteNonNegative = z.number().finite().nonnegative();
const intNonNegative = z.number().int().nonnegative();
/** Unix epoch milliseconds. Guards against absurd values from a bad feed line. */
const epochMillis = z.number().int().nonnegative();

/** A single executed trade. Drives the accepted last price. */
export const normalizedTradeSchema = z.object({
  kind: z.literal('trade'),
  symbol: z.string().min(1),
  price: finitePositive,
  size: finiteNonNegative,
  timestampMs: epochMillis,
  /** Gateway wall-clock receipt time; never used as the exchange timestamp. */
  gatewayReceivedAtMs: epochMillis.optional(),
  /** Provider identity is populated by every production adapter. */
  provider: z.string().min(1).optional(),
  /** Stable provider id when available, otherwise a deterministic wire fingerprint. */
  tradeId: z.string().min(1).optional(),
  session: z.enum(['pre-market', 'regular', 'after-hours', 'closed']).optional(),
  /** Tape/exchange condition flags, when the feed supplies them. */
  conditions: z.array(z.string()).optional(),
  tape: z.string().optional(),
});
export type NormalizedTrade = z.infer<typeof normalizedTradeSchema>;

/** A top-of-book quote when supplied. Bid/Ask are displayed separately. */
export const normalizedQuoteSchema = z.object({
  kind: z.literal('quote'),
  symbol: z.string().min(1),
  bidPrice: finiteNonNegative,
  bidSize: finiteNonNegative,
  askPrice: finiteNonNegative,
  askSize: finiteNonNegative,
  timestampMs: epochMillis,
  gatewayReceivedAtMs: epochMillis.optional(),
});
export type NormalizedQuote = z.infer<typeof normalizedQuoteSchema>;

/**
 * An official 1-minute OHLCV bar (Alpaca `b`) or a correction to one
 * (Alpaca `u` / updatedBar). `updated: true` marks a late correction that must
 * reconcile — never duplicate — the bucket already built from trade ticks.
 * `timestampMs` is the bucket **start**.
 */
export const normalizedBarSchema = z.object({
  kind: z.literal('bar'),
  symbol: z.string().min(1),
  open: finitePositive,
  high: finitePositive,
  low: finitePositive,
  close: finitePositive,
  volume: finiteNonNegative,
  timestampMs: epochMillis,
  updated: z.boolean(),
  /** False for the still-forming gateway candle; true once immutable. */
  finalized: z.boolean().optional(),
  provider: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  timeframe: z.string().min(1).optional(),
  session: z.enum(['pre-market', 'regular', 'after-hours', 'closed']).optional(),
  updatedAtMs: epochMillis.optional(),
  gatewayReceivedAtMs: epochMillis.optional(),
});
export type NormalizedBar = z.infer<typeof normalizedBarSchema>;

/**
 * A per-symbol trading status change (Alpaca `s` / tradingStatuses). A halt on
 * one symbol must be surfaced independently from the aggregate market session.
 */
export const normalizedTradingStatusSchema = z.object({
  kind: z.literal('status'),
  symbol: z.string().min(1),
  statusCode: z.string(),
  statusMessage: z.string(),
  reasonCode: z.string().optional(),
  reasonMessage: z.string().optional(),
  timestampMs: epochMillis,
  gatewayReceivedAtMs: epochMillis.optional(),
  /** Derived from the status code so the UI does not re-implement the mapping. */
  halted: z.boolean(),
});
export type NormalizedTradingStatus = z.infer<typeof normalizedTradingStatusSchema>;

/** Discriminated union of every normalized market event the Gateway fans out. */
export const normalizedMarketEventSchema = z.discriminatedUnion('kind', [
  normalizedTradeSchema,
  normalizedQuoteSchema,
  normalizedBarSchema,
  normalizedTradingStatusSchema,
]);
export type NormalizedMarketEvent = z.infer<typeof normalizedMarketEventSchema>;

/** Channels a subscriber can reference-count independently. */
export const MARKET_CHANNELS = ['trades', 'quotes', 'bars', 'updatedBars', 'statuses'] as const;
export type MarketChannel = (typeof MARKET_CHANNELS)[number];

/** The event kind a given channel produces (updatedBars share the bar kind). */
export function channelOfEvent(event: NormalizedMarketEvent): MarketChannel {
  switch (event.kind) {
    case 'trade':
      return 'trades';
    case 'quote':
      return 'quotes';
    case 'bar':
      return event.updated ? 'updatedBars' : 'bars';
    case 'status':
      return 'statuses';
  }
}
