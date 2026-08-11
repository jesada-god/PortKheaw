'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Info,
  Search,
  Star,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  addWatchlistItemAction,
  removeWatchlistItemAction,
} from '@/app/watchlist/actions';
import Header from '@/src/components/layout/Header';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import type {
  IndustryChartResult,
  IndustryGroup,
  IndustryTimeframe,
} from '@/src/lib/overview/types';
import { OVERVIEW_STATUS_COPY } from '@/src/lib/overview/presentation';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { useToast } from '@/src/components/ui/Toast';
import {
  beginWatchlistChange,
  rollbackWatchlistChange,
} from '@/src/lib/watchlist/optimistic';

type Tab = 'gainers' | 'losers' | 'volume' | 'all';
type Sort = 'percent' | 'price' | 'volume' | 'name' | 'market-cap';
const PAGE_SIZE = 20;

function number(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return 'ยังไม่มีข้อมูล';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function signed(value: number | null, suffix = ''): string {
  if (value === null || !Number.isFinite(value)) return 'ยังไม่มีข้อมูล';
  return `${value > 0 ? '+' : ''}${number(value)}${suffix}`;
}

function tone(value: number | null): string {
  if (value === null || value === 0) return 'text-[var(--text-muted)]';
  return value > 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]';
}

function ChartView({ result }: { result: IndustryChartResult }) {
  if (result.status === 'unavailable' || result.points.length < 2) {
    return (
      <div className="flex min-h-48 items-center justify-center text-center">
        <div>
          <BarChart3 className="mx-auto text-[var(--text-muted)]" />
          <p className="mt-2 text-sm text-[var(--text-secondary)]">กราฟช่วงนี้ยังไม่พร้อม</p>
          <p className="mt-1 max-w-md text-xs leading-5 text-[var(--text-muted)]">
            {result.reason ?? 'ข้อมูล finalized candles ไม่ผ่านเกณฑ์ coverage'}
          </p>
        </div>
      </div>
    );
  }
  const values = result.points.flatMap((point) => [
    point.industryReturn,
    ...(point.benchmarkReturn === null ? [] : [point.benchmarkReturn]),
  ]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = (key: 'industryReturn' | 'benchmarkReturn') => result.points
    .flatMap((point, index) => {
      const value = point[key];
      if (value === null) return [];
      const x = index / (result.points.length - 1) * 100;
      const y = 92 - (value - min) / span * 84;
      return [`${x.toFixed(2)},${y.toFixed(2)}`];
    })
    .join(' ');
  return (
    <div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-52 w-full overflow-visible"
        role="img"
        aria-label={`กราฟผลตอบแทนอุตสาหกรรมเทียบ ${result.benchmarkLabel}`}
      >
        <line x1="0" x2="100" y1={92 - (0 - min) / span * 84} y2={92 - (0 - min) / span * 84} stroke="var(--border-strong)" strokeWidth="0.4" />
        <polyline points={path('benchmarkReturn')} fill="none" stroke="var(--text-muted)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <polyline points={path('industryReturn')} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
        <span className="flex flex-wrap gap-3">
          <span><i className="mr-1 inline-block h-0.5 w-4 bg-[var(--accent)]" />อุตสาหกรรม (Equal-weighted)</span>
          <span><i className="mr-1 inline-block h-0.5 w-4 bg-[var(--text-muted)]" />{result.benchmarkLabel}</span>
        </span>
        <span>
          ใช้ข้อมูล {result.coverage.usable}/{result.coverage.requested} บริษัท
          {result.stale ? ' · ข้อมูลสำรองล่าสุด' : ''}
        </span>
      </div>
    </div>
  );
}

export function IndustryDetailClient({
  industry,
  watchedSymbols,
  slug,
}: {
  industry: IndustryGroup | null;
  watchedSymbols: string[];
  slug: string;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const [tab, setTab] = useState<Tab>('gainers');
  const [sort, setSort] = useState<Sort>('percent');
  const [query, setQuery] = useState('');
  const [watched, setWatched] = useState(() => new Set(watchedSymbols));
  const [savingSymbols, setSavingSymbols] = useState(() => new Set<string>());
  const [, startTransition] = useTransition();
  const [page, setPage] = useState(1);
  const [timeframe, setTimeframe] = useState<IndustryTimeframe>('1D');
  const [charts, setCharts] = useState<Partial<Record<
    IndustryTimeframe,
    { loading: boolean; result: IndustryChartResult | null }
  >>>({ '1D': { loading: true, result: null } });
  const hasMarketCap = industry?.members.some((member) => member.marketCap !== null) ?? false;

  const members = useMemo(() => {
    if (!industry) return [];
    const normalized = query.trim().toLowerCase();
    const filtered = industry.members.filter(({ price }) => (
      !normalized
      || price.symbol.toLowerCase().includes(normalized)
      || price.instrument.companyName.toLowerCase().includes(normalized)
    ) && (
      tab === 'all'
      || tab === 'gainers' && (price.changePercent ?? 0) > 0
      || tab === 'losers' && (price.changePercent ?? 0) < 0
      || tab === 'volume'
    ));
    return filtered.sort((left, right) => {
      if (tab === 'volume' || sort === 'volume') {
        return (right.volume ?? -1) - (left.volume ?? -1);
      }
      if (sort === 'price') return (right.price.price ?? -1) - (left.price.price ?? -1);
      if (sort === 'name') {
        return left.price.instrument.companyName.localeCompare(right.price.instrument.companyName);
      }
      if (sort === 'market-cap') return (right.marketCap ?? -1) - (left.marketCap ?? -1);
      const direction = tab === 'losers' ? 1 : -1;
      return ((left.price.changePercent ?? 0) - (right.price.changePercent ?? 0)) * direction;
    });
  }, [industry, query, sort, tab]);
  const pageCount = Math.max(1, Math.ceil(members.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleMembers = members.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  useEffect(() => {
    if (!industry) return;
    const controller = new AbortController();
    void fetch(
      `/api/market/industry/${encodeURIComponent(slug)}/chart?timeframe=${timeframe}`,
      { signal: controller.signal, credentials: 'same-origin' },
    )
      .then(async (response) => {
        const payload = await response.json() as {
          data: IndustryChartResult | null;
        };
        if (!response.ok || !payload.data) throw new Error('chart unavailable');
        setCharts((current) => ({
          ...current,
          [timeframe]: { loading: false, result: payload.data },
        }));
      })
      .catch((cause) => {
        if (cause instanceof Error && cause.name === 'AbortError') return;
        setCharts((current) => ({
          ...current,
          [timeframe]: {
            loading: false,
            result: {
              timeframe,
              status: 'unavailable',
              points: [],
              benchmarkSymbol: 'SPY',
              benchmarkLabel: 'S&P 500 (SPY ETF อ้างอิง)',
              coverage: { usable: 0, requested: 0, thresholdPercent: 60 },
              stale: false,
              asOf: null,
              reason: 'ผู้ให้บริการกราฟยังไม่พร้อม กรุณาลองใหม่ภายหลัง',
            },
          },
        }));
      });
    return () => controller.abort();
  }, [industry, slug, timeframe]);

  const toggleWatchlist = (symbol: string) => {
    const change = beginWatchlistChange(watched, symbol);
    const removing = change.wasWatched;
    setWatched(change.next);
    setSavingSymbols((current) => new Set(current).add(symbol));
    startTransition(async () => {
      const result = removing
        ? await removeWatchlistItemAction(symbol)
        : await addWatchlistItemAction(symbol);
      if (!result.ok) {
        setWatched((current) => rollbackWatchlistChange(current, change));
        addToast({ title: 'บันทึกรายการติดตามไม่สำเร็จ', message: result.message, type: 'error' });
      } else {
        addToast({ title: removing ? `นำ ${symbol} ออกจากรายการติดตามแล้ว` : `เพิ่ม ${symbol} เข้ารายการติดตามแล้ว`, type: 'success' });
      }
      setSavingSymbols((current) => {
        const next = new Set(current);
        next.delete(symbol);
        return next;
      });
    });
  };

  if (!industry) {
    return (
      <div className="min-w-0">
        <Header title="รายละเอียดอุตสาหกรรม" />
        <main className="mx-auto max-w-3xl p-4 sm:p-6">
          <Link href="/" className="inline-flex min-h-11 items-center gap-2 text-sm text-[var(--accent)]">
            <ArrowLeft size={18} /> กลับหน้าภาพรวม
          </Link>
          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
            <BarChart3 className="mx-auto text-[var(--text-muted)]" />
            <h1 className="mt-3 font-bold text-[var(--text)]">ยังไม่มีข้อมูลอุตสาหกรรมนี้</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
              URL <span className="font-mono">{slug}</span> ใช้งานได้ แต่ผู้ให้บริการยังไม่มีข้อมูลและราคาที่ผ่านเกณฑ์เพียงพอ
            </p>
          </div>
        </main>
      </div>
    );
  }

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'gainers', label: 'ขึ้นมากสุด' },
    { value: 'losers', label: 'ลงมากสุด' },
    { value: 'volume', label: 'ซื้อขายมากสุด' },
    { value: 'all', label: 'หุ้นทั้งหมด' },
  ];
  const timeframes: IndustryTimeframe[] = ['1D', '1W', '1M', '3M', '1Y'];
  const chartState = charts[timeframe];
  const leader = [...industry.members].sort((left, right) =>
    (right.price.changePercent ?? -Infinity) - (left.price.changePercent ?? -Infinity))[0];
  const laggard = [...industry.members].sort((left, right) =>
    (left.price.changePercent ?? Infinity) - (right.price.changePercent ?? Infinity))[0];
  const mostActive = [...industry.members].sort((left, right) =>
    (right.volume ?? -1) - (left.volume ?? -1))[0];

  return (
    <div className="min-w-0">
      <Header title={industry.nameTh ?? industry.name} subtitle={industry.nameTh ? industry.name : undefined} />
      <main className="mx-auto w-full max-w-6xl space-y-5 p-3 sm:p-5 lg:p-6">
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--accent)]">
          <ArrowLeft size={18} /> กลับหน้าภาพรวม
        </Link>

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[1fr_1.3fr]">
            <div>
              <p className="text-xs text-[var(--text-muted)]">{industry.sector ?? 'ยังไม่ระบุ Sector'}</p>
              <p className="mt-1 text-sm font-medium text-[var(--text-secondary)]">
                {industry.nameTh ? industry.name : 'ภาพรวมการเคลื่อนไหวของสมาชิก'}
              </p>
              <p className={`mt-4 text-3xl font-bold tabular-nums ${tone(industry.returnPercent)}`}>
                {signed(industry.returnPercent, '%')}
              </p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                ผลตอบแทนเฉลี่ยแบบให้น้ำหนักเท่ากัน (Equal-weighted)
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['ค่าเฉลี่ย', signed(industry.averageChange, '%'), tone(industry.averageChange)],
                  ['ค่ากลาง', signed(industry.medianChange, '%'), tone(industry.medianChange)],
                  ['ขึ้น / ลง', industry.upDownRatio === null ? 'คำนวณไม่ได้' : number(industry.upDownRatio), 'text-[var(--text)]'],
                  ['ความครอบคลุมของข้อมูล', `${industry.validCount}/${industry.totalCount}`, 'text-[var(--text)]'],
                ].map(([label, value, color]) => (
                  <div key={String(label)} className="rounded-xl bg-[var(--surface-elevated)] p-2 text-center">
                    <p className={`text-sm font-bold tabular-nums ${color}`}>{value}</p>
                    <p className="mt-1 text-[10px] text-[var(--text-muted)]">{label}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-[var(--text-secondary)]">
                <Info size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                ภาพรวมคำนวณจากค่า % เปลี่ยนแปลงของหุ้นแต่ละตัวใน trading date และราคาช่วงตลาดปกติชุดเดียวกัน
                แล้วให้น้ำหนักหุ้นทุกตัวเท่ากัน หุ้นหนึ่งตัวจึงมี contribution เท่ากับ % change ÷ {industry.validCount}
              </p>
              {industry.updatedAt && <p className="mt-3 text-[10px] text-[var(--text-muted)]">อัปเดต {formatBangkokDateTime(industry.updatedAt)}</p>}
            </div>
            <div className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
              <div className="flex flex-wrap gap-2">
                {timeframes.map((item) => {
                  const unavailable = charts[item]?.result?.status === 'unavailable';
                  return (
                  <button
                    key={item}
                    type="button"
                    disabled={unavailable}
                    title={unavailable ? charts[item]?.result?.reason ?? 'ข้อมูลไม่เพียงพอ' : undefined}
                    onClick={() => {
                      setCharts((current) => current[item]
                        ? current
                        : { ...current, [item]: { loading: true, result: null } });
                      setTimeframe(item);
                    }}
                    className={`min-h-11 rounded-lg px-3 text-xs font-semibold ${
                      timeframe === item
                        ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40'
                    }`}
                  >
                    {item}
                  </button>
                  );
                })}
              </div>
              {!chartState || chartState.loading ? (
                <div className="mt-4 h-52 animate-pulse rounded-xl bg-[var(--surface-selected)] motion-reduce:animate-none" aria-label="กำลังโหลดกราฟอุตสาหกรรม" />
              ) : chartState.result ? <ChartView result={chartState.result} /> : null}
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="ข้อมูลเชิงลึกอุตสาหกรรม">
          {[
            ['หุ้นนำตลาด', leader, ArrowUp],
            ['หุ้นฉุดตลาด', laggard, ArrowDown],
            ['ซื้อขายมากที่สุด', mostActive, Activity],
          ].map(([label, member, Icon]) => {
            const item = member as IndustryGroup['members'][number] | undefined;
            const CardIcon = Icon as typeof ArrowUp;
            return (
              <article key={String(label)} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><CardIcon size={16} />{String(label)}</p>
                <p className="mt-2 font-bold text-[var(--text)]">{item?.price.symbol ?? 'ยังไม่มีข้อมูล'}</p>
                <p className={`mt-1 text-sm font-semibold ${tone(item?.price.changePercent ?? null)}`}>
                  {signed(item?.price.changePercent ?? null, '%')}
                </p>
                <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                  Volume {item?.volume == null ? 'ยังไม่มีข้อมูล' : item.volume.toLocaleString('en-US')}
                  {' '}· Contribution {signed(item?.contributionPercent ?? null, '%')}
                </p>
              </article>
            );
          })}
          <article className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><BarChart3 size={16} />Breadth</p>
            <p className="mt-2 font-bold text-[var(--text)]">{industry.advancing} ขึ้น / {industry.declining} ลง</p>
            <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">{number(industry.breadthPercent, 1)}% ปรับขึ้น</p>
            <p className="mt-1 text-[10px] text-[var(--text-muted)]">จากข้อมูลที่ใช้ได้ {industry.validCount} บริษัท</p>
          </article>
        </section>

        <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div role="tablist" aria-label="ตัวกรองหุ้น" className="flex gap-2 overflow-x-auto">
              {tabs.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.value}
                  onClick={() => {
                    setTab(item.value);
                    setPage(1);
                  }}
                  className={`min-h-11 whitespace-nowrap rounded-full px-4 text-xs font-semibold ${
                    tab === item.value
                      ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                      : 'bg-[var(--surface-elevated)] text-[var(--text-secondary)]'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="flex min-h-11 items-center gap-2 text-xs text-[var(--text-muted)]">
              เรียงตาม
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value as Sort);
                  setPage(1);
                }}
                className="min-h-11 rounded-xl border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-sm text-[var(--text)]"
              >
                <option value="percent">เปอร์เซ็นต์</option>
                <option value="price">ราคา</option>
                <option value="volume">Volume</option>
                <option value="name">ชื่อ</option>
                <option value="market-cap" disabled={!hasMarketCap}>
                  Market cap{hasMarketCap ? '' : ' (ข้อมูลยังไม่พร้อม)'}
                </option>
              </select>
            </label>
          </div>

          <div className="relative mt-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={18} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              aria-label="ค้นหาหุ้นในอุตสาหกรรม"
              placeholder="ค้นหา Symbol หรือชื่อบริษัท"
              className="min-h-12 w-full rounded-xl border border-[var(--border-strong)] bg-[var(--input-bg)] pl-10 pr-12 text-base text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="ล้างคำค้น"
                onClick={() => {
                  setQuery('');
                  setPage(1);
                }}
                className="absolute right-1 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center text-[var(--text-muted)]"
              >
                <X size={18} />
              </button>
            )}
          </div>

          <div className="mt-4 divide-y divide-[var(--border)]">
            {members.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--text-secondary)]">ไม่พบหุ้นที่ตรงกับตัวกรอง</p>
            ) : visibleMembers.map(({ price, volume, marketCap, contributionPercent }) => (
              <article
                key={price.symbol}
                role="link"
                tabIndex={0}
                aria-label={`เปิดรายละเอียด ${price.symbol}`}
                onClick={() => router.push(`/stock/${encodeURIComponent(price.symbol)}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    router.push(`/stock/${encodeURIComponent(price.symbol)}`);
                  }
                }}
                className="grid min-h-[92px] cursor-pointer grid-cols-[44px_minmax(0,1fr)] items-center gap-3 py-3 sm:grid-cols-[44px_minmax(0,1fr)_auto] focus-visible:rounded-xl focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                <InstrumentLogo
                  symbol={price.symbol}
                  companyName={price.instrument.companyName}
                  logoUrl={price.instrument.logoUrl}
                  size={44}
                />
                <Link href={`/stock/${encodeURIComponent(price.symbol)}`} className="min-w-0">
                  <span className="flex items-center gap-2">
                    <strong className="text-sm text-[var(--text)]">{price.symbol}</strong>
                    {price.changePercent !== null && (
                      price.changePercent >= 0
                        ? <ArrowUp size={14} className="text-[var(--positive)]" />
                        : <ArrowDown size={14} className="text-[var(--negative)]" />
                    )}
                  </span>
                  <span className="block truncate text-xs text-[var(--text-secondary)]">{price.instrument.companyName}</span>
                  <span className="mt-1 block text-[10px] text-[var(--text-muted)]">
                    Volume {volume === null ? 'ยังไม่มีข้อมูล' : volume.toLocaleString('en-US')}
                    {marketCap !== null ? ` · Market cap ${marketCap.toLocaleString('en-US')}` : ''}
                    {' '}· Contribution {signed(contributionPercent, '%')}
                  </span>
                  <span className="block text-[10px] text-[var(--text-muted)]">
                    {price.sessionLabel} · {OVERVIEW_STATUS_COPY[price.status]}
                    {price.asOf ? ` · ${formatBangkokDateTime(price.asOf)}` : ''}
                  </span>
                </Link>
                <div className="col-span-2 flex items-center justify-end gap-2 text-right sm:col-span-1">
                  <Link href={`/stock/${encodeURIComponent(price.symbol)}`} className="min-w-24">
                    <span className="block whitespace-nowrap text-sm font-bold tabular-nums text-[var(--text)]">
                      {price.price === null ? 'ยังไม่มีข้อมูล' : `${number(price.price)} ${price.currency}`}
                    </span>
                    <span className={`block text-xs font-semibold tabular-nums ${tone(price.changePercent)}`}>
                      {signed(price.change)} · {signed(price.changePercent, '%')}
                    </span>
                  </Link>
                  <button
                    type="button"
                    disabled={savingSymbols.has(price.symbol)}
                    aria-label={watched.has(price.symbol) ? `นำ ${price.symbol} ออกจากรายการติดตาม` : `เพิ่ม ${price.symbol} เข้ารายการติดตาม`}
                    aria-pressed={watched.has(price.symbol)}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleWatchlist(price.symbol);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                    className={`flex min-h-11 min-w-11 items-center justify-center rounded-xl ${
                      watched.has(price.symbol)
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)]'
                    }`}
                  >
                    <Star size={18} fill={watched.has(price.symbol) ? 'currentColor' : 'none'} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          {members.length > PAGE_SIZE && (
            <nav className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4" aria-label="หน้ารายชื่อหุ้น">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-40"
                aria-label="หน้าก่อนหน้า"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-xs text-[var(--text-muted)]">
                หน้า {currentPage} จาก {pageCount} · {members.length} บริษัท
              </span>
              <button
                type="button"
                disabled={currentPage >= pageCount}
                onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--text-secondary)] disabled:opacity-40"
                aria-label="หน้าถัดไป"
              >
                <ChevronRight size={18} />
              </button>
            </nav>
          )}
        </section>
      </main>
    </div>
  );
}
