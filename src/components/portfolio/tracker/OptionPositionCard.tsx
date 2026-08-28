'use client';

import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { isInternalOptionContractSymbol } from '@/src/lib/portfolio/options/contract-symbol-status';
import {
  UNMATCHED_OPTION_MESSAGE,
  optionPositionDescription,
  optionPositionMoneyness,
  optionPositionTitle,
} from '@/src/lib/portfolio/options/presentation';
import type { OptionPositionSummary } from '@/src/lib/portfolio/options/types';
import { gainColor, signedPercent } from '@/src/lib/portfolio/presentation';
import { dayChangeCopy, dayChangeUnavailableCopy } from '@/src/lib/portfolio/day-change-label';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';

export function quoteNumber(value: number | null, digits?: number) {
  if (value === null) return '—';
  if (digits !== undefined) return value.toFixed(digits);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
    useGrouping: false,
  }).format(value);
}

export function optionDisplayTime(value: string, timezone = 'Asia/Bangkok') {
  const parsed = Date.parse(value);
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone })
    .format(Number.isFinite(parsed) ? new Date(parsed) : new Date(`${value}T12:00:00+07:00`));
}

/**
 * One option contract, as a card at every width.
 *
 * The ten-column table this replaces could only exist by scrolling sideways
 * inside its own box, and it said the same things twice — once as a table for a
 * laptop and once as a card for a phone. The card is denser on a wide screen
 * and identical in language.
 *
 * Status is never carried by colour alone: LONG/SHORT, OPEN/CLOSED and the
 * moneyness badge are all words, and the badge only appears when the underlying
 * price is actually known. No Greek, no implied volatility and no moneyness is
 * ever invented — a value the provider did not send reads "—".
 */
export function OptionPositionCard({
  position,
  expanded,
  showBalances,
  timezone,
  marketDate,
  portfolioLabel,
  money,
  signed,
  onToggle,
  children,
}: {
  position: OptionPositionSummary;
  expanded: boolean;
  showBalances: boolean;
  timezone: string;
  /**
   * The exchange-local date, resolved on the server.
   *
   * Needed to tell "the close that finished today" from "an earlier day's
   * close", which is the difference between captioning the day figure "วันนี้"
   * and naming a weekday. Resolving it in the browser instead would answer in
   * the reader's own zone and disagree with the server HTML it hydrates over.
   */
  marketDate: string;
  /** Set when the card is read outside a single portfolio, so it can say where it lives. */
  portfolioLabel?: string | null;
  money: (value: number | null) => string;
  signed: (value: number | null) => string;
  onToggle: () => void;
  /** Actions, sell target and transaction history — supplied where they are allowed. */
  children?: ReactNode;
}) {
  const moneyness = optionPositionMoneyness(position);
  /*
    A closed or expired position moved by zero and has no basis to name, so it
    gets the plain live copy rather than a caption claiming a session it did not
    take part in.
  */
  const dayCopy = position.todayChange !== null && position.todayChangeSource !== null
    ? dayChangeCopy({
      source: position.todayChangeSource,
      sessionDate: position.todayChangeAsOf,
      todayExchangeDate: marketDate,
    })
    : position.todayChange !== null
      ? { label: 'วันนี้', caption: 'สัญญานี้ปิดไปแล้ว จึงไม่มีการเปลี่ยนแปลงในวันนี้' }
      : dayChangeUnavailableCopy();
  return <article className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)]" data-testid="option-position-card">
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex min-h-[4.5rem] w-full min-w-0 items-start gap-3 rounded-2xl p-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <span className="min-w-0 flex-1">
        <strong className="block break-words text-base font-bold text-[var(--text)]">{optionPositionTitle(position)}</strong>
        <span className="mt-0.5 block break-words text-xs text-[var(--text-muted)]">
          {optionPositionDescription(position)}
          {portfolioLabel ? ` · ${portfolioLabel}` : ''}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge tone={position.side === 'long' ? 'positive' : 'negative'}>{position.side}</Badge>
          <Badge tone={position.status === 'open' ? 'accent' : position.status === 'expired' ? 'warning' : 'neutral'}>{position.status}</Badge>
          {moneyness && <Badge tone="neutral">{moneyness}</Badge>}
        </span>
      </span>
      <span className="min-w-0 shrink-0 text-right">
        <span className="block break-all font-mono text-base font-bold text-[var(--text)]">{money(position.marketValue)}</span>
        <span className={`mt-0.5 block break-all font-mono text-xs font-semibold ${position.unrealizedGain === null ? 'text-[var(--text-muted)]' : gainColor(position.unrealizedGain)}`}>
          {position.unrealizedGainPercent === null ? '—' : signedPercent(position.unrealizedGainPercent, showBalances)}
        </span>
        <span className={`mt-0.5 block break-all font-mono text-[11px] ${position.unrealizedGain === null ? 'text-[var(--text-muted)]' : gainColor(position.unrealizedGain)}`}>
          {signed(position.unrealizedGain)}
        </span>
      </span>
      {expanded
        ? <ChevronUp aria-hidden="true" className="mt-1 shrink-0 text-[var(--text-muted)]" size={18} />
        : <ChevronDown aria-hidden="true" className="mt-1 shrink-0 text-[var(--text-muted)]" size={18} />}
    </button>

    <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-3 border-t border-[var(--border)] p-3.5 sm:grid-cols-4">
      <OptionMetric label="จำนวน" value={showBalances ? `${position.contracts} สัญญา` : SENSITIVE_VALUE_MASK} />
      <OptionMetric label="Avg premium" value={`$${position.averagePremium.toFixed(2)}`} />
      <OptionMetric label="ต้นทุนคงเหลือ" value={money(position.remainingCost)} />
      {/*
        THIS TILE USED TO BE A DASH ALMOST ALWAYS.

        The chain pipeline reports `previousClose: null` for every contract it
        ever returns, so an option's day figure had no second price to subtract
        and the tile read "—" in every session, including open ones. The helper
        under it named the missing provider field, which was the wrong sentence
        twice over: it was about our plumbing rather than the reader's money, and
        it appeared even when the market was trading normally.

        The figure now comes from the captured close of a completed session, and
        the tile says which day in the label itself — "กำไร/ขาดทุนวันศุกร์" — so
        the number and the day it belongs to cannot be read apart. English
        trading shorthand is gone with it: this card is read by people who own
        one contract, not by a desk.
      */}
      <OptionMetric
        label={`กำไร/ขาดทุน${dayCopy.label}`}
        value={position.todayChange === null ? '—' : signed(position.todayChange)}
        tone={position.todayChange === null ? 'text-[var(--text-muted)]' : gainColor(position.todayChange)}
        helper={dayCopy.caption}
      />
    </dl>

    {expanded && <div className="min-w-0 space-y-5 border-t border-[var(--border)] p-3.5">
      <div className="min-w-0">
        <p className="text-xs text-[var(--text-muted)]">Bid / Ask / Mark</p>
        <p className="mt-1 break-all font-mono text-sm font-semibold text-[var(--text)]">
          {quoteNumber(position.bid)} / {quoteNumber(position.ask)} / {quoteNumber(position.mark)}
        </p>
        <OptionQuoteMeta position={position} timezone={timezone} />
      </div>
      <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4 lg:grid-cols-6">
        <OptionMetric label="Unrealized P&L" value={signed(position.unrealizedGain)} tone={position.unrealizedGain === null ? 'text-[var(--text-muted)]' : gainColor(position.unrealizedGain)} />
        <OptionMetric label="Realized P&L" value={signed(position.realizedGain)} tone={gainColor(position.realizedGain)} />
        <OptionMetric label="Mark precision (raw quote)" value={quoteNumber(position.mark)} />
        <OptionMetric label="ราคาปิดโดยประมาณ" value={position.estimatedClosePrice === null ? '—' : `$${position.estimatedClosePrice.toFixed(2)}`} />
        <OptionMetric label="มูลค่าปิดโดยประมาณ" value={money(position.estimatedCloseValue)} />
        <OptionMetric label="ตัวคูณต่อสัญญา" value={`${position.multiplier} หุ้น/สัญญา`} />
        <OptionMetric label="Strike" value={`$${position.strikePrice}`} />
        <OptionMetric label="Underlying" value={position.underlyingPrice === null ? '—' : `$${position.underlyingPrice.toFixed(2)}`} />
        <OptionMetric label="Breakeven" value={`$${position.breakeven.toFixed(2)}`} />
        <OptionMetric label="DTE" value={String(position.dte)} />
        <OptionMetric label="IV" value={position.impliedVolatility === null ? '—' : `${(position.impliedVolatility * 100).toFixed(2)}%`} />
        <OptionMetric label="Delta" value={quoteNumber(position.delta, 4)} />
        <OptionMetric label="Theta" value={quoteNumber(position.theta, 4)} />
      </dl>
      {children}
    </div>}
  </article>;
}

