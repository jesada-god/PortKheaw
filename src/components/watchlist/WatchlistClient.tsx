'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDownRight, ArrowUpRight, Plus, Search, Star, Trash2, X } from 'lucide-react';
import { addWatchlistItemAction, removeWatchlistItemAction } from '@/app/watchlist/actions';
import { Button } from '@/src/components/ui/Button';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { useToast } from '@/src/components/ui/Toast';
import type { MarketDataEnvelope, SymbolSearchResult } from '@/src/lib/market-data/types';
import type { WatchlistItemRecord, WatchlistQuote, WatchlistRecord } from '@/src/lib/watchlist/types';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import {
  formatBangkokDateTime,
  isStaleAt,
} from '@/src/lib/presentation/datetime';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { requestCompanyProfile } from '@/src/components/stock/profile-retry';

type SortKey = 'newest' | 'symbol' | 'price' | 'change';
type WatchlistInstrument = {
  companyName: string;
  logoUrl: string | null;
};

function displayTime(value: string | null) {
  if (!value) return 'ไม่ทราบเวลา';
  return formatBangkokDateTime(value);
}

function freshnessLabel(quote: WatchlistQuote | undefined, referenceTime: string) {
  if (!quote || quote.freshness.status === 'unavailable') return 'ข้อมูลยังไม่พร้อม';
  const labels: Record<string, string> = {
    realtime: 'เรียลไทม์',
    delayed: 'ข้อมูลล่าช้า',
    'end-of-day': 'ราคาปิดทางการ',
    cached: 'ข้อมูลล่าสุดที่บันทึกไว้',
    stale: 'ข้อมูลล่าสุดที่บันทึกไว้',
    unknown: 'กำลังตรวจสอบข้อมูล',
  };
  const stale = quote.freshness.status === 'stale'
    || isStaleAt(
      quote.freshness.asOf,
      quote.freshness.maxAgeSeconds,
      referenceTime,
    );
  const label = stale
    ? 'ข้อมูลล่าสุดที่บันทึกไว้'
    : labels[quote.freshness.status] ?? 'กำลังตรวจสอบข้อมูล';
  return quote.freshness.asOf
    ? `${label} · ${displayTime(quote.freshness.asOf)}`
    : label;
}

