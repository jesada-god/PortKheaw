'use client';

import React, { useState } from 'react';
import { Activity, Info, Minus, TrendingDown, TrendingUp, TriangleAlert, Zap } from 'lucide-react';
import type { MarketSignalBias, MarketSignalResult, MarketSignalState } from '@/src/lib/analytics/market-signal/types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import { LockedNotice } from '@/src/components/subscription/EntitlementGate';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';

const DISCLAIMER = 'Market Signal เป็นการสรุปข้อมูลทางเทคนิค ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย';

export const MARKET_SIGNAL_PRESENTATION = {
  STRONG_BULLISH: {
    thai: 'ขาขึ้นแข็งแรง',
    description: 'ขาขึ้นแข็งแรง • ราคาและโมเมนตัมไปทางเดียวกัน มีแรงซื้อสนับสนุน',
    icon: TrendingUp,
    tone: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300',
  },
  BULLISH: {
    thai: 'แนวโน้มขาขึ้น',
    description: 'แนวโน้มเป็นขาขึ้น • แต่ยังควรดูแรงยืนยันและจังหวะของราคา',
    icon: TrendingUp,
    tone: 'border-green-500/35 bg-green-500/10 text-green-300',
  },
  SIDEWAYS: {
    thai: 'ตลาดพักตัว / ยังไม่เลือกทาง',
    description: 'ตลาดกำลังพักตัว • ราคายังไม่มีทิศทางขึ้นหรือลงที่ชัดเจน',
    icon: Minus,
    tone: 'border-sky-500/30 bg-slate-500/10 text-sky-200',
  },
  SQUEEZE: {
    thai: 'สะสมพลัง / เตรียมเลือกทาง',
    description: 'ความผันผวนกำลังหดตัว • ราคาอาจกำลังเตรียมเลือกทิศทางครั้งใหม่',
    icon: Zap,
    tone: 'border-amber-400/40 bg-amber-500/10 text-amber-200',
  },
  OVEREXTENDED: {
    thai: 'ราคาไกลจากค่าเฉลี่ย',
    description: 'ราคาอยู่ห่างจากค่าเฉลี่ยมากกว่าปกติ • มีโอกาสพักตัวหรือแกว่งกลับ',
    icon: TriangleAlert,
    tone: 'border-orange-400/40 bg-orange-500/10 text-orange-200',
  },
  BEARISH: {
    thai: 'แนวโน้มขาลง',
    description: 'แนวโน้มเป็นขาลง • แรงขายยังมีอิทธิพลมากกว่าแรงซื้อ',
    icon: TrendingDown,
    tone: 'border-red-500/35 bg-red-500/10 text-red-300',
  },
  STRONG_BEARISH: {
    thai: 'ขาลงแข็งแรง',
    description: 'ขาลงแข็งแรง • ราคา โมเมนตัม และแรงขายไปในทิศทางเดียวกัน',
    icon: TrendingDown,
    tone: 'border-red-700/50 bg-red-950/40 text-red-300',
  },
} as const satisfies Record<MarketSignalState, {
  thai: string;
  description: string;
  icon: typeof Activity;
  tone: string;
}>;

const BREAKDOWN_COPY = {
  emaTrend: { label: 'EMA / Trend', helper: 'ดูว่าราคาและเส้นค่าเฉลี่ยกำลังเรียงตัวขึ้นหรือลง' },
  momentum: { label: 'Momentum', helper: 'ดูว่าแรงของการเคลื่อนไหวยังเพิ่มขึ้นหรือเริ่มอ่อนลง' },
  trendStrength: { label: 'Trend Strength', helper: 'ดูว่าแนวโน้มปัจจุบันแข็งแรงแค่ไหน' },
  volume: { label: 'Volume', helper: 'ดูว่าปริมาณการซื้อขายสนับสนุนการเคลื่อนไหวหรือไม่' },
  priceStructure: { label: 'Price Structure', helper: 'ดูโครงสร้างราคาและการยืนยันจากแนวรับ/แนวต้าน' },
} as const;

export function MarketSignalSection({ result }: { result: MarketSignalResult | null }) {
  const { can } = useEntitlement();
  const entitled = can('technical.outlook');
  return <MarketSignalContent key={`${result?.symbol ?? 'none'}:${entitled ? 'full' : 'locked'}`} result={result} entitled={entitled} />;
}

