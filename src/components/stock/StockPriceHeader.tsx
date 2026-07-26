'use client';

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { ChevronDown, Clock3, Info, Moon, Sunrise } from 'lucide-react';
import { Modal } from '@/src/components/ui/Modal';
import type { MarketDataApiError } from '@/src/lib/market-data/types';
import type { FxQuote } from '@/src/lib/market-data/fx/types';
import {
  currentSessionPresentation,
  type CurrentMarketSession,
} from '@/src/lib/market-data/current-session';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import { stockDetailErrorMessage } from '@/src/lib/stock-detail/error-presentation';
import {
  connectionStatusPresentation,
  convertUsdForDisplay,
  dataStatusPresentation,
  extendedSessionPresentation,
  formatSessionDateLabel,
  priceDirectionPresentation,
  priceFlashDirection,
  priceSessionLabel,
  resolveDataStatus,
  type ExtendedRowSession,
  type PriceDirection,
  type PriceDisplayCurrency,
  type StockPriceHeaderModel,
} from './price-header';
import type { ConnectionStatus } from '@/src/lib/stock-detail/market-source';

interface TransientPriceMetadata {
  asOf: string | null;
  feed: string | null;
  session?: string | null;
}

export type TransientPriceSink = (
  price: number,
  metadata?: TransientPriceMetadata,
) => void;

interface StockPriceHeaderProps {
  symbol: string;
  exchange: string | null;
  sourceCurrency: string | null;
  /**
   * The single resolved header model: current session, primary regular row and
   * optional extended row. This component is presentation only — it performs no
   * session inference of its own and never re-derives the session from a price
   * or data timestamp.
   */
  model: StockPriceHeaderModel;
  providerConfigured: boolean;
  quoteError: MarketDataApiError | null;
  quoteLoading: boolean;
  quoteRetryAt: number;
  onRetryQuote: () => void;
  fxQuote: FxQuote | null;
  evaluatedAt: string;
  /** True only for a genuine live entitled stream; gates the Real-time badge. */
  realtime?: boolean;
  /** Upstream provider/feed id, e.g. `finnhub`. */
  feed?: string | null;
  /** Per-symbol trading halt, independent of the market-wide session. */
  symbolHalted?: boolean;
  haltReason?: string | null;
  /**
   * Live-connection lifecycle from the WS coordinator. Status indicator only — it
   * never affects the accepted price, timestamp, session or freshness. `null` on a
   * REST-only deployment, which therefore never shows a "reconnecting" pill.
   */
  connectionState?: ConnectionStatus | null;
  /**
   * Shared imperative sink used by the live source for Finnhub trade ticks.
   * The sink mutates only the price text node, avoiding a component-tree render.
   */
  transientPriceSinkRef?: MutableRefObject<TransientPriceSink | null>;
}

const numberFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function formatNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'ไม่พบข้อมูล' : numberFormatter.format(value);
}

function formatSigned(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'ไม่พบข้อมูล';
  const formatted = numberFormatter.format(Math.abs(value));
  return value > 0 ? `+${formatted}` : value < 0 ? `-${formatted}` : formatted;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'ไม่พบข้อมูล';
  const formatted = Math.abs(value).toFixed(2);
  return value > 0 ? `(+${formatted}%)` : value < 0 ? `(-${formatted}%)` : `(${formatted}%)`;
}

function formatProviderTimestamp(value: string | null, dateOnly = false): string {
  if (!value) return 'ไม่ทราบเวลาข้อมูล';
  // Intraday values show HH:mm:ss so a live timestamp visibly advances per tick;
  // `withSeconds` is ignored on the date-only path.
  const formatted = formatMarketDataAsOf(value, { dateOnly, withSeconds: true });
  return formatted === '—' ? 'ไม่ทราบเวลาข้อมูล' : formatted;
}

function directionClass(direction: PriceDirection | null): string {
  if (direction && priceDirectionPresentation(direction).tone === 'positive') return 'text-positive';
  if (direction && priceDirectionPresentation(direction).tone === 'negative') return 'text-negative';
  return 'text-text-muted';
}

function directionMark(direction: PriceDirection | null): string | null {
  return direction ? priceDirectionPresentation(direction).arrow : null;
}

