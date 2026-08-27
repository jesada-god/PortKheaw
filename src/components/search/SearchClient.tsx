'use client';

import { useEffect, useRef, useState } from 'react';
import { History, Plus, Search, Star, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Tabs } from '@/src/components/ui/Tabs';
import { useToast } from '@/src/components/ui/Toast';
import { DataState, reportDataError, type DataStateKind } from '@/src/components/ui/DataState';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { StatusLabel } from '@/src/components/ui/StatusLabel';
import { statusFromChangePercent } from '@/src/lib/presentation/status';
import { useStore } from '@/src/store/useStore';
import type { MarketDataEnvelope, Quote, SymbolSearchResult } from '@/src/lib/market-data/types';
import { addWatchlistItemAction } from '@/app/watchlist/actions';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';

/**
 * How many results are worth a price.
 *
 * Search is a navigation tool, so a row earns exactly enough to be recognised:
 * a logo, a symbol, a name, what kind of instrument it is, and what it costs.
 * The price is the only part that is not already in the search response, so it
 * is fetched for the first few rows only — twenty quotes a keystroke is not a
 * request budget anybody has, which is why the search endpoint never returned
 * prices in the first place.
 */
const PRICED_RESULT_LIMIT = 6;

function formatPrice(quote: Quote): string {
  return `${quote.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${quote.currency ? ` ${quote.currency}` : ''}`;
}

