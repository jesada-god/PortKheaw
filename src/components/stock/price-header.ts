import {
  sessionPresentation,
  type CurrentMarketSession,
  type MarketCloseReason,
  type MarketSessionPhase,
  type SessionPresentation,
} from '@/src/lib/market-data/current-session';
import type {
  CanonicalMarketSnapshot,
  ComparisonBaseKind,
  ExtendedSessionKind,
  MainPriceRole,
} from '@/src/lib/market-data/market-snapshot';
import { classifyUsEquitySession, exchangeSessionDate, US_EQUITY_TIMEZONE } from '@/src/lib/market-data/session';
import type { DataFreshness } from '@/src/lib/market-data/types';
import type { ConnectionStatus } from '@/src/lib/stock-detail/market-source';
import type { StockDetailQuoteResource } from '@/src/lib/stock-detail/types';

/** Which extended window a SECONDARY-row print belongs to. Never a current-session claim. */
export type ExtendedRowSession = ExtendedSessionKind;
export type PriceDirection = 'up' | 'down' | 'neutral';
export type PriceDisplayCurrency = 'USD' | 'THB';
export type PriceDataStatus =
  | 'live'
  | 'delayed'
  | 'cached'
  | 'stale'
  /** A finalized official close. Final, therefore never "ageing out". */
  | 'closed'
  | 'unknown'
  | 'unavailable';

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
const EXTENDED_ROW_PRESENTATION: Record<ExtendedRowSession, {
  icon: SessionPresentation['icon'];
  tone: SessionPresentation['tone'];
  label: string;
  description: string;
  fullName: string;
}> = {
  premarket: {
    icon: 'wb_twilight',
    tone: 'pre',
    label: 'ก่อนเปิดตลาด',
    description: 'ราคาซื้อขายช่วงก่อนตลาดเปิด (Pre-market) เทียบกับราคาปิดล่าสุด',
    fullName: 'Pre-market Session',
  },
  'after-hours': {
    icon: 'bedtime',
    tone: 'post',
    label: 'หลังปิดตลาด',
    description: 'ราคาซื้อขายช่วงหลังตลาดปิด (After-hours) เทียบกับราคาปิดจริงของวันนั้น',
    fullName: 'After-hours / Post-market Session',
  },
};

