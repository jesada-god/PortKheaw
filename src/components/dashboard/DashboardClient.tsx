'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  Eye,
  EyeOff,
  Gauge,
  Info,
  PieChart,
  Plus,
  RefreshCw,
  Star,
  TrendingUp,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { chooseOverviewWatchlistAction } from '@/app/watchlist/actions';
import Header from '@/src/components/layout/Header';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { KheawLoadingBoundary } from '@/src/components/ui/KheawLoadingBoundary';
import { stockDetailHref } from '@/src/lib/instruments/routes';
import { OVERVIEW_STATUS_COPY } from '@/src/lib/overview/presentation';
import { rankIndustries, type IndustryRankingOrder } from '@/src/lib/overview/industry-ranking';
import type {
  IndustryGroup,
  MarketIndexCard,
  OverviewDashboardData,
  OverviewPrice,
} from '@/src/lib/overview/types';
import {
  applyOverviewSectionUpdate,
  type OverviewSectionRelated,
  type OverviewSectionValue,
  type RetriableOverviewSection,
} from '@/src/lib/overview/client-state';
import { LandingFunnel } from '@/src/components/analytics/LandingFunnel';
import { OnboardingCard } from '@/src/components/onboarding/OnboardingCard';
import { UpcomingSection } from '@/src/components/upcoming/UpcomingSection';
import type { OnboardingView } from '@/src/lib/onboarding/onboarding';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { statusFromSignedValue, type StatusLevel } from '@/src/lib/presentation/status';
import { StatusLabel } from '@/src/components/ui/StatusLabel';
import { assetsOutsideMarketStatus } from '@/src/lib/overview/market-assets';
import { buildMarketSummary } from '@/src/lib/overview/market-summary';
import { buildOverviewChanges, type OverviewChange } from '@/src/lib/overview/changes';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';
import { formatPortfolioMoney, signedMoney, signedPercent } from '@/src/lib/portfolio/presentation';
import { dayChangeCopy, dayChangeUnavailableCopy } from '@/src/lib/portfolio/day-change-label';
import { MarketStatusCard } from './MarketStatusCard';
import { MarketEventsCard } from '@/src/components/market-events/MarketEventsCard';
import {
  orderedOverviewSections,
  type OverviewSectionKey,
} from '@/src/lib/overview/section-order';
import {
  MarketAssetStrip,
  MarketTodaySkeleton,
  MarketTodayStrip,
} from './MarketTodaySection';
import { ChangesList } from './ChangesList';
import { WatchlistTable, WatchlistTableSkeleton } from './WatchlistTable';
import { EventsList } from './EventsList';
import type { WatchlistRow } from '@/src/lib/watchlist/rows';
import { usePortfolioPrivacy } from '@/src/hooks/usePortfolioPrivacy';

const NewsFeed = dynamic(
  () => import('@/src/components/news/NewsFeed').then((module) => module.NewsFeed),
  {
    ssr: false,
    // role="status" for the same reason as the breadth bar below: a bare <div>
    // is role="generic", which may not carry a name.
    loading: () => (
      <div className="space-y-3" role="status" aria-label="กำลังโหลดข่าว">
        {[1, 2, 3].map((item) => (
          <div key={item} className="h-24 animate-pulse rounded-xl bg-[var(--surface-elevated)]" />
        ))}
      </div>
    ),
  },
);

function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return 'ยังไม่มีข้อมูล';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value: number | null, suffix = ''): string {
  if (value === null || !Number.isFinite(value)) return 'ยังไม่มีข้อมูล';
  return `${value > 0 ? '+' : ''}${formatNumber(value)}${suffix}`;
}

function tone(value: number | null): string {
  if (value === null || value === 0) return 'text-[var(--text-muted)]';
  return value > 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]';
}

function MiniLine({ values, positive }: { values: number[]; positive: boolean }) {
  if (values.length < 2) return <div className="h-10" aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = index / (values.length - 1) * 100;
    const y = 38 - (value - min) / span * 34;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg viewBox="0 0 100 40" role="img" aria-label="กราฟราคาระหว่างวัน" className="h-10 w-full overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={positive ? 'var(--positive)' : 'var(--negative)'}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const PUBLIC_VALUE_POINTS = [
  {
    icon: PieChart,
    title: 'รู้ว่าพอร์ตเป็นยังไง',
    detail: 'ติดตามมูลค่า กำไรขาดทุน และภาพรวมพอร์ต',
  },
  {
    icon: TrendingUp,
    title: 'เข้าใจหุ้นก่อนตัดสินใจ',
    detail: 'ดูข้อมูลตลาด สถิติ ข่าว การวิเคราะห์ และ Fair Value',
  },
  {
    icon: Gauge,
    title: 'ลองก่อนลงเงินจริง',
    detail: 'จำลอง Options และสถานการณ์ด้วย What-If และ Monte Carlo',
  },
] as const;

/**
 * What PortKheaw is, for somebody who has never seen it — shown only while
 * signed out.
 *
 * Kept to one compact card on purpose: the overview below it is the product,
 * and a visitor should reach the live market data by scrolling once, not by
 * reading a landing page. A signed-in reader never sees this at all, so their
 * portfolio stays the first thing on the screen.
 */