export function WatchlistClient({
  watchlist,
  initialQuotes,
  initialInstruments,
  renderedAt,
}: {
  watchlist: WatchlistRecord;
  initialQuotes: Record<string, WatchlistQuote>;
  initialInstruments: Record<string, WatchlistInstrument>;
  renderedAt: string;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const [items, setItems] = useState(watchlist.items);
  const [quotes, setQuotes] = useState(initialQuotes);
  const [instruments, setInstruments] = useState(initialInstruments);
  const [sort, setSort] = useState<SortKey>('newest');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [pendingSymbols, setPendingSymbols] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();
  const searchRequest = useRef(0);
  const isOnline = useOnlineStatus();

  const existingSymbols = useMemo(() => new Set(items.map((item) => item.symbol)), [items]);
  const sortedItems = useMemo(() => [...items].sort((a, b) => {
    if (sort === 'symbol') return a.symbol.localeCompare(b.symbol);
    if (sort === 'price') return (quotes[b.symbol]?.quote?.price ?? -Infinity) - (quotes[a.symbol]?.quote?.price ?? -Infinity);
    if (sort === 'change') return (quotes[b.symbol]?.quote?.changePercent ?? -Infinity) - (quotes[a.symbol]?.quote?.changePercent ?? -Infinity);
    return b.createdAt.localeCompare(a.createdAt);
  }), [items, quotes, sort]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) return;
    const requestId = ++searchRequest.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true); setSearchError('');
      try {
        const response = await fetch(`/api/market/search?q=${encodeURIComponent(normalized)}&includeDelisted=true&limit=15`, { signal: controller.signal });
        const payload = await response.json() as MarketDataEnvelope<SymbolSearchResult[]>;
        if (requestId !== searchRequest.current) return;
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'Search unavailable');
        setResults(payload.data);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (requestId === searchRequest.current) {
          setResults([]); setSearchError(error instanceof Error ? error.message : 'ค้นหาไม่สำเร็จ');
        }
      } finally {
        if (requestId === searchRequest.current) setSearching(false);
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  function markPending(symbol: string, pending: boolean) {
    setPendingSymbols((current) => {
      const next = new Set(current);
      if (pending) next.add(symbol); else next.delete(symbol);
      return next;
    });
  }

  function updateQuery(value: string) {
    setQuery(value);
    if (!value.trim()) {
      searchRequest.current += 1;
      setResults([]);
      setSearchError('');
      setSearching(false);
    }
  }

  function addSymbol(
    symbol: string,
    status: SymbolSearchResult['status'] = 'active',
    searchResult?: SymbolSearchResult,
  ) {
    if (!isOnline) { addToast({ title: 'เพิ่มไม่ได้ขณะออฟไลน์', message: 'เชื่อมต่ออินเทอร์เน็ตก่อนเพื่อป้องกันข้อมูลขัดแย้ง', type: 'error' }); return; }
    if (status === 'delisted') { addToast({ title: `${symbol} ถูก delisted`, message: 'ไม่สามารถเพิ่ม Symbol นี้เป็นรายการใหม่ได้', type: 'error' }); return; }
    if (existingSymbols.has(symbol) || pendingSymbols.has(symbol)) return;
    markPending(symbol, true);
    startTransition(async () => {
      const result = await addWatchlistItemAction(symbol);
      markPending(symbol, false);
      if (!result.ok || !result.item) {
        addToast({ title: 'เพิ่มไม่สำเร็จ', message: result.ok ? undefined : result.message, type: 'error' });
        return;
      }
      setItems((current) => [result.item as WatchlistItemRecord, ...current]);
      setInstruments((current) => ({
        ...current,
        [symbol]: {
          companyName: searchResult?.name ?? symbol,
          logoUrl: null,
        },
      }));
      setQuery(''); setResults([]);
      addToast({ title: `เพิ่ม ${symbol} แล้ว`, type: 'success' });
      void requestCompanyProfile(symbol)
        .then((resource) => {
          const profile = resource.data;
          if (!profile) return;
          setInstruments((current) => ({
            ...current,
            [symbol]: {
              companyName: profile.name ?? current[symbol]?.companyName ?? symbol,
              logoUrl: profile.logoUrl ?? current[symbol]?.logoUrl ?? null,
            },
          }));
        })
        .catch(() => {
          // The new row keeps its symbol fallback if the independent logo request fails.
        });
      // Quote is independent from the persisted item. Failure only changes its display state.
      try {
        const response = await fetch(`/api/market/quote/${encodeURIComponent(symbol)}`);
        const payload = await response.json() as MarketDataEnvelope<NonNullable<WatchlistQuote['quote']>>;
        setQuotes((current) => ({ ...current, [symbol]: {
          quote: payload.data,
          freshness: payload.meta.freshness,
        } }));
      } catch {
        setQuotes((current) => ({ ...current, [symbol]: {
          quote: null, freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
        } }));
      }
    });
  }

  function removeSymbol(item: WatchlistItemRecord) {
    if (!isOnline) { addToast({ title: 'ลบไม่ได้ขณะออฟไลน์', type: 'error' }); return; }
    if (pendingSymbols.has(item.symbol)) return;
    const previousItems = items;
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    markPending(item.symbol, true);
    startTransition(async () => {
      const result = await removeWatchlistItemAction(item.symbol);
      markPending(item.symbol, false);
      if (!result.ok) {
        setItems(previousItems);
        addToast({ title: 'ลบไม่สำเร็จ', message: result.message, type: 'error' });
      } else {
        addToast({ title: `ลบ ${item.symbol} แล้ว`, type: 'success' });
      }
    });
  }

  return (
    <div className="space-y-5">
      {!isOnline && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">โหมดอ่านอย่างเดียวขณะออฟไลน์ — ราคาอาจเก่า และการเพิ่มหรือลบรายการติดตามถูกปิดไว้</div>}
      <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-4 shadow-xl sm:p-5">
        <label htmlFor="watchlist-search" className="mb-2 block text-sm font-semibold text-white">เพิ่ม Symbol</label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
          <input id="watchlist-search" value={query} onChange={(event) => updateQuery(event.target.value)}
            placeholder="ค้นหา Symbol หรือชื่อบริษัท"
            className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-950/40 pl-10 pr-12 text-base text-white placeholder:text-slate-500 focus:border-[#D4FF00] focus:outline-none" />
          {query && <button aria-label="ล้างคำค้น" onClick={() => updateQuery('')} className="absolute right-1 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-white"><X size={18} /></button>}
        </div>
        {query.trim() && (
          <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/40">
            {searching && <p className="p-4 text-sm text-slate-400">กำลังค้นหา…</p>}
            {!searching && searchError && <p className="p-4 text-sm text-amber-300">{searchError} — รายการติดตามที่บันทึกไว้ไม่ได้รับผลกระทบ</p>}
            {!searching && !searchError && results.length === 0 && <p className="p-4 text-sm text-slate-400">ไม่พบผลลัพธ์</p>}
            {!searching && results.map((result) => {
              const added = existingSymbols.has(result.symbol);
              const pending = pendingSymbols.has(result.symbol);
              return <div key={result.symbol} className="flex min-w-0 items-center gap-3 border-b border-slate-800/70 p-3 last:border-0">
                <button onClick={() => router.push(`/stock/${encodeURIComponent(result.symbol)}`)} className="min-w-0 flex-1 text-left">
                  <span className="block font-bold text-white">{result.symbol}</span>
                  <span className="block truncate text-xs text-slate-400">{result.name} · {result.exchange ?? 'ไม่ระบุตลาด'} · {result.assetType}</span>
                </button>
                {result.status === 'delisted' && <span className="rounded bg-amber-500/15 px-2 py-1 text-[10px] font-bold text-amber-300">DELISTED</span>}
                <Button size="sm" disabled={!isOnline || added || pending || result.status === 'delisted'} onClick={() => addSymbol(result.symbol, result.status, result)} className="min-w-24 shrink-0">
                  <Plus size={16} /> {result.status === 'delisted' ? 'เพิ่มไม่ได้' : added ? 'เพิ่มแล้ว' : pending ? 'กำลังเพิ่ม' : 'เพิ่ม'}
                </Button>
              </div>;
            })}
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#151B28] shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4 sm:px-5">
          <div className="min-w-0"><h2 className="truncate font-semibold text-white">{watchlist.name}</h2><p className="text-xs text-slate-500">{items.length} รายการ · ซิงก์กับบัญชีของคุณ</p></div>
          <label className="flex items-center gap-2 text-xs text-slate-400">เรียงตาม
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-white">
              <option value="newest">เพิ่มล่าสุด</option><option value="symbol">Symbol</option><option value="price">ราคา</option><option value="change">การเปลี่ยนแปลง</option>
            </select>
          </label>
        </div>
        {sortedItems.length === 0 ? <EmptyState icon={Star} title="รายการติดตามยังว่าง" description="ค้นหาและเพิ่มหุ้นที่คุณสนใจจากช่องด้านบน" /> :
          <div className="divide-y divide-slate-800/60">{sortedItems.map((item) => {
            const data = quotes[item.symbol]; const quote = data?.quote; const change = quote?.changePercent;
            const instrument = instruments[item.symbol];
            return <article key={item.id} className="flex min-w-0 items-center gap-3 p-4 hover:bg-slate-800/30 sm:px-5">
              <InstrumentLogo
                symbol={item.symbol}
                companyName={instrument?.companyName ?? item.symbol}
                logoUrl={instrument?.logoUrl ?? null}
                size={40}
                appearance="plain"
              />
              <button onClick={() => router.push(`/stock/${encodeURIComponent(item.symbol)}`)} className="min-w-0 flex-1 text-left">
                <span className="block font-bold text-white hover:text-[#D4FF00]">{item.symbol}</span>
                <span className={`block truncate text-xs ${quote ? 'text-slate-500' : 'text-amber-300'}`}>{freshnessLabel(data, renderedAt)}</span>
              </button>
              <button onClick={() => router.push(`/stock/${encodeURIComponent(item.symbol)}`)} className="shrink-0 text-right">
                <span className="block font-mono text-sm font-medium text-white">{quote ? `${quote.price.toLocaleString('th-TH', { maximumFractionDigits: 4 })}` : '—'}</span>
                <span className={`flex items-center justify-end text-xs font-bold ${change == null ? 'text-slate-500' : change >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {change != null && (change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />)}{change == null ? 'ไม่มี quote' : `${Math.abs(change).toFixed(2)}%`}
                </span>
              </button>
              <button aria-label={`ลบ ${item.symbol}`} disabled={!isOnline || pendingSymbols.has(item.symbol)} onClick={() => removeSymbol(item)} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"><Trash2 size={18} /></button>
            </article>;
          })}</div>}
      </section>
    </div>
  );
}
