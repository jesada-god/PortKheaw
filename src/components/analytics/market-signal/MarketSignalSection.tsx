'use client';

import React, { useState } from 'react';
import { Info, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';

const DISCLAIMER = 'สัญญาณนี้สรุปแนวโน้มทางเทคนิคจากราคา โมเมนตัม ปริมาณซื้อขาย และโครงสร้างกราฟ ไม่ได้รับประกันทิศทางราคาและไม่ใช่คำแนะนำซื้อขาย';

const view = {
  bullish: { english: 'BULLISH', thai: 'แนวโน้มขาขึ้น', icon: TrendingUp, mark: '↗', tone: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' },
  neutral: { english: 'NEUTRAL', thai: 'เป็นกลาง', icon: Minus, mark: '→', tone: 'border-slate-600 bg-slate-500/5 text-slate-300' },
  bearish: { english: 'BEARISH', thai: 'แนวโน้มขาลง', icon: TrendingDown, mark: '↘', tone: 'border-rose-500/30 bg-rose-500/5 text-rose-300' },
} as const;

export function MarketSignalSection({ result }: { result: MarketSignalResult }) {
  const [open, setOpen] = useState(false);
  if (result.status === 'insufficient-data') {
    return (
      <section aria-label="Technical Outlook" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <p className="text-xs uppercase tracking-wide text-slate-500">Technical Signal · 1D</p>
        <div className="mt-2 flex items-center gap-2 text-slate-300">
          <Info aria-hidden="true" size={18} />
          <h2 className="font-bold">Technical Outlook · Market Signal</h2>
        </div>
        <p className="mt-3 text-sm text-slate-400">ข้อมูลไม่เพียงพอ · {result.reason}</p>
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  const presentation = view[result.signal];
  const Icon = presentation.icon;
  const positives = result.reasons.filter((reason) => reason.polarity === 'positive');
  const negatives = result.reasons.filter((reason) => reason.polarity === 'negative' || reason.polarity === 'caution');

  return (
    <section aria-label="Technical Outlook" className={`rounded-2xl border p-5 ${presentation.tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">Technical Signal · 1D</p>
          <div className="mt-2 flex items-center gap-2">
            <Icon aria-hidden="true" size={22} />
            <h2 className="font-bold text-white">Technical Outlook · Market Signal</h2>
          </div>
          <p className="mt-2 font-mono text-xl font-bold">
            {presentation.mark} {presentation.english}
          </p>
          <p className="mt-1 text-sm">{presentation.thai}</p>
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="flex min-h-11 items-center gap-2 rounded-xl border border-current/30 px-3 text-sm font-semibold hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
        >
          <Info aria-hidden="true" size={17} />
          ทำไม
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
        <span>Score: {signed(result.score)}</span>
        <span>Confidence: {result.confidence} ({result.confidencePct}%)</span>
        <span>Finalized candles: {result.dataPoints.finalized}</span>
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400" title={DISCLAIMER}>{DISCLAIMER}</p>

      <ResponsiveDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        title={`ทำไมเป็น${presentation.thai}?`}
      >
        <div className="space-y-5 text-sm text-slate-300">
          <ReasonList title="ปัจจัยสนับสนุน" reasons={positives} empty="ไม่มีปัจจัยบวกเด่นที่ผ่านกฎ" />
          <ReasonList title="ปัจจัยที่ต้องระวัง" reasons={negatives} empty="ไม่มีปัจจัยลบเด่นที่ผ่านกฎ" />

          <section>
            <h3 className="font-semibold text-white">รายละเอียดจากข้อมูลจริง</h3>
            <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
              <Detail label="Close" value={number(result.indicators.close)} />
              <Detail label="EMA20" value={number(result.indicators.ema20)} />
              <Detail label="EMA50" value={number(result.indicators.ema50)} />
              <Detail label="EMA200" value={number(result.indicators.ema200)} />
              <Detail label="RSI14" value={number(result.indicators.rsi14)} />
              <Detail label="MACD" value={number(result.indicators.macd)} />
              <Detail label="MACD Signal" value={number(result.indicators.macdSignal)} />
              <Detail label="MACD Histogram" value={number(result.indicators.macdHistogram)} />
              <Detail label="Relative Volume 20" value={result.indicators.relativeVolume20 === null ? '—' : `${number(result.indicators.relativeVolume20)}×`} />
              <Detail label="OBV Trend" value={result.indicators.obvTrend ?? '—'} />
              <Detail label="Nearest Support" value={number(result.indicators.nearestSupport)} />
              <Detail label="Nearest Resistance" value={number(result.indicators.nearestResistance)} />
            </dl>
          </section>

          <section>
            <h3 className="font-semibold text-white">คะแนนตามองค์ประกอบ</h3>
            <dl className="mt-2 grid grid-cols-2 gap-2">
              {Object.entries(result.components).map(([name, item]) => (
                <div key={name} className="rounded-xl border border-slate-800 p-3">
                  <dt className="text-[10px] uppercase text-slate-500">{name} · {item.weight}%</dt>
                  <dd className="mt-1 font-mono text-white">{item.score === null ? '—' : signed(Math.round(item.score * 100))}</dd>
                </div>
              ))}
            </dl>
          </section>

          <div className="rounded-xl border border-slate-800 p-3 text-xs leading-5 text-slate-400">
            <p>Score: {signed(result.score)}</p>
            <p>Confidence: {result.confidence} ({result.confidencePct}%)</p>
            <p>Timeframe: {result.timeframe}</p>
            <p>Updated: {formatBangkokDateTime(result.calculatedAt)}</p>
            <p>Source: {result.source ?? 'ไม่พร้อมใช้งาน'}</p>
          </div>
          <p className="text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
        </div>
      </ResponsiveDialog>
    </section>
  );
}

function ReasonList({ title, reasons, empty }: { title: string; reasons: MarketSignalResult['reasons']; empty: string }) {
  return (
    <section>
      <h3 className="font-semibold text-white">{title}</h3>
      {reasons.length ? (
        <ul className="mt-2 space-y-2">
          {reasons.map((reason) => (
            <li key={reason.id} className="flex gap-2">
              <span aria-hidden="true">{reason.polarity === 'positive' ? '✓' : '•'}</span>
              <span>{reason.text}</span>
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-slate-500">{empty}</p>}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-right font-mono text-white [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function number(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}
