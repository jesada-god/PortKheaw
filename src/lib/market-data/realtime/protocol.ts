import { z } from 'zod';
import {
  MARKET_CHANNELS,
  normalizedBarSchema,
  normalizedMarketEventSchema,
  normalizedQuoteSchema,
  normalizedTradeSchema,
} from './events';

/**
 * The control protocol spoken between the **browser** and the **Gateway**.
 *
 * The browser never speaks Alpaca's wire protocol and never holds Alpaca
 * credentials; it speaks only this framing to `NEXT_PUBLIC_MARKET_WS_URL`. The
 * Gateway owns the single upstream Alpaca connection and translates. Every frame
 * in both directions is validated with these schemas, so a malformed line is
 * rejected instead of crashing a client or the Gateway.
 */

const channelList = z.array(z.enum(MARKET_CHANNELS)).min(1);
const symbolList = z.array(z.string().min(1)).min(1);

/* ------------------------------- browser → Gateway ------------------------------- */

export const subscribeFrameSchema = z.object({
  type: z.literal('subscribe'),
  symbols: symbolList,
  channels: channelList,
});

export const unsubscribeFrameSchema = z.object({
  type: z.literal('unsubscribe'),
  symbols: symbolList,
  channels: channelList,
});

/** Application-level heartbeat so a client can prove liveness independent of TCP. */
export const pingFrameSchema = z.object({
  type: z.literal('ping'),
  t: z.number().int().nonnegative(),
});

/**
 * An optional opening frame that tells the Gateway *who* is connected.
 *
 * Optional is the important word. Stock pages are public — a signed-out visitor
 * reads live prices — so a Gateway that demanded authentication would break the
 * product's front door. What this frame buys instead is an identity for the
 * connections that have one, which is what lets the Gateway bound a *user*
 * rather than only an address: an address is shared by everybody behind a NAT
 * and is free to rotate for anybody with a proxy pool, so it is the wrong thing
 * to be the only key.
 *
 * The token is a Supabase access token, verified by the Gateway against
 * Supabase's own auth endpoint. It is never trusted as sent, never logged, and
 * never echoed back. A token that fails verification does not close the socket:
 * the connection simply stays anonymous and keeps the bounds anonymous
 * connections get, because a browser holding a session that expired mid-connect
 * is an ordinary event and not an attack.
 *
 * The 4 KiB bound is a parser guard, not a policy — it stops an oversized string
 * from reaching the verifier at all.
 */
export const helloFrameSchema = z.object({
  type: z.literal('hello'),
  token: z.string().min(1).max(4_096),
});

export const clientFrameSchema = z.discriminatedUnion('type', [
  subscribeFrameSchema,
  unsubscribeFrameSchema,
  pingFrameSchema,
  helloFrameSchema,
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

/* ------------------------------- Gateway → browser ------------------------------- */

/**
 * Sent once the Gateway's upstream is authenticated and ready. `realtime` is the
 * Gateway's honest claim about the upstream feed: `true` only for an entitled
 * live IEX stream, `false` for the `test`/FAKEPACA sandbox. The UI must never
 * label data "Real-time" when this is false.
 */
export const connectedFrameSchema = z.object({
  type: z.literal('connected'),
  feed: z.string(),
  realtime: z.boolean(),
});

export const subscribedFrameSchema = z.object({
  type: z.literal('subscribed'),
  symbols: z.array(z.string()),
  channels: z.array(z.enum(MARKET_CHANNELS)),
});

/** A single normalized market event fanned out to interested clients. */
export const eventFrameSchema = z.object({
  type: z.literal('event'),
  event: normalizedMarketEventSchema,
});

/**
 * The current market state for one symbol, delivered immediately after a
 * subscribe so the browser can show live prices WITHOUT waiting for the next
 * trade tick — the fix for a thinly-traded symbol whose header would otherwise
 * sit on a REST/previous-close fallback while its live 1m candle stayed empty.
 *
 * `trade` is the latest eligible trade (the last price and the current-minute
 * close), `quote` the latest top-of-book, and `bars` a short run of the most
 * recent finalized 1-minute bars (ascending, `updated: false`) so the chart has
 * canonical minutes to seed and aggregate from. Every field is REAL provider
 * data or absent — nothing here is interpolated. `origin` is the honest
 * provenance: `cache` (warmed from the live upstream stream) or `rest` (a
 * server-side Alpaca REST bootstrap when the cache had nothing yet).
 */
export const marketSnapshotSchema = z.object({
  symbol: z.string().min(1),
  trade: normalizedTradeSchema.nullable(),
  quote: normalizedQuoteSchema.nullable(),
  bars: z.array(normalizedBarSchema),
  origin: z.enum(['cache', 'rest']),
  /** When the Gateway assembled the snapshot (unix ms). */
  asOfMs: z.number().int().nonnegative(),
});
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

/** A per-symbol initial snapshot pushed to a client right after it subscribes. */
export const snapshotFrameSchema = z.object({
  type: z.literal('snapshot'),
  snapshot: marketSnapshotSchema,
});

export const errorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const pongFrameSchema = z.object({
  type: z.literal('pong'),
  t: z.number().int().nonnegative(),
});

/** Emitted when a subscribe would exceed the Gateway's hard symbol cap. */
export const limitExceededFrameSchema = z.object({
  type: z.literal('limit-exceeded'),
  limit: z.number().int().positive(),
  requested: z.array(z.string()),
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
});

export const serverFrameSchema = z.discriminatedUnion('type', [
  connectedFrameSchema,
  subscribedFrameSchema,
  snapshotFrameSchema,
  eventFrameSchema,
  errorFrameSchema,
  pongFrameSchema,
  limitExceededFrameSchema,
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

/** Parse a raw text frame from the socket into a validated client frame. */
export function parseClientFrame(raw: string): ClientFrame | null {
  return safeParseJson(raw, clientFrameSchema);
}

/** Parse a raw text frame from the socket into a validated server frame. */
export function parseServerFrame(raw: string): ServerFrame | null {
  return safeParseJson(raw, serverFrameSchema);
}

function safeParseJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
