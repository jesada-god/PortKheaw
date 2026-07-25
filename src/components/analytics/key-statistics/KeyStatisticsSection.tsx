'use client';
import { useEffect, useState } from 'react';
import type { KeyStatisticsResult, MetricResult } from '@/src/lib/analytics/fundamentals/types';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';

function display(metric: MetricResult | undefined) {
  if (!metric) return { value: 'Unavailable', reason: 'ยังไม่ได้รับข้อมูลจาก server' };
  if (metric.status === 'unavailable') return { value: 'Unavailable', reason: metric.reason };
  if (metric.status === 'not-meaningful') return { value: 'Not meaningful', reason: metric.reason };
  if (!('value' in metric)) return { value: 'Unavailable', reason: metric.reason };
  return { value: `${metric.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${metric.unit === 'x' ? '×' : metric.unit === '%' ? '%' : ''}`, reason: metric.limitations.join(' ') };
}

const primary = [{ key: 'trailingPe', label: 'P/E Ratio' }, { key: 'marketCap', label: 'Market Cap' }, { key: 'currentVolume', label: 'Volume' }, { key: 'putCallVolume', label: 'Put/Call Ratio' }];
export function KeyStatisticsSection({ symbol }: { symbol: string }) {
  const [data, setData] = useState<KeyStatisticsResult | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); void fetch(`/api/analytics/key-statistics/${encodeURIComponent(symbol)}`, { signal: controller.signal }).then(async (response) => { if (!response.ok) throw new Error(response.status === 404 ? 'ฟีเจอร์ถูกปิด' : 'โหลด Key Statistics ไม่สำเร็จ'); return response.json(); }).then((body) => setData(body.data)).catch((cause) => { if (cause instanceof Error && cause.name !== 'AbortError') setError(cause.message); }); return () => controller.abort(); }, [symbol]);
  if (error) return <p className="rounded-xl border border-amber-500/20 p-4 text-sm text-amber-300">Key Statistics: {error}</p>;
  if (!data) return <div className="h-28 animate-pulse rounded-xl bg-slate-800/50" aria-label="กำลังโหลด Key Statistics"/>;
  return <section aria-label="Key Statistics" className="space-y-3"><h2 className="font-bold text-white">Key Statistics</h2><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{primary.map(({ key, label }) => { const metric = data.metrics[key]; const shown = display(metric); return <article key={key} className="rounded-xl border border-slate-800 bg-[#151B28] p-3"><p className="text-[10px] uppercase text-slate-500">{label}</p><p className="mt-2 font-mono text-sm text-white">{shown.value}</p><p className="mt-1 text-[10px] text-slate-500">{metric?.sourceType ?? 'provider-supplied'} · {metric?.asOf ? formatMarketDataAsOf(metric.asOf, { dateOnly: metric.freshness.status === 'end-of-day' }) : 'ไม่มี timestamp'}</p>{shown.reason && <details className="mt-2 text-xs text-slate-400"><summary className="cursor-pointer">ค่านี้คืออะไร / ข้อจำกัด</summary><p className="mt-1">{shown.reason}</p><p>{metric?.methodology}</p><p>Source: {metric?.source ?? 'unavailable'} · Freshness: {metric?.freshness.status ?? 'unavailable'}</p></details>}</article>; })}</div><details className="rounded-xl border border-slate-800 bg-[#151B28] p-3"><summary className="cursor-pointer text-sm text-slate-300">ดูทั้งหมด</summary><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(data.metrics).filter(([key]) => !primary.some((item) => item.key === key)).map(([key, metric]) => { const shown = display(metric); return <div key={key} className="rounded-lg border border-slate-800 p-3"><p className="text-xs text-slate-500">{key}</p><p className="mt-1 text-sm text-white">{shown.value}</p><p className="mt-1 text-xs text-slate-500">{shown.reason}</p></div>; })}</div></details></section>;
}
