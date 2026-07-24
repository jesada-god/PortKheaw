import { classifyUsEquitySession } from '@/src/lib/market-data/session';
import type { DataFreshness, Quote } from '@/src/lib/market-data/types';
import type { ConnectionStatus } from '@/src/lib/stock-detail/market-source';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';

export type MarketSession = 'halted' | 'holiday' | 'early-close' | 'premarket' | 'open' | 'after-hours' | 'closed' | 'unknown';
export type PriceDirection = 'up' | 'down' | 'neutral';
export type PriceDisplayCurrency = 'USD' | 'THB';
export type PriceDataStatus = 'live' | 'delayed' | 'cached' | 'stale' | 'unknown' | 'unavailable';

export interface MarketSessionSignals {
  halted?: boolean;
  holiday?: boolean;
  earlyClose?: boolean;
  premarket?: boolean;
  regularOpen?: boolean;
  afterHours?: boolean;
  closed?: boolean;
}

export interface PriceChange {
  amount: number;
  percent: number;
  direction: PriceDirection;
}

export interface PriceCurrencyInput {
  profileCurrency: string | null | undefined;
  quoteCurrency: string | null | undefined;
  instrumentCurrency: string | null | undefined;
  exchange: string | null | undefined;
}

export interface ResolvedPriceCurrency {
  currency: string | null;
  source: 'profile' | 'quote' | 'instrument' | 'exchange' | null;
}

export interface PriceHeaderExtendedQuote {
  session: 'premarket' | 'after-hours';
  price: number;
  asOf: string;
  freshness: DataFreshness;
  provider: string | null;
}

export interface PriceHeaderData {
  quote: Quote | null;
  freshness: DataFreshness;
  provider: string | null;
  fallbackLabel: StockDetailQuoteResource['fallbackLabel'];
  extendedQuote: PriceHeaderExtendedQuote | null;
}

const TRUSTED_EXCHANGE_CURRENCIES: Record<string, string> = {
  AMEX: 'USD',
  CBOE: 'USD',
  IEX: 'USD',
  NASDAQ: 'USD',
  NYSE: 'USD',
  'NYSE AMERICAN': 'USD',
  'NYSE ARCA': 'USD',
  'NYSE MKT': 'USD',
  MAI: 'THB',
  SET: 'THB',
  'STOCK EXCHANGE OF THAILAND': 'THB',
};

const MARKET_SESSION_PRESENTATION: Record<MarketSession, { emoji: string; label: string; fullName: string }> = {
  'early-close': { emoji: '⏱️', label: 'ตลาดปิดเร็ว', fullName: 'Early Close Session' },
  halted: { emoji: '⏸️', label: 'ระงับการซื้อขาย', fullName: 'Trading Halt / Symbol Halted' },
  holiday: { emoji: '📅', label: 'วันหยุดตลาด', fullName: 'Market Holiday' },
  premarket: { emoji: '🌅', label: 'ก่อนตลาดเปิด', fullName: 'Pre-market Session' },
  open: { emoji: '☀️', label: 'ตลาดเปิด', fullName: 'Regular Market Session' },
  'after-hours': { emoji: '🌇', label: 'หลังเวลาทำการ', fullName: 'After-hours / Post-market Session' },
  closed: { emoji: '🌙', label: 'ปิดตลาด', fullName: 'Market Closed' },
  unknown: { emoji: '⚠️', label: 'ไม่ทราบสถานะตลาด', fullName: 'Unknown Market Session' },
};

const DATA_STATUS_PRESENTATION: Record<PriceDataStatus, { emoji: string | null; label: string }> = {
  live: { emoji: null, label: 'ข้อมูลสด' },
  delayed: { emoji: '⏱️', label: 'ข้อมูลล่าช้า' },
  cached: { emoji: '💾', label: 'ข้อมูลแคช' },
  stale: { emoji: '🕒', label: 'ข้อมูลเก่า' },
  unknown: { emoji: null, label: 'ไม่ทราบความสดของข้อมูล' },
  unavailable: { emoji: '⚠️', label: 'ไม่มีข้อมูลราคา' },
};

const PRICE_DIRECTION_PRESENTATION: Record<PriceDirection, { sign: '+' | '-' | ''; arrow: '▲' | '▼' | null; tone: 'positive' | 'negative' | 'neutral' }> = {
  up: { sign: '+', arrow: '▲', tone: 'positive' },
  down: { sign: '-', arrow: '▼', tone: 'negative' },
  neutral: { sign: '', arrow: null, tone: 'neutral' },
};

