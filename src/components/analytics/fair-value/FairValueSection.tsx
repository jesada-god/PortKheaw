'use client';

import { useState } from 'react';
import type { FairValueResult } from '@/src/lib/analytics/valuation/types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { canLoadFairValue } from './load-policy';
import { requestFairValue } from './fair-value-client';
import {
  fairValueUnavailableLabel,
  fairValueUnavailableReason,
  formatFairValueMoney,
  formatUpsidePercent,
  modelLabel,
} from './presentation';

export function FairValueSection({ symbol }: { symbol: string }) {
  const [data, setData] = useState<FairValueResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = async () => {
    if (!canLoadFairValue(true, true, true, loading)) return;
    setLoading(true);
    setError(null);
    try {
      setData(await requestFairValue(symbol, new AbortController().signal));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'เกิดข้อผิดพลาด');
    } finally {
      setLoading(false);
    }
  };

  const available = data?.status === 'available' ? data : null;
  const dcf = available?.modelResults.find((model) => model.model === 'fcff-dcf') ?? null;
  const multiples = available?.modelResults.find((model) =>
    model.model === 'pe' || model.model === 'ev-sales') ?? null;

  return (
    <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-white">Fair Value</h2>
          <p className="mt-1 text-xs text-amber-300">Deterministic DCF + Forward Multiples · USD source of truth</p>
        </div>
        {!data && (
          <button
            type="button"
            disabled={loading}
            onClick={() => void analyze()}
            className="min-h-11 rounded-lg bg-[#D4FF00] px-4 text-sm font-semibold text-black disabled:opacity-50"
          >
            {loading ? 'กำลังตรวจข้อมูล…' : 'Analyze'}
          </button>
        )}
      </div>
      {error && <p className="mt-4 text-sm text-red-300">เกิดข้อผิดพลาด: {error}</p>}
      {data?.status === 'unavailable' && (
        <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="font-semibold text-amber-200">{fairValueUnavailableLabel(data.failureKind, 'th')}</p>
          <p className="mt-2 text-sm text-amber-100">{fairValueUnavailableReason(data, 'th')}</p>
          <p className="mt-3 text-xs text-slate-500">
            Provider: {data.provider ?? 'ไม่ทราบ'} · as of {formatBangkokDateTime(data.asOf)}
          </p>
        </div>
      )}
      {available && (
        <div className="mt-5 space-y-4">
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Value label={available.fairValue.label} value={formatFairValueMoney(available.fairValue.value)} />
            <Value label="Current Price" value={formatFairValueMoney(available.marketPrice.value)} />
            <Value label="Upside/Downside" value={formatUpsidePercent(available.upsidePercent)} />
            <Value label="DCF" value={formatFairValueMoney(dcf?.fairValue ?? null)} />
            <Value label="Forward Multiples" value={formatFairValueMoney(multiples?.fairValue ?? null)} />
            <Value label="Confidence" value={available.fairValue.confidence} />
          </dl>
          <details className="rounded-lg border border-slate-700 p-3 text-sm">
            <summary className="min-h-11 cursor-pointer py-2">ดูวิธีคำนวณ</summary>
            <div className="mt-3 space-y-3 text-xs text-slate-400">
              {available.modelResults.map((model) => (
                <div key={model.model}>
                  <p className="font-semibold text-slate-200">
                    {modelLabel(model.model)}
                    {available.fairValue.type === 'base'
                      ? ` · ${(model.weight * 100).toFixed(0)}%`
                      : ' · standalone model'}
                  </p>
                  <p>{model.methodology}</p>
                </div>
              ))}
              {available.fairValue.type !== 'base' && (
                <p className="text-amber-300">
                  {available.fairValue.label} มาจากโมเดลเดียวที่ผ่าน validation จึงไม่ใช่ Base หรือ Blended Fair Value
                </p>
              )}
              <p>Calculated {formatBangkokDateTime(available.calculatedAt)} · {available.methodologyVersion}</p>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 p-3">
      <dt className="text-[10px] uppercase text-slate-500">{label}</dt>
      <dd className="mt-2 font-mono text-white">{value}</dd>
    </div>
  );
}
