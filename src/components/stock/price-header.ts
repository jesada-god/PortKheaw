import { classifyUsEquitySession, exchangeSessionDate, US_EQUITY_TIMEZONE } from '@/src/lib/market-data/session';
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
  /** Exchange-local trading date the print belongs to, always shown in the row. */
  tradingDate: string | null;
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
 * Partitions the ONE already-accepted quote into the header's two rows, and
 * chooses which extended-hours print (if any) belongs in the secondary row.
 *
 * Row policy:
 *
 * - **regular session** — the accepted quote is the primary row and there is no
 *   extended row;
 * - **pre/post session** — the accepted quote becomes the extended row while a
 *   previously accepted regular quote (or the quote's real `regularClose` /
 *   `previousClose`) holds the primary row;
 * - **closed / weekend / holiday** — the primary row is the latest completed
 *   regular close, and the extended row may still show the latest completed
 *   session's print (Friday's after-hours seen on a Sunday), always carrying its
 *   own trading date.
 *
 * Extended-source precedence, highest first:
 *   1. an accepted live/REST extended print already in the quote pipeline;
 *   2. `serverExtendedQuote` — the verified pre/post print resolved server-side
 *      from the existing Yahoo chart pipeline.
 *
 * Two things this function never does: promote an extended price into the
 * primary row, and show an extended print from an older session than the
 * regular price beside it.
 */