export function resolveMarketSession(signals: MarketSessionSignals): MarketSession {
  if (signals.halted) return 'halted';
  if (signals.holiday) return 'holiday';
  if (signals.earlyClose) return 'early-close';
  if (signals.premarket) return 'premarket';
  if (signals.regularOpen) return 'open';
  if (signals.afterHours) return 'after-hours';
  if (signals.closed) return 'closed';
  return 'unknown';
}

export function deriveMarketSession(
  market: { currentStatus: 'pre-market' | 'open' | 'after-hours' | 'closed' | 'holiday' | 'early-close' | 'unknown'; notes: string | null } | null | undefined,
  extendedSession?: 'premarket' | 'after-hours' | null,
): MarketSession {
  const notes = market?.notes?.toLowerCase() ?? '';
  return resolveMarketSession({
    halted: /\b(halt(?:ed)?|suspend(?:ed)?)\b/.test(notes),
    holiday: market?.currentStatus === 'holiday' || /\bholiday\b/.test(notes),
    earlyClose: market?.currentStatus === 'early-close' || /\bearly[- ]?close\b/.test(notes),
    premarket: market?.currentStatus === 'pre-market' || extendedSession === 'premarket' || /\bpre-?market\b/.test(notes),
    regularOpen: market?.currentStatus === 'open',
    afterHours: market?.currentStatus === 'after-hours' || extendedSession === 'after-hours' || /\b(after[- ]?hours|post[- ]?market)\b/.test(notes),
    closed: market?.currentStatus === 'closed',
  });
}

export function marketSessionPresentation(session: MarketSession) {
  return MARKET_SESSION_PRESENTATION[session];
}

export function resolveDataStatus(freshness: DataFreshness, evaluatedAtMs: number): PriceDataStatus {
  if (freshness.status === 'unavailable') return 'unavailable';
  if (freshness.status === 'stale') return 'stale';

  const asOfMs = freshness.asOf ? Date.parse(freshness.asOf) : Number.NaN;
  if (
    Number.isFinite(evaluatedAtMs)
    && Number.isFinite(asOfMs)
    && freshness.maxAgeSeconds !== null
    && evaluatedAtMs - asOfMs > freshness.maxAgeSeconds * 1000
  ) {
    return 'stale';
  }

  if (freshness.status === 'realtime') return 'live';
  if (freshness.status === 'delayed' || freshness.status === 'end-of-day') return 'delayed';
  if (freshness.status === 'cached') return 'cached';
  return 'unknown';
}

