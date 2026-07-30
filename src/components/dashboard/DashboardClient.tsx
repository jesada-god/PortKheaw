'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowDownRight, ArrowUpRight, Eye, EyeOff, Newspaper, Star } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import type { DataFreshness, MarketOverview, Quote } from '@/src/lib/market-data/types';
import type { PortfolioSummary } from '@/src/lib/portfolio/types';
import type { WatchlistItemRecord } from '@/src/lib/watchlist/types';
import {
  marketStatusReasonMessage,
  type MarketStatusUnavailableReason,
} from '@/src/lib/market-data/market-status';
import {
  formatBangkokDateTime,
  isStaleAt,
} from '@/src/lib/presentation/datetime';
import { useStore } from '@/src/store/useStore';
const NewsFeed = dynamic(() => import('@/src/components/news/NewsFeed').then((m) => m.NewsFeed), { ssr: false, loading: () => <div className="h-64 animate-pulse rounded-xl bg-slate-800/50" /> });
export interface DashboardData { summary: PortfolioSummary | null; baseCurrency: 'USD' | 'THB'; usdThbRate: string | null; watchlist: WatchlistItemRecord[]; quotes: Record<string, { quote: Quote | null; freshness: DataFreshness }>; overview: MarketOverview | null; overviewFreshness: DataFreshness; providerConfigured: boolean; marketStatusReason: MarketStatusUnavailableReason | null; timestamp: string; }
function money(value: number | null, currency: string) { return value == null ? '—' : new Intl.NumberFormat('th-TH', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
function freshness(value: DataFreshness, referenceTime: string) { const stale = value.status === 'stale' || isStaleAt(value.asOf, value.maxAgeSeconds, referenceTime); const label = stale ? 'stale' : value.status === 'realtime' ? 'live' : value.status; return value.asOf ? `${label} · ${formatBangkokDateTime(value.asOf)}` : label; }
export function DashboardClient({ data }: { data: DashboardData }) {
  const privacyMode = useStore((state) => state.privacyMode); const setPrivacyMode = useStore((state) => state.setPrivacyMode); const visible = !privacyMode; const market = data.overview?.markets.find((item) => item.currentStatus === 'open') ?? data.overview?.markets[0];
  const updated = formatBangkokDateTime(data.overviewFreshness.asOf ?? data.timestamp);
  const marketUnavailableMessage = marketStatusReasonMessage(data.marketStatusReason ?? 'unknown');
  const rate = data.baseCurrency === 'THB' ? Number(data.usdThbRate) : 1;
  const converted = (amount: number | null | undefined) => amount == null || !Number.isFinite(rate) || rate <= 0 ? null : amount * rate;
  return <div><Header title="แดชบอร์ดหลัก" status={{ text: market ? `${market.region}: ${market.currentStatus}` : marketUnavailableMessage, indicator: market?.currentStatus === 'open' ? 'green' : 'yellow' }}/><div className="space-y-6 p-4 md:p-8">
    <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#151B28] px-4 py-3"><div><p className="text-sm font-semibold text-white">{market ? `${market.marketType} · ${market.region}` : marketUnavailableMessage}</p><p className="text-xs text-slate-500">อัปเดต {updated}</p></div><span className="rounded-full border border-slate-700 px-2 py-1 text-[10px] uppercase text-slate-300">{freshness(data.overviewFreshness, data.timestamp)}</span></section>
    <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5 shadow-xl"><div className="flex items-start justify-between"><div><p className="text-xs uppercase tracking-widest text-slate-400">Portfolio Value ({data.baseCurrency})</p><p className="mt-2 break-all font-mono text-3xl font-bold text-white md:text-4xl">{visible ? money(converted(data.summary?.totalValue), data.baseCurrency) : '••••••'}</p><p className={`mt-2 text-sm ${(data.summary?.todayChange ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{data.summary ? visible ? data.summary.todayChange == null || data.summary.todayChangePercent == null ? '— วันนี้' : `${data.summary.todayChange >= 0 ? '+' : ''}${money(converted(data.summary.todayChange), data.baseCurrency)} (${data.summary.todayChangePercent.toFixed(2)}%) วันนี้` : '•••••• (••••) วันนี้' : 'ยังไม่มีข้อมูลพอร์ต'}</p></div><button aria-label="แสดงหรือซ่อนยอดเงิน" onClick={() => setPrivacyMode(visible)} className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-400">{visible ? <EyeOff/> : <Eye/>}</button></div><Link href="/portfolio" className="mt-5 inline-flex min-h-11 items-center rounded-full bg-[#D4FF00] px-5 text-sm font-bold text-black">จัดการพอร์ต</Link></section>
    <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5"><div className="mb-4 flex items-center justify-between"><h2 className="font-bold text-white">Watchlist</h2><Link href="/watchlist" className="text-xs text-[#D4FF00]">ดูทั้งหมด</Link></div>{data.watchlist.length === 0 ? <div className="py-8 text-center"><Star className="mx-auto mb-2 text-slate-600"/><p className="text-sm text-slate-400">Watchlist ยังว่าง</p></div> : <div className="divide-y divide-slate-800">{data.watchlist.slice(0, 5).map((item) => { const quote = data.quotes[item.symbol]?.quote; const change = quote?.changePercent; return <Link key={item.id} href={`/stock/${encodeURIComponent(item.symbol)}`} className="flex min-h-16 items-center justify-between py-2"><div><p className="font-bold text-white">{item.symbol}</p><p className="text-[10px] text-slate-500">{freshness(data.quotes[item.symbol]?.freshness ?? unavailableFreshness, data.timestamp)}</p></div><div className="text-right"><p className="font-mono text-white">{quote?.price?.toLocaleString('th-TH') ?? '—'}</p><p className={`flex items-center justify-end text-xs ${change == null ? 'text-slate-500' : change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{change == null ? '—' : <>{change >= 0 ? <ArrowUpRight size={13}/> : <ArrowDownRight size={13}/>} {Math.abs(change).toFixed(2)}%</>}</p></div></Link>; })}</div>}</section>
    <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5"><h2 className="mb-4 font-bold text-white">Market overview</h2>{!data.overview ? <p className="py-8 text-center text-sm text-slate-400">{marketUnavailableMessage}</p> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.overview.markets.map((item, index) => <div key={`${item.region}-${index}`} className="rounded-xl border border-slate-800 bg-slate-900/30 p-3"><div className="flex justify-between"><p className="font-semibold text-white">{item.region}</p><span className={item.currentStatus === 'open' ? 'text-emerald-400' : 'text-slate-500'}>{item.currentStatus}</span></div><p className="mt-1 text-xs text-slate-500">{item.primaryExchanges.join(', ') || '—'} · {item.localOpen ?? '—'}–{item.localClose ?? '—'}</p></div>)}</div>}</section>
    <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5"><h2 className="font-bold text-white">Top Movers</h2><p className="mt-3 text-sm text-slate-400">Provider ปัจจุบันไม่รองรับ Movers endpoint</p></section>
    <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5"><div className="mb-4 flex items-center gap-2"><Newspaper size={18}/><h2 className="font-bold text-white">Market News</h2></div><NewsFeed /></section>
  </div></div>;
}
const unavailableFreshness: DataFreshness = { status: 'unavailable', asOf: null, maxAgeSeconds: null };
