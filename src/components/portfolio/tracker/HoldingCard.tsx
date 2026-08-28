'use client';

import Link from 'next/link';
import { ChevronDown, ChevronUp, History } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { PositionToolAction } from '@/src/components/portfolio/PositionToolAction';
import { gainColor, signedPercent } from '@/src/lib/portfolio/presentation';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';
import type { HoldingSummary } from '@/src/lib/portfolio/types';
import type { PortfolioToolContext } from '@/src/lib/tools/handoff';

function number(value: number, maximumFractionDigits = 8) {
  return new Intl.NumberFormat('th-TH', { maximumFractionDigits }).format(value);
}

function displayTime(value: string, timezone: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(parsed);
}

function totalPnlPercent(holding: HoldingSummary) {
  return holding.unrealizedGain === null || holding.costBasis === 0
    ? null
    : holding.unrealizedGain / holding.costBasis * 100;
}

/**
 * A holding as one tappable row that opens into its own detail, at every width.
 *
 * This replaces the eight-column table that used to appear from `md` up. The
 * table was never wrong, but it forced a second reading language on the same
 * data — a phone read cards and a laptop read a spreadsheet — and it could only
 * fit by scrolling sideways inside its own box. One card, denser on a wide
 * screen, is the same information without the second language.
 *
 * Nothing here recalculates: quantity, value, today and total all come straight
 * off the `HoldingSummary` the ledger produced.
 */
