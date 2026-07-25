'use client';

import React, { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import type {
  AnalystConsensusResult,
  ProviderAvailability,
} from '@/src/lib/analytics/analyst-target/types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';

const ANALYST_CLIENT_CACHE_MS = 24 * 60 * 60_000;
const analystCache = new Map<string, { data: AnalystConsensusResult; savedAt: number }>();
const analystInflight = new Map<string, Promise<AnalystConsensusResult>>();

async function requestAnalystConsensus(symbol: string): Promise<AnalystConsensusResult> {
  const key = symbol.trim().toUpperCase();
  const cached = analystCache.get(key);
  if (cached && Date.now() - cached.savedAt < ANALYST_CLIENT_CACHE_MS) return cached.data;
  const existing = analystInflight.get(key);
  if (existing) return existing;
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
  return request;
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
  const [resolvedError, setError] = useState<string | null>(null);
  const [errorSymbol, setErrorSymbol] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void requestAnalystConsensus(symbol).then((data) => {
      if (!active) return;
      setData(data);
      setDataSymbol(symbol);
      setError(null);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : 'เกิดข้อผิดพลาด');
      setErrorSymbol(symbol);
    });
    return () => { active = false; };
  }, [enabled, symbol]);

  if (!enabled) return null;

  const data = dataSymbol === symbol ? resolvedData : null;
  const error = errorSymbol === symbol ? resolvedError : null;
  const loading = data === null && error === null;

  return (
    <section className={`rounded-2xl border border-slate-800 bg-[#151B28] p-5 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h2 className="font-bold text-white">Target Price</h2>
            <SourceDetailsDialog data={data} />
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Analyst Consensus · ราคาเป้าหมายจากผู้ให้ข้อมูลภายนอก
          </p>
        </div>
        {data && <StatusBadge data={data} />}
      </div>

      {loading && (
        <div aria-label="Loading Analyst Consensus" className="mt-5 space-y-3">
          <div className="h-8 w-44 animate-pulse rounded bg-slate-800" />
          <div className="h-16 animate-pulse rounded-xl bg-slate-800/70" />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-300">
          ดึง Analyst Consensus ไม่สำเร็จ: {error}
        </p>
      )}
      {data && <AnalystTargetBody target={data} />}
    </section>
  );
}

function StatusBadge({ data }: { data: AnalystConsensusResult }) {
  const labels: Record<AnalystConsensusResult['status'], string> = {
    available: 'Finnhub',
    fallback: 'Alpha fallback',
    stale: 'Saved data',
    'not-entitled': 'Not entitled',
    'rate-limited': 'Rate limited',
    unavailable: 'Unavailable',
    'provider-error': 'Provider unavailable',
  };
  return (
    <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] text-slate-300">
      {labels[data.status]}
    </span>
  );
}

function AnalystTargetBody({ target }: { target: AnalystConsensusResult }) {
  if (target.targetPrice === null || target.provider === null) {
    return (
      <div className="mt-5 space-y-3 rounded-xl border border-slate-700 bg-slate-800/30 p-4">
        <p className="font-semibold text-slate-200">
          ยังไม่มีราคาเป้าหมายนักวิเคราะห์ที่พร้อมใช้งาน
        </p>
        <CoverageList coverage={target.coverage} />
      </div>
    );
  }

  const direction = target.upsideDownsidePct === null
    ? null
    : target.upsideDownsidePct >= 0 ? 'Upside' : 'Downside';
  const directionClass = target.upsideDownsidePct === null
    ? 'text-slate-400'
    : target.upsideDownsidePct >= 0 ? 'text-emerald-300' : 'text-red-300';
  const showFinnhubDetails = target.provider === 'finnhub';

  return (
    <div className="mt-5 space-y-4">
      {target.stale && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          ข้อมูลล่าสุดที่บันทึกไว้
          {target.cachedAt ? ` · ${formatBangkokDateTime(target.cachedAt)}` : ''}
        </p>
      )}

      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">Target Price</p>
        <p className="mt-1 font-mono text-3xl font-bold text-[#D4FF00]">
          {money(target.targetPrice, target.currency)}
        </p>
        <p className="mt-3 text-sm text-slate-300">Current {money(target.currentPrice, target.currency)}</p>
        <p className={`mt-1 font-mono text-sm font-semibold ${directionClass}`}>
          {target.upsideDownsidePct === null
            ? 'Potential unavailable'
            : `Potential ${signedPercent(target.upsideDownsidePct)} · ${direction}`}
        </p>
        <p className="mt-3 text-xs text-slate-400">Source: {target.providerLabel}</p>
      </div>

      {showFinnhubDetails && (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {target.medianTarget !== null && (
            <Cell label="Median" value={money(target.medianTarget, target.currency)} />
          )}
          {target.lowTarget !== null && target.highTarget !== null && (
            <Cell
              label="Range"
              value={`${money(target.lowTarget, target.currency)}–${money(target.highTarget, target.currency)}`}
            />
          )}
          {target.analystCount !== null && (
            <Cell label="Based on" value={`${target.analystCount} Analysts`} />
          )}
          {target.lastUpdated && (
            <Cell label="Last Updated" value={formatDate(target.lastUpdated)} />
          )}
        </dl>
      )}

      <p className="text-xs leading-5 text-slate-400">
        ราคาเป้าหมายนี้เป็นมุมมองจากนักวิเคราะห์ภายนอก ไม่รับประกันว่าราคาจะไปถึงระดับดังกล่าว
        และไม่ใช่คำแนะนำซื้อขาย
      </p>
    </div>
  );
}

function CoverageList({ coverage }: { coverage: ProviderAvailability[] }) {
  return (
    <ul className="space-y-1 text-sm text-slate-400">
      {coverage.map((item) => (
        <li key={`${item.provider}:${item.endpoint}`}>
          {item.status === 'available' ? '✓' : '—'} {item.message}
        </li>
      ))}
    </ul>
  );
}

function SourceDetailsDialog({ data }: { data: AnalystConsensusResult | null }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="แหล่งข้อมูลที่ใช้วิเคราะห์ Analyst Consensus"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
      >
        <Info aria-hidden="true" size={18} />
      </button>
      <ResponsiveDialog isOpen={open} onClose={() => setOpen(false)} title="แหล่งข้อมูลที่ใช้">
        {!data
          ? <p className="text-sm text-slate-400">กำลังตรวจสอบแหล่งข้อมูล…</p>
          : <SourceDetails data={data} />}
      </ResponsiveDialog>
    </>
  );
}

function SourceDetails({ data }: { data: AnalystConsensusResult }) {
  return (
    <div className="space-y-4 text-sm text-slate-300">
      {data.provider === 'finnhub' && data.targetPrice !== null && (
        <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <h4 className="font-semibold text-white">✓ Finnhub</h4>
          <dl className="mt-2 space-y-1">
            <div>สถานะ: ใช้ในการวิเคราะห์</div>
            <div>ราคาเป้าหมายเฉลี่ย: {money(data.targetPrice, data.currency)}</div>
            {data.medianTarget !== null && (
              <div>ค่ากลาง: {money(data.medianTarget, data.currency)}</div>
            )}
            {data.lowTarget !== null && data.highTarget !== null && (
              <div>
                ช่วงเป้าหมาย: {money(data.lowTarget, data.currency)}–{money(data.highTarget, data.currency)}
              </div>
            )}
            {data.analystCount !== null && (
              <div>จำนวนนักวิเคราะห์: {data.analystCount}</div>
            )}
            {data.lastUpdated && <div>อัปเดตล่าสุด: {formatDate(data.lastUpdated)}</div>}
          </dl>
        </section>
      )}

      {data.provider === 'alpha-vantage' && data.targetPrice !== null && (
        <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <h4 className="font-semibold text-white">✓ Alpha Vantage</h4>
          <dl className="mt-2 space-y-1">
            <div>สถานะ: ใช้เป็นแหล่งสำรอง</div>
            <div>Analyst Target: {money(data.targetPrice, data.currency)}</div>
          </dl>
        </section>
      )}

      <section>
        <h4 className="font-semibold text-white">สถานะผู้ให้ข้อมูล</h4>
        <div className="mt-2 rounded-xl border border-slate-800 p-3">
          <CoverageList coverage={data.coverage} />
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 p-3">
        <h4 className="font-semibold text-white">ชื่อสถาบันรายตัว</h4>
        <p className="mt-1 text-slate-400">
          — ผู้ให้ข้อมูลไม่ได้ระบุชื่อสถาบันรายตัวใน response นี้
        </p>
      </section>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 p-3">
      <dt className="text-[10px] uppercase text-slate-500">{label}</dt>
      <dd className="mt-2 break-words font-mono text-white">{value}</dd>
    </div>
  );
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