function MarketSignalContent({ result, entitled }: { result: MarketSignalResult | null; entitled: boolean }) {
  const [open, setOpen] = useState(false);
  if (!entitled) {
    return (
      <section aria-label="Technical Outlook" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5" data-testid="technical-outlook-locked">
        <p className="text-xs uppercase tracking-wide text-slate-500">Technical Signal · 1D</p>
        <div className="mt-2 flex items-center gap-2 text-slate-300">
          <Info aria-hidden="true" size={18} />
          <h2 className="font-bold">Technical Outlook · Market Signal</h2>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-400">สรุปแนวโน้ม คะแนนทิศทาง และความมั่นใจจากข้อมูลทางเทคนิคจริง</p>
        <div className="mt-3">
          <LockedNotice capability="technical.outlook" source="financials.technical-outlook" />
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  if (!result) {
    return (
      <section aria-label="Technical Outlook" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <p className="text-xs uppercase tracking-wide text-slate-500">Technical Signal · 1D</p>
        <div className="mt-2 flex items-center gap-2 text-slate-300">
          <Info aria-hidden="true" size={18} />
          <h2 className="font-bold">Technical Outlook · Market Signal</h2>
        </div>
        <p className="mt-3 text-sm text-slate-400">ยังโหลดข้อมูล Technical Outlook ไม่สำเร็จ จึงไม่แสดงผลลัพธ์ที่เดาขึ้นเอง</p>
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  if (result.status === 'insufficient-data') {
    return (
      <section aria-label="Technical Outlook" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <p className="text-xs uppercase tracking-wide text-slate-500">Technical Signal · 1D</p>
        <div className="mt-2 flex items-center gap-2 text-slate-300">
          <Info aria-hidden="true" size={18} />
          <h2 className="font-bold">Technical Outlook · Market Signal</h2>
        </div>
        <p className="mt-3 text-sm text-slate-400">ข้อมูลไม่เพียงพอ · {result.reason}</p>
        {result.warnings.map((warning) => <p key={warning} className="mt-2 text-xs text-amber-300">{warning}</p>)}
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  const presentation = MARKET_SIGNAL_PRESENTATION[result.state];
  const Icon = presentation.icon;
  const supporting = result.reasons.filter((reason) => result.bias === 'bullish'
    ? reason.polarity === 'positive'
    : result.bias === 'bearish' ? reason.polarity === 'negative' : reason.polarity === 'information');
  const cautions = result.reasons.filter((reason) => reason.polarity === 'caution'
    || (result.bias === 'bullish' && reason.polarity === 'negative')
    || (result.bias === 'bearish' && reason.polarity === 'positive'));
  const unconfirmed = result.warnings;
  const biasLabel = result.bias === 'bullish' ? 'Bullish Bias' : result.bias === 'bearish' ? 'Bearish Bias' : 'Neutral Bias';
  const beginnerDescription = descriptionFor(result.state, result.bias, presentation.description);

  return (
    <section aria-label="Technical Outlook" data-state={result.state} className={`rounded-2xl border p-5 ${presentation.tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">Technical Signal · 1D</p>
          <div className="mt-2 flex items-center gap-2">
            <Icon aria-hidden="true" size={22} />
            <h2 className="font-bold text-white">Technical Outlook · Market Signal</h2>
          </div>
          <p className="mt-2 break-words font-mono text-lg font-bold text-white sm:text-xl">
            {result.state} <span className="text-slate-500" aria-hidden="true">•</span> {biasLabel}
          </p>
          <p className="mt-1 text-sm font-semibold">{presentation.thai}</p>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{beginnerDescription}</p>
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="flex min-h-11 items-center gap-2 rounded-xl border border-current/30 px-3 text-sm font-semibold hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
        >
          <Info aria-hidden="true" size={17} />
          ทำไม?
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-300">
        <span className="inline-flex min-h-11 items-center gap-2">
          Score <strong className="font-mono text-white">{signed(result.score)} / 100</strong>
          <InfoHint term="directionalScore" align="start" />
        </span>
        <span className="inline-flex min-h-11 items-center gap-2">
          Confidence <strong className="font-mono text-white">{result.confidence}%</strong>
          <InfoHint term="signalConfidence" align="end" />
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2" aria-label="Signal flags">
        {result.flags.map((flag) => <span key={flag} className="rounded-full border border-current/20 px-2 py-1 text-[11px] font-semibold">{flag.replaceAll('_', ' ')}</span>)}
      </div>
      <p className="mt-3 text-xs leading-5 text-slate-400">{DISCLAIMER}</p>

      <ResponsiveDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        title={`ทำไมเป็น ${result.state} • ${biasLabel}?`}
      >
        <div className="space-y-6 text-sm text-slate-300">
          <section>
            <h3 className="font-semibold text-white">1. สถานะนี้แปลว่าอะไร</h3>
            <p className="mt-2 leading-6">{beginnerDescription}</p>
          </section>

          <section>
            <h3 className="font-semibold text-white">2. ระบบดูจากอะไร</h3>
            <p className="mt-2 leading-6">ใช้ finalized 1D candles และหลักฐานจาก EMA, Momentum, ADX/DMI, Volume และ Price Structure โดยไม่ใช้ Score แทน Confidence</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <ConfidenceDetail label="Data completeness" value={result.confidenceBreakdown.completeness} />
              <ConfidenceDetail label="Evidence agreement" value={result.confidenceBreakdown.agreement} />
              <ConfidenceDetail label="Evidence strength" value={result.confidenceBreakdown.evidenceStrength} />
              <ConfidenceDetail label="Volume confirmation" value={result.confidenceBreakdown.volumeConfirmation} />
              <ConfidenceDetail label="Regime clarity" value={result.confidenceBreakdown.regimeClarity} />
              <ConfidenceDetail label="Conflict penalty" value={result.confidenceBreakdown.conflictPenalty} />
            </dl>
          </section>

          <section>
            <h3 className="font-semibold text-white">3. คะแนนมาจากอะไร</h3>
            <div className="mt-3 space-y-2">
              {(Object.entries(result.scoreBreakdown) as Array<[keyof typeof BREAKDOWN_COPY, (typeof result.scoreBreakdown)[keyof typeof result.scoreBreakdown]]>).map(([id, item]) => {
                const copy = BREAKDOWN_COPY[id];
                return (
                  <div key={id} className="rounded-xl border border-slate-800 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-white">{copy.label}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">{copy.helper}</p>
                      </div>
                      <p className="shrink-0 font-mono text-white">{item.points === null ? '—' : signed(item.points)} / {item.maxPoints}</p>
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center justify-between border-t border-slate-700 px-3 pt-3 font-semibold text-white">
                <span>รวม</span>
                <span className="font-mono">{signed(result.score)} / 100</span>
              </div>
            </div>
          </section>

          <ReasonList title="4. ปัจจัยสนับสนุน" reasons={supporting} empty="ยังไม่มีปัจจัยสนับสนุนเด่นที่ผ่านกฎ" />
          <ReasonList title="5. ปัจจัยที่ต้องระวัง" reasons={cautions} empty="ยังไม่มีปัจจัยขัดแย้งเด่นที่ผ่านกฎ" />
          <TextList title="6. สิ่งที่ยังไม่ยืนยัน" items={unconfirmed} empty="ตัวชี้วัดหลักพร้อมและยังไม่มีคำเตือนเพิ่มเติม" />

          <section>
            <h3 className="font-semibold text-white">Metrics จากข้อมูลจริง</h3>
            <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
              <Detail label="Close" value={number(result.metrics.close)} />
              <Detail label="EMA20 / EMA50 / EMA200" value={joined(result.metrics.ema20, result.metrics.ema50, result.metrics.ema200)} />
              <Detail label="EMA20 / 50 / 200 slopes" value={percentJoined(result.metrics.ema20SlopePct, result.metrics.ema50SlopePct, result.metrics.ema200SlopePct)} />
              <Detail label="RSI14" value={number(result.metrics.rsi14)} />
              <Detail label="MACD / Signal / Histogram" value={joined(result.metrics.macd, result.metrics.macdSignal, result.metrics.macdHistogram)} />
              <Detail label="ADX / +DI / -DI" value={joined(result.metrics.adx14, result.metrics.plusDi14, result.metrics.minusDi14)} />
              <Detail label="Relative Volume 20" value={result.metrics.relativeVolume20 === null ? '—' : `${number(result.metrics.relativeVolume20)}×`} />
              <Detail label="Bollinger U / M / L" value={joined(result.metrics.bollingerUpper, result.metrics.bollingerMiddle, result.metrics.bollingerLower)} />
              <Detail label="Keltner U / M / L" value={joined(result.metrics.keltnerUpper, result.metrics.keltnerMiddle, result.metrics.keltnerLower)} />
              <Detail label="Squeeze status" value={result.metrics.squeezeOn === null ? '—' : result.metrics.squeezeOn ? 'ON' : 'OFF'} />
              <Detail label="ATR14" value={number(result.metrics.atr14)} />
              <Detail label="Close ↔ EMA20 deviation" value={percent(result.metrics.ema20DeviationPct)} />
              <Detail label="ATR-normalized distance" value={result.metrics.atrNormalizedDistance === null ? '—' : `${number(result.metrics.atrNormalizedDistance)} ATR`} />
              <Detail label="OBV Trend" value={result.metrics.obvTrend ?? '—'} />
              <Detail label="Support / Resistance" value={joined(result.metrics.nearestSupport, result.metrics.nearestResistance)} />
              <Detail label="Divergence" value={result.metrics.divergence ?? '—'} />
            </dl>
          </section>

          <div className="rounded-xl border border-slate-800 p-3 text-xs leading-5 text-slate-400">
            <p>Score: {signed(result.score)} / 100</p>
            <p>Confidence: {result.confidenceLabel} ({result.confidence}%)</p>
            <p>Timeframe: {result.timeframe} · Finalized candles: {result.dataPoints.finalized}</p>
            <p>Updated: {formatBangkokDateTime(result.calculatedAt)}</p>
            <p>Source: {result.source ?? 'ไม่พร้อมใช้งาน'}</p>
          </div>
          <p className="text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
        </div>
      </ResponsiveDialog>
    </section>
  );
}

function descriptionFor(state: MarketSignalState, bias: MarketSignalBias, fallback: string): string {
  if (state === 'SQUEEZE') {
    if (bias === 'bullish') return 'ยังไม่ยืนยันการเบรก แต่โครงสร้างปัจจุบันเอนเอียงไปทางขาขึ้น';
    if (bias === 'bearish') return 'ยังไม่ยืนยันการเบรก แต่โครงสร้างปัจจุบันเอนเอียงไปทางขาลง';
    return 'ความผันผวนกำลังบีบตัว แต่ระบบยังไม่พบฝั่งที่ได้เปรียบชัดเจน';
  }
  if (state === 'OVEREXTENDED') {
    if (bias === 'bullish') return 'แนวโน้มหลักยังขึ้น แต่ราคาวิ่งไกลจากค่าเฉลี่ย ระวังการพักตัว';
    if (bias === 'bearish') return 'แนวโน้มหลักยังลง แต่ราคาลงไกลจากค่าเฉลี่ย ระวังการเด้งกลับ';
  }
  if (state === 'SIDEWAYS' && bias === 'neutral') return 'แรงซื้อและแรงขายใกล้เคียงกัน ระบบยังไม่พบฝั่งที่ได้เปรียบชัดเจน';
  return fallback;
}

function ReasonList({ title, reasons, empty }: { title: string; reasons: MarketSignalResult['reasons']; empty: string }) {
  return (
    <section>
      <h3 className="font-semibold text-white">{title}</h3>
      {reasons.length ? (
        <ul className="mt-2 space-y-2">
          {reasons.map((reason) => <li key={reason.id} className="flex gap-2"><span aria-hidden="true">•</span><span>{reason.text}</span></li>)}
        </ul>
      ) : <p className="mt-2 text-slate-500">{empty}</p>}
    </section>
  );
}

function TextList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section>
      <h3 className="font-semibold text-white">{title}</h3>
      {items.length ? <ul className="mt-2 space-y-2">{items.map((item) => <li key={item} className="flex gap-2"><span aria-hidden="true">•</span><span>{item}</span></li>)}</ul> : <p className="mt-2 text-slate-500">{empty}</p>}
    </section>
  );
}

function ConfidenceDetail({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-slate-800 p-2"><dt className="text-slate-500">{label}</dt><dd className="mt-1 font-mono text-white">{value}%</dd></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 py-2"><dt className="text-slate-500">{label}</dt><dd className="min-w-0 break-words text-right font-mono text-white [overflow-wrap:anywhere]">{value}</dd></div>;
}

function number(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${signed(round(value, 2))}%`;
}

function joined(...values: Array<number | null>): string {
  return values.map(number).join(' / ');
}

function percentJoined(...values: Array<number | null>): string {
  return values.map(percent).join(' / ');
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