function PublicValueProposition() {
  return (
    <section
      aria-labelledby="portkheaw-intro"
      className="panel p-4 sm:p-5"
    >
      <h2 id="portkheaw-intro" className="text-lg font-bold leading-snug text-[var(--text)] sm:text-xl">
        ลงทุนให้เห็นภาพมากขึ้น ไม่ต้องเปิดหลายแอป
      </h2>
      <p className="mt-1.5 text-sm leading-6 text-[var(--text-secondary)]">
        ติดตามพอร์ต ดูข้อมูลหุ้น วิเคราะห์ Options และลองจำลองสถานการณ์ก่อนตัดสินใจ — ทั้งหมดใน PortKheaw
      </p>
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-3 sm:gap-2">
        {PUBLIC_VALUE_POINTS.map(({ icon: Icon, title, detail }) => (
          <li key={title} className="inset flex items-start gap-2.5 p-2.5 sm:p-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] sm:h-8 sm:w-8">
              <Icon size={16} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-[var(--text)]">{title}</p>
              <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">{detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          href="/auth/sign-up"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 text-sm font-bold text-[var(--accent-fg)]"
        >
          เริ่มใช้ฟรี
          <ChevronRight size={16} aria-hidden="true" />
        </Link>
        {/*
          A visitor deciding whether this is worth an account should be able to
          see what it costs without making one, so the prices are one link away
          rather than behind sign-up.
        */}
        <Link
          href="/pricing"
          className="inline-flex min-h-11 items-center rounded-xl px-1 text-sm font-medium text-[var(--text-secondary)] underline-offset-4 hover:underline"
        >
          ดูแพ็กเกจและราคา
        </Link>
        <p className="text-xs text-[var(--text-muted)]">ไม่ต้องผูกบัตร • ทดลอง Elite ฟรี 7 วัน</p>
      </div>
    </section>
  );
}

/**
 * A section announces itself with its name, a hairline running to the right
 * margin, and whatever control belongs to it parked at the end of that line.
 *
 * The accent icon that used to sit in front of every one of these is gone. Five
 * sections each led by a lime glyph made all five look equally important, and
 * made the page look assembled from a single part — the icons were decoration
 * doing a heading's job. A rule is a typographic device rather than a sixth
 * box, so a section can now announce itself without becoming a card to do it.
 */
function SectionTitle({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-head">
      <h2 className="section-head__name truncate">{title}</h2>
      <span aria-hidden="true" className="section-head__rule" />
      {action && <span className="section-head__action">{action}</span>}
    </div>
  );
}

function RetryButton({
  section,
  loading,
  onRetry,
}: {
  section: RetriableOverviewSection;
  loading: boolean;
  onRetry: (section: RetriableOverviewSection) => void;
}) {
  return (
    <button
      type="button"
      disabled={loading}
      aria-label="โหลดข้อมูลส่วนนี้ใหม่"
      onClick={() => onRetry(section)}
      className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
    >
      <RefreshCw
        size={17}
        aria-hidden="true"
        className={loading ? 'animate-spin motion-reduce:animate-none' : ''}
      />
    </button>
  );
}

/** Breathing room kept between an open Info panel and the edge of the screen. */
const PANEL_VIEWPORT_MARGIN = 8;

/**
 * The single Info affordance the overview sections share.
 *
 * It replaces two different things that both failed the same way on a phone: a
 * `title` attribute on a decorative icon (nothing happens on tap — a native
 * tooltip is hover-only), and a panel that lived in the DOM permanently with
 * `group-hover`/`group-focus-within` deciding its visibility (once a tap focused
 * the trigger, the panel stayed up with no way to dismiss it).
 *
 * The behaviour contract, identical wherever this is used:
 *  - closed on mount, and re-renders or a section refresh never open it;
 *  - a real `<button>` toggles it, so one tap opens and the next closes;
 *  - a pointer press outside the wrapper closes it, as does Escape, which then
 *    hands focus back to the trigger;
 *  - each instance owns its own state, so opening one leaves the other closed.
 *
 * Escape is claimed in the CAPTURE phase and stopped there for the same reason
 * as {@link InfoHint}: an enclosing disclosure must not be torn down along with
 * the explanation the reader opened.
 *
 * Presentation stays with the call site — `iconSize` and `triggerClassName` keep
 * each header looking exactly as it did — while the panel is deliberately shared
 * so the two sections read as one pattern.
 */
function SectionInfo({
  label,
  testId,
  iconSize,
  triggerClassName,
  children,
}: {
  /** Thai `aria-label` for the trigger, e.g. `ข้อมูลอุตสาหกรรมเด่นวันนี้`. */
  label: string;
  testId: string;
  iconSize: number;
  triggerClassName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  /*
   * Where the panel may sit is decided by flex-wrap, not by the markup. The
   * breadth Info rides at the end of a wrapping badge row, so on a phone it
   * lands near the left edge, where a right-anchored 288px panel hangs ~200px
   * off the screen — and the anchor that would be correct at 390px is the wrong
   * one at 430px, where the row no longer wraps. So the panel is measured once
   * it is open and nudged back inside the viewport. When it already fits — every
   * desktop case, and the industry header at any width — the shift is 0 and
   * nothing moves, which is why the layout is unchanged everywhere it was fine.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const node = panelRef.current;
    if (!node) return;
    const clamp = () => {
      /*
       * The correction is read off the UNSHIFTED box: the transform is dropped
       * for the measurement and restored immediately, within the same layout
       * effect, so nothing is painted in between. Measuring the shifted box and
       * subtracting instead would make the result depend on its own output, and
       * anywhere `getBoundingClientRect` does not reflect the transform the two
       * would chase each other forever.
       */
      const previous = node.style.transform;
      node.style.transform = 'none';
      const rect = node.getBoundingClientRect();
      node.style.transform = previous;

      const viewport = document.documentElement.clientWidth;
      // No layout to measure (jsdom, or a hidden ancestor): leave it anchored.
      if (!viewport || !rect.width) return;

      const limit = viewport - PANEL_VIEWPORT_MARGIN;
      const next = rect.left < PANEL_VIEWPORT_MARGIN ? PANEL_VIEWPORT_MARGIN - rect.left
        : rect.right > limit ? limit - rect.right
          : 0;
      setShift((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    /*
     * The trigger sits inside the wrapper, so its own press is never treated as
     * "outside" — the click that follows does the toggling, and the panel cannot
     * be closed and reopened by the same gesture.
     */
    const onPointerDown = (event: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-describedby={open ? panelId : undefined}
        data-testid={`${testId}-trigger`}
        onClick={() => setOpen((value) => !value)}
        className={triggerClassName}
      >
        <Info size={iconSize} aria-hidden="true" />
      </button>
      {open && (
        <span
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          data-testid={`${testId}-panel`}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          className="absolute right-0 top-full z-20 block w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs leading-5 text-[var(--text-secondary)] shadow-xl"
        >
          {children}
        </span>
      )}
    </span>
  );
}

/**
 * Which of the five levels each service level reads as.
 *
 * `connecting` is 🟡 rather than its own blue. It was the only place in the
 * product where `--info` carried a status, and a reader does not need a fourth
 * colour to learn that a section is still being fetched.
 *
 * `delayed` and `partial` used to share one amber, which is what having only
 * three dots forced. They are now told apart: delayed data is all there and
 * behind the clock (🟡), while partial means some sections did not answer at
 * all (🟠) — the page is still worth reading, which is what 🟠 says and 🔴 would
 * not.
 */
const SERVICE_STATUS_LEVEL = {
  ready: 'good',
  connecting: 'neutral',
  delayed: 'neutral',
  partial: 'weak',
} as const satisfies Record<OverviewDashboardData['serviceStatus']['level'], StatusLevel>;

function ServiceStatus({ data }: { data: OverviewDashboardData['serviceStatus'] }) {
  const level = SERVICE_STATUS_LEVEL[data.level];
  return (
    <details className="group rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <summary className="grid min-h-11 cursor-pointer list-none gap-1 px-3 py-2 text-sm sm:flex sm:items-center sm:justify-between sm:gap-3">
        <span className="flex min-w-0 items-center gap-2">
          {/*
            A dot: "พร้อมใช้งาน" / "กำลังเชื่อมต่อ" is about this app's own
            plumbing. An arrow would put a market direction on a row that is
            reporting whether a feed answered.
          */}
          <StatusLabel level={level} label={data.label} mark="dot" className="font-medium" />
        </span>
        <span className="pl-4 text-[10px] text-[var(--text-muted)] sm:shrink-0 sm:pl-0 sm:text-xs">
          ตรวจล่าสุด {formatBangkokDateTime(data.checkedAt)}
        </span>
      </summary>
      <div className="border-t border-[var(--border)] px-3 py-3 text-sm text-[var(--text-secondary)]">
        {data.affected.length ? (
          <>
            <p className="font-medium text-[var(--text)]">ส่วนที่ได้รับผลกระทบ</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {data.affected.map((item) => <li key={`${item.section}-${item.label}`}>{item.label}</li>)}
            </ul>
          </>
        ) : <p>ทุกส่วนที่รองรับตอบกลับตามปกติ</p>}
      </div>
    </details>
  );
}

/**
 * The portfolio, in one line.
 *
 * It used to be the largest block on the overview: a scope selector, the total,
 * today's move, total gain, a three-facet cash/equity/options strip, the goal
 * card, and a four-way row of quick links — roughly a third of the page before
 * the market was mentioned.
 *
 * Every one of those still exists, on `/portfolio`, which is a whole page built
 * for exactly that reading. What the overview is for is the glance: what is my
 * money worth, and am I up or down on it. So this answers that and links to the
 * rest.
 *
 * IT LEADS WITH THE TOTAL RETURN, not with today's move. The first version had
 * that the other way round, and today's move is the figure most often missing —
 * so the card spent most of its life printing "ยังไม่มีข้อมูล" beside a total
 * while the number the reader came for, the one `/portfolio` shows, was not on
 * the card at all.
 *
 * WHAT IT KEEPS, and neither is decoration:
 *  - the privacy mask, because a balance a reader has chosen to hide must stay
 *    hidden wherever it would otherwise be printed; and
 *  - `hasMissingPrices`, because a total assembled from some of the holdings is
 *    a different number from a total, and the page has to say which one this is.
 */
function PortfolioSummaryLine({ data, usdThbRate }: {
  data: OverviewDashboardData['portfolio'];
  usdThbRate: string | null;
}) {
  const { visible, toggleVisibility } = usePortfolioPrivacy();
  const summary = data.summary;
  const baseCurrency = data.baseCurrency;

  if (!data.authenticated || !summary) {
    return (
      <section className="panel min-w-0 p-4" data-testid="overview-portfolio-line">
        <h2 className="font-bold text-[var(--text)]">
          {data.authenticated ? 'เริ่มบันทึกพอร์ตแรกของคุณ' : 'ติดตามพอร์ตได้ในที่เดียว'}
        </h2>
        <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
          ใช้บันทึกหุ้นและออปชันที่ถืออยู่ โดยยังดูข้อมูลตลาดได้โดยไม่ต้องสร้างพอร์ต
        </p>
        <Link
          href={data.authenticated ? '/portfolio' : '/auth/sign-in?next=/portfolio'}
          className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-bold text-[var(--accent-fg)]"
        >
          <Plus size={17} aria-hidden="true" />
          {data.authenticated ? 'สร้างพอร์ตแรก' : 'เข้าสู่ระบบเพื่อสร้างพอร์ต'}
        </Link>
      </section>
    );
  }

  const total = summary.totalValue ?? data.coverage?.verifiedValueUsd ?? null;
  /*
   * ⚪ while the balances are hidden, and that is not a technicality. The status
   * mark is a colour, and a green one beside a masked total tells anybody
   * looking over the reader's shoulder the very thing the mask is for.
   */
  /*
   * The percentage decides the mark, and the AMOUNT decides it when there is no
   * percentage to ask.
   *
   * `portfolioTotalReturnPercent` returns null whenever the invested basis is
   * zero or below — a portfolio funded entirely by transfers — while `totalGain`
   * stays a real, signed number. Asking only about the percentage drew
   * "-$746.28" beside ⚪: a loss on the screen, and a mark beside it saying
   * there was no reading. Both routes go through the same mapper, so the
   * fallback is coarser, never different.
   */
  const level = (percent: number | null, amount: number | null = null) =>
    visible ? statusFromSignedValue(percent ?? amount) : 'unknown';
  /*
   * "-$746.28 · -80.18%", the same sentence `/portfolio` prints for the same
   * number, through the same two formatters. The card used to compose its own
   * with a local `Intl.NumberFormat` that omitted `currencyDisplay`, so the
   * overview said "US$184.44" over a portfolio page saying "$184.44".
   */
  /*
   * ON A THB PORTFOLIO WITH NO FX RATE, this reads "— · -80.18%", and that is
   * deliberate.
   *
   * `signedMoney` converts through `usdThbRate` and returns an em dash when
   * there is no rate to convert with. The percentage needs no rate — it is a
   * ratio of two USD figures and is just as true in either currency — so half
   * the row is genuinely known and half genuinely is not.
   *
   * The row therefore stays. Hiding it would withhold a return the reader can
   * act on because a conversion rate was missing, which is a worse answer than
   * showing the half that survived and marking the half that did not.
   */
  const move = (amount: number, percent: number | null) => {
    if (!visible) return SENSITIVE_VALUE_MASK;
    const money = signedMoney(amount, baseCurrency, usdThbRate);
    return percent === null || !Number.isFinite(percent)
      ? money
      : `${money} · ${signedPercent(percent)}`;
  };
  /*
   * A row is rendered when its number exists and is left out when it does not
   * — never printed as "ยังไม่มีข้อมูล", and never twice.
   */
  const readable = (value: number | null): value is number =>
    value !== null && Number.isFinite(value);
  const totalGainLabel = readable(summary.totalGain)
    ? move(summary.totalGain, summary.totalGainPercent)
    : null;
  /*
   * TODAY'S MOVE NOW ALWAYS SAYS SOMETHING.
   *
   * It used to be the figure most often absent — `todayChange` went null the
   * moment ANY holding's quote arrived without a `previousClose`, which outside
   * the regular session is nearly always — and the card answered by deleting
   * the row. A reader in Bangkok, whose evening is the middle of a New York
   * night, therefore saw no day figure most of the time and no reason why.
   *
   * The figure now falls back to the captured close of a completed session, and
   * the row states WHICH session in words. The two states it can be in are both
   * informative and both are printed:
   *
   *  - a number, captioned with where it came from ("ตลาดปิดแล้ว ตัวเลขนี้คือ
   *    ราคาปิดของวันศุกร์ที่ 29 ส.ค. 2025"); or
   *  - no number, captioned with what is missing and that it will resolve.
   *
   * The old blank was neither. The caption is what makes keeping the row honest
   * rather than merely tidy: without it a Friday close under a "วันนี้" label on
   * a Sunday would be a false statement, which is why the label is derived from
   * the summary's own attribution and not hardcoded.
   */
  const todayCopy = readable(summary.todayChange) && summary.todayChangeSource !== null
    ? dayChangeCopy({
      source: summary.todayChangeSource,
      sessionDate: summary.todayChangeAsOf,
      todayExchangeDate: data.todayExchangeDate,
    })
    : dayChangeUnavailableCopy();
  const todayLabel = readable(summary.todayChange)
    ? move(summary.todayChange, summary.todayChangePercent)
    : null;

  return (
    <section
      className="panel min-w-0 p-4"
      data-testid="overview-portfolio-summary"
      data-section="overview-portfolio-line"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="figure-label">
            {summary.hasMissingPrices ? 'มูลค่าที่ยืนยันได้' : 'มูลค่าพอร์ตรวม'}
          </p>
          <p className="figure-hero mt-1 break-all">
            {!visible
              ? SENSITIVE_VALUE_MASK
              : total === null
                ? 'ข้อมูลมูลค่ายังไม่ครบ'
                : formatPortfolioMoney(total, baseCurrency, usdThbRate)}
          </p>
          {totalGainLabel !== null && (
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs text-[var(--text-muted)]">กำไร/ขาดทุนรวม</span>
              <StatusLabel
                level={level(summary.totalGainPercent, summary.totalGain)}
                label={totalGainLabel}
                className="text-sm"
              />
            </div>
          )}
          <div className="mt-1 min-w-0" data-testid="overview-portfolio-today">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs text-[var(--text-muted)]">{todayCopy.label}</span>
              {todayLabel !== null && (
                <StatusLabel
                  level={level(summary.todayChangePercent, summary.todayChange)}
                  label={todayLabel}
                  className="text-sm"
                />
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-muted)]">
              {todayCopy.caption}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href="/portfolio"
            className="flex min-h-11 items-center rounded-[var(--radius-control)] px-3 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--surface-hover)]"
          >
            ดูพอร์ต
          </Link>
          <button
            type="button"
            aria-label={visible ? 'ซ่อนยอดพอร์ต' : 'แสดงยอดพอร์ต'}
            onClick={toggleVisibility}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
          >
            {visible ? <EyeOff size={20} /> : <Eye size={20} />}
          </button>
        </div>
      </div>
      {summary.hasMissingPrices && (
        <p className="mt-3 text-xs leading-5 text-[var(--warning)]">
          คำนวณได้ {data.coverage?.pricedAssets ?? 0} จาก {data.coverage?.totalAssets ?? 0} สินทรัพย์
        </p>
      )}
    </section>
  );
}

/**
 * "สิ่งที่เปลี่ยนไป" — and nothing at all on a quiet day.
 *
 * The block renders only when {@link buildOverviewChanges} found something. A
 * section heading over "ไม่มีการเปลี่ยนแปลง" takes the same space as real news
 * and carries none, and a reader who meets it three mornings running stops
 * looking at the block on the fourth.
 */
/**
 * The news block, with or without its scope filter.
 *
 * `NEWS_FILTER` reaches this component as DATA rather than as a flag read: the
 * server puts the reader's symbols in `newsContext` when the flag is on and
 * leaves them empty when it is off, so this decides what to render from what it
 * was given. A client component reading `process.env` would be reading the
 * BUILD's value, which is not the same question.
 *
 * With no symbols it is the market-wide feed that shipped, unchanged.
 */
function NewsSection({
  context,
  defaultScope,
}: {
  context: OverviewDashboardData['newsContext'];
  /**
   * Which tab opens first. Absent leaves the feed on its own default, which is
   * how every surface other than this one behaves.
   */
  defaultScope?: OverviewDashboardData['newsDefaultScope'];
}) {
  const filtered = context.portfolioSymbols.length > 0 || context.watchlistSymbols.length > 0;
  return (
    <section className="panel-quiet min-w-0" data-testid="overview-news">
      <SectionTitle title="ข่าวสำคัญต่อตลาดหุ้น" />
      {filtered
        ? (
          <NewsFeed
            withScopeFilter
            defaultScope={defaultScope}
            portfolioSymbols={context.portfolioSymbols}
            watchlistSymbols={context.watchlistSymbols}
          />
        )
        : <NewsFeed marketWide />}
    </section>
  );
}

function ChangesSection({ changes }: { changes: readonly OverviewChange[] }) {
  if (changes.length === 0) return null;
  return (
    <section className="panel-quiet min-w-0" data-testid="overview-changes">
      <SectionTitle title="สิ่งที่เปลี่ยนไป" />
      <ul className="grid min-w-0 gap-1">
        {changes.map((change) => (
          <li key={change.id} className="min-w-0">
            <Link
              href={stockDetailHref(change.symbol)}
              className="flex min-h-11 min-w-0 items-center rounded-[var(--radius-control)] px-2 hover:bg-[var(--surface-hover)]"
            >
              <StatusLabel level={change.level} label={change.text} className="text-sm" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MarketCard({ item }: { item: MarketIndexCard }) {
  return (
    /*
     * The whole card is the link — a reader who taps a price expects the market
     * it belongs to, not a dead rectangle with one small link in it. There is
     * nothing else interactive inside, so a single anchor stays a single tab
     * stop; the section's refresh button sits in the header, outside every card,
     * and cannot be reached by activating one.
     */
    <Link
      href={stockDetailHref(item.symbol)}
      aria-label={`เปิดรายละเอียด ${item.name} (${item.symbol})`}
      // Addressable by instrument, so a browser check can measure ONE card's
      // contents against ONE card's box. The rail is a legitimate horizontal
      // scroller, which is exactly what makes a viewport-level overflow probe
      // blind to a card whose own text is running past its edge.
      data-testid="market-card"
      data-symbol={item.symbol}
      /*
       * Enter is native to a link; Space is not — it scrolls the page. Readers
       * who arrive by keyboard try both, so Space is claimed here and turned
       * into the same navigation.
       */
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Spacebar') return;
        event.preventDefault();
        event.currentTarget.click();
      }}
      className="group block min-w-[238px] snap-start rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] active:bg-[var(--surface-selected)] sm:min-w-0"
    >
      {/*
        The name row owns the card's full width.

        It used to share it with the session pill, and on a 238px handset card
        that pill is `shrink-0` — it took its width first and left the name
        roughly 60px to live in, so "น้ำมัน WTI" and "SPY · ETF อ้างอิง" each
        broke over two or three lines while the pill sat comfortably beside
        them. The pill is not the card's headline and does not belong in the
        headline's row; it has moved to the provenance line at the foot, which
        is where the reader already looks to find out how current the price is.
        Nothing shrank to make this fit and no type got smaller.
      */}
      <div className="flex items-start gap-3">
        <InstrumentLogo
          symbol={item.symbol}
          companyName={item.instrument.companyName}
          logoUrl={item.instrument.logoUrl}
          size={36}
          appearance="plain"
        />
        <div className="min-w-0 flex-1">
          {/*
            Still allowed to wrap rather than truncate: the name of the market
            is the one thing on the card that cannot afford to be unreadable.
            With the row to itself a long name now fits on one line at 320px,
            and the wrap is the safety net rather than the normal case.
          */}
          <h3 className="font-semibold leading-tight text-[var(--text)]">{item.name}</h3>
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{item.subtitle}</p>
        </div>
        {/* The one affordance: enough to read as "this opens", small enough
            not to compete with the price. */}
        <ChevronRight
          size={16}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5"
        />
      </div>
      {/*
        `break-words` on the price, not a smaller size.

        A commodity quotes in whole dollars per ounce or per barrel and carries a
        currency after it — "3,432.10 USD" is half again as long as "612.44 USD"
        — and the price is the reason the card exists, so it keeps its full
        text-xl weight at every width and is simply allowed to take a second line
        in the impossible case rather than run off the edge of a 320px screen.
      */}
      <p className="mt-4 break-words text-xl font-bold tabular-nums text-[var(--text)]">
        {item.price === null ? 'ข้อมูลยังไม่พร้อม' : `${formatNumber(item.price)} ${item.currency}`}
      </p>
      <div className={`mt-1 flex gap-2 text-xs font-semibold tabular-nums ${tone(item.changePercent)}`}>
        <span>{signed(item.change)}</span>
        <span>{signed(item.changePercent, '%')}</span>
      </div>
      <div className="mt-2">
        <MiniLine values={item.sparkline} positive={(item.changePercent ?? 0) >= 0} />
      </div>
      {item.price === null && item.unavailableReason && (
        <p className="mt-2 text-[10px] leading-4 text-[var(--warning)]">{item.unavailableReason}</p>
      )}
      {/*
        The provenance line: what state the market is in, how much to trust the
        number, and when it was taken. Three short facts about the SAME price,
        which is why the session pill reads correctly here and read as a headline
        up beside the name.

        It wraps. "ข้อมูลล่าสุดที่บันทึกไว้" beside a full Thai date and time is
        wider than a 238px card's content box on its own, and this row used to be
        a no-wrap `justify-between` — so on a handset it pushed the card wider
        than every other card in the rail. Wrapping is what lets each fact stay
        at its own legible size instead of being squeezed to fit one line.
      */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--text-muted)]">
        <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-0.5 text-[var(--text-secondary)]">
          {item.sessionLabel}
        </span>
        <span>{OVERVIEW_STATUS_COPY[item.status]}</span>
        <span className="ml-auto">{item.asOf ? formatBangkokDateTime(item.asOf) : 'ยังไม่มีเวลาอัปเดต'}</span>
      </div>
      {/*
        The vendor name is deliberately NOT printed here.

        `item.source` still arrives on every card and nothing behind it changed —
        the provider chain, its fallbacks and the freshness stamp above are
        untouched, and the same field is still shown where a reader is actually
        auditing a number (Stock Detail). On the overview it was a row of vendor
        names under a row of prices, which is provenance answering a question
        nobody asked at a glance: what these cards are for is "what is the market
        doing", and the status and as-of already say how much to trust that.
      */}
    </Link>
  );
}

function IndustryRanking({
  industries,
  industryData,
  limitations,
  retrying,
  loading,
  onRetry,
}: {
  industries: IndustryGroup[];
  industryData: OverviewDashboardData['industryData'];
  limitations: string[];
  retrying: boolean;
  /**
   * A request is genuinely in flight. Deliberately not `state === 'refreshing'`:
   * that flag is set by the server and is never cleared by a request that fails,
   * so reading it directly is how a loader ends up spinning forever.
   */
  loading: boolean;
  onRetry: (section: RetriableOverviewSection) => void;
}) {
  const [order, setOrder] = useState<IndustryRankingOrder>('gainers');
  const ranked = useMemo(() => rankIndustries(industries, order, 8), [industries, order]);
  const tabs: Array<{ value: IndustryRankingOrder; label: string }> = [
    { value: 'gainers', label: 'ขึ้นมากสุด' },
    { value: 'losers', label: 'ลงมากสุด' },
    { value: 'all', label: 'ทั้งหมด' },
  ];
  const scale = Math.max(1, ...ranked.map((item) => Math.abs(item.returnPercent)));
  return (
    <section className="panel-quiet min-w-0">
      <SectionTitle
        title="อุตสาหกรรมเด่นวันนี้"
        action={(
          <span className="flex items-center gap-1">
            {/*
              The icon stays visually 18px and keeps its place in the header;
              the ≥44px tap target is a transparent `::after` overlay that adds
              no layout size, so the row is unchanged.
            */}
            <SectionInfo
              label="ข้อมูลอุตสาหกรรมเด่นวันนี้"
              testId="industry-info"
              iconSize={18}
              triggerClassName="relative inline-flex items-center justify-center text-[var(--text-muted)] outline-none after:absolute after:-inset-[13px] after:content-[''] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              เฉลี่ยแบบให้น้ำหนักเท่ากันจากหุ้นที่มีข้อมูลช่วงซื้อขายปกติถูกต้องอย่างน้อย 5 ตัวต่อกลุ่ม
            </SectionInfo>
            <RetryButton section="industries" loading={retrying} onRetry={onRetry} />
          </span>
        )}
      />
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--text-muted)]">
        <span>ข้อมูลกลุ่ม {formatBangkokDateTime(industryData.classificationUpdatedAt)}</span>
        <span>
          ราคา {industryData.quotesUpdatedAt
            ? formatBangkokDateTime(industryData.quotesUpdatedAt)
            : 'กำลังอัปเดต'}
        </span>
      </div>
      <div role="tablist" aria-label="เรียงอุตสาหกรรม" className="mb-4 flex gap-2 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={order === tab.value}
            onClick={() => setOrder(tab.value)}
            className={`min-h-11 whitespace-nowrap rounded-full px-4 text-xs font-semibold ${
              order === tab.value
                ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                : 'bg-[var(--surface-elevated)] text-[var(--text-secondary)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {/*
        * One loading presentation, not two: the four pulsing boxes that used to
        * stand here are gone, and Kheaw is the only thing shown while the
        * ranking is being gathered. `min-h` holds roughly the height the list
        * will occupy so the page does not jump when it arrives, and the
        * boundary's own grace keeps a fast refresh from flashing the mascot at
        * all. Success, empty and error all render `children`, so there is no
        * path on which the loader stays up.
        */}
      <div className="min-h-[176px]">
        <KheawLoadingBoundary
          loading={loading}
          ready={ranked.length > 0}
          message="กำลังรวบรวมราคาช่วงตลาดปกติ"
        >
          {ranked.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--border-strong)] p-5 text-center">
              <Gauge className="mx-auto text-[var(--text-muted)]" aria-hidden="true" />
              <p className="mt-2 font-medium text-[var(--text)]">ข้อมูลยังไม่เพียงพอสำหรับจัดอันดับ</p>
              <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                ระบบจะแสดงเฉพาะกลุ่มที่มีหุ้นผ่านเกณฑ์อย่างน้อย 5 ตัว และจะไม่แทนข้อมูลที่ขาดด้วย 0%
              </p>
              {limitations.map((item) => <p key={item} className="mt-2 text-xs text-[var(--warning)]">{item}</p>)}
            </div>
          ) : (
            <ol className="grid gap-2 lg:grid-cols-2">
              {ranked.map((industry, index) => (
                <li key={industry.slug}>
                  <Link
                    href={`/industry/${encodeURIComponent(industry.slug)}`}
                    className="grid min-h-[76px] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-[var(--border)] p-3 hover:bg-[var(--surface-hover)]"
                  >
                    <span className="text-center text-sm font-bold text-[var(--accent)]">{index + 1}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-[var(--text)]">
                        {industry.nameTh ?? industry.name}
                      </span>
                      {industry.nameTh && <span className="block truncate text-[10px] text-[var(--text-muted)]">{industry.name}</span>}
                      <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-[var(--surface-selected)]">
                        <span
                          className={`block h-full rounded-full ${industry.returnPercent >= 0 ? 'bg-[var(--positive)]' : 'bg-[var(--negative)]'}`}
                          style={{ width: `${Math.max(4, Math.abs(industry.returnPercent) / scale * 100)}%` }}
                        />
                      </span>
                      <span className="mt-1 block text-[10px] text-[var(--text-muted)]">
                        {industry.advancing} จาก {industry.validCount} หุ้นปรับขึ้น
                      </span>
                    </span>
                    <span className={`flex items-center gap-1 text-sm font-bold tabular-nums ${tone(industry.returnPercent)}`}>
                      {signed(industry.returnPercent, '%')} <ChevronRight size={16} aria-hidden="true" />
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </KheawLoadingBoundary>
      </div>
    </section>
  );
}

function WatchlistSection({
  items,
  rows,
  alertCounts,
  preview,
  retrying,
  onRetry,
}: {
  items: OverviewPrice[];
  /**
   * The rows with a trend column and the expanded details, when the capped
   * watchlist view loaded.
   *
   * Null falls the section back to `items` — the quote-only rows the overview
   * has always drawn. That is the degradation path for a slow or failed view
   * load, and it is why the two are separate props rather than one: losing the
   * trend must cost the trend, not the section.
   */
  rows?: WatchlistRow[] | null;
  /** Alert rules per symbol. Undefined means unreadable — the row draws none. */
  alertCounts?: Record<string, number> | null;
  /**
   * Present only while `WATCHLIST_V2` is on. It carries the lists the reader
   * owns so the card can say WHICH one it is showing and let them switch, and
   * whether the link has more behind it.
   *
   * The five-row cut is NOT done here. `overviewPreview` applied it on the
   * server, before any price was fetched, so rows six and beyond are not in
   * `items` at all — this component could not render a sixth if it tried, which
   * is the point: how many are shown is a property of the product, not of the
   * viewport.
   */
  preview?: OverviewDashboardData['watchlistPreview'];
  retrying: boolean;
  onRetry: (section: RetriableOverviewSection) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'up' | 'down'>('all');
  const visible = items.filter((item) =>
    filter === 'all' || (filter === 'up' ? (item.changePercent ?? 0) > 0 : (item.changePercent ?? 0) < 0));
  /*
    The same filter over the richer rows, and the same ORDER as `items` so the
    two renderings cannot disagree about which symbol is third. Null whenever
    the view did not load, which is what sends the section back to `items`.
  */
  const visibleRows = rows
    ? items
      .filter((item) => visible.includes(item))
      .flatMap((item) => rows.find((row) => row.symbol === item.symbol) ?? [])
    : null;
  const selected = preview?.lists.find((list) => list.id === preview.selectedId) ?? null;
  const router = useRouter();
  const [, startChoosing] = useTransition();
  const chooseList = useCallback((id: string) => {
    startChoosing(async () => {
      /*
        A failed write leaves the card on the list it was already showing, which
        is the honest outcome: nothing changed. It is deliberately not reported
        as an error toast — the reader's watchlists are all still there, and the
        next tap is the retry.
      */
      const result = await chooseOverviewWatchlistAction(id);
      if (result.ok) router.refresh();
    });
  }, [router]);
  return (
    <section className="panel-quiet min-w-0" data-testid="overview-watchlist">
      <SectionTitle
        title="หุ้นที่ติดตาม"
        action={(
          <span className="flex items-center gap-1">
            <Link
              href={preview ? `/watchlist?list=${encodeURIComponent(preview.selectedId)}` : '/watchlist'}
              className="text-xs font-semibold text-[var(--accent)]"
            >
              ดูทั้งหมด
            </Link>
            <RetryButton section="watchlist" loading={retrying} onRetry={onRetry} />
          </span>
        )}
      />
      {/*
        Which list this is, and how to change it. Rendered only when the reader
        has more than one — a selector with a single option is a control that
        cannot do anything, and it would appear for every account that has never
        made a second list.

        The choice is SAVED, not held in a query string. A reader who picks a
        list here is saying which one their overview is about, and that has to
        survive them closing the tab — `set_overview_watchlist` writes it to the
        preference row, and `get_or_create_default_watchlist` reads it back, so
        this page and `/watchlist` resolve the same list from the same answer.
      */}
      {preview && preview.lists.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">แสดงจาก</span>
          {preview.lists.map((list) => (
            <button
              key={list.id}
              type="button"
              onClick={() => chooseList(list.id)}
              data-testid={`overview-watchlist-${list.id}`}
              aria-pressed={list.id === preview.selectedId}
              className={`min-h-11 rounded-full px-3 text-[11px] font-semibold ${
                list.id === preview.selectedId
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)]'
              }`}
            >
              {list.name}
            </button>
          ))}
        </div>
      )}
      {preview?.hasMore && selected && (
        <p className="mb-2 text-[11px] text-[var(--text-muted)]" data-testid="overview-watchlist-more">
          แสดง {items.length} จาก {selected.itemCount} ตัวใน “{selected.name}”
        </p>
      )}
      <div className="mb-3 flex gap-2">
        {([
          ['all', 'ทั้งหมด'],
          ['up', 'ขึ้น'],
          ['down', 'ลง'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`min-h-11 rounded-full px-4 text-xs font-semibold ${
              filter === value ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-muted)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <div className="py-6 text-center">
          <Star className="mx-auto text-[var(--text-muted)]" aria-hidden="true" />
          <p className="mt-2 text-sm text-[var(--text-secondary)]">ยังไม่มีหุ้นในรายการติดตาม</p>
          <Link href="/search" className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-[var(--accent-soft)] px-4 text-sm font-semibold text-[var(--accent)]">ค้นหาหุ้น</Link>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--text-secondary)]">ไม่มีหุ้นที่ตรงกับตัวกรองนี้</p>
      ) : visibleRows ? (
        /*
          A retry replaces the rows with a skeleton of the same height rather
          than dimming them: a half-faded table is still readable, and a reader
          who reads it is reading numbers the page has already decided are
          suspect. The skeleton is sized from the row count it is replacing, so
          nothing below it moves.
        */
        retrying
          ? <WatchlistTableSkeleton rows={visibleRows.length} />
          : <WatchlistTable rows={visibleRows} counts={alertCounts} />
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {visible.map((item) => (
            <Link
              key={item.symbol}
              href={stockDetailHref(item.symbol)}
              className="grid min-h-[82px] grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 py-3"
            >
              <InstrumentLogo
                symbol={item.symbol}
                companyName={item.instrument.companyName}
                logoUrl={item.instrument.logoUrl}
                size={40}
                appearance="plain"
              />
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <strong className="text-sm text-[var(--text)]">{item.symbol}</strong>
                  <span className="truncate text-[10px] text-[var(--text-muted)]">{item.instrument.companyName}</span>
                </span>
                <span className="mt-1 block text-[10px] text-[var(--text-muted)]">
                  {item.sessionLabel} · {OVERVIEW_STATUS_COPY[item.status]}
                  {item.asOf ? ` · ${formatBangkokDateTime(item.asOf)}` : ''}
                </span>
                {item.extended && (
                  <span className="mt-1 block text-[10px] text-[var(--text-secondary)]">
                    {item.extended.label} {formatNumber(item.extended.price)}{' '}
                    <span
                      className={tone(item.extended.changePercent)}
                      data-testid={`watchlist-extended-change-${item.symbol}`}
                    >
                      {signed(item.extended.changePercent, '%')}
                    </span>
                  </span>
                )}
              </span>
              <span className="text-right">
                <span className="block whitespace-nowrap text-sm font-bold tabular-nums text-[var(--text)]">
                  {item.price === null ? 'ข้อมูลยังไม่พร้อม' : `${formatNumber(item.price)} ${item.currency}`}
                </span>
                <span className={`mt-1 flex justify-end gap-2 whitespace-nowrap text-xs font-semibold tabular-nums ${tone(item.changePercent)}`}>
                  <span>{signed(item.change)}</span>
                  <span>{signed(item.changePercent, '%')}</span>
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function BreadthSection({
  data,
  retrying,
  onRetry,
}: {
  data: OverviewDashboardData['breadth'];
  retrying: boolean;
  onRetry: (section: RetriableOverviewSection) => void;
}) {
  const total = data?.validCount ?? 0;
  const width = (value: number) => total ? `${value / total * 100}%` : '0%';
  return (
    <section className="panel-quiet min-w-0">
      <SectionTitle
        title="ภาพรวมแรงซื้อแรงขาย"
        action={<RetryButton section="breadth" loading={retrying} onRetry={onRetry} />}
      />
      {!data ? (
        /*
         * `ready` is false here by definition — there is no snapshot to protect
         * — so the boundary owns the wait, and the spinner that used to sit in
         * this slot is gone. That spinner had no exit: the auto-refresh below
         * fires once on mount, and if it failed the section spun forever with
         * no way to tell that it had stopped trying. Now a failed refresh falls
         * through to the message and its retry control.
         */
        <KheawLoadingBoundary loading={retrying} message="กำลังอ่าน breadth snapshot ล่าสุด">
          <div className="py-8 text-center">
            <p className="text-sm text-[var(--text-secondary)]">
              ยังอ่าน breadth snapshot ไม่ได้
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              กดปุ่มโหลดใหม่ด้านบนเพื่อลองอีกครั้ง ส่วนอื่นของหน้ายังใช้งานได้ตามปกติ
            </p>
          </div>
        </KheawLoadingBoundary>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px]">
            <span className={`rounded-full px-2 py-1 ${
              data.status === 'ready'
                ? 'bg-[var(--positive-soft)] text-[var(--positive)]'
                : 'bg-[var(--warning-soft)] text-[var(--warning)]'
            }`}>
              {data.status === 'ready' ? 'พร้อมใช้งาน' : data.status === 'stale' ? 'ข้อมูลบันทึกล่าสุด' : 'ข้อมูลตลาดยังไม่ครบ'}
            </span>
            <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-1 text-[var(--text-muted)]">
              Regular session · delayed SIP
            </span>
            <SectionInfo
              label="ข้อมูลภาพรวมแรงซื้อแรงขาย"
              testId="breadth-info"
              iconSize={16}
              triggerClassName="inline-flex min-h-11 min-w-11 items-center justify-center text-[var(--text-muted)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {data.universeDescription} เปรียบเทียบ regular close/price กับ previous regular close ของ trading date เดียวกันเท่านั้น
            </SectionInfo>
          </div>
          <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-3">
            {[
              ['หุ้นปรับขึ้น', data.advancing, 'text-[var(--positive)]'],
              ['หุ้นปรับลง', data.declining, 'text-[var(--negative)]'],
              ['ไม่เปลี่ยนแปลง', data.unchanged, 'text-[var(--text-secondary)]'],
            ].map(([label, value, className]) => (
              <div key={String(label)} className="rounded-xl bg-[var(--surface-elevated)] p-3 text-center">
                <p className={`text-xl font-bold tabular-nums ${className}`}>{value}</p>
                <p className="mt-1 text-[10px] text-[var(--text-muted)]">{label}</p>
              </div>
            ))}
          </div>
          {/*
           * role="img" is what makes the aria-label legal here. A bare <div> is
           * role="generic", which prohibits a name, so axe flagged the label as
           * an ARIA attribute the element may not use — and screen readers threw
           * it away, leaving the bar silent. As an image it also gets to state
           * the counts it is drawing instead of only naming the categories.
           */}
          <div
            className="mt-4 flex h-3 overflow-hidden rounded-full bg-[var(--surface-selected)]"
            role="img"
            aria-label={`สัดส่วนหุ้น: ปรับขึ้น ${data.advancing.toLocaleString()} ตัว ปรับลง ${data.declining.toLocaleString()} ตัว ไม่เปลี่ยนแปลง ${data.unchanged.toLocaleString()} ตัว`}
          >
            <span className="bg-[var(--positive)]" style={{ width: width(data.advancing) }} />
            <span className="bg-[var(--negative)]" style={{ width: width(data.declining) }} />
          </div>
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-[var(--text-secondary)]">สัดส่วน Up / Down</span>
            <strong className="tabular-nums text-[var(--text)]">
              {data.upDownRatio === null ? 'ยังคำนวณไม่ได้' : data.upDownRatio.toFixed(2)}
            </strong>
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-[var(--text-secondary)]">% Breadth (Up)</span>
            <strong className="tabular-nums text-[var(--text)]">{data.breadthPercent.toFixed(1)}%</strong>
          </div>
          {data.aboveEma20Percent !== null && (
            <div className="mt-2 flex items-center justify-between text-sm">
              <span className="text-[var(--text-secondary)]">อยู่เหนือ EMA20</span>
              <strong className="tabular-nums text-[var(--text)]">{data.aboveEma20Percent.toFixed(1)}%</strong>
            </div>
          )}
          {/*
            The headline answers the only question most readers have — how much of
            the market this number actually covers, and how recent it is. The run's
            failure counts, stale counts and wall-clock duration are real and stay
            available, but they were reading as a debug panel on the home screen,
            so they moved one tap away into the same disclosure pattern the service
            status above already uses. Nothing about the health CALCULATION changed.
          */}
          <details
            data-testid="breadth-data-health"
            className="group mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)]"
          >
            <summary className="grid min-h-11 cursor-pointer list-none gap-1 px-3 py-2 text-xs sm:flex sm:items-center sm:justify-between sm:gap-3">
              <span className="text-[var(--text-secondary)]">
                ข้อมูลพร้อมใช้ {data.coveragePercent.toFixed(1)}%
                {' · '}
                อัปเดตเมื่อ {formatBangkokDateTime(data.updatedAt ?? data.evaluatedAt)}
              </span>
              <span className="text-[10px] text-[var(--text-muted)] sm:shrink-0">
                รายละเอียดข้อมูล
              </span>
            </summary>
            <div className="space-y-1 border-t border-[var(--border)] px-3 py-3 text-[10px] leading-4 text-[var(--text-muted)]">
              <p>คำนวณจากหุ้นที่มีข้อมูลพร้อมใช้ {data.validCount.toLocaleString()} จากทั้งหมด {data.universeCount.toLocaleString()} ตัว ({data.coveragePercent.toFixed(1)}%)</p>
              <p>ดึงข้อมูลไม่สำเร็จ {data.failedCount.toLocaleString()} ตัว · ข้อมูลเก่ากว่ากำหนด {data.staleCount.toLocaleString()} ตัว · ใช้เวลาประมวลผล {(data.durationMs / 1_000).toFixed(1)} วินาที</p>
              <p>ประเมิน {formatBangkokDateTime(data.evaluatedAt)}{data.updatedAt ? ` · ราคาล่าสุด ${formatBangkokDateTime(data.updatedAt)}` : ''}</p>
            </div>
          </details>
          {data.validCount < 800 && (
            <p className="mt-3 rounded-xl bg-[var(--warning-soft)] p-3 text-xs leading-5 text-[var(--warning)]">
              ข้อมูลตลาดยังไม่ครบ: มีหุ้นพร้อมคำนวณน้อยกว่า 800 ตัว จึงยังไม่ถือว่าเป็นภาพรวมทั้งตลาด
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function DashboardClient({
  data,
  onboarding = { kind: 'none' },
}: {
  data: OverviewDashboardData;
  /**
   * Resolved on the server from the account's own preference row. A separate
   * prop rather than a field on the dashboard payload, because it describes the
   * reader rather than the market and no section retry ever refreshes it.
   */
  onboarding?: OnboardingView;
}) {
  const [viewState, setViewState] = useState(() => ({ source: data, value: data }));
  const view = viewState.source === data ? viewState.value : data;
  const [retrying, setRetrying] = useState<Partial<Record<RetriableOverviewSection, boolean>>>({});
  const [retryNotice, setRetryNotice] = useState('');
  /*
   * Whether the industry ranking has been attempted at all in this tab. Together
   * with `retrying` it is the whole loading condition: before the first attempt
   * the section is waiting, during an attempt it is loading, and after one — won
   * or lost — it shows what it has.
   */
  const [industriesAttempted, setIndustriesAttempted] = useState(false);
  const autoIndustryRefreshStarted = useRef(false);
  const autoBreadthRefreshStarted = useRef(false);

  const retry = useCallback(async (section: RetriableOverviewSection) => {
    setRetrying((current) => ({ ...current, [section]: true }));
    setRetryNotice('');
    try {
      const response = await fetch(`/api/market/overview/section?section=${section}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const payload = await response.json() as {
        data: {
          section: RetriableOverviewSection;
          value: OverviewSectionValue;
          related?: OverviewSectionRelated | null;
          generatedAt: string;
        } | null;
      };
      if (!response.ok || !payload.data || payload.data.section !== section) {
        throw new Error('section retry failed');
      }
      setViewState((current) => ({
        source: data,
        value: applyOverviewSectionUpdate(
          current.source === data ? current.value : data,
          section,
          payload.data!.value,
          payload.data!.generatedAt,
          payload.data!.related ?? null,
        ),
      }));
      setRetryNotice('อัปเดตข้อมูลส่วนนี้แล้ว');
    } catch {
      setRetryNotice('ยังอัปเดตข้อมูลส่วนนี้ไม่ได้ ข้อมูลล่าสุดยังคงแสดงอยู่');
    } finally {
      setRetrying((current) => ({ ...current, [section]: false }));
      if (section === 'industries') setIndustriesAttempted(true);
    }
  }, [data]);

  useEffect(() => {
    if (
      autoIndustryRefreshStarted.current
      || view.industries.length > 0
      || view.industryData.state !== 'refreshing'
    ) return;
    autoIndustryRefreshStarted.current = true;
    void retry('industries');
  }, [retry, view.industries.length, view.industryData.state]);

  useEffect(() => {
    if (autoBreadthRefreshStarted.current || view.breadth) return;
    autoBreadthRefreshStarted.current = true;
    void retry('breadth');
  }, [retry, view.breadth]);

  const marketSummary = useMemo(() => buildMarketSummary(view.indices), [view.indices]);
  const changes = useMemo(() => buildOverviewChanges(view.watchlist), [view.watchlist]);
  /*
   * S&P and NASDAQ first, everything else in the order the catalogue gives.
   *
   * The section holds ten assets — the two broad indices, Dow, Russell, three
   * commodities, rare earths and Bitcoin — and on a handset it is a horizontal
   * scroller, so whichever two are drawn first are the two most readers will
   * ever see. Those should be the two the summary line above is about, or the
   * sentence and the cards under it are describing different things.
   *
   * A sort rather than a filter: nothing is taken off the page, it is put in an
   * order.
   */
  const orderedIndices = useMemo(() => {
    const lead = ['SPY', 'QQQ'];
    const rank = (symbol: string) => {
      const index = lead.indexOf(symbol);
      return index === -1 ? lead.length : index;
    };
    return [...view.indices].sort((left, right) => rank(left.symbol) - rank(right.symbol));
  }, [view.indices]);

  /*
   * The asset band under the Phase 2 snapshot, with nothing said twice.
   *
   * The band above states six markets; three of these rows are the same three
   * markets through the funds that track them, so the page was printing the
   * S&P twice — once as 7,631 and once as 761.78 — ten pixels apart. The design
   * called for the lower band to hold what the upper one does NOT.
   *
   * Filtered HERE and not at `MARKET_ASSETS`, because the catalogue is also
   * what the flag-off page draws: all nine cards, and a summary line that reads
   * SPY and QQQ off the same array. With `PHASE2_MARKET_SNAPSHOT` off this
   * value is never used and the section renders exactly as it shipped.
   *
   * `assetsOutsideMarketStatus` reads the pairing from the input table rather
   * than from a list kept here — `SPX` quotes `^GSPC` and covers `SPY`, a
   * relationship no comparison of symbols would find, and a copy of it in this
   * file would go stale the next time one of them changes.
   */
  const uncoveredIndices = useMemo(
    () => assetsOutsideMarketStatus(orderedIndices),
    [orderedIndices],
  );

  /*
   * WHICH SECTIONS EXIST AT ALL, this render.
   *
   * "Present" means the section will draw something. A flag that is off, a
   * payload that did not load, and a detector that found nothing today are all
   * the same answer here — there is nothing to show — and collapsing them is
   * deliberate: the page has no way to render "this card is off" that is not
   * just a gap.
   *
   * `watchlist` and `news` are always present because both own their empty
   * states: the watchlist explains how to add a symbol, and the feed says when
   * there is no news. Those are contentful, not blank.
   */
  /*
   * The Phase 2 change feed, when the reader has it.
   *
   * Null and an empty array are different: null means the section is not part
   * of this page, an empty array means it is and nothing happened today. The
   * second owns a one-line quiet state, so the section is PRESENT for it — the
   * V1 list, which has no such state, still disappears when it is empty.
   */
  const phase2Changes = view.changes ?? null;

  const sections = useMemo(() => orderedOverviewSections({
    marketToday: true,
    marketStatus: Boolean(view.marketStatus),
    portfolio: true,
    watchlist: true,
    whatChanged: phase2Changes ? true : changes.length > 0,
    marketEvents: Boolean(view.marketEvents),
    events: Boolean(view.events),
    upcoming: Boolean(view.upcoming),
    news: true,
  }, view.overviewV2), [
    view.marketStatus,
    view.marketEvents,
    view.events,
    view.upcoming,
    view.overviewV2,
    phase2Changes,
    changes.length,
  ]);

  const sectionNodes: Record<OverviewSectionKey, React.ReactNode> = {
    /*
      ตลาดวันนี้, and the one section that renders two different things.

      With a Phase 2 snapshot it is the six-instrument band, the three-way word
      and the regime reasons, with the nine assets compact underneath. Without
      one it is exactly the block that shipped — the summary line and the nine
      cards — because this key replaced a fixed `<section>` and V1 must not
      notice that it moved.

      Nothing was removed in either state: gold, silver, crude, rare earths and
      Bitcoin are on the page both ways.
    */
    marketToday: (
      <section id="market-overview" className="stack-lead scroll-mt-24">
        <SectionTitle
          title="ตลาดวันนี้"
          action={<RetryButton section="market" loading={Boolean(retrying.market)} onRetry={retry} />}
        />
        {view.marketToday ? (
          <>
            {retrying.market
              ? <MarketTodaySkeleton />
              : <MarketTodayStrip snapshot={view.marketToday} />}
            <MarketAssetStrip items={uncoveredIndices} />
          </>
        ) : (
          <>
            {marketSummary && (
              <StatusLabel
                level={marketSummary.level}
                label={marketSummary.text}
                className="mb-3 text-sm"
                data-testid="overview-market-summary"
              />
            )}
            <div className="bleed-mobile flex snap-x snap-mandatory gap-3 overflow-x-auto px-[var(--page-gutter)] pb-2 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-4">
              {orderedIndices.map((item) => <MarketCard key={item.symbol} item={item} />)}
            </div>
          </>
        )}
      </section>
    ),
    marketStatus: view.marketStatus && (
      <MarketStatusCard
        evaluation={view.marketStatus.evaluation}
        sessionDate={view.marketStatus.sessionDate}
      />
    ),
    portfolio: <PortfolioSummaryLine data={view.portfolio} usdThbRate={view.usdThbRate} />,
    watchlist: (
      <WatchlistSection
        items={view.watchlist}
        rows={view.watchlistRows}
        alertCounts={view.alertCountBySymbol}
        preview={view.watchlistPreview}
        retrying={Boolean(retrying.watchlist)}
        onRetry={retry}
      />
    ),
    whatChanged: phase2Changes
      ? (
        <section className="panel-quiet min-w-0" data-testid="overview-changes">
          <SectionTitle title="สิ่งที่เปลี่ยนไป" />
          <ChangesList changes={phase2Changes} />
        </section>
      )
      : <ChangesSection changes={changes} />,
    marketEvents: view.marketEvents && <MarketEventsCard view={view.marketEvents} />,
    /*
      THE MERGED LIST, WHICH NO ORDER ARRAY WALKS ANY MORE.

      Both orders draw `marketEvents` — the month grid — in the calendar slot,
      so this key is never in `sections` and this node is never consulted. It
      is kept whole rather than deleted because the decision it lost to is an
      editorial one the owner can reverse: the grid shows the shape of a month
      at a glance, the list shows which rows touch the reader's own symbols,
      and putting the list back is one entry in `section-order.ts`.

      `STRANDED_SECTION_KEYS` there says the same thing where the filtering
      happens, and `section-order.test.ts` fails if a key is stranded without
      being named.
    */
    events: view.events && (
      <section className="panel-quiet min-w-0">
        <SectionTitle title="วันสำคัญที่ใกล้ถึง" />
        <EventsList view={view.events} />
      </section>
    ),
    upcoming: view.upcoming && <UpcomingSection feed={view.upcoming} />,
    news: <NewsSection context={view.newsContext} defaultScope={view.newsDefaultScope} />,
  };

  return (
    <div className="min-w-0">
      <Header title="ภาพรวม" subtitle="พอร์ต ตลาด อุตสาหกรรม และข่าวสำคัญ" />
      <main className="mx-auto w-full max-w-[1440px] page-stack px-[var(--page-gutter)] py-4 sm:py-6">
        <p className="sr-only" role="status" aria-live="polite">{retryNotice}</p>
        {!view.portfolio.authenticated && <><LandingFunnel /><PublicValueProposition /></>}

        {/*
          Above the portfolio, and only ever once: a reader who has answered, or
          waved it away, or finished the one hint, never sees it again on any
          device — the answer lives on their account, not in this browser.
        */}
        <OnboardingCard view={onboarding} />

        {/*
          THE READING ORDER now lives in `src/lib/overview/section-order.ts`,
          including the argument for why the market leads and the portfolio is
          second. It used to live here because ตลาดวันนี้ was a fixed section
          rendered above the ordered run — which also meant the one block the
          page opens with was the one block the ordering flag could not move.
          It is a key now, and the reasoning moved with it.
        */}

        {/*
          ==================================================================
          THE ORDERED RUN. One list, rendered in the order `section-order.ts`
          gives, with absent sections GONE rather than rendered empty.
          ==================================================================

          Written as a sequence of `{x && <X/>}` this was seven conditionals,
          and the failure mode was silent: a section that renders null inside a
          wrapper leaves the wrapper's margin behind, so the page grows a gap
          where a card used to be and the gap reads as a load that never
          finished. Here a section that is not present is not in the list, so
          there is nothing to leave behind.

          `sectionNodes` is only consulted for keys that survived the filter,
          which is why every entry can assume its own data is there.

          The order is the same list on every screen. Nothing below reorders
          itself at a breakpoint — a reader who learns the page on a phone finds
          it in the same sequence on a desktop, and the mobile layout is a
          matter of how each card draws itself, not of where it sits.
        */}
        {sections.map((key) => (
          <Fragment key={key}>{sectionNodes[key]}</Fragment>
        ))}

        <details className="panel group min-w-0">
          <summary className="grid min-h-14 cursor-pointer list-none gap-1 px-4 py-3 text-sm sm:flex sm:items-center sm:justify-between sm:gap-3">
            <span className="flex min-w-0 items-center gap-2 font-bold text-[var(--text)]">
              <Gauge size={18} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />
              ข้อมูลเชิงลึกของตลาดและสถานะระบบ
            </span>
            <span className="pl-6 text-xs text-[var(--text-muted)] sm:shrink-0 sm:pl-0">
              อุตสาหกรรมเด่น · แรงซื้อแรงขาย · สถานะข้อมูล
            </span>
          </summary>
          <div className="grid min-w-0 gap-5 border-t border-[var(--border)] p-4 sm:p-5">
            <ServiceStatus data={view.serviceStatus} />
            <IndustryRanking
              industries={view.industries}
              industryData={view.industryData}
              limitations={view.limitations}
              retrying={Boolean(retrying.industries)}
              loading={Boolean(retrying.industries)
                || (view.industryData.state === 'refreshing' && !industriesAttempted)}
              onRetry={retry}
            />
            <BreadthSection
              data={view.breadth}
              retrying={Boolean(retrying.breadth)}
              onRetry={retry}
            />
          </div>
        </details>
      </main>
    </div>
  );
}
