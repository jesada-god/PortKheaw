'use client';

import { useEffect, useRef, useState } from 'react';
import { History, Plus, Search, Star, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Tabs } from '@/src/components/ui/Tabs';
import { useToast } from '@/src/components/ui/Toast';
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

export function SearchClient({ watchedSymbols }: { watchedSymbols: readonly string[] }) {
  const router = useRouter();
  const { recentSearches, addRecentSearch, clearRecentSearches } = useStore();
  const { addToast } = useToast();
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState('ALL');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [prices, setPrices] = useState<Record<string, Quote>>({});
  const [watched, setWatched] = useState<Set<string>>(() => new Set(watchedSymbols));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) return;
    const current = ++requestId.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError('');
      const assetType = activeTab === 'STOCKS' ? '&assetType=Stock' : activeTab === 'ETFS' ? '&assetType=ETF' : '';
      try {
        const response = await fetch(`/api/market/search?q=${encodeURIComponent(normalized)}${assetType}&includeDelisted=true&limit=20`, { signal: controller.signal });
        const payload = await response.json() as MarketDataEnvelope<SymbolSearchResult[]>;
        if (current !== requestId.current) return;
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'Search unavailable');
        setResults(payload.data);
        void loadPrices(payload.data.slice(0, PRICED_RESULT_LIMIT), current, controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted && current === requestId.current) { setResults([]); setError(cause instanceof Error ? cause.message : 'ค้นหาไม่สำเร็จ'); }
      } finally { if (current === requestId.current) setLoading(false); }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, activeTab]);

  function openSymbol(symbol: string) { addRecentSearch(symbol); router.push(`/stock/${encodeURIComponent(symbol)}`); }

  function updateQuery(value: string) {
    setQuery(value);
    if (!value.trim()) { requestId.current += 1; setResults([]); setLoading(false); setError(''); }
  }

  async function addToWatchlist(event: React.MouseEvent, result: SymbolSearchResult) {
    event.stopPropagation();
    if (!isOnline) { addToast({ title: 'เพิ่มรายการติดตามไม่ได้ขณะออฟไลน์', type: 'error' }); return; }
    if (result.status === 'delisted') { addToast({ title: `${result.symbol} ถูก delisted`, message: 'ไม่สามารถเพิ่ม Symbol นี้เป็นรายการใหม่ได้', type: 'error' }); return; }
    const response = await addWatchlistItemAction(result.symbol);
    if (response.ok) setWatched((current) => new Set(current).add(result.symbol));
    addToast(response.ok
      ? { title: `เพิ่ม ${result.symbol} เข้ารายการติดตามแล้ว`, type: 'success' }
      : { title: 'เพิ่มไม่สำเร็จ', message: response.message, type: 'error' });
  }

  return <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
    <div className="relative">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={20} />
      <input value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="ค้นหา Symbol หรือชื่อบริษัท" autoFocus
        aria-label="ค้นหา Symbol หรือชื่อบริษัท"
        className="w-full rounded-xl border border-slate-700 bg-[#151B28] py-4 pl-12 pr-12 text-lg text-white placeholder:text-slate-500 focus:border-[#D4FF00] focus:outline-none focus:ring-1 focus:ring-[#D4FF00]/50" />
      {query && <button aria-label="ล้างคำค้น" onClick={() => updateQuery('')} className="absolute right-3 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center text-slate-500 hover:text-white"><X size={16} /></button>}
    </div>
    <Tabs tabs={['ALL', 'STOCKS', 'ETFS']} activeTab={activeTab} onChange={setActiveTab} />
    {query.trim() ? <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[#151B28] shadow-xl">
      {loading && <p className="p-6 text-sm text-slate-400">กำลังค้นหา…</p>}
      {!loading && error && <p className="p-6 text-sm text-amber-300">{error}</p>}
      {!loading && !error && results.length === 0 && <p className="p-8 text-center text-slate-500">ไม่พบข้อมูลสำหรับ &quot;{query}&quot;</p>}
      {!loading && results.map((result) => {
        const quote = prices[result.symbol];
        const inList = watched.has(result.symbol);
        return <button
          key={`${result.symbol}-${result.exchange ?? ''}`}
          onClick={() => openSymbol(result.symbol)}
          data-testid={`search-result-${result.symbol}`}
          className="flex min-h-16 w-full items-center gap-3 border-b border-slate-800/50 p-4 text-left last:border-0 hover:bg-slate-800/50"
        >
          <InstrumentLogo symbol={result.symbol} companyName={result.name} logoUrl={result.logoUrl ?? null} size={40} />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-bold text-white">{result.symbol}</span>
              {inList && <Star aria-label="อยู่ในรายการติดตามแล้ว" size={13} className="shrink-0 text-[#D4FF00]" fill="currentColor" />}
            </span>
            <span className="block truncate text-sm text-slate-200">{result.name}</span>
            <span className="block truncate text-xs text-slate-500">{result.assetType}{result.exchange ? ` · ${result.exchange}` : ''}</span>
          </span>
          {quote && <span className="shrink-0 text-right font-mono text-sm text-white" data-testid={`search-price-${result.symbol}`}>{formatPrice(quote)}</span>}
          {result.status === 'delisted' && <span className="shrink-0 rounded bg-amber-500/15 px-2 py-1 text-[10px] font-bold text-amber-300">DELISTED</span>}
          <span role="button" aria-label={`เพิ่ม ${result.symbol} เข้ารายการติดตาม`} aria-disabled={!isOnline || inList || result.status === 'delisted'} onClick={(event) => void addToWatchlist(event, result)} className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full ${!isOnline || inList || result.status === 'delisted' ? 'cursor-not-allowed text-slate-700' : 'text-slate-500 hover:bg-[#D4FF00]/10 hover:text-[#D4FF00]'}`}><Plus size={20} /></span>
        </button>;
      })}
    </div> : <div className="rounded-2xl border border-slate-800 bg-[#151B28] p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-white"><History size={16} className="text-slate-400" /> ค้นหาล่าสุด</h2>
        {recentSearches.length > 0 && <button onClick={clearRecentSearches} className="min-h-11 text-xs text-slate-500 hover:text-white">ล้างประวัติ</button>}
      </div>
      {recentSearches.length
        ? <div className="flex flex-wrap gap-2">{recentSearches.map((term) => <button key={term} onClick={() => updateQuery(term)} className="min-h-11 rounded-lg bg-slate-800 px-3 text-xs text-slate-300 hover:bg-slate-700">{term}</button>)}</div>
        : <p className="text-sm text-slate-500">ไม่มีประวัติการค้นหา</p>}
    </div>}
  </div>;
}
