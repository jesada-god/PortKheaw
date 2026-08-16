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
import { rememberInstrumentLogo } from '@/src/components/instruments/InstrumentLogoProvider';
import {
  sortWatchlistRows,
  watchlistContextLine,
  WATCHLIST_SORT_LABELS,
  type WatchlistSortKey,
} from '@/src/lib/watchlist/context';

type SortKey = WatchlistSortKey;
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
  earningsDays = {},
  renderedAt,
}: {
  watchlist: WatchlistRecord;
  initialQuotes: Record<string, WatchlistQuote>;
  initialInstruments: Record<string, WatchlistInstrument>;
  /**
   * Whole days to the next scheduled report, per symbol, from the shared
   * earnings calendar service. A symbol the calendar did not answer for is
   * simply absent — it never becomes a zero.
   */
  earningsDays?: Record<string, number>;
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
  /*
   * Sorting lives in the watchlist library, not in this component: the same
   * comparator is what the tests assert, and a row with no accepted quote sorts
   * last on every price-driven order rather than being read as zero.
   */
  const sortedItems = useMemo(() => sortWatchlistRows(
    items.map((item) => ({
      ...item,
      price: quotes[item.symbol]?.quote?.price ?? null,
      changePercent: quotes[item.symbol]?.quote?.changePercent ?? null,
    })),
    sort,
  ), [items, quotes, sort]);

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
      /*
       * The logo the action resolved and persisted while creating this row. It
       * is written straight in — the row must never be seeded with `null` and
       * then corrected, because that null is what a reader sees as "the logo
       * does not show up".
       */
      rememberInstrumentLogo(symbol, result.logoUrl);
      setInstruments((current) => ({
        ...current,
        [symbol]: {
          companyName: result.companyName ?? searchResult?.name ?? current[symbol]?.companyName ?? symbol,
          logoUrl: result.logoUrl ?? current[symbol]?.logoUrl ?? null,
        },
      }));
      setQuery(''); setResults([]);
      addToast({ title: `เพิ่ม ${symbol} แล้ว`, type: 'success' });
      /*
       * No follow-up profile request. The action that created this row already
       * resolved the identity server-side and returned it, so asking the browser
       * to fetch the same thing again only spends a request — and, whenever the
       * profile providers are unavailable, prints an error for a row that is in
       * fact complete.
       */
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
    <div className="space-y-4">
      {!isOnline && <p className="rounded-[var(--radius-control)] border border-[var(--warning-line)] bg-[var(--warning-soft)] p-3 text-sm leading-6 text-[var(--warning)]">โหมดอ่านอย่างเดียวขณะออฟไลน์ — ราคาอาจเก่า และการเพิ่มหรือลบรายการติดตามถูกปิดไว้</p>}

      {/*
        The search is a field on the page, not a panel of its own.

        It used to sit in a full card — border, surface, shadow, a bold label —
        directly above a second card holding the list, so the screen opened as
        two stacked boxes of equal weight before a single price was visible. A
        watchlist is a place for watching, so the control that adds to it stays
        one line tall and the list gets the room.
      */}
      <div>
        <label htmlFor="watchlist-search" className="sr-only">เพิ่ม Symbol ในรายการติดตาม</label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={18} />
          <input id="watchlist-search" value={query} onChange={(event) => updateQuery(event.target.value)}
            placeholder="ค้นหา Symbol หรือชื่อบริษัทเพื่อเพิ่ม"
            className="min-h-12 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--input-bg)] pl-10 pr-12 text-base text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none" />
          {query && <button aria-label="ล้างคำค้น" onClick={() => updateQuery('')} className="absolute right-1 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text)]"><X size={18} /></button>}
        </div>
        {query.trim() && (
          <div className="panel mt-2 max-h-72 overflow-y-auto">
            {searching && <p className="p-4 text-sm text-[var(--text-muted)]">กำลังค้นหา…</p>}
            {!searching && searchError && <p className="p-4 text-sm text-[var(--warning)]">{searchError} — รายการติดตามที่บันทึกไว้ไม่ได้รับผลกระทบ</p>}
            {!searching && !searchError && results.length === 0 && <p className="p-4 text-sm text-[var(--text-muted)]">ไม่พบผลลัพธ์</p>}
            {!searching && results.map((result) => {
              const added = existingSymbols.has(result.symbol);
              const pending = pendingSymbols.has(result.symbol);
              return <div key={result.symbol} className="flex min-w-0 items-center gap-3 border-b border-[var(--hairline)] p-3 last:border-0">
                <button onClick={() => router.push(`/stock/${encodeURIComponent(result.symbol)}`)} className="min-w-0 flex-1 text-left">
                  <span className="block font-bold text-[var(--text)]">{result.symbol}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{result.name} · {result.exchange ?? 'ไม่ระบุตลาด'} · {result.assetType}</span>
                </button>
                {result.status === 'delisted' && <span className="rounded-[var(--radius-mark)] bg-[var(--warning-soft)] px-2 py-1 text-[10px] font-bold text-[var(--warning)]">DELISTED</span>}
                <Button size="sm" disabled={!isOnline || added || pending || result.status === 'delisted'} onClick={() => addSymbol(result.symbol, result.status, result)} className="min-w-24 shrink-0">
                  <Plus size={16} /> {result.status === 'delisted' ? 'เพิ่มไม่ได้' : added ? 'เพิ่มแล้ว' : pending ? 'กำลังเพิ่ม' : 'เพิ่ม'}
                </Button>
              </div>;
            })}
          </div>
        )}
      </div>

      <section className="panel min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-3.5 py-3 sm:px-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-[var(--text)]">{watchlist.name}</h2>
            <p className="text-xs text-[var(--text-muted)]">{items.length} รายการ · ซิงก์กับบัญชีของคุณ</p>
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">เรียงตาม
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="เรียงรายการติดตาม" data-testid="watchlist-sort" className="min-h-11 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-sm text-[var(--text)]">
              {(['change', 'symbol', 'newest', 'price'] as const).map((key) =>
                <option key={key} value={key}>{WATCHLIST_SORT_LABELS[key]}</option>)}
            </select>
          </label>
        </div>
        {/*
          The one Kheaw on this screen, and only in this state. An untouched
          watchlist is a beginning — the reader has arrived somewhere they have
          not used yet — which is exactly the moment the mascot is for. The
          "no rows matched your filter" case a few lines down deliberately keeps
          plain text: that is a blank, not a beginning.
        */}
        {sortedItems.length === 0 ? <EmptyState mascot icon={Star} title="รายการติดตามยังว่าง" description="ค้นหาและเพิ่มหุ้นที่คุณสนใจจากช่องด้านบน" /> :
          /*
            Denser than the overview's version of the same list, because this is
            the screen somebody opens to compare a dozen symbols rather than to
            glance at three. The price column is fixed-width and tabular, so the
            decimal points line up down the page and a column of percentages can
            be read as a column.
          */
          <ul className="divide-y divide-[var(--hairline)]">{sortedItems.map((item) => {
            const data = quotes[item.symbol]; const quote = data?.quote; const change = quote?.changePercent;
            const instrument = instruments[item.symbol];
            const context = watchlistContextLine({
              changePercent: change ?? null,
              earningsDays: earningsDays[item.symbol] ?? null,
            });
            return <li key={item.id}><article className="flex min-w-0 items-center gap-3 px-3.5 py-2.5 hover:bg-[var(--surface-hover)] sm:px-4">
              <InstrumentLogo
                symbol={item.symbol}
                companyName={instrument?.companyName ?? item.symbol}
                logoUrl={instrument?.logoUrl ?? null}
                size={36}
                appearance="plain"
              />
              <button onClick={() => router.push(`/stock/${encodeURIComponent(item.symbol)}`)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-sm font-bold tracking-tight text-[var(--text)] hover:text-[var(--accent)]">{item.symbol}</span>
                {/*
                  One line of context, no new columns: today's accepted change,
                  a plain note when that move was large, and the calendar's own
                  day count when a report is close. Absent whenever none of the
                  three has real data behind it.
                */}
                {context && <span className="block truncate text-xs text-[var(--text-secondary)]" data-testid={`watchlist-context-${item.symbol}`}>{context}</span>}
                <span className={`block truncate text-[11px] ${quote ? 'text-[var(--text-muted)]' : 'text-[var(--warning)]'}`}>{freshnessLabel(data, renderedAt)}</span>
              </button>
              <button onClick={() => router.push(`/stock/${encodeURIComponent(item.symbol)}`)} className="shrink-0 text-right">
                <span className="figure-data block text-[var(--text)]">{quote ? `${quote.price.toLocaleString('th-TH', { maximumFractionDigits: 4 })}` : '—'}</span>
                <span className={`figure flex items-center justify-end text-xs font-bold ${change == null ? 'text-[var(--text-muted)]' : change >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
                  {change != null && (change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />)}{change == null ? 'ไม่มี quote' : `${Math.abs(change).toFixed(2)}%`}
                </span>
              </button>
              <button aria-label={`ลบ ${item.symbol}`} disabled={!isOnline || pendingSymbols.has(item.symbol)} onClick={() => removeSymbol(item)} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-muted)] hover:bg-[var(--negative-soft)] hover:text-[var(--negative)] disabled:opacity-40"><Trash2 size={18} /></button>
            </article></li>;
          })}</ul>}
      </section>
    </div>
  );
}