function tradeablePrice(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Partitions the ONE already-accepted quote into the Investing-style header rows.
 * It never fetches or derives another market value:
 *
 * - regular session: the accepted quote remains the primary row;
 * - pre/post session: the accepted quote becomes the extended row, while a
 *   previously accepted regular quote (or the quote's real `previousClose`) stays
 *   in the primary row;
 * - a stale, date-only or session-mismatched accepted value is never promoted to
 *   an extended-hours quote.
 */
export function resolvePriceHeaderData(input: {
  current: StockDetailQuoteResource;
  initial: StockDetailQuoteResource;
  marketStatus: 'pre-market' | 'open' | 'after-hours' | 'closed' | 'holiday' | 'early-close' | 'unknown' | null;
  evaluatedAt: string;
}): PriceHeaderData {
  const { current, initial, marketStatus, evaluatedAt } = input;
  const currentQuote = current.data;
  const acceptedAsOf = current.freshness.asOf;
  const acceptedSession = acceptedAsOf ? classifyUsEquitySession(acceptedAsOf) : null;
  const expectedExtendedSession = marketStatus === 'pre-market'
    ? 'premarket' as const
    : marketStatus === 'after-hours' || marketStatus === 'closed'
      ? 'afterhours' as const
      : null;
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const acceptedStatus = resolveDataStatus(current.freshness, evaluatedAtMs);
  const acceptedExtended = currentQuote
    && tradeablePrice(currentQuote.price)
    && acceptedAsOf
    && acceptedSession === expectedExtendedSession;

  // A quote accepted from the entitled Alpaca stream is the newest market
  // observation available to this app. Keep it in the primary price row in
  // every session; otherwise an after-hours snapshot is hidden behind the
  // previous regular close and the screen appears stale until another trade.
  const genuineAlpacaRealtime = currentQuote
    && tradeablePrice(currentQuote.price)
    && current.freshness.status === 'realtime'
    && current.provider?.toLowerCase().startsWith('alpaca');

  if (genuineAlpacaRealtime) {
    return {
      quote: currentQuote,
      freshness: current.freshness,
      provider: current.provider,
      fallbackLabel: null,
      extendedQuote: null,
    };
  }

  if (!acceptedExtended || !expectedExtendedSession || !currentQuote || !acceptedAsOf) {
    return {
      quote: currentQuote,
      freshness: current.freshness,
      provider: current.provider,
      fallbackLabel: current.fallbackLabel,
      extendedQuote: null,
    };
  }

  const initialAsOf = initial.freshness.asOf;
  const acceptedRegularQuote = initial.data
    && tradeablePrice(initial.data.price)
    && initialAsOf
    && classifyUsEquitySession(initialAsOf) === 'regular'
    ? initial.data
    : null;
  const regularQuote = acceptedRegularQuote ?? (
    tradeablePrice(currentQuote.previousClose)
      ? {
          ...currentQuote,
          price: currentQuote.previousClose,
          previousClose: null,
          change: null,
          changePercent: null,
        }
      : null
  );

  // Without a real regular close there is no truthful primary row or comparison
  // base. Do not promote an extended/stale value to the primary "current" price.
  if (!regularQuote || !tradeablePrice(regularQuote.price)) {
    return {
      quote: null,
      freshness: { ...current.freshness, asOf: null },
      provider: current.provider,
      fallbackLabel: null,
      extendedQuote: null,
    };
  }

  const eligibleExtended = acceptedStatus !== 'stale' && acceptedStatus !== 'unavailable';

  return {
    quote: regularQuote,
    freshness: acceptedRegularQuote
      ? initial.freshness
      : { ...current.freshness, asOf: null },
    provider: acceptedRegularQuote ? initial.provider : current.provider,
    fallbackLabel: acceptedRegularQuote ? initial.fallbackLabel : null,
    extendedQuote: eligibleExtended
      ? {
          session: expectedExtendedSession === 'premarket' ? 'premarket' : 'after-hours',
          price: currentQuote.price,
          asOf: acceptedAsOf,
          freshness: current.freshness,
          provider: current.provider,
        }
      : null,
  };
}

export function dataStatusPresentation(status: PriceDataStatus) {
  return DATA_STATUS_PRESENTATION[status];
}

export function priceDirectionPresentation(direction: PriceDirection) {
  return PRICE_DIRECTION_PRESENTATION[direction];
}

/**
 * Presentation-only view of the live-connection lifecycle.
 *
 * - `none`         — nothing to show. `connected` relies on the existing
 *   Real-time badge; `connecting` and a REST-only (`null`) deployment stay
 *   neutral, showing only the untouched freshness status.
 * - `awaiting`     — a calm "เชื่อมต่อแล้ว · รอข้อมูลสด" pill for a genuinely open
 *   socket that has not yet received its first tick (a quiet/low-volume market).
 *   It is NOT an error tone: the socket is healthy and the fallback price keeps
 *   showing until the first live tick flips the header to Real-time.
 * - `reconnecting` — a concise pill ("กำลังเชื่อมต่อใหม่…") with a spinner while
 *   the socket is being restored; the last accepted price keeps showing.
 * - `error`        — "การเชื่อมต่อขัดข้อง" for a degraded/offline connection,
 *   shown alongside (never instead of) the existing freshness badge.
 *
 * This maps status → label only. It never derives price, timestamp, session or
 * freshness, so the connection indicator can never alter the displayed value.
 * Critically, a REST quote failure (e.g. an unentitled provider 403) never
 * produces `error` here — only a genuinely down socket (`degraded`/`disconnected`)
 * does, so a working WebSocket is never mislabelled as a broken connection.
 */
export type ConnectionStatusView =
  | { kind: 'none' }
  | { kind: 'awaiting'; label: string }
  | { kind: 'reconnecting'; label: string }
  | { kind: 'error'; label: string };

export function connectionStatusPresentation(status: ConnectionStatus | null | undefined): ConnectionStatusView {
  switch (status) {
    case 'awaiting-data':
      return { kind: 'awaiting', label: 'เชื่อมต่อแล้ว · รอข้อมูลสด' };
    case 'reconnecting':
      return { kind: 'reconnecting', label: 'กำลังเชื่อมต่อใหม่…' };
    case 'degraded':
    case 'disconnected':
      return { kind: 'error', label: 'การเชื่อมต่อขัดข้อง' };
    case 'connecting':
    case 'connected':
    case null:
    case undefined:
    default:
      return { kind: 'none' };
  }
}

function normalizedCurrency(value: string | null | undefined): string | null {
  const currency = value?.trim().toUpperCase() ?? '';
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function normalizedExchange(value: string | null | undefined): string {
  return value?.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toUpperCase() ?? '';
}

export function resolvePriceCurrency(input: PriceCurrencyInput): ResolvedPriceCurrency {
  const candidates = [
    ['profile', normalizedCurrency(input.profileCurrency)],
    ['quote', normalizedCurrency(input.quoteCurrency)],
    ['instrument', normalizedCurrency(input.instrumentCurrency)],
  ] as const;
  for (const [source, currency] of candidates) {
    if (currency) return { currency, source };
  }

  const currency = TRUSTED_EXCHANGE_CURRENCIES[normalizedExchange(input.exchange)] ?? null;
  return currency
    ? { currency, source: 'exchange' }
    : { currency: null, source: null };
}

export function calculatePriceChange(price: number | null | undefined, comparisonBase: number | null | undefined): PriceChange | null {
  if (
    price === null
    || price === undefined
    || comparisonBase === null
    || comparisonBase === undefined
    || !Number.isFinite(price)
    || !Number.isFinite(comparisonBase)
    || price <= 0
    || comparisonBase <= 0
  ) {
    return null;
  }

  const amount = price - comparisonBase;
  const percent = (amount / comparisonBase) * 100;
  if (!Number.isFinite(amount) || !Number.isFinite(percent)) return null;
  return {
    amount,
    percent,
    direction: amount > 0 ? 'up' : amount < 0 ? 'down' : 'neutral',
  };
}

/**
 * Resolve the regular-session daily change with a truthful, provider-first policy:
 *
 *   1. Trust the provider's own `change` + `changePercent` when BOTH are finite —
 *      they are the authoritative daily change for this price (Polygon's
 *      `todaysChange`/`todaysChangePerc`) and remain valid even when the provider
 *      did not also return a previous close.
 *   2. Otherwise derive it from a real `previousClose` via
 *      {@link calculatePriceChange}, which rejects a non-finite / non-positive base
 *      and computes `price - previousClose` (never from open/high/low, never from a
 *      cached price).
 *   3. Otherwise return null so the header hides the change — but ONLY when neither
 *      a provider change nor a real previous close exists.
 *
 * The percentage is carried straight through from whichever source supplied it and
 * is never currency-converted by the caller. Nothing here is fabricated.
 */
export function resolvePriceChange(input: {
  price: number | null | undefined;
  previousClose: number | null | undefined;
  providerChange: number | null | undefined;
  providerChangePercent: number | null | undefined;
}): PriceChange | null {
  const { price, previousClose, providerChange, providerChangePercent } = input;
  // The displayed price itself must be a real, tradeable value.
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  if (
    providerChange !== null && providerChange !== undefined && Number.isFinite(providerChange)
    && providerChangePercent !== null && providerChangePercent !== undefined && Number.isFinite(providerChangePercent)
  ) {
    return {
      amount: providerChange,
      percent: providerChangePercent,
      direction: providerChange > 0 ? 'up' : providerChange < 0 ? 'down' : 'neutral',
    };
  }
  return calculatePriceChange(price, previousClose);
}

/**
 * Direction of a live price move, used only to drive the flash micro-interaction
 * (`up` → green, `down` → red). Returns `null` when there is no comparable prior
 * price or the value did not move, and rejects non-finite or non-positive values
 * so a bad tick never flashes. This is presentation-only: it never fabricates or
 * alters the displayed price.
 */
export function priceFlashDirection(
  previous: number | null | undefined,
  next: number | null | undefined,
): PriceDirection | null {
  if (
    previous === null
    || previous === undefined
    || next === null
    || next === undefined
    || !Number.isFinite(previous)
    || !Number.isFinite(next)
    || previous <= 0
    || next <= 0
    || previous === next
  ) {
    return null;
  }
  return next > previous ? 'up' : 'down';
}

export function convertUsdForDisplay(
  valueUsd: number | null | undefined,
  currency: PriceDisplayCurrency,
  usdThbRate: number | null,
): number | null {
  if (valueUsd === null || valueUsd === undefined || !Number.isFinite(valueUsd)) return null;
  if (currency === 'USD') return valueUsd;
  if (usdThbRate === null || !Number.isFinite(usdThbRate) || usdThbRate <= 0) return null;
  const converted = valueUsd * usdThbRate;
  return Number.isFinite(converted) ? converted : null;
}
