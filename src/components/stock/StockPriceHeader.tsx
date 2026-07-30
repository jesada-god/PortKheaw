'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { Info } from 'lucide-react';
import { Modal } from '@/src/components/ui/Modal';
import { SessionIcon } from '@/src/components/ui/SessionIcon';
import type { MarketDataApiError } from '@/src/lib/market-data/types';
import type { FxQuote } from '@/src/lib/market-data/fx/types';
import { currentSessionPresentation } from '@/src/lib/market-data/current-session';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import { stockDetailErrorMessage } from '@/src/lib/stock-detail/error-presentation';
import {
  connectionStatusPresentation,
  calculatePriceChange,
  comparisonBaseLabel,
  convertUsdForDisplay,
  dataStatusPresentation,
  extendedSessionPresentation,
  formatSessionDateLabel,
  mainPriceRoleLabel,
  priceDirectionPresentation,
  priceFlashDirection,
  priceSessionLabel,
  type PriceDirection,
  type PriceDisplayCurrency,
  type StockPriceHeaderModel,
} from './price-header';
import { classifyUsEquitySession } from '@/src/lib/market-data/session';
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
   * The sink mutates the canonical price/change/% group in one synchronous turn,
   * avoiding a component-tree render without showing mismatched values.
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

/**
 * The headline price, at the precision the exchange actually printed.
 *
 * Deliberately NOT the 2-decimal `compact` mode. US closes are quoted to 2–4
 * decimals — NVTS's official regular close is 9.735 — and rounding the headline to
 * 9.74 reproduces the very complaint this work exists to fix: the big number not
 * matching the official close. Trailing zeros are still dropped, so an ordinary
 * 206.87 close is unchanged and only real sub-cent precision is shown.
 */
