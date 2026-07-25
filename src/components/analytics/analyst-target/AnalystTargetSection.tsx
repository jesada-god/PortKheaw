'use client';

import React, { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import type { AnalystConsensusResult } from '@/src/lib/analytics/analyst-target/types';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';

const ANALYST_CLIENT_CACHE_MS = 24 * 60 * 60_000;
const TARGET_DISCLAIMER = 'ราคาเป้าหมายจากข้อมูลนักวิเคราะห์ภายนอก ใช้เป็นข้อมูลประกอบ ไม่ได้รับประกันว่าราคาจะไปถึงระดับนี้';
const analystCache = new Map<string, { data: AnalystConsensusResult; savedAt: number }>();
const analystInflight = new Map<string, Promise<AnalystConsensusResult>>();

interface AnalystRequestResult {
  data: AnalystConsensusResult;
  clientCached: boolean;
}

async function requestAnalystConsensus(symbol: string): Promise<AnalystRequestResult> {
  const key = symbol.trim().toUpperCase();
  const cached = analystCache.get(key);
  if (cached && Date.now() - cached.savedAt < ANALYST_CLIENT_CACHE_MS) {
    return { data: cached.data, clientCached: true };
  }

  const existing = analystInflight.get(key);
  if (existing) return { data: await existing, clientCached: false };

  const request = fetch(
    `/api/analytics/analyst-target/${encodeURIComponent(key)}`,
    { cache: 'no-store' },
  ).then(async (response) => {
    const body = (await response.json()) as {
      data?: AnalystConsensusResult;
      error?: { message?: string };
    };
    if (!response.ok || !body.data) {
      throw new Error(body.error?.message ?? 'ไม่พบข้อมูล');
    }
    analystCache.set(key, { data: body.data, savedAt: Date.now() });
    return body.data;
  }).finally(() => analystInflight.delete(key));

  analystInflight.set(key, request);
  return { data: await request, clientCached: false };
}

export function clearAnalystTargetClientCacheForTests(): void {
  analystCache.clear();
  analystInflight.clear();
}

export function AnalystTargetSection({
  symbol,
  enabled = true,
  className = '',
}: {
  symbol: string;
  enabled?: boolean;
  className?: string;
}) {
  const [resolvedData, setData] = useState<AnalystConsensusResult | null>(null);
  const [dataSymbol, setDataSymbol] = useState<string | null>(null);
  const [resolvedError, setError] = useState(false);
  const [errorSymbol, setErrorSymbol] = useState<string | null>(null);
  const [clientCached, setClientCached] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void requestAnalystConsensus(symbol).then((result) => {
      if (!active) return;
      setData(result.data);
      setDataSymbol(symbol);
      setClientCached(result.clientCached);
      setError(false);
    }).catch(() => {
      if (!active) return;
      setError(true);
      setErrorSymbol(symbol);
      console.warn('[analyst-target:request-failed]', { symbol });
    });
    return () => { active = false; };
  }, [enabled, symbol]);

  if (!enabled) return null;

  const data = dataSymbol === symbol ? resolvedData : null;
  const error = errorSymbol === symbol ? resolvedError : false;
  const loading = data === null && !error;

  return (
    <section
      aria-label="Target Price"
      className={`rounded-2xl border border-slate-800 bg-[#151B28] p-5 ${className}`}
    >
      {loading && (
        <div aria-label="Loading Analyst Consensus">
          <p className="text-xs uppercase tracking-wide text-slate-500">Target Price</p>
          <div className="mt-3 h-8 w-44 animate-pulse rounded bg-slate-800" />
          <div className="mt-3 h-16 animate-pulse rounded-xl bg-slate-800/70" />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-slate-300">
          ยังไม่มีราคาเป้าหมายสำหรับหุ้นนี้
        </p>
      )}
      {data && <AnalystTargetBody target={data} clientCached={clientCached} />}
    </section>
  );
}

