'use client';

import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { Info, X } from 'lucide-react';
import type {
  AnalystConsensusResult,
  ProviderAvailability,
} from '@/src/lib/analytics/analyst-target/types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';

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
    const controller = new AbortController();
    void fetch(
      `/api/analytics/analyst-target/${encodeURIComponent(symbol)}`,
      { cache: 'no-store', signal: controller.signal },
    ).then(async (response) => {
      const body = (await response.json()) as {
        data?: AnalystConsensusResult;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? 'ไม่พบข้อมูล');
      }
      setData(body.data);
      setDataSymbol(symbol);
      setError(null);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'เกิดข้อผิดพลาด');
      setErrorSymbol(symbol);
    });
    return () => controller.abort();
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
            <h2 className="font-bold text-white">Analyst Consensus</h2>
            <SourceDetailsPopover data={data} />
          </div>
          <p className="mt-1 text-xs text-slate-400">
            ราคาเป้าหมายนักวิเคราะห์จากผู้ให้ข้อมูลภายนอก ไม่ใช่มูลค่าที่ Nexora คำนวณเอง
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
        <p className="text-xs uppercase tracking-wide text-slate-500">Analyst Consensus</p>
        <p className="mt-1 font-mono text-3xl font-bold text-[#D4FF00]">
          {money(target.targetPrice, target.currency)}
        </p>
        <p className="mt-3 text-sm text-slate-300">
          Current {money(target.currentPrice, target.currency)} → Target{' '}
          {money(target.targetPrice, target.currency)}
        </p>
        <p className={`mt-1 font-mono text-sm font-semibold ${directionClass}`}>
          {target.upsideDownsidePct === null
            ? 'Potential Upside / Downside unavailable'
            : `${signedPercent(target.upsideDownsidePct)} Potential ${direction}`}
        </p>
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

function SourceDetailsPopover({ data }: { data: AnalystConsensusResult | null }) {
  const id = `analyst-sources-${useId().replaceAll(':', '')}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      setPinned(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  const close = () => {
    setOpen(false);
    setPinned(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    buttonRef.current?.focus();
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!pinned && !containerRef.current?.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (!pinned) setOpen(false); }}
      onFocus={() => setOpen(true)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label="แหล่งข้อมูลที่ใช้วิเคราะห์ Analyst Consensus"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setPinned((current) => {
            const next = !current;
            setOpen(next);
            return next;
          });
        }}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
      >
        <Info aria-hidden="true" size={18} />
      </button>

      {open && (
        <div
          id={id}
          role="dialog"
          aria-label="แหล่งข้อมูลที่ใช้วิเคราะห์"
          className="absolute right-0 z-50 mt-2 max-h-[75vh] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-slate-700 bg-[#0F1420] p-4 shadow-2xl"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-bold text-white">แหล่งข้อมูลที่ใช้</h3>
            <button
              type="button"
              aria-label="ปิดรายละเอียดแหล่งข้อมูล"
              onClick={close}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          {!data
            ? <p className="mt-4 text-sm text-slate-400">กำลังตรวจสอบแหล่งข้อมูล…</p>
            : <SourceDetails data={data} />}
        </div>
      )}
    </div>
  );
}

function SourceDetails({ data }: { data: AnalystConsensusResult }) {
  return (
    <div className="mt-4 space-y-4 text-sm text-slate-300">
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
