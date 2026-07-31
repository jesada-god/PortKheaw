'use client';

import { useEffect, useRef, useState } from 'react';
import { History, Plus, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { Tabs } from '@/src/components/ui/Tabs';
import { useToast } from '@/src/components/ui/Toast';
import { useStore } from '@/src/store/useStore';
import type { MarketDataEnvelope, SymbolSearchResult } from '@/src/lib/market-data/types';
import { addWatchlistItemAction } from '@/app/watchlist/actions';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';

export default function SearchPage() {
  const router = useRouter();
  const { recentSearches, addRecentSearch, clearRecentSearches } = useStore();
  const { addToast } = useToast();
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState('ALL');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const isOnline = useOnlineStatus();

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
    if (!isOnline) { addToast({ title: 'เพิ่ม Watchlist ไม่ได้ขณะออฟไลน์', type: 'error' }); return; }
    if (result.status === 'delisted') { addToast({ title: `${result.symbol} ถูก delisted`, message: 'ไม่สามารถเพิ่ม Symbol นี้เป็นรายการใหม่ได้', type: 'error' }); return; }
    const response = await addWatchlistItemAction(result.symbol);
    addToast(response.ok
      ? { title: `เพิ่ม ${result.symbol} เข้า Watchlist แล้ว`, type: 'success' }
      : { title: 'เพิ่มไม่สำเร็จ', message: response.message, type: 'error' });
  }

  return <div><Header title="ค้นหา (Search)" /><div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
    <div className="relative"><Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={20} />
      <input value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="ค้นหา Symbol หรือชื่อบริษัท" autoFocus
        className="w-full rounded-xl border border-slate-700 bg-[#151B28] py-4 pl-12 pr-12 text-lg text-white placeholder:text-slate-500 focus:border-[#D4FF00] focus:outline-none focus:ring-1 focus:ring-[#D4FF00]/50" />
      {query && <button aria-label="ล้างคำค้น" onClick={() => updateQuery('')} className="absolute right-3 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center text-slate-500 hover:text-white"><X size={16} /></button>}
    </div>
    <Tabs tabs={['ALL', 'STOCKS', 'ETFS']} activeTab={activeTab} onChange={setActiveTab} />
    {query.trim() ? <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[#151B28] shadow-xl">
      {loading && <p className="p-6 text-sm text-slate-400">กำลังค้นหา…</p>}
      {!loading && error && <p className="p-6 text-sm text-amber-300">{error}</p>}
      {!loading && !error && results.length === 0 && <p className="p-8 text-center text-slate-500">ไม่พบข้อมูลสำหรับ &quot;{query}&quot;</p>}
      {!loading && results.map((result) => <button key={`${result.symbol}-${result.exchange ?? ''}`} onClick={() => openSymbol(result.symbol)} className="flex min-h-16 w-full items-center gap-3 border-b border-slate-800/50 p-4 text-left last:border-0 hover:bg-slate-800/50">
        <InstrumentLogo symbol={result.symbol} companyName={result.name} logoUrl={null} size={40} />
        <span className="w-20 shrink-0 font-bold text-white">{result.symbol}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm text-slate-200">{result.name}</span><span className="block truncate text-xs text-slate-500">{result.exchange ?? 'ไม่ระบุตลาด'} · {result.assetType} · {result.currency ?? 'USD'}</span></span>
        {result.status === 'delisted' && <span className="rounded bg-amber-500/15 px-2 py-1 text-[10px] font-bold text-amber-300">DELISTED</span>}
        <span role="button" aria-label={`เพิ่ม ${result.symbol} เข้า Watchlist`} aria-disabled={!isOnline || result.status === 'delisted'} onClick={(event) => void addToWatchlist(event, result)} className={`flex min-h-11 min-w-11 items-center justify-center rounded-full ${!isOnline || result.status === 'delisted' ? 'cursor-not-allowed text-slate-700' : 'text-slate-500 hover:bg-[#D4FF00]/10 hover:text-[#D4FF00]'}`}><Plus size={20} /></span>
      </button>)}
    </div> : <div className="rounded-2xl border border-slate-800 bg-[#151B28] p-6"><div className="mb-4 flex items-center justify-between"><h3 className="flex items-center gap-2 font-semibold text-white"><History size={16} className="text-slate-400" /> Recent Searches</h3>{recentSearches.length > 0 && <button onClick={clearRecentSearches} className="text-xs text-slate-500 hover:text-white">Clear</button>}</div>
      {recentSearches.length ? <div className="flex flex-wrap gap-2">{recentSearches.map((term) => <button key={term} onClick={() => updateQuery(term)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700">{term}</button>)}</div> : <p className="text-sm text-slate-500">ไม่มีประวัติการค้นหา</p>}
    </div>}
  </div></div>;
}