function AnalystTargetBody({
  target,
  clientCached,
}: {
  target: AnalystConsensusResult;
  clientCached: boolean;
}) {
  if (target.targetPrice === null || target.provider === null) {
    return <p className="text-sm font-semibold text-slate-200">ยังไม่มีราคาเป้าหมายสำหรับหุ้นนี้</p>;
  }

  const directionClass = target.upsideDownsidePct === null
    ? 'text-slate-400'
    : target.upsideDownsidePct >= 0 ? 'text-emerald-300' : 'text-red-300';

  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-slate-500">Target Price</p>
      <p className="mt-2 break-words font-mono text-3xl font-bold text-[#D4FF00]">
        {money(target.targetPrice, target.currency)}
      </p>
      <p className="mt-3 text-sm text-slate-300">
        Current {money(target.currentPrice, target.currency)}
      </p>
      <p className={`mt-1 font-mono text-sm font-semibold ${directionClass}`}>
        {target.upsideDownsidePct === null ? '—' : signedPercent(target.upsideDownsidePct)}
      </p>
      <div className="mt-3 flex min-w-0 items-center gap-1 text-xs text-slate-400">
        <span className="min-w-0 break-words">Source: {target.providerLabel}</span>
        <TargetDetailsDialog data={target} clientCached={clientCached} />
      </div>
    </div>
  );
}

function TargetDetailsDialog({
  data,
  clientCached,
}: {
  data: AnalystConsensusResult;
  clientCached: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="รายละเอียดราคาเป้าหมาย"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={TARGET_DISCLAIMER}
        onClick={() => setOpen(true)}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
      >
        <Info aria-hidden="true" size={18} />
      </button>
      <ResponsiveDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        title="รายละเอียดราคาเป้าหมาย"
      >
        <TargetDetails data={data} clientCached={clientCached} />
      </ResponsiveDialog>
    </>
  );
}

function TargetDetails({
  data,
  clientCached,
}: {
  data: AnalystConsensusResult;
  clientCached: boolean;
}) {
  const difference = data.targetPrice !== null && data.currentPrice !== null
    ? data.targetPrice - data.currentPrice
    : null;
  const potentialLabel = data.upsideDownsidePct === null
    ? 'Potential'
    : data.upsideDownsidePct >= 0 ? 'Potential Upside' : 'Potential Downside';
  const showFinnhubDetails = data.provider === 'finnhub';

  return (
    <div className="min-w-0 space-y-4 text-sm text-slate-300">
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        <DetailCell label="Target Price" value={money(data.targetPrice, data.currency)} />
        <DetailCell label="ราคาปัจจุบัน" value={money(data.currentPrice, data.currency)} />
        <DetailCell label="ส่วนต่าง" value={signedMoney(difference, data.currency)} />
        <DetailCell
          label={potentialLabel}
          value={data.upsideDownsidePct === null ? '—' : signedPercent(data.upsideDownsidePct)}
        />
        <DetailCell label="แหล่งข้อมูล" value={data.providerLabel ?? '—'} />
        {data.lastUpdated && (
          <DetailCell label="อัปเดตล่าสุด" value={formatDate(data.lastUpdated)} />
        )}
        <DetailCell label="สถานะข้อมูล" value={dataStatusLabel(data, clientCached)} />

        {showFinnhubDetails && data.medianTarget !== null && (
          <DetailCell label="Median Target" value={money(data.medianTarget, data.currency)} />
        )}
        {showFinnhubDetails && data.lowTarget !== null && data.highTarget !== null && (
          <DetailCell
            label="Low–High"
            value={`${money(data.lowTarget, data.currency)}–${money(data.highTarget, data.currency)}`}
          />
        )}
        {showFinnhubDetails && data.analystCount !== null && (
          <DetailCell label="Analyst Count" value={data.analystCount.toLocaleString('en-US')} />
        )}
      </dl>
      <p className="text-xs leading-5 text-slate-400">{TARGET_DISCLAIMER}</p>
    </div>
  );
}

function DetailCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-800 p-3">
      <dt className="text-[10px] uppercase text-slate-500">{label}</dt>
      <dd className="mt-2 min-w-0 break-words font-mono text-white [overflow-wrap:anywhere]">
        {value}
      </dd>
    </div>
  );
}

function dataStatusLabel(data: AnalystConsensusResult, clientCached: boolean): string {
  if (data.stale) {
    const rateLimited = data.coverage.some((item) => item.status === 'rate-limited');
    return rateLimited
      ? 'กำลังใช้ข้อมูลล่าสุดที่บันทึกไว้'
      : 'ข้อมูลอาจไม่ใช่ข้อมูลล่าสุด';
  }
  if (clientCached) return 'ข้อมูลที่บันทึกไว้ล่าสุด';
  return 'ข้อมูลล่าสุด';
}

function money(value: number | null, currency: string | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ?? 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`;
  }
}

function signedMoney(value: number | null, currency: string | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : '-'}${money(Math.abs(value), currency)}`;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(timestamp));
}
