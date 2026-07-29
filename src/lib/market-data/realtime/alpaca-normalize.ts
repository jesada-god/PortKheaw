import {
  normalizedBarSchema,
  normalizedQuoteSchema,
  normalizedTradeSchema,
  normalizedTradingStatusSchema,
  type NormalizedMarketEvent,
} from './events';
import { classifyUsEquityTimestamp } from './session';

/**
 * Pure mappers from Alpaca's IEX/SIP wire messages to normalized events.
 *
 * No network or state here — the Gateway feeds raw parsed JSON in and gets
 * validated normalized events out (or null for lines that are not market data
 * or that fail validation, e.g. a non-positive price or a future-dated tick the
 * schema rejects). This is the only place that understands Alpaca's `T`
 * discriminator and its RFC-3339 nanosecond timestamps.
 */

/**
 * Alpaca timestamps are RFC-3339 with up to nanosecond precision
 * (`2024-01-02T15:04:05.123456789Z`). `Date.parse` is only reliable to
 * milliseconds, so truncate any fractional part beyond 3 digits first.
 */
export function rfc3339ToMillis(value: string): number | null {
  const truncated = value.replace(/(\.\d{3})\d+(?=[Z+\-])/, '$1');
  const ms = Date.parse(truncated);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Nasdaq/UTP trading-action codes Alpaca reports in `sc` that mean the symbol is
 * NOT currently tradeable. Anything else (notably `T` = resumption, `Q` = quote
 * only pre-open) is treated as not halted, so we never falsely claim a halt.
 */
const HALT_CODES = new Set([
  'H', // Trading Halt
  'LUDP', // Volatility Trading Pause
  'LUDS', // Volatility Trading Pause – Straddle
  'MWC1', 'MWC2', 'MWC3', 'MWCA', 'MWCB', 'MWCC', // Market-Wide Circuit Breakers
  'PAUSE',
  'D', // Delisted
]);

export function isHaltCode(code: string): boolean {
  return HALT_CODES.has(code.toUpperCase());
}

interface AlpacaMessage {
  T?: unknown;
  S?: unknown;
  [key: string]: unknown;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map a single Alpaca wire message to a normalized event, or null when it is not
 * market data (control frames), is missing required fields, or fails the
 * normalized schema (which rejects non-positive prices and bad timestamps).
 *
 * Every priced event carries the trading session its OWN exchange timestamp falls
 * in, exactly as the Finnhub adapter already does. Alpaca does not state a session
 * on the wire, and leaving the field absent was the origin of the header defect
 * this tagging closes: with no session on the event, the browser source fell back
 * to the CHART SELECTION's session (`regular` — a request parameter, not market
 * truth), so every after-hours print was labelled a regular-session price and
 * could overwrite the official regular close in the main price row. The session is
 * derived from the provider timestamp in America/New_York; no local clock is used.
 */
export function normalizeAlpacaMessage(message: unknown): NormalizedMarketEvent | null {
  if (typeof message !== 'object' || message === null) return null;
  const msg = message as AlpacaMessage;
  const type = str(msg.T);
  const symbol = str(msg.S);
  if (!type) return null;

  switch (type) {
    case 't': {
      if (!symbol) return null;
      const price = num(msg.p);
      const size = num(msg.s);
      const ts = str(msg.t);
      if (price === null || size === null || !ts) return null;
      const timestampMs = rfc3339ToMillis(ts);
      if (timestampMs === null) return null;
      const parsed = normalizedTradeSchema.safeParse({
        kind: 'trade',
        symbol: symbol.toUpperCase(),
        price,
        size,
        timestampMs,
        session: classifyUsEquityTimestamp(timestampMs),
        ...(Array.isArray(msg.c) ? { conditions: msg.c.filter((c): c is string => typeof c === 'string') } : {}),
        ...(str(msg.z) ? { tape: str(msg.z)! } : {}),
      });
      return parsed.success ? parsed.data : null;
    }
    case 'q': {
      if (!symbol) return null;
      const bidPrice = num(msg.bp);
      const bidSize = num(msg.bs);
      const askPrice = num(msg.ap);
      const askSize = num(msg.as);
      const ts = str(msg.t);
      if (bidPrice === null || bidSize === null || askPrice === null || askSize === null || !ts) return null;
      const timestampMs = rfc3339ToMillis(ts);
      if (timestampMs === null) return null;
      const parsed = normalizedQuoteSchema.safeParse({
        kind: 'quote',
        symbol: symbol.toUpperCase(),
        bidPrice,
        bidSize,
        askPrice,
        askSize,
        timestampMs,
      });
      return parsed.success ? parsed.data : null;
    }
    case 'b':
    case 'u': {
      if (!symbol) return null;
      const open = num(msg.o);
      const high = num(msg.h);
      const low = num(msg.l);
      const close = num(msg.c);
      const volume = num(msg.v);
      const ts = str(msg.t);
      if (open === null || high === null || low === null || close === null || volume === null || !ts) return null;
      const timestampMs = rfc3339ToMillis(ts);
      if (timestampMs === null) return null;
      const parsed = normalizedBarSchema.safeParse({
        kind: 'bar',
        symbol: symbol.toUpperCase(),
        open,
        high,
        low,
        close,
        volume,
        timestampMs,
        updated: type === 'u',
        // A 1m bar's timestamp is its bucket START, which is the minute the bar's
        // trading actually happened in — so the same classification applies.
        session: classifyUsEquityTimestamp(timestampMs),
      });
      return parsed.success ? parsed.data : null;
    }
    case 's': {
      if (!symbol) return null;
      const statusCode = str(msg.sc) ?? '';
      const ts = str(msg.t);
      const timestampMs = ts ? rfc3339ToMillis(ts) : Date.now();
      if (timestampMs === null) return null;
      const parsed = normalizedTradingStatusSchema.safeParse({
        kind: 'status',
        symbol: symbol.toUpperCase(),
        statusCode,
        statusMessage: str(msg.sm) ?? '',
        ...(str(msg.rc) ? { reasonCode: str(msg.rc)! } : {}),
        ...(str(msg.rm) ? { reasonMessage: str(msg.rm)! } : {}),
        timestampMs,
        halted: isHaltCode(statusCode),
      });
      return parsed.success ? parsed.data : null;
    }
    default:
      return null;
  }
}

/** Alpaca control frames the Gateway uses to drive its handshake state machine. */
export type AlpacaControl =
  | { kind: 'success'; message: string }
  | { kind: 'error'; code: number | null; message: string }
  | {
      kind: 'subscription';
      /** Union of every symbol Alpaca reports as actually subscribed. */
      symbols: string[];
      /** Per-channel symbol lists Alpaca echoed (only non-empty channels). */
      channels: Partial<Record<string, string[]>>;
    };

/**
 * The channel arrays an Alpaca `subscription` ack can carry. Alpaca echoes the
 * FULL current subscription (every channel, even the empty ones) on every ack,
 * so this is the ground truth of what the upstream is really streaming — which
 * is why the Gateway logs it: "we asked for trades but only got quotes" is
 * otherwise invisible.
 */
const SUBSCRIPTION_CHANNELS = [
  'trades', 'quotes', 'bars', 'updatedBars', 'dailyBars',
  'statuses', 'lulds', 'corrections', 'cancelErrors',
] as const;

/** Classify a non-market Alpaca control frame, or null when it is market data. */
export function classifyAlpacaControl(message: unknown): AlpacaControl | null {
  if (typeof message !== 'object' || message === null) return null;
  const msg = message as AlpacaMessage;
  switch (str(msg.T)) {
    case 'success':
      return { kind: 'success', message: str(msg.msg) ?? '' };
    case 'error':
      return { kind: 'error', code: num(msg.code), message: str(msg.msg) ?? '' };
    case 'subscription': {
      const channels: Partial<Record<string, string[]>> = {};
      const symbols = new Set<string>();
      for (const channel of SUBSCRIPTION_CHANNELS) {
        const raw = msg[channel];
        if (!Array.isArray(raw)) continue;
        const syms = raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
        if (syms.length === 0) continue;
        channels[channel] = syms;
        for (const s of syms) symbols.add(s.toUpperCase());
      }
      return { kind: 'subscription', symbols: [...symbols], channels };
    }
    default:
      return null;
  }
}
