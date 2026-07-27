import {
  isRegularSession,
  usesLatestRegularClose,
  type CurrentMarketSession,
} from '@/src/lib/market-data/current-session';
import { extendedQuoteFollowsRegularClose } from '@/src/lib/market-data/extended-hours';
import { classifyUsEquitySession, exchangeSessionDate, US_EQUITY_TIMEZONE } from '@/src/lib/market-data/session';
import type { DataFreshness, Quote } from '@/src/lib/market-data/types';
import type { ConnectionStatus } from '@/src/lib/stock-detail/market-source';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';

/** Which extended window a SECONDARY-row print belongs to. Never a current-session claim. */
export type ExtendedRowSession = 'premarket' | 'after-hours';
export type PriceDirection = 'up' | 'down' | 'neutral';
export type PriceDisplayCurrency = 'USD' | 'THB';
export type PriceDataStatus = 'live' | 'delayed' | 'cached' | 'stale' | 'unknown' | 'unavailable';

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
  session: ExtendedRowSession;
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

/**
 * Labels for the SECONDARY row only. These describe which window a print was
 * executed in — they are deliberately not part of the current-session vocabulary
 * (see `currentSessionPresentation`), so an extended row can never be mistaken
 * for a claim that the market is in that session now.
 */
const EXTENDED_ROW_PRESENTATION: Record<ExtendedRowSession, { emoji: string; label: string; fullName: string }> = {
  premarket: { emoji: '🌅', label: 'ก่อนตลาดเปิด', fullName: 'Pre-market Session' },
  // 🌇, deliberately not the 🌙 of "ตลาดปิด": the two appear together whenever a
  // completed after-hours row is shown while the market is closed, and they must
  // stay visually distinguishable.
  'after-hours': { emoji: '🌇', label: 'หลังเวลาทำการ', fullName: 'After-hours / Post-market Session' },
};

const DATA_STATUS_PRESENTATION: Record<PriceDataStatus, { emoji: string | null; label: string }> = {
  live: { emoji: null, label: 'ราคาสด' },
  delayed: { emoji: '⏱️', label: 'ราคาล่าช้า' },
  cached: { emoji: '💾', label: 'ข้อมูลที่บันทึกไว้' },
  stale: { emoji: '🕒', label: 'ข้อมูลอาจล่าช้า' },
  unknown: { emoji: null, label: 'ไม่ทราบสถานะข้อมูล' },
  unavailable: { emoji: '⚠️', label: 'ไม่มีข้อมูล' },
};

const PRICE_DIRECTION_PRESENTATION: Record<PriceDirection, { sign: '+' | '-' | ''; arrow: '▲' | '▼' | null; tone: 'positive' | 'negative' | 'neutral' }> = {
  up: { sign: '+', arrow: '▲', tone: 'positive' },
  down: { sign: '-', arrow: '▼', tone: 'negative' },
  neutral: { sign: '', arrow: null, tone: 'neutral' },
};