function formatMainPrice(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? 'ไม่พบข้อมูล'
    : numberFormatter.format(value);
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
  const changeRowRef = useRef<HTMLDivElement>(null);
  const changeAmountRef = useRef<HTMLSpanElement>(null);
  const changePercentRef = useRef<HTMLSpanElement>(null);
  const changeDirectionRef = useRef<HTMLSpanElement>(null);
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
  // Everything below reads the already-resolved model, which is a projection of the
  // ONE canonical snapshot. No session, row, comparison base or data status is
  // decided here.
  const { session: phase, main, secondary, presentation, snapshot } = model;
  const freshness = main.freshness;
  const provider = main.provider;
  const fallbackLabel = main.fallbackLabel;
  const mainPrice = main.price;
  const mainChange = main.change;
  const displayPrice = mainPrice !== null
    ? verifiedUsdSource
      ? convertUsdForDisplay(mainPrice, selectedCurrency, fxRate)
      : mainPrice
    : null;
  const displayChange = mainChange
    ? verifiedUsdSource
      ? convertUsdForDisplay(mainChange.amount, selectedCurrency, fxRate)
      : mainChange.amount
    : null;
  const extendedChange = secondary?.change ?? null;
  const displayExtendedPrice = secondary
    ? verifiedUsdSource
      ? convertUsdForDisplay(secondary.price, selectedCurrency, fxRate)
      : secondary.price
    : null;
  const displayExtendedChange = extendedChange
    ? verifiedUsdSource
      ? convertUsdForDisplay(extendedChange.amount, selectedCurrency, fxRate)
      : extendedChange.amount
    : null;
  const dataStatusView = dataStatusPresentation(main.status);
  const extendedDataStatusView = secondary ? dataStatusPresentation(secondary.status) : null;
  const renderedExtendedPrice = displayExtendedPrice ?? secondary?.price ?? null;
  const changeDirection = mainChange?.direction ?? null;
  const extendedDirection = extendedChange?.direction ?? null;
  // Flash the price on a real move only (keyed on the source USD value, so a
  // USD/THB toggle never flashes). Reduced motion is handled by global CSS.
  const priceFlash = usePriceFlash(mainPrice);
  const extendedFlash = usePriceFlash(secondary?.price ?? null);
  const thbUnavailable = !verifiedUsdSource || fxRate === null || !Number.isFinite(fxRate) || fxRate <= 0;
  const quoteCoolingDown = quoteRetryAt > 0;
  const quoteDate = freshness?.asOf ? null : main.asOf;
  const displayedQuoteAsOf = main.asOf;
  const combinedStatus = presentation.label;
  // Exchange-local DD/MM for the trading date the MAIN price belongs to. It is a
  // DATA date, never evidence about the current session — so outside REGULAR it is
  // prefixed "ข้อมูลล่าสุด" to make that impossible to misread.
  const priceDateLabel = formatSessionDateLabel(main.tradingDate ?? displayedQuoteAsOf);
  const sessionDateLabel = priceDateLabel === null
    ? null
    : phase === 'REGULAR'
      ? priceDateLabel
      : `ข้อมูลล่าสุด ${priceDateLabel}`;
  const extendedDateLabel = formatSessionDateLabel(secondary?.tradingDate ?? secondary?.asOf);
  // Real-time badge is gated on the truthful `realtime` flag (a genuine live feed)
  // AND on the main row actually showing a live regular price. A finalized close is
  // never "real-time", however healthy the socket is.
  const feedLabel = feed ? feed.toUpperCase() : null;
  const showRealtime = realtime
    && main.role === 'regular'
    && mainPrice !== null
    && feedLabel !== null;
  // Status-only view of the live socket. Never derives price/freshness — it is
  // rendered ALONGSIDE the existing status, never replacing it.
  const connectionView = connectionStatusPresentation(connectionState);

  /**
   * The imperative hot path: a live trade tick writes the price/change group
   * directly, without a React render.
   *
   * It is gated by the SAME phase rule the resolver applies, and gated FIRST. This
   * is the exact node the NVTS defect wrote to: the main price element showed an
   * after-hours print of 10.42 while the official close was 9.735, because the old
   * gate trusted a provider-supplied session string that Alpaca never sends — so it
   * read `undefined`, never matched, and every extended tick was let through.
   *
   * Two independent conditions now have to hold, and neither depends on a provider
   * label. The market must be in a phase whose main line IS a live regular price
   * (REGULAR only — during PRE/POST/CLOSED the main line is a completed close and no
   * tick may touch it), and the tick's own exchange timestamp must fall inside the
   * regular session. A tick with no usable timestamp is refused rather than assumed.
   */
  const applyTransientPrice = useCallback<TransientPriceSink>((price, metadata) => {
    if (!Number.isFinite(price) || price <= 0) return;
    if (phase !== 'REGULAR' || main.role !== 'regular') return;
    if (!metadata?.asOf || classifyUsEquitySession(metadata.asOf) !== 'regular') return;
    lastTransientUsdPriceRef.current = {
      symbol,
      price,
      asOf: metadata.asOf,
      feed: metadata?.feed ?? null,
    };
    const nextDisplayPrice = verifiedUsdSource
      ? convertUsdForDisplay(price, selectedCurrency, fxRate)
      : price;
    const nextChange = calculatePriceChange(price, main.comparisonBase);
    if (priceDisplayRef.current) priceDisplayRef.current.textContent = formatMainPrice(nextDisplayPrice);
    if (
      !nextChange
      || !changeRowRef.current
      || !changeAmountRef.current
      || !changePercentRef.current
      || !changeDirectionRef.current
    ) return;
    const nextDisplayChange = verifiedUsdSource
      ? convertUsdForDisplay(nextChange.amount, selectedCurrency, fxRate)
      : nextChange.amount;
    // All writes are synchronous in one JS task, so the browser cannot paint a
    // fresh WS price beside the previous tick's amount or percentage.
    changeAmountRef.current.textContent = formatSigned(nextDisplayChange);
    changePercentRef.current.textContent = formatPercent(nextChange.percent);
    changeRowRef.current.className = `inline-flex basis-full shrink-0 items-center gap-x-2 whitespace-nowrap text-base font-semibold sm:text-xl ${directionClass(nextChange.direction)}`;
    const mark = directionMark(nextChange.direction);
    changeDirectionRef.current.textContent = mark ?? '';
    changeDirectionRef.current.classList.toggle('hidden', mark === null);
    if (mark) {
      changeDirectionRef.current.setAttribute(
        'aria-label',
        nextChange.direction === 'up' ? 'ราคาเพิ่มขึ้น' : 'ราคาลดลง',
      );
    } else {
      changeDirectionRef.current.removeAttribute('aria-label');
    }
  }, [fxRate, main.comparisonBase, main.role, phase, selectedCurrency, symbol, verifiedUsdSource]);

  useEffect(() => {
    if (!transientPriceSinkRef) return;
    const sink = applyTransientPrice;
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
  }, [applyTransientPrice, symbol, transientPriceSinkRef]);

  useLayoutEffect(() => {
    const latest = lastTransientUsdPriceRef.current;
    if (
      latest?.symbol !== symbol
      || (!realtime && connectionState !== 'connected')
    ) return;
    // React may just have committed an older REST/error value. Restore the
    // complete newest live observation before paint without scheduling a render.
    applyTransientPrice(latest.price, { asOf: latest.asOf, feed: latest.feed });
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
                {displayPrice === null ? 'ไม่พบราคาล่าสุด' : formatMainPrice(displayPrice)}
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-text-muted">{displayedCurrency}</span>
            </span>
            {/* The change always occupies its own line: `basis-full` makes it wrap
                below the price group at every width, giving the fixed reading
                order price → change → session that the header specifies, while
                remaining a sibling so no numeric token can ever split. */}
            {mainChange && <div ref={changeRowRef} data-testid="regular-change" title={comparisonBaseLabel(main.comparisonBaseKind)} className={`inline-flex basis-full shrink-0 items-center gap-x-2 whitespace-nowrap text-base font-semibold sm:text-xl ${directionClass(changeDirection)}`}>
              <span ref={changeAmountRef} className="whitespace-nowrap">{formatSigned(displayChange)}</span>
              <span ref={changePercentRef} className="whitespace-nowrap">{formatPercent(mainChange.percent)}</span>
              <span
                ref={changeDirectionRef}
                className={`text-[0.7em] ${directionMark(changeDirection) ? '' : 'hidden'}`}
                {...(directionMark(changeDirection)
                  ? { 'aria-label': changeDirection === 'up' ? 'ราคาเพิ่มขึ้น' : 'ราคาลดลง' }
                  : {})}
              >{directionMark(changeDirection)}</span>
            </div>}
          </div>

          {/* Session + trading date only. Provider, exact timestamp, delay class
              and any fallback reason live behind the ⓘ control — they are
              provenance, not headline. */}
          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-muted" data-testid="session-line">
            {/* Session status: one Material Symbols glyph + Thai text, both driven by
                the snapshot's phase and close reason. The icon carries the Thai
                description as its accessible name and tooltip; `role="status"` is
                deliberately NOT used here — this is a label, not a live region, and
                the connection pills below own that role. */}
            <span
              className="inline-flex min-w-0 items-center gap-1.5 font-medium"
              data-testid="current-session-label"
              data-session-phase={phase}
              data-close-reason={model.closeReason ?? ''}
              title={presentation.description}
            >
              <SessionIcon name={presentation.icon} tone={presentation.tone} title={presentation.description}/>
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
            {connectionView.kind === 'connecting' && <>
              <span aria-hidden="true">·</span>
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-300"
              >
                <span
                  className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-sky-300/40 border-t-sky-300"
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

      {/* Extended-hours row. It renders only when the snapshot resolved a REAL
          extended print — never as an empty placeholder, and never with a 0.00%
          that a reader cannot tell apart from a genuinely flat session. */}
      {secondary && <div data-testid="extended-hours-row" data-extended-session={secondary.session} className="mt-3.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-border/70 bg-bg-base/40 px-3 py-2 font-mono text-sm tabular-nums">
        <span
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-sans text-xs font-semibold text-text-muted"
          title={extendedSessionPresentation(secondary.session).description}
          aria-label={extendedSessionPresentation(secondary.session).description}
        >
          <SessionIcon
            name={extendedSessionPresentation(secondary.session).icon}
            tone={extendedSessionPresentation(secondary.session).tone}
            title={extendedSessionPresentation(secondary.session).description}
          />
          {extendedSessionPresentation(secondary.session).label}
        </span>
        <span key={extendedFlash.nonce} data-testid="extended-hours-price" className={`shrink-0 whitespace-nowrap rounded px-1 -mx-1 text-base font-bold text-text-main ${flashClass(extendedFlash.direction)}`}>
          {formatNumber(renderedExtendedPrice)}
          {displayExtendedPrice === null && normalizedSourceCurrency ? ` ${normalizedSourceCurrency}` : ''}
        </span>
        {extendedChange && displayExtendedChange !== null && <span
          data-testid="extended-hours-change"
          title={comparisonBaseLabel(secondary.comparisonBaseKind)}
          className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap font-semibold ${directionClass(extendedDirection)}`}
        >
          <span>{formatSigned(displayExtendedChange)}</span>
          <span>{formatPercent(extendedChange.percent)}</span>
          {directionMark(extendedDirection) && <span className="text-[0.7em]" aria-label={extendedDirection === 'up' ? 'ราคาเพิ่มขึ้น' : 'ราคาลดลง'}>{directionMark(extendedDirection)}</span>}
        </span>}
        {extendedDateLabel && <span data-testid="extended-hours-date" className="ml-auto shrink-0 whitespace-nowrap text-xs text-text-muted">{extendedDateLabel}</span>}
        {extendedDataStatusView && <span data-testid="extended-hours-status" className="basis-full font-sans text-[11px] text-text-muted">
          {extendedDataStatusView.label}
          {secondary.provider ? ` · ${secondary.provider}` : ''}
          {` · ${formatProviderTimestamp(secondary.asOf)}`}
        </span>}
      </div>}

      {mainPrice === null && <div className="mt-5 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-bg-base/60 p-3 text-sm text-amber-300"><p className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{stockDetailErrorMessage(quoteError, 'quote', providerConfigured)}</p><button type="button" disabled={quoteLoading || quoteCoolingDown} onClick={onRetryQuote} className="min-h-11 shrink-0 rounded-lg border border-amber-400/30 px-3 text-xs disabled:opacity-50">{quoteLoading ? 'กำลังโหลด…' : quoteCoolingDown ? 'รอตามระยะเวลาที่กำหนดแล้วลองอีกครั้ง' : 'ลองโหลดราคาอีกครั้ง'}</button></div>}
    </section>

    <Modal isOpen={detailsOpen} onClose={() => setDetailsOpen(false)} title="รายละเอียดราคา">
      <dl className="text-sm">
        <Detail label="Provider" value={provider ?? 'ไม่พบข้อมูล'}/>
        <Detail label="Symbol" value={symbol}/>
        <Detail label="Exchange" value={exchange ?? 'ไม่พบข้อมูล'}/>
        {/* Market Session provenance: WHICH session, WHY it is closed, resolved from
            WHAT, and WHEN it was evaluated. Kept strictly separate from the price
            timestamps below so the two can never be read as the same fact. */}
        <Detail label="สถานะตลาด" value={`${combinedStatus} (${presentation.fullName})`}/>
        <Detail label="Session Phase" value={`${phase}${model.closeReason ? ` · ${model.closeReason}` : ''} (${currentSessionPresentation(model.sessionLabel).fullName})`}/>
        <Detail label="Market Session Source" value={model.currentSessionSource}/>
        <Detail
          label="Session Evaluated At"
          value={`${model.currentSessionEvaluatedAt} (${formatProviderTimestamp(model.currentSessionEvaluatedAt)})`}
        />
        {/* The canonical snapshot's own answers, each with the field it came from —
            so "which value is this, and where is it from" is always inspectable. */}
        <Detail label="ราคาหลักคืออะไร" value={mainPriceRoleLabel(main.role)}/>
        <Detail label="Main Price" value={`${formatNumber(mainPrice)} ${normalizedSourceCurrency ?? 'ไม่ทราบสกุลเงิน'}`}/>
        <Detail label="Main Price Source" value={main.source ?? 'ไม่พบข้อมูล'}/>
        <Detail label="ช่วงเวลาของราคา" value={priceSessionLabel(displayedQuoteAsOf)}/>
        <Detail
          label="Regular Close"
          value={`${formatNumber(snapshot.regularClose)} ${normalizedSourceCurrency ?? ''} · ${snapshot.regularCloseSource ?? 'ไม่พบแหล่งข้อมูล'}`}
        />
        <Detail
          label="Previous Regular Close"
          value={`${formatNumber(snapshot.previousRegularClose)} ${normalizedSourceCurrency ?? ''} · ${snapshot.previousRegularCloseSource ?? 'ไม่พบแหล่งข้อมูล'}`}
        />
        <Detail label="Comparison Base" value={`${formatNumber(main.comparisonBase)} · ${comparisonBaseLabel(main.comparisonBaseKind)}`}/>
        {secondary && <Detail
          label="Extended Price"
          value={`${formatNumber(secondary.price)} ${normalizedSourceCurrency ?? 'ไม่ทราบสกุลเงิน'} · ${extendedSessionPresentation(secondary.session).label} · ${secondary.tradingDate ?? 'ไม่ทราบวันซื้อขาย'}`}
        />}
        {secondary && <Detail label="Extended Source" value={`${secondary.source ?? 'ไม่พบข้อมูล'} · ${formatProviderTimestamp(secondary.asOf)}`}/>}
        {secondary && <Detail label="Extended Comparison Base" value={`${formatNumber(secondary.comparisonBase)} · ${comparisonBaseLabel(secondary.comparisonBaseKind)}`}/>}
        {secondary && extendedDataStatusView && <Detail label="Extended Data Status" value={extendedDataStatusView.label}/>}
        {!secondary && <Detail label="Extended Price" value="ไม่มีการซื้อขายนอกเวลาทำการที่ตรวจสอบได้"/>}
        <Detail label="Display Currency" value={displayedCurrency}/>
        <Detail
          label={quoteDate ? 'Trading date' : 'Timestamp'}
          value={`${displayedQuoteAsOf ?? 'ไม่พบข้อมูล'} (${formatProviderTimestamp(displayedQuoteAsOf, Boolean(quoteDate))})`}
        />
        <Detail label="Trading Date" value={snapshot.tradingDate ?? 'ไม่พบข้อมูล'}/>
        <Detail label="Display Timezone" value="Asia/Bangkok; วันซื้อขายอ้างอิงเวลาตลาด (America/New_York)"/>
        <Detail label="Data Status" value={dataStatusView.label}/>
        {/* Validation outcomes. A rejected value never silently disappears: the flag
            that rejected it is listed here. */}
        {snapshot.flags.length > 0 && <Detail label="Data Validation" value={snapshot.flags.join(', ')}/>}
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
      {/* Plain-language explanation for a beginner: what the big number means in
          THIS session, and what each change is measured against. */}
      <div className="mt-4 space-y-2 rounded-xl border border-border bg-bg-base/60 p-3 text-xs leading-5 text-text-muted">
        <p>{mainPriceRoleLabel(main.role)} · {comparisonBaseLabel(main.comparisonBaseKind)}</p>
        {phase === 'PRE' && <p>ก่อนตลาดเปิด ราคาหลักจะเป็นราคาปิดจริงของวันซื้อขายล่าสุด ส่วนราคาที่ซื้อขายช่วงก่อนเปิดตลาดจะแสดงเป็นแถวรองด้านล่าง</p>}
        {phase === 'POST' && <p>หลังตลาดปิด ราคาหลักจะเป็นราคาปิดจริงของวันนี้เท่านั้น ส่วนราคาที่ซื้อขายหลังตลาดปิดจะแสดงเป็นแถวรองด้านล่าง</p>}
        {/* CLOSED is deliberately worded differently from POST: both extended
            windows have ENDED, so the row is not "missing" — it is over, and a
            leftover print would read as a current price. */}
        {phase === 'CLOSED' && <p>ช่วงซื้อขายนอกเวลาทำการสิ้นสุดแล้ว จึงแสดงเฉพาะราคาปิดจริงของวันซื้อขายล่าสุดเพียงแถวเดียว</p>}
        {secondary && <p>ราคานอกเวลาทำการ (Extended Hours) {comparisonBaseLabel(secondary.comparisonBaseKind)}</p>}
        {!secondary && (phase === 'PRE' || phase === 'POST') && <p>ยังไม่มีการซื้อขายนอกเวลาทำการที่ตรวจสอบได้ จึงไม่แสดงแถวรอง</p>}
      </div>
    </Modal>
  </>;
}
