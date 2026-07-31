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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from '@/src/components/layout/Header';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
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
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { calculateGoalProgress } from '@/src/lib/portfolio/aggregate';
import { useStore } from '@/src/store/useStore';

const NewsFeed = dynamic(
  () => import('@/src/components/news/NewsFeed').then((module) => module.NewsFeed),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-3" aria-label="กำลังโหลดข่าว">
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
  const privacyMode = useStore((state) => state.privacyMode);
  const setPrivacyMode = useStore((state) => state.setPrivacyMode);
  const visible = !privacyMode;
  const selectedPortfolio = data.portfolios.find((portfolio) => portfolio.id === selectedId);
  const summary = selectedPortfolio?.summary ?? data.summary;
  const baseCurrency = selectedPortfolio?.baseCurrency ?? data.baseCurrency;
  const targetValueUsd = selectedPortfolio ? selectedPortfolio.targetValueUsd : data.targetValueUsd;
  const targetDate = selectedPortfolio ? selectedPortfolio.targetDate : data.targetDate;
  const coverage = selectedPortfolio?.coverage ?? data.coverage;
  const valuedAt = selectedPortfolio ? selectedPortfolio.valuedAt : data.valuedAt;
  const portfolioName = selectedPortfolio?.name ?? data.portfolioName;
  const rate = baseCurrency === 'THB' ? Number(usdThbRate) : 1;
  const convert = (value: number | null) =>
    value === null || !Number.isFinite(rate) || rate <= 0 ? null : value * rate;
  const goal = calculateGoalProgress(summary?.totalValue ?? null, {
    targetValueUsd,
    targetDate,
  });
  const progress = goal.progressPercent === null
    ? null
    : Math.max(0, Math.min(100, goal.progressPercent));
  const actions = [
    { href: '#market-overview', label: 'ภาพรวมตลาด', icon: TrendingUp },
    { href: '/portfolio', label: 'พอร์ตของฉัน', icon: PieChart },
    { href: '/watchlist', label: 'Watchlist', icon: Star },
    { href: '/portfolio', label: 'รายการเงินสด', icon: Banknote },
  ];

  if (!data.authenticated || !summary) {
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
                  : '••••••'}
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
              onClick={() => setPrivacyMode(visible)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
            >
              {visible ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-[var(--text-muted)]">วันนี้</p>
              <p className={`mt-1 text-sm font-semibold tabular-nums ${tone(summary.todayChange)}`}>
                {visible ? signed(convert(summary.todayChange)) : '••••'}
              </p>
              <p className={`text-xs tabular-nums ${tone(summary.todayChangePercent)}`}>
                {visible ? signed(summary.todayChangePercent, '%') : '••••'}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--text-muted)]">กำไร / ขาดทุนรวม</p>
              <p className={`mt-1 text-sm font-semibold tabular-nums ${tone(summary.totalGain)}`}>
                {visible ? signed(convert(summary.totalGain)) : '••••'}
              </p>
              <p className={`text-xs tabular-nums ${tone(summary.totalGainPercent)}`}>
                {visible ? signed(summary.totalGainPercent, '%') : '••••'}
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
                  {visible ? formatMoney(convert(value as number | null), baseCurrency) : '••••'}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-[var(--surface-elevated)] p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--text-secondary)]">เป้าหมายพอร์ต</span>
            <span className="font-semibold tabular-nums text-[var(--text)]">
              {progress === null ? 'ยังไม่ได้ตั้งเป้าหมาย' : `${goal.progressPercent!.toFixed(0)}%`}
            </span>
          </div>
          {progress === null ? (
            <Link
              href="/portfolio"
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--border)] px-3 text-xs font-semibold text-[var(--text)] hover:bg-[var(--surface-hover)]"
            >
              <Plus size={15} /> ตั้งเป้าหมาย
            </Link>
          ) : (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-selected)]">
              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${progress}%` }} />
            </div>
          )}
          <div className="mt-3 space-y-1 text-xs text-[var(--text-muted)]">
            <p>{data.portfolioCount} พอร์ตที่ใช้งานอยู่ · {data.totalPortfolioCount} พอร์ตทั้งหมด</p>
            <p>{coverage?.totalAssets ?? 0} สินทรัพย์</p>
            {valuedAt && <p>ประเมินล่าสุด {formatBangkokDateTime(valuedAt)}</p>}
          </div>
          {summary.hasMissingPrices && (
            <p className="mt-2 text-xs leading-5 text-[var(--warning)]">
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
    <article className="min-w-[238px] snap-start rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <InstrumentLogo
            symbol={item.symbol}
            companyName={item.instrument.companyName}
            logoUrl={item.instrument.logoUrl}
            size={36}
          />
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-[var(--text)]">{item.name}</h3>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{item.symbol} · {item.proxyLabel}</p>
          </div>
        </div>
        <span className="rounded-full bg-[var(--surface-elevated)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
          {item.sessionLabel}
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
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
        <span>{OVERVIEW_STATUS_COPY[item.status]}</span>
        <span>{item.asOf ? formatBangkokDateTime(item.asOf) : 'ยังไม่มีเวลาอัปเดต'}</span>
      </div>
    </article>
  );
}

function IndustryRanking({
  industries,
  industryData,
  limitations,
  retrying,
  onRetry,
}: {
  industries: IndustryGroup[];
  industryData: OverviewDashboardData['industryData'];
  limitations: string[];
  retrying: boolean;
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
            <span title="เฉลี่ยแบบให้น้ำหนักเท่ากันจากหุ้นที่มีข้อมูลช่วงซื้อขายปกติถูกต้องอย่างน้อย 5 ตัวต่อกลุ่ม">
              <Info size={18} className="text-[var(--text-muted)]" aria-label="วิธีคำนวณอุตสาหกรรมเด่น" />
            </span>
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
      {ranked.length === 0 && industryData.state === 'refreshing' ? (
        <div className="space-y-2" aria-label="กำลังรวบรวมข้อมูลอุตสาหกรรม" aria-busy="true">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className="h-[76px] animate-pulse rounded-xl bg-[var(--surface-elevated)] motion-reduce:animate-none" />
          ))}
          <p className="pt-2 text-center text-xs text-[var(--text-secondary)]">
            กำลังรวบรวมราคาช่วงตลาดปกติ คุณยังใช้ข้อมูลพอร์ตและตลาดส่วนอื่นได้ตามปกติ
          </p>
        </div>
      ) : ranked.length === 0 ? (
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
          <p className="mt-2 text-sm text-[var(--text-secondary)]">ยังไม่มีหุ้นใน Watchlist</p>
          <Link href="/search" className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-[var(--accent-soft)] px-4 text-sm font-semibold text-[var(--accent)]">ค้นหาหุ้น</Link>
        </div>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--text-secondary)]">ไม่มีหุ้นที่ตรงกับตัวกรองนี้</p>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {visible.map((item) => (
            <Link
              key={item.symbol}
              href={`/stock/${encodeURIComponent(item.symbol)}`}
              className="grid min-h-[82px] grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 py-3"
            >
              <InstrumentLogo
                symbol={item.symbol}
                companyName={item.instrument.companyName}
                logoUrl={item.instrument.logoUrl}
                size={40}
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
                    {item.extended.label} {formatNumber(item.extended.price)} {signed(item.extended.changePercent, '%')}
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
        <div className="py-8 text-center" role="status">
          <RefreshCw className="mx-auto animate-spin text-[var(--text-muted)]" aria-hidden="true" />
          <p className="mt-2 text-sm text-[var(--text-secondary)]">กำลังอ่าน breadth snapshot ล่าสุด</p>
        </div>
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
            <span className="group relative inline-flex">
              <button type="button" aria-label="อธิบายขอบเขตและวิธีคำนวณ market breadth" className="inline-flex min-h-11 min-w-11 items-center justify-center text-[var(--text-muted)]">
                <Info size={16} />
              </button>
              <span role="tooltip" className="invisible absolute right-0 top-full z-20 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs leading-5 text-[var(--text-secondary)] shadow-xl group-hover:visible group-focus-within:visible">
                {data.universeDescription} เปรียบเทียบ regular close/price กับ previous regular close ของ trading date เดียวกันเท่านั้น
              </span>
            </span>
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
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-[var(--surface-selected)]" aria-label="สัดส่วนหุ้นขึ้น ลง และไม่เปลี่ยนแปลง">
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
          <div className="mt-4 space-y-1 text-[10px] leading-4 text-[var(--text-muted)]">
            <p>คำนวณจากหุ้นที่มีข้อมูลพร้อมใช้ {data.validCount.toLocaleString()} จากทั้งหมด {data.universeCount.toLocaleString()} ตัว ({data.coveragePercent.toFixed(1)}%)</p>
            <p>Failed {data.failedCount.toLocaleString()} · Stale {data.staleCount.toLocaleString()} · ใช้เวลา {(data.durationMs / 1_000).toFixed(1)} วินาที</p>
            <p>ประเมิน {formatBangkokDateTime(data.evaluatedAt)}{data.updatedAt ? ` · ราคาล่าสุด ${formatBangkokDateTime(data.updatedAt)}` : ''}</p>
          </div>
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

export function DashboardClient({ data }: { data: OverviewDashboardData }) {
  const [view, setView] = useState(data);
  const [retrying, setRetrying] = useState<Partial<Record<RetriableOverviewSection, boolean>>>({});
  const [retryNotice, setRetryNotice] = useState('');
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
      setView((current) => applyOverviewSectionUpdate(
        current,
        section,
        payload.data!.value,
        payload.data!.generatedAt,
        payload.data!.related ?? null,
      ));
      setRetryNotice('อัปเดตข้อมูลส่วนนี้แล้ว');
    } catch {
      setRetryNotice('ยังอัปเดตข้อมูลส่วนนี้ไม่ได้ ข้อมูลล่าสุดยังคงแสดงอยู่');
    } finally {
      setRetrying((current) => ({ ...current, [section]: false }));
    }
  }, []);

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
        <ServiceStatus data={view.serviceStatus} />
        <PortfolioCard data={view.portfolio} usdThbRate={view.usdThbRate} />

        <section id="market-overview" className="scroll-mt-24">
          <SectionTitle
            icon={TrendingUp}
            title="ภาพรวมตลาด"
            action={<RetryButton section="market" loading={Boolean(retrying.market)} onRetry={retry} />}
          />
          <div className="-mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-4">
            {view.indices.map((item) => <MarketCard key={item.symbol} item={item} />)}
          </div>
        </section>

        <IndustryRanking
          industries={view.industries}
          industryData={view.industryData}
          limitations={view.limitations}
          retrying={Boolean(retrying.industries)}
          onRetry={retry}
        />

        <div className="grid min-w-0 gap-5 xl:grid-cols-[1.4fr_0.8fr]">
          <WatchlistSection
            items={view.watchlist}
            retrying={Boolean(retrying.watchlist)}
            onRetry={retry}
          />
          <BreadthSection
            data={view.breadth}
            retrying={Boolean(retrying.breadth)}
            onRetry={retry}
          />
        </div>

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
          <SectionTitle
            icon={Newspaper}
            title="ข่าวสำคัญต่อตลาดหุ้น"
          />
          <NewsFeed marketWide />
        </section>
      </main>
    </div>
  );
}