export function extendedSessionPresentation(session: ExtendedRowSession) {
  return EXTENDED_ROW_PRESENTATION[session];
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

function sameExtendedQuote(left: PriceHeaderExtendedQuote, right: PriceHeaderExtendedQuote): boolean {
  return left.session === right.session
    && left.price === right.price
    && left.asOf === right.asOf
    && left.tradingDate === right.tradingDate
    && left.provider === right.provider
    && left.freshness.status === right.freshness.status
    && left.freshness.asOf === right.freshness.asOf
    && left.freshness.maxAgeSeconds === right.freshness.maxAgeSeconds;
}

/**
 * Keeps the newest valid extended-hours print across regular snapshots,
 * reconnects and canonical React syncs. Missing input never means "clear": a
 * quote is replaced only by an equally-newer valid quote with real provenance.
 */
export function preserveLastKnownExtendedQuote(
  previous: PriceHeaderExtendedQuote | null,
  incoming: PriceHeaderExtendedQuote | null | undefined,
): PriceHeaderExtendedQuote | null {
  const validPrevious = previous && tradeablePrice(previous.price) && Number.isFinite(Date.parse(previous.asOf))
    ? previous
    : null;
  const validIncoming = incoming && tradeablePrice(incoming.price) && Number.isFinite(Date.parse(incoming.asOf))
    ? incoming
    : null;
  if (!validIncoming) return validPrevious;
  if (!validPrevious) return validIncoming;

  const previousAsOf = Date.parse(validPrevious.asOf);
  const incomingAsOf = Date.parse(validIncoming.asOf);
  if (incomingAsOf < previousAsOf) return validPrevious;
  return sameExtendedQuote(validPrevious, validIncoming) ? validPrevious : validIncoming;
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
 * Three things this function never does: promote an extended price into the
 * primary row, show an extended print from an older session than the regular
 * price beside it, and render an extended row while the market is REGULAR
 * (invariant B — "ตลาดเปิด" and "หลังเวลาทำการ" can never coexist).
 *
 * `currentSession` is the ONLY session input, and it comes from
 * `resolveCurrentMarketSession`. No timestamp reaching this function — quote,
 * candle or extended — is ever allowed to decide it.
 */
export function resolvePriceHeaderData(input: {
  current: StockDetailQuoteResource;
  initial: StockDetailQuoteResource;
  /** The resolved CURRENT market session; never derived from a price timestamp. */
  currentSession: CurrentMarketSession;
  evaluatedAt: string;
  /** Server-resolved pre/post print; used only when the pipeline has no accepted one. */
  serverExtendedQuote?: PriceHeaderExtendedQuote | null;
}): PriceHeaderData {
  const { current, initial, currentSession, evaluatedAt } = input;
  // Which extended window MAY occupy the secondary row right now. REGULAR, HALTED
  // and UNKNOWN yield null — invariant B, enforced at the single point that can
  // produce the row, so "ตลาดเปิด" + "หลังเวลาทำการ" is unreachable whatever the
  // server or the quote pipeline offers.
  const expectedExtendedSession = currentSession === 'PREMARKET'
    ? 'premarket' as const
    : currentSession === 'AFTER_HOURS'
      || currentSession === 'CLOSED'
      || currentSession === 'HOLIDAY'
      || currentSession === 'EARLY_CLOSE'
      ? 'afterhours' as const
      : null;
  const serverExtendedQuote = expectedExtendedSession ? input.serverExtendedQuote ?? null : null;

  /**
   * The server print is only valid beside a primary row it actually FOLLOWS (see
   * {@link extendedQuoteFollowsRegularClose}). That admits both real shapes —
   * Friday's after-hours row on a Sunday, and Monday's pre-market row beside
   * Friday's close — while rejecting any older leftover.
   */
  const serverExtendedFor = (regularAsOf: string | null): PriceHeaderExtendedQuote | null => {
    if (!serverExtendedQuote || !regularAsOf || !serverExtendedQuote.tradingDate) return null;
    if (currentSession === 'PREMARKET' && serverExtendedQuote.session !== 'premarket') return null;
    if (currentSession === 'AFTER_HOURS' && serverExtendedQuote.session !== 'after-hours') return null;
    return extendedQuoteFollowsRegularClose(serverExtendedQuote.asOf, regularAsOf)
      ? serverExtendedQuote
      : null;
  };
  const currentQuote = current.data;
  const acceptedAsOf = current.freshness.asOf;
  const acceptedSession = acceptedAsOf ? classifyUsEquitySession(acceptedAsOf) : null;
  // An extended print is only "now" if it belongs to the SAME New York trading
  // date we are evaluating. Both extended windows (04:00 and 20:00 ET) sit inside
  // one calendar date, so this never rejects a genuine tick — but it is the only
  // guard that stops Friday's after-hours print from being shown as the current
  // extended quote on Saturday or Sunday, when an end-of-day feed reports
  // maxAgeSeconds: null and the freshness threshold therefore cannot age it out.
  const sameSessionDate = acceptedAsOf !== null
    && exchangeSessionDate(acceptedAsOf, US_EQUITY_TIMEZONE) === exchangeSessionDate(evaluatedAt, US_EQUITY_TIMEZONE);
  const acceptedSessionMatches = currentSession === 'PREMARKET'
    ? acceptedSession === 'premarket'
    : currentSession === 'AFTER_HOURS'
      ? acceptedSession === 'afterhours'
      : currentSession === 'CLOSED'
        || currentSession === 'HOLIDAY'
        || currentSession === 'EARLY_CLOSE'
        ? acceptedSession === 'premarket' || acceptedSession === 'afterhours'
        : false;
  // Some regular snapshots are timestamped when they are received after the
  // bell but still carry only `regularClose`. They must not replace a distinct
  // persisted extended print merely because that receipt time classifies as
  // after-hours.
  const regularSnapshotWithoutExtendedPrice = Boolean(
    serverExtendedQuote
    && currentQuote
    && tradeablePrice(currentQuote.regularClose)
    && currentQuote.price === currentQuote.regularClose
    && serverExtendedQuote.price !== currentQuote.price,
  );
  const acceptedExtended = currentQuote
    && tradeablePrice(currentQuote.price)
    && acceptedAsOf
    && sameSessionDate
    && acceptedSessionMatches
    && !regularSnapshotWithoutExtendedPrice;

  /**
   * The instant the PRIMARY row's price actually printed — the only truthful
   * thing to order an extended print against.
   *
   * The same regular-close snapshot detected above is stamped when it ARRIVED,
   * not when the close printed. Ordering against that receipt time makes a
   * genuine pre-market print look older than the close it follows, so a routine
   * snapshot refresh silently deletes the row (§3). The server-rendered quote —
   * the very value the server gated this print against — is used instead.
   */
  const regularRowAnchor = regularSnapshotWithoutExtendedPrice
    ? initial.freshness.asOf ?? current.freshness.asOf
    : current.freshness.asOf;

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
      extendedQuote: serverExtendedFor(regularRowAnchor),
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
    extendedQuote: acceptedExtended
      ? {
          session: acceptedSession === 'premarket' ? 'premarket' : 'after-hours',
          price: currentQuote.price,
          asOf: acceptedAsOf,
          tradingDate: exchangeSessionDate(acceptedAsOf, US_EQUITY_TIMEZONE),
          freshness: current.freshness,
          provider: current.provider,
        }
      : serverExtendedFor(primaryFreshness.asOf ?? regularRowAnchor),
  };
}

export interface PriceHeaderRegularRow {
  price: number | null;
  previousClose: number | null;
  change: PriceChange | null;
  /** ISO instant of the regular price. NEVER used to decide the current session. */
  asOf: string | null;
  provider: string | null;
  freshness: DataFreshness;
  fallbackLabel: StockDetailQuoteResource['fallbackLabel'];
}

export interface PriceHeaderExtendedRow {
  session: ExtendedRowSession;
  price: number;
  /** Change against the regular close in the primary row (§6 comparison base). */
  change: PriceChange | null;
  /** ISO instant of the extended print. NEVER used to decide the current session. */
  asOf: string;
  tradingDate: string | null;
  provider: string | null;
  freshness: DataFreshness;
}

/**
 * The ONE model `StockPriceHeader` renders. Assembling it here keeps the
 * component purely presentational: it holds no second opinion about which
 * session the market is in, which price belongs in which row, or what the
 * change is computed against.
 *
 * `currentSession` arrives already resolved from `resolveCurrentMarketSession`
 * and is simply carried through — this function never re-derives it, least of
 * all from `regular.asOf` or `extended.asOf`, which are DATA timestamps.
 */
export interface StockPriceHeaderModel {
  currentSession: CurrentMarketSession;
  /** The instant the session was resolved — not the instant the price printed. */
  currentSessionEvaluatedAt: string;
  currentSessionSource: string;
  regular: PriceHeaderRegularRow;
  extended: PriceHeaderExtendedRow | null;
}

export function buildStockPriceHeaderModel(input: {
  data: PriceHeaderData;
  currentSession: CurrentMarketSession;
  currentSessionEvaluatedAt: string;
  currentSessionSource: string;
}): StockPriceHeaderModel {
  const { data, currentSession } = input;
  const quote = data.quote;
  const price = tradeablePrice(quote?.price) ? quote!.price : null;
  const regular: PriceHeaderRegularRow = {
    price,
    previousClose: quote?.previousClose ?? null,
    // Canonical daily change: always `price - previousClose`. Provider change
    // fields are never allowed to describe a different/stale accepted price.
    change: resolvePriceChange({
      price,
      previousClose: quote?.previousClose,
      providerChange: quote?.change,
      providerChangePercent: quote?.changePercent,
    }),
    asOf: data.freshness.asOf ?? quote?.latestTradingDay ?? null,
    provider: data.provider,
    freshness: data.freshness,
    fallbackLabel: data.fallbackLabel,
  };

  // Belt and braces for invariant B: `resolvePriceHeaderData` already refuses to
  // emit a row during REGULAR/HALTED, and the final model refuses to carry one.
  const extendedQuote = isRegularSession(currentSession) || !usesLatestRegularClose(currentSession)
    ? null
    : data.extendedQuote;

  return {
    currentSession,
    currentSessionEvaluatedAt: input.currentSessionEvaluatedAt,
    currentSessionSource: input.currentSessionSource,
    regular,
    extended: extendedQuote
      ? {
          session: extendedQuote.session,
          price: extendedQuote.price,
          // §6: an extended print is always compared against the regular close
          // shown beside it — never against another extended print or a candle.
          change: calculatePriceChange(extendedQuote.price, price),
          asOf: extendedQuote.asOf,
          tradingDate: extendedQuote.tradingDate,
          provider: extendedQuote.provider,
          freshness: extendedQuote.freshness,
        }
      : null,
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
  | { kind: 'connecting'; label: string }
  | { kind: 'reconnecting'; label: string }
  | { kind: 'error'; label: string };

export function connectionStatusPresentation(status: ConnectionStatus | null | undefined): ConnectionStatusView {
  switch (status) {
    case 'awaiting-data':
      return { kind: 'awaiting', label: 'เชื่อมต่อแล้ว · รอข้อมูลสด' };
    case 'reconnecting':
      return { kind: 'reconnecting', label: 'กำลังเชื่อมต่อใหม่' };
    case 'degraded':
    case 'disconnected':
      return { kind: 'error', label: 'ออฟไลน์' };
    case 'connecting':
      return { kind: 'connecting', label: 'กำลังเชื่อมต่อ' };
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
 * Resolve the regular-session daily change against the canonical contract:
 *
 *     change        = displayedPrice - previousClose
 *     changePercent = change / previousClose * 100
 *
 * where `previousClose` is the finalized regular-session close of the previous US
 * trading day (resolved upstream by `comparisonCloseForAcceptedPrice`).
 *
 * With a real `previousClose`, derive from the DISPLAYED price via
 * {@link calculatePriceChange}. A provider `change` describes the price the
 * provider itself returned; once a fresher accepted price (a live stream tick)
 * has replaced it, that number no longer matches what the header shows.
 *
 * With no usable canonical previous close, return null. Provider change fields
 * cannot establish that the comparison base is the finalized close of the
 * immediately preceding US trading day, so using them would violate the
 * contract rather than rescue it.
 *
 * Nothing here is fabricated, and the percentage is never currency-converted.
 */
export function resolvePriceChange(input: {
  price: number | null | undefined;
  previousClose: number | null | undefined;
  providerChange: number | null | undefined;
  providerChangePercent: number | null | undefined;
}): PriceChange | null {
  const { price, previousClose } = input;
  // The displayed price itself must be a real, tradeable value.
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) {
    return null;
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