function formatChangePercent(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/**
 * Six rows of the shape the results have.
 *
 * The panel used to say "กำลังค้นหา…" in the space the rows would occupy, which
 * meant the height of the panel changed the moment anything arrived and the
 * whole page under it moved. A skeleton at the row's real proportions — logo,
 * two lines of text, a price — holds the space it is about to hand over.
 */
function ResultsSkeleton() {
  return (
    <div className="divide-y divide-[var(--hairline)]">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="flex min-h-16 items-center gap-3 p-4">
          <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3 w-40 max-w-full" />
          </div>
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function SearchClient({ watchedSymbols }: { watchedSymbols: readonly string[] }) {
  const router = useRouter();
  const { recentSearches, addRecentSearch, clearRecentSearches } = useStore();
  const { addToast } = useToast();
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState('ALL');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [prices, setPrices] = useState<Record<string, Quote>>({});
  const [watched, setWatched] = useState<Set<string>>(() => new Set(watchedSymbols));
  /*
   * ONE state field, not a `loading` boolean beside an `error` string.
   *
   * The two used to be separate, and every render had to answer "loading and
   * also errored?" — a combination the panel had no design for and which the
   * abort path could produce. A single value cannot hold two answers at once.
   */
  const [state, setState] = useState<DataStateKind>('ready');
  const requestId = useRef(0);
  const isOnline = useOnlineStatus();

  /*
   * Prices arrive after the rows, never in front of them: a row is useful the
   * moment it can be tapped, and a quote that fails or is still in flight leaves
   * the row exactly as it was rather than blocking or erroring the whole list.
   */
  async function loadPrices(subset: SymbolSearchResult[], current: number, signal: AbortSignal) {
    for (const result of subset) {
      if (current !== requestId.current || signal.aborted) return;
      try {
        const response = await fetch(`/api/market/quote/${encodeURIComponent(result.symbol)}`, { signal });
        const payload = await response.json() as MarketDataEnvelope<Quote>;
        if (current !== requestId.current || !response.ok || !payload.data) continue;
        setPrices((existing) => ({ ...existing, [result.symbol]: payload.data! }));
      } catch {
        // A missing price is a missing price. The row stays navigable.
      }
    }
  }

  async function runSearch(normalized: string, current: number, signal: AbortSignal) {
    setState('loading');
    const assetType = activeTab === 'STOCKS' ? '&assetType=Stock' : activeTab === 'ETFS' ? '&assetType=ETF' : '';
    try {
      const response = await fetch(`/api/market/search?q=${encodeURIComponent(normalized)}${assetType}&includeDelisted=true&limit=20`, { signal });
      const payload = await response.json() as MarketDataEnvelope<SymbolSearchResult[]>;
      if (current !== requestId.current) return;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'search failed');
      setResults(payload.data);
      setState(payload.data.length === 0 ? 'empty' : 'ready');
      void loadPrices(payload.data.slice(0, PRICED_RESULT_LIMIT), current, signal);
    } catch (cause) {
      if (signal.aborted || current !== requestId.current) return;
      /*
       * The provider's sentence goes to the console and no further. This panel
       * used to print `payload.error.message` directly — an endpoint, a status
       * line, occasionally a provider slug — none of which a reader can act on.
       */
      reportDataError('search', cause);
      setResults([]);
      setState('error');
    }
  }

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) return;
    const current = ++requestId.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void runSearch(normalized, current, controller.signal), 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeTab]);

  function retry() {
    const normalized = query.trim();
    if (!normalized) return;
    const current = ++requestId.current;
    void runSearch(normalized, current, new AbortController().signal);
  }

  function openSymbol(symbol: string) { addRecentSearch(symbol); router.push(`/stock/${encodeURIComponent(symbol)}`); }

  function updateQuery(value: string) {
    setQuery(value);
    if (!value.trim()) { requestId.current += 1; setResults([]); setState('ready'); }
  }

  async function addToWatchlist(event: React.MouseEvent, result: SymbolSearchResult) {
    event.stopPropagation();
    if (!isOnline) { addToast({ title: 'เพิ่มรายการติดตามไม่ได้ขณะออฟไลน์', type: 'error' }); return; }
    if (result.status === 'delisted') { addToast({ title: `${result.symbol} เลิกซื้อขายแล้ว`, message: 'ไม่สามารถเพิ่ม Symbol นี้เป็นรายการใหม่ได้', type: 'error' }); return; }
    const response = await addWatchlistItemAction(result.symbol);
    if (response.ok) setWatched((current) => new Set(current).add(result.symbol));
    addToast(response.ok
      ? { title: `เพิ่ม ${result.symbol} เข้ารายการติดตามแล้ว`, type: 'success' }
      : { title: 'เพิ่มไม่สำเร็จ', message: response.message, type: 'error' });
  }

  return <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
    <div className="relative">
      <Search aria-hidden="true" className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" size={20} />
      <input value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="ค้นหา Symbol หรือชื่อบริษัท" autoFocus
        aria-label="ค้นหา Symbol หรือชื่อบริษัท"
        className="w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--input-bg)] py-4 pl-12 pr-12 text-lg text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]" />
      {query && <button aria-label="ล้างคำค้น" onClick={() => updateQuery('')} className="absolute right-3 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]"><X aria-hidden="true" size={16} /></button>}
    </div>
    <Tabs tabs={['ALL', 'STOCKS', 'ETFS']} activeTab={activeTab} onChange={setActiveTab} />
    {query.trim() ? <div className="panel min-w-0 overflow-hidden">
      <DataState
        state={state}
        onRetry={retry}
        skeleton={<ResultsSkeleton />}
        emptyMessage={`ไม่พบหุ้นที่ตรงกับ “${query.trim()}”`}
      >
        {results.map((result) => {
          const quote = prices[result.symbol];
          const inList = watched.has(result.symbol);
          const changePercent = quote?.changePercent ?? null;
          return <button
            key={`${result.symbol}-${result.exchange ?? ''}`}
            onClick={() => openSymbol(result.symbol)}
            data-testid={`search-result-${result.symbol}`}
            className="flex min-h-16 w-full items-center gap-3 border-b border-[var(--hairline)] p-4 text-left last:border-0 hover:bg-[var(--surface-hover)]"
          >
            <InstrumentLogo symbol={result.symbol} companyName={result.name} logoUrl={result.logoUrl ?? null} size={40} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-bold text-[var(--text)]">{result.symbol}</span>
                {inList && <Star aria-label="อยู่ในรายการติดตามแล้ว" size={13} className="shrink-0 text-[var(--accent)]" fill="currentColor" />}
              </span>
              <span className="block truncate text-sm text-[var(--text-secondary)]">{result.name}</span>
              <span className="block truncate text-xs text-[var(--text-muted)]">{result.assetType}{result.exchange ? ` · ${result.exchange}` : ''}</span>
            </span>
            {quote && (
              <span className="shrink-0 text-right" data-testid={`search-price-${result.symbol}`}>
                <span className="block font-mono text-sm text-[var(--text)]">{formatPrice(quote)}</span>
                {/*
                  The day's move, on the same five-level scale the watchlist and
                  the stock page use. A row whose quote arrived without a
                  percentage shows the price alone rather than a ⚪ that would
                  claim the engine had a reading it does not.
                */}
                {changePercent !== null && Number.isFinite(changePercent) && (
                  <StatusLabel
                    level={statusFromChangePercent(changePercent)}
                    label={formatChangePercent(changePercent)}
                    className="justify-end text-xs"
                  />
                )}
              </span>
            )}
            {result.status === 'delisted' && (
              <span className="shrink-0 rounded-[var(--radius-mark)] border border-[var(--caution-line)] bg-[var(--caution-soft)] px-2 py-1 text-[10px] font-bold text-[var(--caution)]">
                เลิกซื้อขายแล้ว
              </span>
            )}
            <span role="button" aria-label={`เพิ่ม ${result.symbol} เข้ารายการติดตาม`} aria-disabled={!isOnline || inList || result.status === 'delisted'} onClick={(event) => void addToWatchlist(event, result)} className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full ${!isOnline || inList || result.status === 'delisted' ? 'cursor-not-allowed text-[var(--text-muted)] opacity-50' : 'text-[var(--text-muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]'}`}><Plus aria-hidden="true" size={20} /></span>
          </button>;
        })}
      </DataState>
    </div> : <div className="panel min-w-0 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-[var(--text)]"><History aria-hidden="true" size={16} className="text-[var(--text-muted)]" /> ค้นหาล่าสุด</h2>
        {recentSearches.length > 0 && <button onClick={clearRecentSearches} className="min-h-11 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">ล้างประวัติ</button>}
      </div>
      {recentSearches.length
        ? <div className="flex flex-wrap gap-2">{recentSearches.map((term) => <button key={term} onClick={() => updateQuery(term)} className="min-h-11 rounded-[var(--radius-control)] bg-[var(--surface-elevated)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">{term}</button>)}</div>
        : <p className="text-sm text-[var(--text-muted)]">ไม่มีประวัติการค้นหา</p>}
    </div>}
  </div>;
}