function flashClass(direction: PriceDirection | null): string {
  return direction === 'up' ? 'price-flash-up' : direction === 'down' ? 'price-flash-down' : '';
}

/**
 * Tracks the last accepted USD price and, whenever a new tick moves it, returns a
 * flash direction plus a monotonically increasing `nonce`. The nonce is used as a
 * React `key` on the flashing element so the CSS animation replays on every move.
 * Keying on the currency-independent USD price means a USD/THB toggle never
 * flashes — only a genuine market move does. Reduced motion is honored by the
 * global CSS that caps animation-duration.
 */
function usePriceFlash(value: number | null): { direction: PriceDirection | null; nonce: number } {
  const previousRef = useRef<number | null>(null);
  const [flash, setFlash] = useState<{ direction: PriceDirection | null; nonce: number }>({
    direction: null,
    nonce: 0,
  });
  useEffect(() => {
    const direction = priceFlashDirection(previousRef.current, value);
    if (value !== null && Number.isFinite(value) && value > 0) previousRef.current = value;
    if (direction) setFlash((current) => ({ direction, nonce: current.nonce + 1 }));
  }, [value]);
  return flash;
}

function StatusEmoji({ value }: { value: string }) {
  return <span aria-hidden="true" className="shrink-0">{value}</span>;
}

function CurrentSessionIcon({ session }: { session: CurrentMarketSession }) {
  const className = session === 'PREMARKET' || session === 'AFTER_HOURS'
    ? 'text-accent-blue'
    : session === 'REGULAR'
      ? 'text-positive'
      : 'text-negative';
  if (session === 'PREMARKET') {
    return <Sunrise aria-hidden="true" className={`shrink-0 ${className}`} size={15}/>;
  }
  if (session === 'AFTER_HOURS' || session === 'CLOSED' || session === 'HOLIDAY') {
    return <Moon aria-hidden="true" className={`shrink-0 ${className}`} size={15}/>;
  }
  return <Clock3 aria-hidden="true" className={`shrink-0 ${className}`} size={14}/>;
}

function ExtendedSessionIcon({ session }: { session: ExtendedRowSession }) {
  return session === 'premarket'
    ? <Sunrise aria-hidden="true" className="shrink-0 text-accent-blue" size={15}/>
    : <Moon aria-hidden="true" className="shrink-0 text-accent-blue" size={15}/>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[9rem_1fr]"><dt className="text-text-muted">{label}</dt><dd className="min-w-0 break-words text-text-main">{value}</dd></div>;
}