export function HoldingCard({
  holding,
  companyName,
  portfolioLabel,
  expanded,
  showBalances,
  dayLabel,
  timezone,
  portfolioId,
  assetType,
  canWrite,
  money,
  signed,
  hidden,
  onToggle,
  onBuy,
  onSell,
  onCloseAll,
}: {
  holding: HoldingSummary;
  companyName?: string | null;
  /** Set only when the row is read outside a single portfolio, so it can say where it lives. */
  portfolioLabel?: string | null;
  expanded: boolean;
  showBalances: boolean;
  /**
   * The word the day figure is labelled with — "วันนี้" while the market is
   * trading, a weekday once the figure is a completed session's close.
   *
   * Passed in rather than written here because every figure on the tracker must
   * carry the SAME word: the number itself is reconciled across the whole
   * portfolio, so a row claiming a different day from the total beside it would
   * be describing a session it did not come from.
   */
  dayLabel: string;
  timezone: string;
  portfolioId: string;
  /**
   * The instrument master's own classification, which is what decides the tool a
   * holding can reach. Never inferred from the symbol: SPY and AAPL are both
   * four plausible letters, and only the master knows one of them is an ETF.
   * Both go to the Stock Planner — the distinction exists so neither can ever be
   * routed into an option simulator.
   */
  assetType: 'stock' | 'etf';
  canWrite: boolean;
  money: (value: number | string | null) => string;
  signed: (value: number | null) => string;
  hidden: (value: string) => string;
  onToggle: () => void;
  onBuy: () => void;
  onSell: () => void;
  onCloseAll: () => void;
}) {
  const percent = totalPnlPercent(holding);
  return <article className="panel min-w-0" data-testid="holding-card">
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex min-h-[4.5rem] w-full min-w-0 items-center gap-3 rounded-[var(--radius-panel)] p-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
    >
      <InstrumentLogo symbol={holding.symbol} companyName={companyName ?? holding.symbol} size={40} />
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-base font-bold text-[var(--text)]">{holding.symbol}</strong>
        <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
          {companyName && companyName !== holding.symbol ? `${companyName} · ` : ''}
          {hidden(number(holding.quantity))} หน่วย
          {portfolioLabel ? ` · ${portfolioLabel}` : ''}
        </span>
      </span>
      <span className="min-w-0 shrink-0 text-right">
        <span className="figure block break-all text-base font-bold text-[var(--text)]">{money(holding.marketValue)}</span>
        <span className={`figure mt-0.5 block break-all text-xs font-semibold ${holding.todayChange === null ? 'text-[var(--text-muted)]' : gainColor(holding.todayChange)}`}>
          {holding.todayChange === null ? `— ${dayLabel}` : `${signed(holding.todayChange)} ${dayLabel}`}
        </span>
        <span className={`figure mt-0.5 block break-all text-[11px] ${holding.unrealizedGain === null ? 'text-[var(--text-muted)]' : gainColor(holding.unrealizedGain)}`}>
          รวม {signed(holding.unrealizedGain)}{percent === null ? '' : ` · ${signedPercent(percent, showBalances)}`}
        </span>
      </span>
      {expanded
        ? <ChevronUp aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" size={18} />
        : <ChevronDown aria-hidden="true" className="shrink-0 text-[var(--text-muted)]" size={18} />}
    </button>

    {expanded && <div className="min-w-0 space-y-4 border-t border-[var(--border)] p-3.5">
      <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4">
        <Detail label="ต้นทุนเฉลี่ย" value={money(holding.averageCost)} />
        <Detail label="ราคาปัจจุบัน" value={money(holding.marketPrice)} extra={<QuoteMeta holding={holding} timezone={timezone} />} />
        <Detail label="ต้นทุนคงเหลือ" value={money(holding.costBasis)} />
        <Detail label="น้ำหนักในพอร์ต" value={showBalances ? `${holding.allocation.toFixed(2)}%` : SENSITIVE_VALUE_MASK} />
      </dl>

      {canWrite && <div className="flex min-w-0 flex-wrap gap-2">
        <Button size="sm" onClick={onBuy}>เพิ่มซื้อ</Button>
        <Button size="sm" variant="outline" onClick={onSell}>ขายบางส่วน</Button>
        <Button size="sm" variant="outline" onClick={onCloseAll}>ปิดทั้งหมด</Button>
      </div>}

      {/*
        The planner, on its own row under a rule, because it is the one control
        here that writes nothing. Shares and ETFs reach exactly one tool, so
        there is nothing to choose between and it opens straight into it with
        this holding already filled in.
      */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        <PositionToolAction
          context={{
            type: assetType,
            symbol: holding.symbol,
            quantity: holding.quantity,
            averageCost: holding.averageCost,
            price: holding.marketPrice,
            marketValue: holding.marketValue,
            unrealizedGain: holding.unrealizedGain,
            portfolioId,
          } satisfies PortfolioToolContext}
          label="วางแผน"
          source="portfolio.holding"
        />
        <span className="min-w-0 break-words text-xs text-[var(--text-muted)]">คำนวณอย่างเดียว ไม่บันทึกรายการ</span>
      </div>

      <div>
        <h4 className="section-eyebrow">Lots ที่เหลือ</h4>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {holding.lots.map((lot) => <div key={lot.transactionId} className="inset p-3 text-xs">
            <p className="figure text-[var(--text)]">{hidden(number(lot.remainingQuantity))} / {hidden(number(lot.originalQuantity))} หน่วย</p>
            <p className="mt-1 text-[var(--text-muted)]">{displayTime(lot.occurredAt, timezone)} · ต้นทุนคงเหลือ {money(lot.remainingCost)}</p>
            {lot.broker && <p className="text-[var(--text-muted)]">{lot.broker}</p>}
          </div>)}
        </div>
      </div>

      {/*
        Lots describe what is still held, so they belong here. The transactions
        behind them are history, and history lives on the statement route where
        it can be read, filtered and corrected in one place.
      */}
      <Link
        href={`/portfolio/transactions?portfolio=${portfolioId}`}
        className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <History aria-hidden="true" size={14} /> ดูประวัติของ {holding.symbol}
      </Link>
    </div>}
  </article>;
}

function QuoteMeta({ holding, timezone }: { holding: HoldingSummary; timezone: string }) {
  if (holding.marketPrice === null) {
    return <span className="mt-1 block text-[11px] text-[var(--warning)]">ข้อมูลราคายังไม่พร้อม</span>;
  }
  return <span className={`mt-1 block text-[11px] ${holding.priceStale ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
    {holding.priceStale || holding.priceCached ? 'ข้อมูลล่าสุดที่บันทึกไว้' : 'ข้อมูลตลาด'}
    {holding.priceAsOf ? ` · ${displayTime(holding.priceAsOf, timezone)}` : ''}
  </span>;
}

function Detail({ label, value, extra }: { label: string; value: string; extra?: React.ReactNode }) {
  return <div className="min-w-0">
    <dt className="figure-label">{label}</dt>
    <dd className="figure-data mt-1 break-words text-[var(--text)]">{value}</dd>
    {extra}
  </div>;
}