export function resolvePriceHeaderData(input: {
  current: StockDetailQuoteResource;
  initial: StockDetailQuoteResource;
  marketStatus: 'pre-market' | 'open' | 'after-hours' | 'closed' | 'holiday' | 'early-close' | 'unknown' | null;
  evaluatedAt: string;
  /** Server-resolved pre/post print; used only when the pipeline has no accepted one. */
  serverExtendedQuote?: PriceHeaderExtendedQuote | null;
}): PriceHeaderData {
  const { current, initial, marketStatus, evaluatedAt } = input;
  const serverExtendedQuote = input.serverExtendedQuote ?? null;

  /**
   * The server print is only valid beside a primary row from the SAME exchange
   * trading date. This is what allows Friday's after-hours row on a Sunday
   * (primary row is also Friday) while rejecting any older leftover.
   */
  const serverExtendedFor = (regularAsOf: string | null): PriceHeaderExtendedQuote | null => {
    if (!serverExtendedQuote || !regularAsOf || !serverExtendedQuote.tradingDate) return null;
    return exchangeSessionDate(regularAsOf, US_EQUITY_TIMEZONE) === serverExtendedQuote.tradingDate
      ? serverExtendedQuote
      : null;
  };
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
  // An extended print is only "now" if it belongs to the SAME New York trading
  // date we are evaluating. Both extended windows (04:00 and 20:00 ET) sit inside
  // one calendar date, so this never rejects a genuine tick — but it is the only
  // guard that stops Friday's after-hours print from being shown as the current
  // extended quote on Saturday or Sunday, when an end-of-day feed reports
  // maxAgeSeconds: null and the freshness threshold therefore cannot age it out.
  const sameSessionDate = acceptedAsOf !== null
    && exchangeSessionDate(acceptedAsOf, US_EQUITY_TIMEZONE) === exchangeSessionDate(evaluatedAt, US_EQUITY_TIMEZONE);
  const acceptedExtended = currentQuote
    && tradeablePrice(currentQuote.price)
    && acceptedAsOf
    && sameSessionDate
    && acceptedSession === expectedExtendedSession;

  // A pre/post print carried over from an earlier trading date (typically Friday's
  // after-hours seen over a weekend) is not a current price in EITHER row. It is
  // rejected as the extended quote above; here it is also kept out of the primary
  // row, which must fall back to the latest real regular close instead.
  const carriedOverExtendedPrint = Boolean(
    acceptedAsOf && !sameSessionDate
    && (acceptedSession === 'premarket' || acceptedSession === 'afterhours'),
  );

  if ((!acceptedExtended && !carriedOverExtendedPrint) || !expectedExtendedSession || !currentQuote || !acceptedAsOf) {
    return {
      quote: currentQuote,
      freshness: current.freshness,
      provider: current.provider,
      fallbackLabel: current.fallbackLabel,
      // The pipeline had no extended print of its own — during the regular
      // session there is correctly none, and the server resolver also returns
      // none. Outside it, this is what surfaces the latest session's pre/post
      // row without ever touching the primary price above.
      extendedQuote: serverExtendedFor(current.freshness.asOf),
    };
  }

  const initialAsOf = initial.freshness.asOf;
  const acceptedRegularQuote = initial.data
    && tradeablePrice(initial.data.price)
    && initialAsOf
    && classifyUsEquitySession(initialAsOf) === 'regular'
    ? initial.data
    : null;
  const providerRegularClose = tradeablePrice(currentQuote.regularClose)
    ? currentQuote.regularClose
    : tradeablePrice(initial.data?.regularClose)
      ? initial.data!.regularClose
      : null;
  const regularQuote = acceptedRegularQuote ?? (
    tradeablePrice(providerRegularClose ?? currentQuote.previousClose)
      ? {
          ...currentQuote,
          price: providerRegularClose ?? currentQuote.previousClose!,
          previousClose: currentQuote.previousRegularClose ?? currentQuote.previousClose,
          change: currentQuote.previousRegularClose || currentQuote.previousClose
            ? (providerRegularClose ?? currentQuote.previousClose!) - (currentQuote.previousRegularClose ?? currentQuote.previousClose!)
            : null,
          changePercent: currentQuote.previousRegularClose || currentQuote.previousClose
            ? ((providerRegularClose ?? currentQuote.previousClose!) - (currentQuote.previousRegularClose ?? currentQuote.previousClose!))
              / (currentQuote.previousRegularClose ?? currentQuote.previousClose!) * 100
            : null,
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

  const eligibleExtended = acceptedExtended
    && acceptedStatus !== 'stale' && acceptedStatus !== 'unavailable';
  const primaryFreshness = acceptedRegularQuote
    ? initial.freshness
    : { ...current.freshness, asOf: null };

  return {
    quote: regularQuote,
    freshness: primaryFreshness,
    provider: acceptedRegularQuote ? initial.provider : current.provider,
    fallbackLabel: acceptedRegularQuote ? initial.fallbackLabel : null,
    // An accepted live/REST extended print wins; otherwise the server-resolved
    // pre/post print fills the row, matched to the primary row's trading date.
    extendedQuote: eligibleExtended
      ? {
          session: expectedExtendedSession === 'premarket' ? 'premarket' : 'after-hours',
          price: currentQuote.price,
          asOf: acceptedAsOf,
          tradingDate: exchangeSessionDate(acceptedAsOf, US_EQUITY_TIMEZONE),
          freshness: current.freshness,
          provider: current.provider,
        }
      : serverExtendedFor(primaryFreshness.asOf ?? acceptedAsOf),
  };
}

export function dataStatusPresentation(status: PriceDataStatus) {
  return DATA_STATUS_PRESENTATION[status];
}

/**
 * Short `DD/MM` label for the trading session a price belongs to.
 *
 * The date is resolved in EXCHANGE-local time, not the reader's: a US close at
 * 16:00 ET is the 24th's session even though it is already the 25th in Bangkok.
 * Labelling it by the reader's clock would show the wrong trading day for every
 * Asian user, which is precisely the row this date exists to disambiguate.
 * Accepts either an ISO instant or an already-resolved `YYYY-MM-DD`.
 */
export function formatSessionDateLabel(
  value: string | null | undefined,
  timeZone = US_EQUITY_TIMEZONE,
): string | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : exchangeSessionDate(value, timeZone);
  if (!date) return null;
  const [, month, day] = date.split('-');
  return month && day ? `${day}/${month}` : null;
}

/**
 * Human label for which session a price was printed in, used in the provenance
 * detail so "regular vs pre vs after" is always inspectable even though the
 * primary row stays free of technical vocabulary.
 */
export function priceSessionLabel(asOf: string | null | undefined): string {
  if (!asOf) return 'ไม่ทราบช่วงเวลาซื้อขาย';
  switch (classifyUsEquitySession(asOf)) {
    case 'premarket': return 'ก่อนตลาดเปิด (Pre-market)';
    case 'regular': return 'เวลาทำการปกติ (Regular)';
    case 'afterhours': return 'หลังเวลาทำการ (After-hours)';
    default: return 'นอกเวลาซื้อขาย (Closed)';
  }
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
