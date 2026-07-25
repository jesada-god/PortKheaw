'use client';

import { useEffect, useId, useState } from 'react';
import type { FairValueResult } from '@/src/lib/analytics/valuation/types';
import type { CompanyProfileLanguage } from '@/src/lib/stock-detail/profile-presentation';
import { FairValueDetailsDrawer } from './FairValueDetailsDrawer';
import { requestFairValue } from './fair-value-client';
import {
  availableFairValueResult,
  displayStatus,
  fairValueUnavailableLabel,
  fairValueUnavailableReason,
  formatFairValueMoney,
  formatUpsidePercent,
  modelLabel,
  upsideTone,
} from './presentation';

export function FairValueCard({
  symbol,
  enabled,
  language = 'th',
}: {
  symbol: string;
  enabled: boolean;
  language?: CompanyProfileLanguage;
}) {
  const requestKey = `${symbol}:${enabled}`;
  const [result, setResult] = useState<{
    key: string;
    data: FairValueResult | null;
    error: string | null;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const drawerId = `fair-value-details-${useId().replaceAll(':', '')}`;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let current = true;
    void requestFairValue(symbol, controller.signal).then(
      (data) => {
        if (current) setResult({ key: requestKey, data, error: null });
      },
      (cause) => {
        if (current && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setResult({
            key: requestKey,
            data: null,
            error: cause instanceof Error ? cause.message : 'ไม่สามารถโหลด Fair Value ได้',
          });
        }
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [enabled, requestKey, symbol]);

  const currentResult = result?.key === requestKey ? result : null;
  const data = currentResult?.data ?? null;
  const loading = enabled && currentResult === null;
  const available = availableFairValueResult(data);
  const dcf = available?.modelResults.find((model) => model.model === 'fcff-dcf')?.fairValue ?? null;
  const forwardMultiples = available?.modelResults.find(
    (model) => model.model === 'pe' || model.model === 'ev-sales',
  )?.fairValue ?? null;
  const tone = upsideTone(available?.upsidePercent ?? null);
  const toneClass = tone === 'success'
    ? 'text-emerald-400'
    : tone === 'danger' ? 'text-red-400' : 'text-slate-400';
  const error = enabled
    ? currentResult?.error ?? null
    : language === 'th' ? 'ระบบ Fair Value ถูกปิดอยู่' : 'Fair Value feature is disabled';
  const unavailableLabel = data?.status === 'unavailable'
    ? fairValueUnavailableLabel(data.failureKind, language)
    : currentResult?.error
      ? language === 'th' ? 'เกิดข้อผิดพลาด' : 'Error'
      : language === 'th' ? 'ยังไม่พร้อมใช้งาน' : 'Unavailable';
  const unavailableReason = error ?? (data?.status === 'unavailable'
    ? fairValueUnavailableReason(data, language)
    : null);

  return (
    <>
      <div className="min-h-20 rounded-xl border border-slate-800 bg-[#151B28] p-3" aria-live="polite">
        <div className="flex min-h-11 items-center justify-between gap-1">
          <p
            className="text-[10px] font-semibold uppercase tracking-wide text-slate-400"
            title="Deterministic DCF + Forward Multiples; USD source of truth"
          >
            Fair Value
          </p>
          <button
            type="button"
            aria-label="ดูวิธีคำนวณ Fair Value"
            aria-expanded={open}
            aria-controls={drawerId}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-slate-400 outline-none hover:bg-slate-800 hover:text-[#D4FF00] focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
          >
            <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full border border-current text-[11px] font-bold">?</span>
          </button>
        </div>
        {loading ? (
          <div data-testid="fair-value-skeleton" className="space-y-2">
            <p className="text-xs text-slate-400">{language === 'th' ? 'กำลังโหลด Fair Value…' : 'Loading Fair Value…'}</p>
            <div className="h-3 w-28 animate-pulse rounded bg-slate-800" />
          </div>
        ) : available ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[10px] sm:grid-cols-3">
            <Metric label={available.fairValue.label} value={formatFairValueMoney(available.fairValue.value)} />
            <Metric label="Current Price" value={formatFairValueMoney(available.marketPrice.value)} />
            <Metric
              label="Upside/Downside"
              value={formatUpsidePercent(available.upsidePercent)}
              valueClass={toneClass}
            />
            <Metric label="DCF" value={formatFairValueMoney(dcf)} />
            <Metric label="Forward Multiples" value={formatFairValueMoney(forwardMultiples)} />
            <Metric label="Data Quality" value={available.dataQualityLabel} />
            <div className="col-span-full text-slate-500">
              {modelLabel(available.selectedModel)} · Confidence {available.fairValue.confidence} · {displayStatus(available)} · USD source of truth
            </div>
            {available.fairValue.type !== 'base' && (
              <div className="col-span-full text-amber-300">
                {language === 'th'
                  ? `${available.fairValue.label} มาจากโมเดลเดียวที่ผ่าน validation และไม่ใช่ Base/Blended`
                  : `${available.fairValue.label} uses one validated model and is not Base/Blended.`}
              </div>
            )}
          </dl>
        ) : (
          <div>
            <p className="font-mono text-sm text-amber-300">{unavailableLabel}</p>
            <p className="mt-1 line-clamp-2 text-[10px] text-slate-500">
              {unavailableReason ?? 'ข้อมูลจริงไม่เพียงพอ'}
            </p>
          </div>
        )}
      </div>
      <FairValueDetailsDrawer
        id={drawerId}
        open={open}
        onClose={() => setOpen(false)}
        data={data}
        unavailableReason={unavailableReason}
      />
    </>
  );
}

function Metric({
  label,
  value,
  valueClass = 'text-white',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`font-mono text-xs tabular-nums ${valueClass}`}>{value}</dd>
    </div>
  );
}
