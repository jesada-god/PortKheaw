'use client';

import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import type { PortfolioDailyInsight } from '@/src/lib/portfolio/daily-insight';
import { portfolioReturnToneClass } from '@/src/lib/portfolio/presentation';

/**
 * One card, one question: "วันนี้พอร์ตเป็นยังไง?".
 *
 * The primary view is deliberately short — a headline and at most three short
 * facts — because the answer somebody opens the app for is one sentence long.
 * The decomposition every one of those facts came from is one tap down, and it
 * is the same holdings the page is already showing, not a second dashboard.
 */
export function DailyInsightCard({
  insight,
  open,
  onToggle,
  signed,
  percent,
  showBalances,
}: {
  insight: PortfolioDailyInsight;
  open: boolean;
  onToggle: () => void;
  signed: (value: number | null) => string;
  percent: (value: number | null) => string;
  showBalances: boolean;
}) {
  if (!insight.hasContent) return null;

  const lines: string[] = [];
  if (insight.contributor) lines.push(`${insight.contributor.symbol} ช่วยพอร์ตมากที่สุด ${signed(insight.contributor.change)}`);
  if (insight.detractor) lines.push(`${insight.detractor.symbol} ฉุดพอร์ตมากที่สุด ${signed(insight.detractor.change)}`);
  if (insight.sector) lines.push(`กลุ่ม ${insight.sector.name} มีผลต่อพอร์ตมากที่สุด ${signed(insight.sector.change)}`);
  const expiry = insight.expiries[0];
  if (expiry) {
    lines.push(insight.expiries.length > 1
      ? `มี ${insight.expiries.length} สัญญาใกล้หมดอายุ เร็วที่สุดคือ ${expiry.underlyingSymbol} ในอีก ${expiry.dte} วัน`
      : `มี 1 สัญญาใกล้หมดอายุใน ${expiry.dte} วัน (${expiry.underlyingSymbol})`);
  }

  return <section
    className="min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
    data-testid="portfolio-daily-insight"
  >
    <div className="min-w-0 p-4">
      <h2 className="flex min-w-0 items-center gap-2 text-sm font-bold text-[var(--text)]">
        <Sparkles aria-hidden="true" size={16} className="shrink-0 text-[var(--accent)]" />
        วันนี้พอร์ตเป็นยังไง?
      </h2>
      {insight.today
        ? <p
          className={`mt-2 break-all font-mono text-xl font-black ${portfolioReturnToneClass(showBalances ? insight.today.change : null, 'text-[var(--text)]')}`}
          data-testid="daily-insight-headline"
        >
          {signed(insight.today.change)}
          {insight.today.changePercent !== null && <span className="ml-2 text-base">({percent(insight.today.changePercent)})</span>}
        </p>
        /*
          No priced movement is a real state, not an error and not a zero. It is
          said plainly and the facts below — an expiry, for instance — still
          stand on their own.
        */
        : <p className="mt-2 text-sm text-[var(--text-muted)]">ยังคำนวณผลของวันนี้ไม่ได้ เพราะยังไม่มีราคาปิดวันก่อนครบทุกสินทรัพย์</p>}

      {lines.length > 0 && <ul className="mt-3 grid min-w-0 gap-1.5">
        {lines.map((line) => <li key={line} className="flex min-w-0 gap-2 text-sm leading-6 text-[var(--text-secondary)]">
          <span aria-hidden="true" className="mt-2.5 size-1 shrink-0 rounded-full bg-[var(--accent)]" />
          <span className="min-w-0 break-words">{line}</span>
        </li>)}
      </ul>}
    </div>

    {insight.movers.length > 0 && <>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="daily-insight-toggle"
        className="flex min-h-12 w-full min-w-0 items-center justify-between gap-3 border-t border-[var(--border)] px-4 text-left text-sm font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <span>ดูรายละเอียด</span>
        {open
          ? <ChevronUp aria-hidden="true" className="shrink-0" size={18} />
          : <ChevronDown aria-hidden="true" className="shrink-0" size={18} />}
      </button>
      {open && <ul className="grid min-w-0 gap-2 border-t border-[var(--border)] p-4" data-testid="daily-insight-detail">
        {insight.movers.map((mover) => <li key={mover.symbol} className="flex min-w-0 items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-semibold text-[var(--text)]">{mover.symbol}</span>
          <span className={`shrink-0 break-all font-mono text-sm ${portfolioReturnToneClass(showBalances ? mover.change : null, 'text-[var(--text-muted)]')}`}>
            {signed(mover.change)}
          </span>
        </li>)}
      </ul>}
    </>}
  </section>;
}
