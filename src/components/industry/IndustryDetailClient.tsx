'use client';

import Link from 'next/link';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Search,
  Star,
  X,
} from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import {
  addWatchlistItemAction,
  removeWatchlistItemAction,
} from '@/app/watchlist/actions';
import Header from '@/src/components/layout/Header';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import type { IndustryGroup } from '@/src/lib/overview/types';
import { OVERVIEW_STATUS_COPY } from '@/src/lib/overview/presentation';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { useToast } from '@/src/components/ui/Toast';

type Tab = 'gainers' | 'losers' | 'volume' | 'all';
type Sort = 'percent' | 'price' | 'volume' | 'name' | 'market-cap';

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

export function IndustryDetailClient({
  industry,
  watchedSymbols,
  slug,
}: {
  industry: IndustryGroup | null;
  watchedSymbols: string[];
  slug: string;
}) {
  const { addToast } = useToast();
  const [tab, setTab] = useState<Tab>('gainers');
  const [sort, setSort] = useState<Sort>('percent');
  const [query, setQuery] = useState('');
  const [watched, setWatched] = useState(() => new Set(watchedSymbols));
  const [pending, startTransition] = useTransition();
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

  const toggleWatchlist = (symbol: string) => {
    const removing = watched.has(symbol);
    startTransition(async () => {
      const result = removing
        ? await removeWatchlistItemAction(symbol)
        : await addWatchlistItemAction(symbol);
      if (!result.ok) {
        addToast({ title: 'บันทึก Watchlist ไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      setWatched((current) => {
        const next = new Set(current);
        if (removing) next.delete(symbol);
        else next.add(symbol);
        return next;
      });
      addToast({ title: removing ? `นำ ${symbol} ออกจาก Watchlist แล้ว` : `เพิ่ม ${symbol} เข้า Watchlist แล้ว`, type: 'success' });
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
  const timeframes = ['1D', '1W', '1M', '3M', '1Y'];

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
              <h1 className="mt-1 text-2xl font-bold text-[var(--text)]">{industry.nameTh ?? industry.name}</h1>
              {industry.nameTh && <p className="mt-1 text-sm text-[var(--text-secondary)]">{industry.name}</p>}
              <p className={`mt-4 text-3xl font-bold tabular-nums ${tone(industry.returnPercent)}`}>
                {signed(industry.returnPercent, '%')}
              </p>
              <div className="mt-4 grid grid-cols-4 gap-2">
                {[
                  ['ขึ้น', industry.advancing, 'text-[var(--positive)]'],
                  ['ลง', industry.declining, 'text-[var(--negative)]'],
                  ['คงที่', industry.unchanged, 'text-[var(--text-secondary)]'],
                  ['ใช้ได้', industry.validCount, 'text-[var(--text)]'],
                ].map(([label, value, color]) => (
                  <div key={String(label)} className="rounded-xl bg-[var(--surface-elevated)] p-2 text-center">
                    <p className={`font-bold tabular-nums ${color}`}>{value}</p>
                    <p className="mt-1 text-[10px] text-[var(--text-muted)]">{label}</p>
                  </div>
                ))}
              </div>
              {industry.updatedAt && <p className="mt-3 text-[10px] text-[var(--text-muted)]">อัปเดต {formatBangkokDateTime(industry.updatedAt)}</p>}
            </div>
            <div className="rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-elevated)] p-4">
              <div className="flex flex-wrap gap-2">
                {timeframes.map((timeframe) => (
                  <button
                    key={timeframe}
                    type="button"
                    disabled
                    title="ยังไม่มีข้อมูลย้อนหลังระดับอุตสาหกรรมที่ผู้ให้บริการยืนยัน"
                    className="min-h-11 rounded-lg px-3 text-xs text-[var(--text-muted)] opacity-60"
                  >
                    {timeframe}
                  </button>
                ))}
              </div>
              <div className="flex min-h-40 items-center justify-center text-center">
                <div>
                  <BarChart3 className="mx-auto text-[var(--text-muted)]" />
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">ยังไม่มีกราฟรวมย้อนหลังที่คำนวณได้จริง</p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">ระบบจะไม่สร้างเส้นกราฟจำลองแทนข้อมูลที่ไม่มี</p>
                </div>
              </div>
            </div>
          </div>
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
                  onClick={() => setTab(item.value)}
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
                onChange={(event) => setSort(event.target.value as Sort)}
                className="min-h-11 rounded-xl border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-sm text-[var(--text)]"
              >
                <option value="percent">เปอร์เซ็นต์</option>
                <option value="price">ราคา</option>
                <option value="volume">Volume</option>
                <option value="name">ชื่อ</option>
                {hasMarketCap && <option value="market-cap">Market cap</option>}
              </select>
            </label>
          </div>

          <div className="relative mt-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="ค้นหาหุ้นในอุตสาหกรรม"
              placeholder="ค้นหา Symbol หรือชื่อบริษัท"
              className="min-h-12 w-full rounded-xl border border-[var(--border-strong)] bg-[var(--input-bg)] pl-10 pr-12 text-base text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label="ล้างคำค้น"
                onClick={() => setQuery('')}
                className="absolute right-1 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center text-[var(--text-muted)]"
              >
                <X size={18} />
              </button>
            )}
          </div>

          <div className="mt-4 divide-y divide-[var(--border)]">
            {members.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--text-secondary)]">ไม่พบหุ้นที่ตรงกับตัวกรอง</p>
            ) : members.map(({ price, volume, marketCap }) => (
              <article key={price.symbol} className="grid min-h-[92px] grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 py-3">
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
                  </span>
                  <span className="block text-[10px] text-[var(--text-muted)]">
                    {price.sessionLabel} · {OVERVIEW_STATUS_COPY[price.status]}
                  </span>
                </Link>
                <div className="flex items-center gap-2 text-right">
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
                    disabled={pending}
                    aria-label={watched.has(price.symbol) ? `นำ ${price.symbol} ออกจาก Watchlist` : `เพิ่ม ${price.symbol} เข้า Watchlist`}
                    aria-pressed={watched.has(price.symbol)}
                    onClick={() => toggleWatchlist(price.symbol)}
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
        </section>
      </main>
    </div>
  );
}