export function StockPriceHeader({
  symbol,
  exchange,
  sourceCurrency,
  model,
  providerConfigured,
  quoteError,
  quoteLoading,
  quoteRetryAt,
  onRetryQuote,
  fxQuote,
  evaluatedAt,
  realtime = false,
  feed = null,
  symbolHalted = false,
  haltReason = null,
  connectionState = null,
  transientPriceSinkRef,
}: StockPriceHeaderProps) {
  const [currency, setCurrency] = useState<PriceDisplayCurrency>('USD');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const priceDisplayRef = useRef<HTMLSpanElement>(null);
  const lastTransientUsdPriceRef = useRef<{
    symbol: string;
    price: number;
    asOf: string | null;
    feed: string | null;
  } | null>(null);
  const normalizedSourceCurrency = sourceCurrency?.toUpperCase() ?? null;
  const verifiedUsdSource = normalizedSourceCurrency === 'USD';
  const fxRate = fxQuote ? Number(fxQuote.rate) : null;
  const selectedCurrency = verifiedUsdSource ? currency : 'USD';
  const displayedCurrency = verifiedUsdSource ? selectedCurrency : normalizedSourceCurrency ?? 'ไม่ทราบสกุลเงิน';
  // Everything below reads the already-resolved model. No session, row or
  // comparison base is decided here.
  const { currentSession, regular, extended: extendedQuote } = model;
  const freshness = regular.freshness;
  const provider = regular.provider;
  const fallbackLabel = regular.fallbackLabel;
  const regularPrice = regular.price;
  const regularChange = regular.change;
  const displayPrice = regularPrice !== null
    ? verifiedUsdSource
      ? convertUsdForDisplay(regularPrice, selectedCurrency, fxRate)
      : regularPrice
    : null;
  const displayChange = regularChange
    ? verifiedUsdSource
      ? convertUsdForDisplay(regularChange.amount, selectedCurrency, fxRate)
      : regularChange.amount
    : null;
  const extendedChange = extendedQuote?.change ?? null;
  const displayExtendedPrice = extendedQuote
    ? verifiedUsdSource
      ? convertUsdForDisplay(extendedQuote.price, selectedCurrency, fxRate)
      : extendedQuote.price
    : null;
  const displayExtendedChange = extendedChange
    ? verifiedUsdSource
      ? convertUsdForDisplay(extendedChange.amount, selectedCurrency, fxRate)
      : extendedChange.amount
    : null;
  const sessionView = currentSessionPresentation(currentSession);
  const dataStatus = regularPrice === null ? 'unavailable' : resolveDataStatus(freshness, Date.parse(evaluatedAt));
  const dataStatusView = dataStatusPresentation(dataStatus);
  const extendedDataStatusView = extendedQuote && extendedChange
    ? dataStatusPresentation(resolveDataStatus(extendedQuote.freshness, Date.parse(evaluatedAt)))
    : null;
  const changeDirection = regularChange?.direction ?? null;
  const extendedDirection = extendedChange?.direction ?? null;
  // Flash the price on a real move only (keyed on the source USD value, so a
  // USD/THB toggle never flashes). Reduced motion is handled by global CSS.
  const priceFlash = usePriceFlash(regularPrice);
  const extendedFlash = usePriceFlash(extendedQuote?.price ?? null);
  const thbUnavailable = !verifiedUsdSource || fxRate === null || !Number.isFinite(fxRate) || fxRate <= 0;
  const quoteCoolingDown = quoteRetryAt > 0;
  const quoteDate = freshness.asOf ? null : regular.asOf;
  const displayedQuoteAsOf = regular.asOf;
  const combinedStatus = sessionView.label;
  // Exchange-local DD/MM for the trading date the primary PRICE belongs to. It is
  // a DATA date, never evidence about the current session — so outside REGULAR it
  // is prefixed "ข้อมูลล่าสุด" to make that impossible to misread.
  const priceDateLabel = formatSessionDateLabel(displayedQuoteAsOf);
  const sessionDateLabel = priceDateLabel === null
    ? null
    : currentSession === 'REGULAR'
      ? priceDateLabel
      : `ข้อมูลล่าสุด ${priceDateLabel}`;
  const extendedDateLabel = formatSessionDateLabel(extendedQuote?.tradingDate ?? extendedQuote?.asOf);
  // Real-time badge is gated on the truthful `realtime` flag (a genuine live
  // feed), never on the data-status heuristic alone.
  const feedLabel = feed ? feed.toUpperCase() : null;
  const showRealtime = realtime && extendedQuote === null && regularPrice !== null && feedLabel !== null;
  // Status-only view of the live socket. Never derives price/freshness — it is
  // rendered ALONGSIDE the existing status, never replacing it.
  const connectionView = connectionStatusPresentation(connectionState);

  useEffect(() => {
    if (!transientPriceSinkRef) return;
    const sink: TransientPriceSink = (price, metadata) => {
      if (!Number.isFinite(price) || price <= 0) return;
      // PRE/AFTER trades belong exclusively in the secondary row. The accepted
      // React path partitions them with their regular-close comparison base; the
      // imperative hot path must never overwrite the main regular price first.
      if (metadata?.session === 'pre-market' || metadata?.session === 'after-hours') return;
      lastTransientUsdPriceRef.current = {
        symbol,
        price,
        asOf: metadata?.asOf ?? null,
        feed: metadata?.feed ?? null,
      };
      const nextDisplayPrice = verifiedUsdSource
        ? convertUsdForDisplay(price, selectedCurrency, fxRate)
        : price;
      if (priceDisplayRef.current) {
        // Hot trade-tick path: one text-node write, zero React state updates.
        priceDisplayRef.current.textContent = formatNumber(nextDisplayPrice);
      }
    };
    transientPriceSinkRef.current = sink;
    // Re-apply the newest tick after a USD/THB toggle without waiting for another
    // market event; React may just have rendered the slower bar-backed price.
    const latest = lastTransientUsdPriceRef.current;
    if (latest?.symbol === symbol) {
      sink(latest.price, { asOf: latest.asOf, feed: latest.feed });
    }
    return () => {
      if (transientPriceSinkRef.current === sink) transientPriceSinkRef.current = null;
    };
  }, [fxRate, selectedCurrency, symbol, transientPriceSinkRef, verifiedUsdSource]);

  useLayoutEffect(() => {
    const latest = lastTransientUsdPriceRef.current;
    if (
      latest?.symbol !== symbol
      || (!realtime && connectionState !== 'connected')
    ) return;
    const nextDisplayPrice = verifiedUsdSource
      ? convertUsdForDisplay(latest.price, selectedCurrency, fxRate)
      : latest.price;
    if (priceDisplayRef.current) {
      // React may just have committed an older REST/error value. Restore the
      // newest live observation before paint without scheduling another render.
      priceDisplayRef.current.textContent = formatNumber(nextDisplayPrice);
    }
  });

  return <>
    <section className="min-h-32 min-w-0 py-1">
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1.5 font-mono tabular-nums">
            {/* Price + currency are one atomic flow unit. The change may wrap below
                it on mobile, but no numeric token may ever split mid-number. */}
            <span className="inline-flex max-w-full shrink-0 items-baseline gap-x-1.5 whitespace-nowrap">
              <span
                ref={priceDisplayRef}
                data-testid="stock-last-price"
                key={priceFlash.nonce}
                className={displayPrice === null
                  ? 'font-sans text-2xl font-bold leading-tight tracking-tight text-text-main sm:text-3xl'
                  : `whitespace-nowrap rounded-md px-1.5 -mx-1.5 text-[clamp(2.25rem,10vw,3.25rem)] font-bold leading-none tracking-tight text-text-main ${flashClass(priceFlash.direction)}`}>
                {displayPrice === null ? 'ไม่พบราคาล่าสุด' : formatNumber(displayPrice)}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-text-muted">{displayedCurrency}</span>
            </span>
            {/* The change always occupies its own line: `basis-full` makes it wrap
                below the price group at every width, giving the fixed reading
                order price → change → session that the header specifies, while
                remaining a sibling so no numeric token can ever split. */}
            {regularChange && <div data-testid="regular-change" className={`inline-flex basis-full shrink-0 items-center gap-x-2 whitespace-nowrap text-base font-semibold sm:text-xl ${directionClass(changeDirection)}`}>
              <span className="whitespace-nowrap">{formatSigned(displayChange)}</span>
              <span className="whitespace-nowrap">{formatPercent(regularChange.percent)}</span>
              {directionMark(changeDirection) && <span className="text-[0.7em]" aria-label={changeDirection === 'up' ? 'ราคาเพิ่มขึ้น' : 'ราคาลดลง'}>{directionMark(changeDirection)}</span>}
            </div>}
          </div>

          {/* Session + trading date only. Provider, exact timestamp, delay class
              and any fallback reason live behind the ⓘ control — they are
              provenance, not headline. */}
          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-muted" data-testid="session-line">
            <span className="inline-flex min-w-0 items-center gap-1.5 font-medium" data-testid="current-session-label">
              <CurrentSessionIcon session={currentSession}/>
              <span>{combinedStatus}</span>
            </span>
            {sessionDateLabel && <>
              <span className="text-text-muted/60" aria-hidden="true">·</span>
              <span className="whitespace-nowrap tabular-nums">{sessionDateLabel}</span>
            </>}
            {showRealtime && <>
              <span aria-hidden="true">·</span>
              <span
                title={`ข้อมูลสดจาก ${feedLabel} ผ่าน Railway WebSocket Gateway`}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true"/>
                Real-time · {feedLabel}
              </span>
            </>}
            {symbolHalted && <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-300">
                ⏸️ ระงับการซื้อขาย{haltReason ? ` · ${haltReason}` : ''}
              </span>
            </>}
            {connectionView.kind === 'awaiting' && !showRealtime && <>
              <span aria-hidden="true">·</span>
              {/* Socket is open and subscribed but no tick has arrived yet — a calm,
                  non-error status. The fallback price above keeps showing until the
                  first live tick swaps in the Real-time badge. */}
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-300"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden="true"/>
                {connectionView.label}
              </span>
            </>}
            {connectionView.kind === 'reconnecting' && <>
              <span aria-hidden="true">·</span>
              {/* Reassures the user while the socket recovers; the last accepted
                  price above is untouched. Reduced motion caps the spin globally. */}
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300"
              >
                <span
                  className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-amber-300/40 border-t-amber-300"
                  aria-hidden="true"
                />
                {connectionView.label}
              </span>
            </>}
            {connectionView.kind === 'error' && <>
              <span aria-hidden="true">·</span>
              {/* Degraded/offline: shown next to the existing freshness badge, which
                  continues to reflect the (delayed/cached) data honestly. */}
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-300"
              >
                <StatusEmoji value="⚠️"/>
                {connectionView.label}
              </span>
            </>}
          </div>

        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-xl border border-border bg-bg-base p-1">
          {verifiedUsdSource && (['USD', 'THB'] as const).map((item) => <button
            key={item}
            type="button"
            aria-pressed={currency === item}
            onClick={() => setCurrency(item)}
            className={`min-h-11 rounded-lg px-3 text-xs font-semibold ${currency === item ? 'bg-primary text-black' : 'text-text-muted hover:text-text-main'}`}
          >{item}</button>)}
          {!verifiedUsdSource && <span className="px-3 text-xs font-semibold text-text-muted">{displayedCurrency}</span>}
          <button
            type="button"
            aria-label="ดูรายละเอียดราคา"
            aria-haspopup="dialog"
            onClick={() => setDetailsOpen(true)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-text-muted hover:text-text-main"
          ><Info aria-hidden="true" size={18}/></button>
        </div>
      </div>

      {currency === 'THB' && thbUnavailable && <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-300">ไม่มีอัตรา USD/THB จริงที่ตรวจสอบได้</p>}

      {/* Extended-hours row. It sits BELOW the regular price and never replaces
          it, carries its own trading date so a Friday after-hours print read on
          a Sunday is unambiguous, and is never labelled live. Provider and delay
          class stay in the ⓘ detail. */}
      {extendedQuote && extendedChange && displayExtendedPrice !== null && displayExtendedChange !== null && <div data-testid="extended-hours-row" className="mt-3.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-border/70 bg-bg-base/40 px-3 py-2 font-mono text-sm tabular-nums">
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-sans text-xs font-semibold text-text-muted">
          <ExtendedSessionIcon session={extendedQuote.session}/>
          {extendedSessionPresentation(extendedQuote.session).label}
        </span>
        <span key={extendedFlash.nonce} data-testid="extended-hours-price" className={`shrink-0 whitespace-nowrap rounded px-1 -mx-1 text-base font-bold text-text-main ${flashClass(extendedFlash.direction)}`}>{formatNumber(displayExtendedPrice)}</span>
        <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold ${directionClass(extendedDirection)}`}>
          <span>{formatSigned(displayExtendedChange)}</span>
          <span>{formatPercent(extendedChange.percent)}</span>
          {directionMark(extendedDirection) && <span className="text-[0.7em]" aria-label={extendedDirection === 'up' ? 'ราคาเพิ่มขึ้น' : 'ราคาลดลง'}>{directionMark(extendedDirection)}</span>}
        </span>
        {extendedDateLabel && <span data-testid="extended-hours-date" className="ml-auto shrink-0 whitespace-nowrap text-xs text-text-muted">{extendedDateLabel}</span>}
      </div>}

      {regularPrice === null && <div className="mt-5 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-base/60 p-3 text-sm text-amber-300"><p className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{stockDetailErrorMessage(quoteError, 'quote', providerConfigured)}</p><button type="button" disabled={quoteLoading || quoteCoolingDown} onClick={onRetryQuote} className="min-h-11 shrink-0 rounded-lg border border-amber-400/30 px-3 text-xs disabled:opacity-50">{quoteLoading ? 'กำลังโหลด…' : quoteCoolingDown ? 'รอตามระยะเวลาที่กำหนดแล้วลองอีกครั้ง' : 'ลองโหลดราคาอีกครั้ง'}</button></div>}
    </section>

    <Modal isOpen={detailsOpen} onClose={() => setDetailsOpen(false)} title="รายละเอียดราคา">
      <dl className="text-sm">
        <Detail label="Provider" value={provider ?? 'ไม่พบข้อมูล'}/>
        <Detail label="Symbol" value={symbol}/>
        <Detail label="Exchange" value={exchange ?? 'ไม่พบข้อมูล'}/>
        {/* Market Session provenance: WHICH session, resolved from WHAT, and WHEN
            it was evaluated. Kept strictly separate from the price timestamps
            below so the two can never be read as the same fact. */}
        <Detail label="สถานะตลาด" value={`${combinedStatus} (${sessionView.fullName})`}/>
        <Detail label="Market Session Source" value={model.currentSessionSource}/>
        <Detail
          label="Session Evaluated At"
          value={`${model.currentSessionEvaluatedAt} (${formatProviderTimestamp(model.currentSessionEvaluatedAt)})`}
        />
        <Detail label="ช่วงเวลาของราคา" value={priceSessionLabel(displayedQuoteAsOf)}/>
        <Detail label="Regular Price" value={`${formatNumber(regularPrice)} ${normalizedSourceCurrency ?? 'ไม่ทราบสกุลเงิน'}`}/>
        {!fallbackLabel && <Detail label="Previous Close" value={`${formatNumber(regular.previousClose)} ${normalizedSourceCurrency ?? 'ไม่ทราบสกุลเงิน'}`}/>}
        {extendedQuote && extendedChange && <Detail
          label="Extended Price"
          value={`${formatNumber(extendedQuote.price)} ${normalizedSourceCurrency ?? 'ไม่ทราบสกุลเงิน'} · ${extendedSessionPresentation(extendedQuote.session).label} · ${extendedQuote.tradingDate ?? 'ไม่ทราบวันซื้อขาย'}`}
        />}
        {extendedQuote && extendedChange && <Detail label="Extended Source" value={`${extendedQuote.provider ?? 'ไม่พบข้อมูล'} · ${formatProviderTimestamp(extendedQuote.asOf)}`}/>}
        {extendedQuote && extendedDataStatusView && <Detail label="Extended Data Status" value={extendedDataStatusView.label}/>}
        {!fallbackLabel && <Detail label="Comparison Base" value={extendedQuote && extendedChange ? 'Official Regular Close' : 'Previous Close'}/>}
        <Detail label="Display Currency" value={displayedCurrency}/>
        <Detail
          label={quoteDate ? 'Trading date' : 'Timestamp'}
          value={`${displayedQuoteAsOf ?? 'ไม่พบข้อมูล'} (${formatProviderTimestamp(displayedQuoteAsOf, Boolean(quoteDate))})`}
        />
        <Detail label="Display Timezone" value="Asia/Bangkok; วันซื้อขายอ้างอิงเวลาตลาด (America/New_York)"/>
        <Detail label="Data Status" value={dataStatusView.label}/>
        {/* Fallback provenance moved out of the primary row: it is a technical
            explanation of WHERE the price came from, not part of the price. */}
        {fallbackLabel && <Detail
          label="Fallback"
          value={fallbackLabel === 'Intraday close fallback'
            ? 'ใช้ราคาปิดระหว่างวันล่าสุดแทน เนื่องจากผู้ให้บริการหลักไม่ตอบกลับราคาปัจจุบัน'
            : 'ใช้ข้อมูลจากวันซื้อขายก่อนหน้า'}
        />}
        <Detail label="Delay Duration" value="Provider ไม่ได้ระบุ"/>
        {selectedCurrency === 'THB' && <Detail label="FX" value={fxQuote ? `1 USD = ${fxQuote.rate} THB · ${fxQuote.source} · ณ ${fxQuote.asOf}${fxQuote.stale ? ' · ข้อมูลเก่า' : fxQuote.cached ? ' · ข้อมูลแคช' : ''}` : 'ไม่พบข้อมูล'}/>}
      </dl>
      <div className="mt-4 space-y-2 rounded-xl border border-border bg-bg-base/60 p-3 text-xs leading-5 text-text-muted">
        <p>Previous Close ยังใช้เป็นฐานคำนวณ Daily Change แม้ไม่ได้แสดงในการ์ด Overview</p>
        {extendedQuote && extendedChange && <p>ราคาช่วง Extended Hours เปรียบเทียบกับราคาปิดของ Regular Session ล่าสุด</p>}
      </div>
    </Modal>
  </>;
}
