'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  ChevronRight,
  Eye,
  EyeOff,
  Gauge,
  Info,
  Landmark,
  Newspaper,
  PieChart,
  Plus,
  RefreshCw,
  Star,
  TrendingUp,
  WalletCards,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Header from '@/src/components/layout/Header';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { OverviewPortfolioGoalCard } from '@/src/components/dashboard/OverviewPortfolioGoalCard';
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
import { buildPortfolioGoalCardModel } from '@/src/lib/portfolio/goal-card';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';
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

function formatMoney(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return 'ข้อมูลมูลค่ายังไม่ครบ';
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

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
      className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5"
    >
      <h2 id="portkheaw-intro" className="text-lg font-bold leading-snug text-[var(--text)] sm:text-xl">
        ลงทุนให้เห็นภาพมากขึ้น ไม่ต้องเปิดหลายแอป
      </h2>
      <p className="mt-1.5 text-sm leading-6 text-[var(--text-secondary)]">
        ติดตามพอร์ต ดูข้อมูลหุ้น วิเคราะห์ Options และลองจำลองสถานการณ์ก่อนตัดสินใจ — ทั้งหมดใน PortKheaw
      </p>
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-3 sm:gap-2">
        {PUBLIC_VALUE_POINTS.map(({ icon: Icon, title, detail }) => (
          <li key={title} className="flex items-start gap-2.5 rounded-xl bg-[var(--surface-elevated)] p-2.5 sm:p-3">
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

function SectionTitle({
  icon: Icon,
  title,
  action,
}: {
  icon: typeof Activity;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex min-w-0 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={19} className="shrink-0 text-[var(--accent)]" aria-hidden="true" />
        <h2 className="truncate text-base font-bold text-[var(--text)] sm:text-lg">{title}</h2>
      </div>
      {action}
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

function ServiceStatus({ data }: { data: OverviewDashboardData['serviceStatus'] }) {
  const dot = data.level === 'ready' ? 'bg-[var(--positive)]'
    : data.level === 'connecting' ? 'bg-[var(--info)]'
      : 'bg-[var(--warning)]';
  return (
    <details className="group rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <summary className="grid min-h-11 cursor-pointer list-none gap-1 px-3 py-2 text-sm sm:flex sm:items-center sm:justify-between sm:gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
          <span className="font-medium text-[var(--text-secondary)]">{data.label}</span>
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

function PortfolioCard({ data, usdThbRate }: {
  data: OverviewDashboardData['portfolio'];
  usdThbRate: string | null;
}) {
  const [selectedId, setSelectedId] = useState('aggregate');
  const { visible, toggleVisibility } = usePortfolioPrivacy();
  const selectedPortfolio = data.portfolios.find((portfolio) => portfolio.id === selectedId);
  const summary = selectedPortfolio?.summary ?? data.summary;
  const baseCurrency = selectedPortfolio?.baseCurrency ?? data.baseCurrency;
  const targetValueUsd = selectedPortfolio ? selectedPortfolio.targetValueUsd : data.targetValueUsd;
  const targetDate = selectedPortfolio ? selectedPortfolio.targetDate : data.targetDate;
  const coverage = selectedPortfolio?.coverage ?? data.coverage;
  const portfolioName = selectedPortfolio?.name ?? data.portfolioName;
  const rate = baseCurrency === 'THB' ? Number(usdThbRate) : 1;
  const convert = (value: number | null) =>
    value === null || !Number.isFinite(rate) || rate <= 0 ? null : value * rate;
  const goalCard = summary ? buildPortfolioGoalCardModel({
    scope: selectedPortfolio ? 'selected' : 'aggregate',
    summary,
    goal: { targetValueUsd, targetDate },
    activePortfolios: data.portfolioCount,
    totalPortfolios: data.totalPortfolioCount,
  }) : null;
  const actions = [
    { href: '#market-overview', label: 'ภาพรวมตลาด', icon: TrendingUp },
    { href: '/portfolio', label: 'พอร์ตของฉัน', icon: PieChart },
    { href: '/watchlist', label: 'รายการติดตาม', icon: Star },
    { href: '/portfolio', label: 'รายการเงินสด', icon: Banknote },
  ];

  if (!data.authenticated || !summary || !goalCard) {
    return (
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] sm:p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <WalletCards aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-bold text-[var(--text)]">
              {data.authenticated ? 'เริ่มบันทึกพอร์ตแรกของคุณ' : 'ติดตามพอร์ตได้ในที่เดียว'}
            </h1>
            <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
              ใช้บันทึกหุ้นและออปชันที่ถืออยู่ โดยยังดูข้อมูลตลาดได้โดยไม่ต้องสร้างพอร์ต
            </p>
            <Link
              href={data.authenticated ? '/portfolio' : '/auth/sign-in?next=/portfolio'}
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-bold text-[var(--accent-fg)]"
            >
              <Plus size={17} />
              {data.authenticated ? 'สร้างพอร์ตแรก' : 'เข้าสู่ระบบเพื่อสร้างพอร์ต'}
            </Link>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 border-t border-[var(--border)] pt-4">
          {actions.map(({ href, label, icon: Icon }) => (
            <Link key={label} href={href} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl bg-[var(--surface-elevated)] px-1 text-center text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[1.2fr_1fr]">
        <div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[var(--text-muted)]">
                {summary.hasMissingPrices ? 'มูลค่าที่ยืนยันได้' : 'มูลค่าพอร์ตรวม'}
                {portfolioName ? ` · ${portfolioName}` : ''}
              </p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--text)] sm:text-3xl">
                {visible
                  ? formatMoney(
                    convert(summary.totalValue ?? coverage?.verifiedValueUsd ?? null),
                    baseCurrency,
                  )
                  : SENSITIVE_VALUE_MASK}
              </p>
              {data.portfolios.length > 0 && (
                <label className="mt-3 block text-xs text-[var(--text-secondary)]">
                  ขอบเขตพอร์ต
                  <select
                    value={selectedId}
                    onChange={(event) => setSelectedId(event.target.value)}
                    className="mt-1 min-h-11 w-full max-w-xs rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 text-sm text-[var(--text)]"
                  >
                    <option value="aggregate">รวมทุกพอร์ต</option>
                    {data.portfolios.map((portfolio) => (
                      <option key={portfolio.id} value={portfolio.id}>
                        {portfolio.name}{portfolio.archived ? ' (Archive)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button
              type="button"
              aria-label={visible ? 'ซ่อนยอดพอร์ต' : 'แสดงยอดพอร์ต'}
              onClick={toggleVisibility}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
            >
              {visible ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-[var(--text-muted)]">วันนี้</p>
              <p className={`mt-1 text-sm font-semibold tabular-nums ${tone(summary.todayChange)}`}>
                {visible ? signed(convert(summary.todayChange)) : SENSITIVE_VALUE_MASK}
              </p>
              <p className={`text-xs tabular-nums ${tone(summary.todayChangePercent)}`}>
                {visible ? signed(summary.todayChangePercent, '%') : SENSITIVE_VALUE_MASK}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--text-muted)]">กำไร / ขาดทุนรวม</p>
              <p className={`mt-1 text-sm font-semibold tabular-nums ${tone(summary.totalGain)}`}>
                {visible ? signed(convert(summary.totalGain)) : SENSITIVE_VALUE_MASK}
              </p>
              <p className={`text-xs tabular-nums ${tone(summary.totalGainPercent)}`}>
                {visible ? signed(summary.totalGainPercent, '%') : SENSITIVE_VALUE_MASK}
              </p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-2 min-[360px]:grid-cols-3">
            {[
              ['เงินสด', summary.cashBalance],
              ['หุ้น', summary.equityMarketValue],
              ['ออปชัน', summary.optionsMarketValue],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-[var(--surface-elevated)] p-2">
                <p className="text-[10px] text-[var(--text-muted)]">{label}</p>
                <p className="mt-1 text-xs font-semibold tabular-nums text-[var(--text)]">
                  {visible ? formatMoney(convert(value as number | null), baseCurrency) : SENSITIVE_VALUE_MASK}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <OverviewPortfolioGoalCard
            model={goalCard}
            money={(value) => visible
              ? formatMoney(convert(value), baseCurrency)
              : SENSITIVE_VALUE_MASK}
            signed={(value) => visible ? signed(convert(value)) : SENSITIVE_VALUE_MASK}
            percent={(value) => visible ? signed(value, '%') : SENSITIVE_VALUE_MASK}
            showBalances={visible}
          />
          {summary.hasMissingPrices && (
            <p className="mt-2 rounded-lg bg-[var(--warning-soft)] p-2.5 text-xs leading-5 text-[var(--warning)]">
              คำนวณได้ {coverage?.pricedAssets ?? 0} จาก {coverage?.totalAssets ?? 0} สินทรัพย์
              {' '}โดยแสดงยอดที่ยืนยันได้และไม่ล้างค่าที่คำนวณสำเร็จแล้ว
            </p>
          )}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-px border-t border-[var(--border)] bg-[var(--border)]">
        {actions.map(({ href, label, icon: Icon }) => (
          <Link key={label} href={href} className="flex min-h-16 flex-col items-center justify-center gap-1 bg-[var(--surface)] px-1 text-center text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </Link>
        ))}
      </div>
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
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <InstrumentLogo
            symbol={item.symbol}
            companyName={item.instrument.companyName}
            logoUrl={item.instrument.logoUrl}
            size={36}
            appearance="plain"
          />
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-[var(--text)]">{item.name}</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{item.symbol} · {item.proxyLabel}</p>
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
            {item.sessionLabel}
          </span>
          {/* The one affordance: enough to read as "this opens", small enough
              not to compete with the price. */}
          <ChevronRight
            size={16}
            aria-hidden="true"
            className="text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5"
          />
        </span>
      </div>
      <p className="mt-4 text-xl font-bold tabular-nums text-[var(--text)]">
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
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
        <span>{OVERVIEW_STATUS_COPY[item.status]}</span>
        <span>{item.asOf ? formatBangkokDateTime(item.asOf) : 'ยังไม่มีเวลาอัปเดต'}</span>
      </div>
      {item.source && (
        <p className="mt-1 truncate text-[10px] text-[var(--text-muted)]" title={item.source}>
          แหล่งข้อมูล {item.source}
        </p>
      )}
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
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
      <SectionTitle
        icon={Landmark}
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
  retrying,
  onRetry,
}: {
  items: OverviewPrice[];
  retrying: boolean;
  onRetry: (section: RetriableOverviewSection) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'up' | 'down'>('all');
  const visible = items.filter((item) =>
    filter === 'all' || (filter === 'up' ? (item.changePercent ?? 0) > 0 : (item.changePercent ?? 0) < 0));
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
      <SectionTitle
        icon={Star}
        title="หุ้นที่ติดตาม"
        action={(
          <span className="flex items-center gap-1">
            <Link href="/watchlist" className="text-xs font-semibold text-[var(--accent)]">ดูทั้งหมด</Link>
            <RetryButton section="watchlist" loading={retrying} onRetry={onRetry} />
          </span>
        )}
      />
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
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
      <SectionTitle
        icon={Activity}
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

  return (
    <div className="min-w-0">
      <Header title="ภาพรวม" subtitle="พอร์ต ตลาด อุตสาหกรรม และข่าวสำคัญ" />
      <main className="mx-auto w-full max-w-[1440px] space-y-5 p-3 sm:p-5 lg:p-6">
        <p className="sr-only" role="status" aria-live="polite">{retryNotice}</p>
        {!view.portfolio.authenticated && <><LandingFunnel /><PublicValueProposition /></>}

        {/*
          Above the portfolio, and only ever once: a reader who has answered, or
          waved it away, or finished the one hint, never sees it again on any
          device — the answer lives on their account, not in this browser.
        */}
        <OnboardingCard view={onboarding} />

        {/*
          The reading order is the order the questions are asked in: what is
          mine, what am I watching, what is the market doing, what is coming up,
          and what is being said about it. Nothing was removed to get here —
          breadth, the industry ranking and the service status are all still on
          this page, one disclosure below, because they answer a question a
          reader asks occasionally rather than every time they open the app.
        */}
        <PortfolioCard data={view.portfolio} usdThbRate={view.usdThbRate} />

        <WatchlistSection
          items={view.watchlist}
          retrying={Boolean(retrying.watchlist)}
          onRetry={retry}
        />

        <section id="market-overview" className="scroll-mt-24">
          <SectionTitle
            icon={TrendingUp}
            title="ตลาดวันนี้"
            action={<RetryButton section="market" loading={Boolean(retrying.market)} onRetry={retry} />}
          />
          <div className="-mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-4">
            {view.indices.map((item) => <MarketCard key={item.symbol} item={item} />)}
          </div>
        </section>

        {view.upcoming && <UpcomingSection feed={view.upcoming} />}

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
          <SectionTitle
            icon={Newspaper}
            title="ข่าวสำคัญต่อตลาดหุ้น"
          />
          <NewsFeed marketWide />
        </section>

        <details className="group min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
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