const DATA_STATUS_PRESENTATION: Record<PriceDataStatus, { emoji: string | null; label: string }> = {
  live: { emoji: null, label: 'ราคาสด' },
  delayed: { emoji: '⏱️', label: 'ราคาล่าช้า' },
  cached: { emoji: '💾', label: 'ข้อมูลที่บันทึกไว้' },
  stale: { emoji: '🕒', label: 'ข้อมูลอาจล่าช้า' },
  // A finalized official close. It does not age into "possibly delayed": it is the
  // final value for that session, and labelling it stale at 3am was itself a defect.
  closed: { emoji: null, label: 'ราคาปิดทางการ' },
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
 * The MAIN price row: the one number a reader sees as "the price".
 *
 * Every field is copied from the canonical snapshot. Nothing here re-decides which
 * price belongs in the row, what it is compared against, or which session the
 * market is in — those are the snapshot's answers, and duplicating any of them is
 * how the header drifted out of agreement with the resolver in the first place.
 */
export interface PriceHeaderMainRow {
  price: number | null;
  /** Which semantic slot the displayed price fills. */
  role: MainPriceRole | null;
  /** The value the change is measured against, and what that value IS. */
  comparisonBase: number | null;
  comparisonBaseKind: ComparisonBaseKind | null;
  change: PriceChange | null;
  /** ISO instant of the price. NEVER used to decide the current session. */
  asOf: string | null;
  /** Exchange-local trading date the price belongs to. */
  tradingDate: string | null;
  provider: string | null;
  /** `provider.field` provenance for the ⓘ detail. */
  source: string | null;
  freshness: DataFreshness | null;
  status: PriceDataStatus;
  fallbackLabel: StockDetailQuoteResource['fallbackLabel'];
}

/**
 * The SECONDARY row: an extended-hours print shown beneath the main price.
 *
 * It exists only when there is a REAL extended print. With none, the row is absent
 * entirely rather than rendered empty or with a fabricated 0.00% — a placeholder
 * reading "0.00%" is indistinguishable from a genuine flat session.
 */
export interface PriceHeaderSecondaryRow {
  session: ExtendedRowSession;
  price: number;
  /**
   * Change against the OFFICIAL REGULAR CLOSE in the main row — the only base that
   * answers what a reader is asking ("how far has it moved since the close?").
   * Null when no close could be established, which hides the numbers rather than
   * comparing against something else.
   */
  change: PriceChange | null;
  comparisonBase: number | null;
  comparisonBaseKind: ComparisonBaseKind | null;
  /** ISO instant of the print. NEVER used to decide the current session. */
  asOf: string;
  tradingDate: string | null;
  provider: string | null;
  source: string | null;
  freshness: DataFreshness;
  status: PriceDataStatus;
}

/**
 * The ONE model `StockPriceHeader` renders, projected from the ONE canonical
 * snapshot. The component is purely presentational: it holds no second opinion
 * about the session, the rows, or the comparison bases.
 */
export interface StockPriceHeaderModel {
  /** The canonical snapshot this model is a projection of. */
  snapshot: CanonicalMarketSnapshot;
  session: MarketSessionPhase;
  closeReason: MarketCloseReason | null;
  /** Icon, color tone and Thai status text for the session + close reason. */
  presentation: SessionPresentation;
  /** The raw resolved session label, for the ⓘ provenance detail. */
  sessionLabel: CurrentMarketSession;
  /** The instant the session was resolved — not the instant any price printed. */
  currentSessionEvaluatedAt: string;
  currentSessionSource: string;
  main: PriceHeaderMainRow;
  secondary: PriceHeaderSecondaryRow | null;
}

/**
 * Truthful data status for a resolved price.
 *
 * A finalized official close reports `closed`, never an aged-out `stale`: it is the
 * final value for its session and does not become less true as the evening goes on.
 * Everything still live is aged against its own provider freshness budget.
 */
function priceStatus(
  role: MainPriceRole | null,
  freshness: DataFreshness | null,
  evaluatedAtMs: number,
): PriceDataStatus {
  if (!freshness) return 'unavailable';
  if (role === 'regular-close') return 'closed';
  return resolveDataStatus(freshness, evaluatedAtMs);
}

/**
 * Project the canonical snapshot into the header's two rows.
 *
 * The only arithmetic performed here is the two changes, and each is computed
 * against the base the snapshot named:
 *
 *   main change      = mainPrice - comparisonBase        (the previous regular close)
 *   secondary change = extendedPrice - regularClose      (the close it followed)
 *
 * The secondary base is deliberately NOT `previousRegularClose`. An after-hours
 * print compared against yesterday's close answers a question nobody asked and
 * double-counts the day's move.
 */
export function buildStockPriceHeaderModel(input: {
  snapshot: CanonicalMarketSnapshot;
  /** The instant the view is being evaluated at, for freshness labelling only. */
  evaluatedAt: string;
  /** Provenance note from the quote pipeline when a fallback source was used. */
  fallbackLabel?: StockDetailQuoteResource['fallbackLabel'];
}): StockPriceHeaderModel {
  const { snapshot } = input;
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  const price = tradeablePrice(snapshot.mainPrice) ? snapshot.mainPrice : null;

  const main: PriceHeaderMainRow = {
    price,
    role: price === null ? null : snapshot.mainPriceRole,
    comparisonBase: snapshot.comparisonBase,
    comparisonBaseKind: snapshot.comparisonBaseKind,
    change: calculatePriceChange(price, snapshot.comparisonBase),
    asOf: snapshot.mainPriceTimestamp,
    tradingDate: snapshot.tradingDate,
    provider: snapshot.mainPriceProvider,
    source: snapshot.mainPriceSource,
    freshness: snapshot.mainPriceFreshness,
    status: price === null
      ? 'unavailable'
      : priceStatus(snapshot.mainPriceRole, snapshot.mainPriceFreshness, evaluatedAtMs),
    fallbackLabel: input.fallbackLabel ?? null,
  };

  const hasSecondary = tradeablePrice(snapshot.extendedPrice)
    && snapshot.extendedSession !== null
    && snapshot.extendedPriceTimestamp !== null
    && snapshot.extendedPriceFreshness !== null;

  return {
    snapshot,
    session: snapshot.session,
    closeReason: snapshot.closeReason,
    presentation: sessionPresentation(snapshot.session, snapshot.closeReason, snapshot.sessionLabel),
    sessionLabel: snapshot.sessionLabel,
    currentSessionEvaluatedAt: snapshot.evaluatedAt,
    currentSessionSource: snapshot.sessionSource,
    main,
    secondary: hasSecondary
      ? {
        session: snapshot.extendedSession!,
        price: snapshot.extendedPrice!,
        change: calculatePriceChange(snapshot.extendedPrice, snapshot.regularClose),
        comparisonBase: snapshot.regularClose,
        comparisonBaseKind: snapshot.regularClose === null ? null : 'regular-close',
        asOf: snapshot.extendedPriceTimestamp!,
        tradingDate: snapshot.extendedPriceTradingDate,
        provider: snapshot.extendedPriceProvider,
        source: snapshot.extendedPriceSource,
        freshness: snapshot.extendedPriceFreshness!,
        status: resolveDataStatus(snapshot.extendedPriceFreshness!, evaluatedAtMs),
      }
      : null,
  };
}

export function dataStatusPresentation(status: PriceDataStatus) {
  return DATA_STATUS_PRESENTATION[status];
}

/**
 * Thai label for WHAT a change is measured against.
 *
 * Shown next to every change in the ⓘ detail and as the row tooltip, because "-2.75
 * (-2.75%)" is ambiguous on its own: the main row compares against the previous
 * session's close while the extended row compares against today's, and a reader has
 * no way to tell which without being told.
 */
export function comparisonBaseLabel(kind: ComparisonBaseKind | null): string {
  switch (kind) {
    case 'previous-regular-close': return 'เทียบราคาปิดของวันซื้อขายก่อนหน้า';
    case 'regular-close': return 'เทียบราคาปิดจริงของวันซื้อขายล่าสุด';
    default: return 'ไม่มีฐานเปรียบเทียบที่ตรวจสอบได้';
  }
}

/** Thai label for which semantic slot the main price fills. */
export function mainPriceRoleLabel(role: MainPriceRole | null): string {
  switch (role) {
    case 'regular': return 'ราคาซื้อขายล่าสุดในเวลาทำการปกติ';
    case 'regular-close': return 'ราคาปิดจริงของวันซื้อขายล่าสุด (Official Regular Close)';
    case 'premarket': return 'ราคาซื้อขายล่าสุดช่วงก่อนเปิดตลาด (Pre-market)';
    default: return 'ไม่พบราคาที่ตรวจสอบได้';
  }
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