export function OptionQuoteMeta({ position, timezone = 'Asia/Bangkok' }: { position: OptionPositionSummary; timezone?: string }) {
  if (isInternalOptionContractSymbol(position.contractSymbol) && position.quoteFreshness === 'missing') {
    return <span className="mt-1 block text-[11px] text-[var(--warning)]">{UNMATCHED_OPTION_MESSAGE}</span>;
  }
  if (position.quoteFreshness === 'missing') return <span className="mt-1 block text-[11px] text-[var(--warning)]">ไม่มีราคา · แสดง —</span>;
  return <span className={`mt-1 block text-[11px] ${position.quoteFreshness === 'stale' ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
    {position.quoteFreshness === 'stale' ? 'ราคาเก่า (Stale)' : position.quoteFreshness} · {position.quoteSource ?? 'ไม่ทราบแหล่ง'}
    {position.quoteAsOf ? ` · ${optionDisplayTime(position.quoteAsOf, timezone)}` : ''}
  </span>;
}

export function OptionMetric({ label, value, tone = 'text-[var(--text)]', helper }: {
  label: string;
  value: string;
  tone?: string;
  helper?: string;
}) {
  return <div className="min-w-0">
    <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
    <dd className={`mt-1 break-words font-mono text-sm font-semibold ${tone}`}>{value}</dd>
    {helper && <dd className="mt-0.5 text-[11px] font-normal text-[var(--text-muted)]">{helper}</dd>}
  </div>;
}

function Badge({ tone, children }: { tone: 'positive' | 'negative' | 'accent' | 'warning' | 'neutral'; children: ReactNode }) {
  const style = {
    positive: 'bg-[color-mix(in_srgb,var(--positive)_15%,transparent)] text-[var(--positive)]',
    negative: 'bg-[color-mix(in_srgb,var(--negative)_15%,transparent)] text-[var(--negative)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)]',
    warning: 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning)]',
    neutral: 'bg-[var(--surface-hover)] text-[var(--text-secondary)]',
  }[tone];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${style}`}>{children}</span>;
}
