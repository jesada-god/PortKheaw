'use client';

import { useMemo, useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { DataStatusBadge } from '@/src/components/market-data/DataProvenance';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import { useOptionsSupportResistance } from '@/src/components/stock/chart/useOptionsSupportResistance';
import {
  assembleOptionsSignalInput,
  type OptionsSignalServerContext,
} from '@/src/lib/analytics/options-signal/assemble';
import { calculateOptionsSignal } from '@/src/lib/analytics/options-signal/calculations';
import type {
  OptionsSignalFactorId,
  OptionsSignalFactorScore,
  OptionsSignalResult,
} from '@/src/lib/analytics/options-signal/types';
import type { GlossaryTermId } from '@/src/lib/analytics/glossary';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import {
  DATA_STATE_LABEL,
  FACTOR_COPY,
  IV_LEVEL_LABEL,
  OPTIONS_SIGNAL_PRESENTATION,
  displayStatusOf,
  ivBasisLabel,
  signedPoints,
} from './presentation';

const DISCLAIMER = 'Options Signal Engine เป็นการสรุปหลักฐานเชิงเทคนิคและข้อมูลตลาดจริงเพื่อการเรียนรู้ ไม่ใช่คำแนะนำซื้อขาย และไม่รับประกันผลลัพธ์';

const FACTOR_ORDER: OptionsSignalFactorId[] = ['macro', 'trend', 'momentum', 'sentiment', 'riskReward'];

export interface OptionsSignalSectionProps {
  symbol: string;
  /** Candle/earnings-derived inputs computed on the server. */
  context: OptionsSignalServerContext | null;
  /** The single accepted underlying price shared with the header and chart. */
  acceptedPrice: number | null;
  /** True only while the Analysis tab is mounted, so the chain loads lazily. */
  active: boolean;
}

/**
 * Options Signal Engine card.
 *
 * The options half of the input comes from the browser-wide options
 * coordinators, so it joins the request the Options Chain panel already makes
 * instead of issuing another one. The scoring itself lives entirely in the pure
 * engine — this component only renders what the engine returned.
 */
export function OptionsSignalSection(props: OptionsSignalSectionProps) {
  return <OptionsSignalContent key={props.symbol} {...props} />;
}

function OptionsSignalContent({ symbol, context, acceptedPrice, active }: OptionsSignalSectionProps) {
  const [open, setOpen] = useState(false);
  const options = useOptionsSupportResistance({ symbol, acceptedPrice, enabled: Boolean(context), active });

  const result = useMemo<OptionsSignalResult | null>(() => {
    if (!context) return null;
    return calculateOptionsSignal(assembleOptionsSignalInput(context, {
      chain: options.chain,
      optionsSr: options.result,
      acceptedPrice,
    }));
  }, [context, options.chain, options.result, acceptedPrice]);

  if (!context || !result) {
    return (
      <section aria-label="Options Signal Engine" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <Header timeframe="1D" />
        <p className="mt-3 text-sm text-slate-400">
          ยังโหลดข้อมูลพื้นฐานของสัญญาณไม่สำเร็จ จึงไม่แสดงผลลัพธ์ที่เดาขึ้นเอง
        </p>
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  if (result.status === 'insufficient-data') {
    return (
      <section aria-label="Options Signal Engine" data-signal="insufficient-data" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <Header timeframe={result.timeframe} />
        <p className="mt-3 text-sm text-slate-300">ข้อมูลไม่เพียงพอ · {result.reason}</p>
        <SourceStates result={result} />
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  const presentation = OPTIONS_SIGNAL_PRESENTATION[result.signalType];
  const diagnostics = result.diagnostics;
  const iv = diagnostics.iv;
  const event = diagnostics.event;
  const highlights = result.reasoning
    .filter((reason) => reason.polarity === 'positive' || reason.polarity === 'caution')
    .slice(0, 4);

  return (
    <section
      aria-label="Options Signal Engine"
      data-signal={result.signalType}
      className={`rounded-2xl border p-5 ${presentation.tone}`}
    >
      <Header timeframe={result.timeframe} />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 font-mono text-base font-bold sm:text-lg ${presentation.badgeTone}`}>
          <span aria-hidden="true">{presentation.dot}</span>
          {presentation.title}
        </p>
        <p className="inline-flex items-center gap-2 font-mono text-lg font-bold text-white">
          {result.confidenceScore} <span className="text-sm font-normal text-slate-400">/ 100</span>
          <InfoHint term="optionsSignalConfidence" align="end" />
        </p>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-300">{presentation.headline}</p>

      <dl className="mt-4 space-y-1.5" aria-label="คะแนนแต่ละปัจจัย">
        {FACTOR_ORDER.map((id) => (
          <FactorRow key={id} factor={diagnostics.factors[id]} />
        ))}
      </dl>

      <dl className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-sm">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <dt className="flex items-center gap-1.5 text-slate-300">
            {ivBasisLabel(iv.basis)}
            <InfoHint term="ivRank" />
          </dt>
          <dd className="flex items-center gap-2 font-mono text-white">
            {iv.level === null ? '—' : (
              <>
                <span>{iv.basis === 'iv-rank' ? iv.ivRank : `${(iv.ratio ?? 0).toFixed(2)}×`}</span>
                <span className="font-sans text-xs text-slate-300">{IV_LEVEL_LABEL[iv.level]}</span>
              </>
            )}
            <DataStatusBadge status={displayStatusOf(iv.state)} />
          </dd>
        </div>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <dt className="flex items-center gap-1.5 text-slate-300">
            Earnings
            <InfoHint term="daysToEarnings" />
          </dt>
          <dd className="flex items-center gap-2 font-mono text-white">
            <span>{event.daysToEarnings === null ? '—' : `อีก ${event.daysToEarnings} วัน`}</span>
            <DataStatusBadge status={displayStatusOf(event.state)} />
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">เหตุผล</h3>
        <ul className="mt-2 space-y-1.5 text-sm leading-6 text-slate-300">
          {highlights.map((reason) => (
            <li key={reason.id} className="flex gap-2">
              <span aria-hidden="true">{reason.polarity === 'caution' ? '⚠' : '•'}</span>
              <span>{reason.text}</span>
            </li>
          ))}
        </ul>
      </div>

      <SetupBlock setup={result.suggestedOptionsSetup} />

      {options.loading && (
        <p className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <Loader2 aria-hidden="true" size={14} className="motion-safe:animate-spin" />
          กำลังโหลดข้อมูล options chain เพื่อเติมปัจจัย IV และ Put/Call
        </p>
      )}

      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/20 px-3 text-sm font-semibold text-white hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00] sm:w-auto"
      >
        <Info aria-hidden="true" size={17} />
        ดูรายละเอียดการคำนวณ
      </button>

      <p className="mt-3 text-xs leading-5 text-slate-400">{DISCLAIMER}</p>

      <ResponsiveDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        title={`รายละเอียดการคำนวณ · ${presentation.title}`}
      >
        <DetailBody result={result} />
      </ResponsiveDialog>
    </section>
  );
}

function Header({ timeframe }: { timeframe: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-bold text-white">Options Signal Engine</h2>
      <span className="rounded-full border border-slate-700 px-2 py-1 font-mono text-[11px] text-slate-300">{timeframe}</span>
    </div>
  );
}

function FactorRow({ factor }: { factor: OptionsSignalFactorScore }) {
  const copy = FACTOR_COPY[factor.id];
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
      <dt className="flex items-center gap-1.5 text-slate-300">
        {copy.label}
        {factor.partial && <span className="text-[11px] text-amber-300">ข้อมูลบางส่วน</span>}
      </dt>
      <dd className="flex items-center gap-2">
        <span className="font-mono text-white">{signedPoints(factor.points)}</span>
        <span className="font-mono text-xs text-slate-500">/ {factor.maxPoints}</span>
        {!factor.available && <DataStatusBadge status="unavailable" />}
      </dd>
    </div>
  );
}

function SetupBlock({ setup }: { setup: OptionsSignalResult['suggestedOptionsSetup'] }) {
  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Setup เพื่อการเรียนรู้</h3>
      {setup.status === 'suggested' ? (
        <>
          <p className="mt-1 font-mono text-sm text-white">
            {setup.dteMin}–{setup.dteMax} DTE · Delta {setup.deltaMin.toFixed(2)}–{setup.deltaMax.toFixed(2)} ·{' '}
            {setup.direction === 'call' ? 'ฝั่ง Call' : 'ฝั่ง Put'}
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-300">{setup.rationale}</p>
        </>
      ) : (
        <p className="mt-1 text-sm leading-6 text-slate-300">ยังไม่แนะนำรูปแบบสัญญา · {setup.reason}</p>
      )}
      <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-400">
        {setup.warnings.map((warning) => (
          <li key={warning} className="flex gap-2"><span aria-hidden="true">•</span><span>{warning}</span></li>
        ))}
      </ul>
    </div>
  );
}

function SourceStates({ result }: { result: OptionsSignalResult }) {
  const factors = result.diagnostics.factors;
  return (
    <ul className="mt-3 space-y-1 text-xs text-slate-400">
      {FACTOR_ORDER.map((id) => (
        <li key={id} className="flex flex-wrap items-center gap-2">
          <span className="text-slate-300">{FACTOR_COPY[id].label}</span>
          <DataStatusBadge status={displayStatusOf(factors[id].state)} />
          <span>{factors[id].reason ?? DATA_STATE_LABEL[factors[id].state]}</span>
        </li>
      ))}
    </ul>
  );
}

function DetailBody({ result }: { result: OptionsSignalResult }) {
  const diagnostics = result.diagnostics;
  const squeeze = diagnostics.squeeze;
  const riskReward = diagnostics.riskReward;
  const iv = diagnostics.iv;
  const event = diagnostics.event;

  return (
    <div className="space-y-6 text-sm text-slate-300">
      <section>
        <h3 className="font-semibold text-white">1. คะแนนทิศทางมาจากอะไร</h3>
        <p className="mt-2 leading-6">
          แต่ละปัจจัยให้คะแนนในช่วง −น้ำหนัก ถึง +น้ำหนัก แล้วนำมารวมกัน ปัจจัยที่ไม่มีข้อมูลจะถูกตัดออกจากทั้งตัวตั้งและตัวหาร ไม่ถูกแทนด้วยศูนย์
        </p>
        <div className="mt-3 space-y-2">
          {FACTOR_ORDER.map((id) => {
            const factor = diagnostics.factors[id];
            return (
              <div key={id} className="rounded-xl border border-slate-800 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-white">{FACTOR_COPY[id].label}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">{FACTOR_COPY[id].helper}</p>
                  </div>
                  <p className="shrink-0 font-mono text-white">
                    {signedPoints(factor.points)} / {factor.maxPoints}
                  </p>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-300">{factor.detail}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  <DataStatusBadge status={displayStatusOf(factor.state)} />
                  <span>{factor.provider ?? 'ไม่ทราบผู้ให้บริการ'}</span>
                  {factor.asOf && <span>{formatBangkokDateTime(factor.asOf)}</span>}
                </div>
              </div>
            );
          })}
          <div className="flex items-center justify-between border-t border-slate-700 px-3 pt-3 font-semibold text-white">
            <span>รวม (เทียบเฉพาะปัจจัยที่มีข้อมูล)</span>
            <span className="font-mono">
              {signedPoints(diagnostics.directionScore)} / {diagnostics.availableWeight} → {diagnostics.normalizedScore}
            </span>
          </div>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-white">2. TTM Squeeze และ RVOL</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="สถานะ Squeeze" value={squeeze.state ?? '—'} term="ttmSqueeze" />
          <Detail label="Squeeze Momentum" value={numberText(squeeze.momentum)} />
          <Detail label="Momentum ÷ ATR (normalize)" value={numberText(squeeze.normalizedMomentum)} />
          <Detail label="RVOL 20 วัน" value={squeeze.relativeVolume === null ? '—' : `${squeeze.relativeVolume.toFixed(2)}×`} term="relativeVolume" />
          <Detail label="ระดับการยืนยันจาก RVOL" value={squeeze.confirmation === null ? 'ไม่มีข้อมูล' : `${Math.round(squeeze.confirmation * 100)}%`} />
        </dl>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Squeeze ON คือความผันผวนกำลังบีบตัว ไม่ได้แปลว่าขาขึ้น และ RVOL บอกความคึกคักของการซื้อขาย จึงใช้ยืนยันทิศทางเดิมเท่านั้น ไม่สร้างทิศทางใหม่
        </p>
      </section>

      <section>
        <h3 className="font-semibold text-white">3. แนวรับ/แนวต้าน และ Risk:Reward</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="ราคาที่ใช้คำนวณ" value={numberText(riskReward.price)} />
          <Detail label="แนวรับใกล้สุด" value={numberText(riskReward.support)} />
          <Detail label="แนวต้านใกล้สุด" value={numberText(riskReward.resistance)} />
          <Detail label="ระยะขึ้น / ระยะลง" value={`${percentText(riskReward.upsidePercent)} / ${percentText(riskReward.downsidePercent)}`} />
          <Detail label="R:R ฝั่ง Call" value={numberText(riskReward.callRewardRisk)} />
          <Detail label="R:R ฝั่ง Put" value={numberText(riskReward.putRewardRisk)} />
        </dl>
      </section>

      <section>
        <h3 className="font-semibold text-white">4. ราคาพรีเมียม (IV) และ Put/Call</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="เกณฑ์ที่ใช้" value={ivBasisLabel(iv.basis)} />
          <Detail label="IV Rank" value={iv.ivRank === null ? 'ไม่พร้อมใช้งาน' : String(iv.ivRank)} />
          <Detail label="IV ปัจจุบัน (ATM)" value={iv.impliedVolatility === null ? '—' : `${(iv.impliedVolatility * 100).toFixed(1)}%`} />
          <Detail label="ความผันผวนจริง 1 ปี" value={iv.realizedVolatility === null ? '—' : `${(iv.realizedVolatility * 100).toFixed(1)}%`} />
          <Detail label="IV ÷ ความผันผวนจริง" value={numberText(iv.ratio)} />
          <Detail label="ระดับความแพง" value={iv.level === null ? 'ไม่พร้อมใช้งาน' : IV_LEVEL_LABEL[iv.level]} />
          <Detail label="สถานะข้อมูล IV" value={DATA_STATE_LABEL[iv.state]} />
          <Detail label="Put/Call (Open Interest)" value={diagnostics.factors.sentiment.detail} term="putCallRatio" />
        </dl>
        {iv.reason && <p className="mt-2 text-xs leading-5 text-amber-300">{iv.reason}</p>}
      </section>

      <section>
        <h3 className="font-semibold text-white">5. ความเสี่ยงจากเหตุการณ์ (Earnings)</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="วันประกาศงบ" value={event.reportDate ?? 'ไม่พร้อมใช้งาน'} />
          <Detail label="เหลืออีก" value={event.daysToEarnings === null ? '—' : `${event.daysToEarnings} วัน`} />
          <Detail label="ช่วงเวลา" value={event.timeOfDay ?? '—'} />
          <Detail label="สถานะข้อมูล" value={DATA_STATE_LABEL[event.state]} />
        </dl>
        {event.reason && <p className="mt-2 text-xs leading-5 text-amber-300">{event.reason}</p>}
      </section>

      <section>
        <h3 className="font-semibold text-white">6. Confidence และการหักคะแนน</h3>
        <p className="mt-2 leading-6">
          Confidence วัดว่าหลักฐานหนักแน่นและไปทางเดียวกันแค่ไหน <b className="text-white">ไม่ใช่โอกาสทำกำไร</b>
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <Metric label="ความครบของข้อมูล" value={`${Math.round(diagnostics.coverage * 100)}%`} />
          <Metric label="ความสอดคล้อง" value={`${Math.round(diagnostics.agreement * 100)}%`} />
          <Metric label="ความหนักแน่น" value={`${Math.round(diagnostics.evidenceStrength * 100)}%`} />
          <Metric label="คะแนนก่อนหักลบ" value={`${Math.round(diagnostics.confidenceBase * 100)}%`} />
        </dl>
        {diagnostics.penalties.length ? (
          <ul className="mt-3 space-y-1.5 text-xs">
            {diagnostics.penalties.map((penalty) => (
              <li key={penalty.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 p-2">
                <span className="text-slate-300">{penalty.detail}</span>
                <span className="font-mono text-amber-300">−{Math.round(penalty.amount * 100)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-xs text-slate-500">ไม่มีการหักคะแนนจากความเสี่ยง</p>}
      </section>

      <section>
        <h3 className="font-semibold text-white">7. เงื่อนไขที่ทำให้ยังไม่เป็น PRIME</h3>
        {diagnostics.dataSufficiency.primeBlockers.length ? (
          <ul className="mt-2 space-y-1">
            {diagnostics.dataSufficiency.primeBlockers.map((blocker) => (
              <li key={blocker} className="flex gap-2"><span aria-hidden="true">•</span><span className="font-mono text-xs">{blocker}</span></li>
            ))}
          </ul>
        ) : <p className="mt-2 text-slate-500">ผ่านเงื่อนไข PRIME ครบทุกข้อ</p>}
        {diagnostics.gates.ivWarningReasons.map((reason) => (
          <p key={reason} className="mt-2 text-xs leading-5 text-amber-300">{reason}</p>
        ))}
      </section>

      <section>
        <h3 className="font-semibold text-white">8. เหตุผลทั้งหมด</h3>
        <ul className="mt-2 space-y-1.5">
          {result.reasoning.map((reason) => (
            <li key={reason.id} className="flex gap-2">
              <span aria-hidden="true">{reason.polarity === 'caution' ? '⚠' : '•'}</span>
              <span>{reason.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="rounded-xl border border-slate-800 p-3 text-xs leading-5 text-slate-400">
        <p>Timeframe: {result.timeframe} · แท่งที่ปิดแล้ว: {result.finalizedCandles}</p>
        <p>แท่งล่าสุดที่ใช้: {result.latestCandleAt ?? 'ไม่พร้อมใช้งาน'}</p>
        <p>คำนวณเมื่อ: {formatBangkokDateTime(result.calculatedAt)}</p>
      </div>
      <p className="text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
    </div>
  );
}

/**
 * One metric row. `term` attaches the SHARED glossary hint, whose 18px trigger
 * carries its ≥44px tap target as an overlay, so adding one never widens the
 * row or pushes the value column off a 320px screen.
 */
function Detail({ label, value, term }: { label: string; value: string; term?: GlossaryTermId }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 py-2">
      <dt className="flex min-w-0 flex-wrap items-center gap-1.5 text-slate-500">
        <span className="min-w-0">{label}</span>
        {term && <InfoHint term={term} />}
      </dt>
      <dd className="min-w-0 break-words text-right font-mono text-white [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 p-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 font-mono text-white">{value}</dd>
    </div>
  );
}

function numberText(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function percentText(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}
