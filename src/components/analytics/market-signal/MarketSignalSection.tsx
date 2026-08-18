'use client';

import React, { useState } from 'react';
import { Activity, Info, Minus, TrendingDown, TrendingUp, TriangleAlert, Zap } from 'lucide-react';
import type { MarketSignalBias, MarketSignalResult, MarketSignalState, MarketSignalZones } from '@/src/lib/analytics/market-signal/types';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
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

/**
 * Flag chips, in the order a reader should meet them.
 *
 * Ordering is by how much the flag should change what someone does with the
 * card: things that undermine the reading come before things that colour it.
 * Only the first `MAX_FLAG_CHIPS` are drawn; the rest are listed in the "ทำไม?"
 * dialog, because a row of eight chips is a row nobody reads.
 *
 * This ordering — and the Thai wording — applies only once `result.gate` is
 * present, i.e. only with `SIGNAL_GATE` on. With the flag off the card renders
 * the raw flag list exactly as it did before P1.
 */
const FLAG_COPY: Record<string, string> = {
  pending_breakout: 'รอปิดยืนยันเบรกขึ้น',
  pending_breakdown: 'รอปิดยืนยันหลุดลง',
  conflicting_evidence: 'หลักฐานขัดแย้งกัน',
  stale_or_partial_data: 'ข้อมูลไม่สดหรือไม่ครบ',
  earnings_imminent: 'ใกล้ประกาศงบมาก',
  earnings_soon: 'ใกล้ประกาศงบ',
  pre_earnings_breakout: 'เบรกก่อนงบ',
  low_volume_confirmation: 'วอลุ่มไม่ยืนยัน',
  weak_confirmation: 'ยังยืนยันไม่ชัด',
  stale_zone: 'ไม่มีการแตะแนวมานาน',
  narrow_range: 'กรอบแคบกว่า 1 ATR',
  overextended: 'ราคาไกลค่าเฉลี่ย',
  squeeze: 'ความผันผวนบีบตัว',
  bearish_divergence: 'Bearish divergence',
  bullish_divergence: 'Bullish divergence',
  strong_momentum: 'โมเมนตัมแรง',
  high_volume: 'วอลุ่มสูง',
};
const FLAG_ORDER = Object.keys(FLAG_COPY);
const MAX_FLAG_CHIPS = 4;

const orderedFlags = (flags: readonly string[]) => [...flags].sort((left, right) => {
  const leftIndex = FLAG_ORDER.indexOf(left);
  const rightIndex = FLAG_ORDER.indexOf(right);
  return (leftIndex === -1 ? FLAG_ORDER.length : leftIndex) - (rightIndex === -1 ? FLAG_ORDER.length : rightIndex);
});

const flagLabel = (flag: string) => FLAG_COPY[flag] ?? flag.replaceAll('_', ' ');

const BAND_COPY = {
  neutral: 'คะแนนรวมยังต่ำกว่าเกณฑ์ที่จะเรียกว่ามีทิศทาง',
  weak: 'มีทิศทาง แต่ยังบาง',
  moderate: 'มีทิศทางชัดพอสมควร',
  strong: 'คะแนนอยู่ในช่วงสูงสุด',
} as const;

const CONFLICT_COPY = {
  ema_vs_momentum: 'EMA/Trend กับ Momentum ชี้คนละทาง',
  structure_vs_momentum: 'Price Structure กับ Momentum ชี้คนละทาง',
} as const;

const BREAKDOWN_COPY = {
  emaTrend: { label: 'EMA / Trend', helper: 'ดูว่าราคาและเส้นค่าเฉลี่ยกำลังเรียงตัวขึ้นหรือลง' },
  momentum: { label: 'Momentum', helper: 'ดูว่าแรงของการเคลื่อนไหวยังเพิ่มขึ้นหรือเริ่มอ่อนลง' },
  trendStrength: { label: 'Trend Strength', helper: 'ดูว่าแนวโน้มปัจจุบันแข็งแรงแค่ไหน' },
  volume: { label: 'Volume', helper: 'ดูว่าปริมาณการซื้อขายสนับสนุนการเคลื่อนไหวหรือไม่' },
  priceStructure: { label: 'Price Structure', helper: 'ดูโครงสร้างราคาและการยืนยันจากแนวรับ/แนวต้าน' },
} as const;

/**
 * @param capability Which row of the matrix opens the signal for the instrument
 *   on screen. The panel is identical either way — this only decides which gate
 *   is asked and, through it, which plan the padlock names. It is passed in from
 *   `resolveAssetPresentationPolicy` so it is the SAME capability the server
 *   already enforced when it decided whether to compute `result`: a client that
 *   checked a different row would either paint a padlock over a result the
 *   server had sent, or invite an upgrade to a plan that would not help.
 *   Defaulted to the equity row, so every existing caller is unchanged.
 */
export function MarketSignalSection({
  result,
  capability = 'technical.outlook',
  livePrice = null,
}: {
  result: MarketSignalResult | null;
  capability?: SubscriptionCapability;
  /** The page's accepted marking price, for the second marker on the zone bar. */
  livePrice?: number | null;
}) {
  const { can } = useEntitlement();
  const entitled = can(capability);
  return (
    <MarketSignalContent
      key={`${result?.symbol ?? 'none'}:${capability}:${entitled ? 'full' : 'locked'}`}
      result={result}
      entitled={entitled}
      capability={capability}
      livePrice={livePrice}
    />
  );
}

function MarketSignalContent({ result, entitled, capability, livePrice }: {
  result: MarketSignalResult | null;
  entitled: boolean;
  capability: SubscriptionCapability;
  livePrice: number | null;
}) {
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
          {/* The notice derives its own wording and its own required plan from
              the capability, so a commodity page asks for Pro and a stock page
              asks for Elite without either naming a tier here. */}
          <LockedNotice capability={capability} source="financials.technical-outlook" />
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
  /*
   * Thai wording and the four-chip cap arrive with the first phase that adds
   * flags. Without a phase on, the card keeps the raw list it has always drawn,
   * so a reader with every flag off sees the pixels they saw yesterday.
   */
  const chipsOrdered = Boolean(result.gate ?? result.zones);

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
        {(chipsOrdered ? orderedFlags(result.flags).slice(0, MAX_FLAG_CHIPS) : result.flags).map((flag) => (
          <span key={flag} className="rounded-full border border-current/20 px-2 py-1 text-[11px] font-semibold">
            {chipsOrdered ? flagLabel(flag) : flag.replaceAll('_', ' ')}
          </span>
        ))}
        {chipsOrdered && result.flags.length > MAX_FLAG_CHIPS ? (
          <span className="rounded-full border border-current/20 px-2 py-1 text-[11px] font-semibold text-slate-400">
            +{result.flags.length - MAX_FLAG_CHIPS} ใน “ทำไม?”
          </span>
        ) : null}
      </div>
      {result.zones ? <ZoneBar zones={result.zones} score={result.score} livePrice={livePrice} /> : null}
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

          {result.gate ? (
            <section data-testid="signal-gate-explainer">
              <h3 className="font-semibold text-white">ทำไมถึงไม่สรุปแรงกว่านี้</h3>
              <p className="mt-2 leading-6">{BAND_COPY[result.gate.band]} (คะแนนรวม {signed(result.score)})</p>
              {result.gate.conflicts.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {result.gate.conflicts.map((conflict) => <li key={conflict}>{CONFLICT_COPY[conflict]}</li>)}
                </ul>
              ) : null}
              {result.gate.earningsProximity === 'imminent' || result.gate.earningsProximity === 'soon' ? (
                <p className="mt-2 leading-6">อีก {result.gate.daysToEarnings} วันจะประกาศงบ ซึ่งเป็นเหตุการณ์ที่กราฟยังมองไม่เห็น จึงลดความมั่นใจลง</p>
              ) : null}
              {result.flags.length > MAX_FLAG_CHIPS ? (
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  สัญญาณอื่นที่พบ: {orderedFlags(result.flags).slice(MAX_FLAG_CHIPS).map(flagLabel).join(' · ')}
                </p>
              ) : null}
              {/* The multipliers, in the order the product takes them. Confidence
                  is not a sum of parts any more, so showing parts that add up
                  would misdescribe it. */}
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <ConfidenceDetail label="ฐานจากน้ำหนักหลักฐาน" value={Math.round(result.gate.confidenceFactors.base)} />
                <ConfidenceDetail label="× ความครบของข้อมูล" value={Math.round(result.gate.confidenceFactors.completeness * 100)} />
                <ConfidenceDetail label="× ความสอดคล้อง" value={Math.round(result.gate.confidenceFactors.agreement * 100)} />
                <ConfidenceDetail label="× ความชัดของภาวะตลาด" value={Math.round(result.gate.confidenceFactors.regimeClarity * 100)} />
                <ConfidenceDetail label="× หักความขัดแย้ง" value={Math.round(result.gate.confidenceFactors.conflict * 100)} />
                <ConfidenceDetail label="× ระยะถึงวันงบ" value={Math.round(result.gate.confidenceFactors.earnings * 100)} />
              </dl>
            </section>
          ) : null}

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


const ZONE_COPY = {
  uptrend: 'อยู่เหนือโครงสร้างที่ยืนยันแล้ว',
  sideways: 'อยู่ในกรอบระหว่างแนวรับและแนวต้าน',
  downtrend: 'อยู่ใต้โครงสร้างที่ยืนยันแล้ว',
} as const;

const ZONE_MODE_COPY = {
  structural: 'กรอบยึดจาก swing high/low ล่าสุด',
  atr_band: 'ยังไม่มี swing ที่ใช้ได้ จึงใช้กรอบ ATR รอบ EMA20',
} as const;

/** A tilt inside a zone, worded as a lean rather than as a direction. */
function tiltCopy(score: number): string {
  const magnitude = Math.abs(score);
  if (magnitude < 15) return 'ยังไม่เอียงไปทางไหน';
  const direction = score > 0 ? 'ขึ้น' : 'ลง';
  return magnitude >= 40 ? `เอียง${direction}ชัด (${signed(score)})` : `เอียง${direction}เล็กน้อย (${signed(score)})`;
}

/**
 * The zone bar.
 *
 * Two markers, never one. The signal is computed from the last FINALIZED close;
 * the header is showing a live price that on an open market is a different
 * number. Drawing only the close would quietly invite a reader to compare a
 * trigger against the price they can see at the top of the screen, which is not
 * the price the trigger was measured from. So both are drawn, both are labelled,
 * and when the live price has crossed a trigger the card says so explicitly
 * instead of leaving the reader to notice.
 *
 * Every distance is stated in price AND in ATR, because "3.18 away" means
 * nothing without knowing that this instrument moves 4.06 on an average day.
 */
function ZoneBar({ zones, score, livePrice }: {
  zones: MarketSignalZones;
  score: number;
  livePrice: number | null;
}) {
  const { support, resistance, upperTrigger, lowerTrigger, referenceClose } = zones;
  // The drawn extent always covers both markers and both triggers, so nothing
  // the card talks about falls off the end of the bar it is drawn on.
  const candidates = [referenceClose, livePrice, support, resistance, upperTrigger, lowerTrigger]
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const low = Math.min(...candidates);
  const high = Math.max(...candidates);
  const span = high - low;
  /*
   * Clamped for DRAWING only. `positionPct` is reported unclamped on purpose —
   * IREN reads 113.7% and that is the fact that matters — but a marker placed
   * at 113.7% of the track would sit outside the bar it belongs to. The extent
   * already spans every value the card mentions, so this only guards against a
   * live price arriving from outside that set.
   */
  const at = (value: number) => span > 0 ? Math.min(100, Math.max(0, ((value - low) / span) * 100)) : 50;

  const nearestDistance = Math.abs(zones.upperDistance) <= Math.abs(zones.lowerDistance)
    ? zones.upperDistance : zones.lowerDistance;
  const liveCrossedUp = livePrice !== null && upperTrigger !== null && livePrice > upperTrigger;
  const liveCrossedDown = livePrice !== null && lowerTrigger !== null && livePrice < lowerTrigger;

  return (
    <div className="mt-4 rounded-xl border border-current/20 p-3" data-testid="signal-zone-bar">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm font-semibold">
          {ZONE_COPY[zones.zone]} · {tiltCopy(score)}
          {/*
            "Sideways" was doing the work of two very different sentences: QQQ
            0.05 ATR under its trigger and CL-F 4.9 ATR from the nearest one read
            identically. This says which, in words rather than as another chip.
          */}
          {zones.proximity === 'near_trigger' ? (
            <span className="ml-1 font-normal text-slate-300">
              · {zones.nearestTriggerAtr < 0 ? 'เลยแนวใกล้สุดมา' : 'ห่างแนวใกล้สุด'}
              {' '}{Math.abs(nearestDistance).toLocaleString('en-US', { maximumFractionDigits: 2 })}
              {' '}({Math.abs(zones.nearestTriggerAtr)} ATR)
            </span>
          ) : zones.proximity === 'deep_range' ? (
            <span className="ml-1 font-normal text-slate-400">
              · อยู่ห่างจากทุกแนว {Math.abs(zones.nearestTriggerAtr)} ATR
            </span>
          ) : null}
        </p>
        <p className="text-[11px] text-slate-400">
          อิงราคาปิด {referenceClose.toLocaleString('en-US', { maximumFractionDigits: 2 })} ({zones.referenceDate})
        </p>
      </div>

      <div className="relative mt-3 h-8" aria-hidden="true">
        <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-slate-700/60" />
        {lowerTrigger !== null && upperTrigger !== null ? (
          <div
            className="absolute top-3 h-2 rounded-full bg-current/25"
            style={{ left: `${at(lowerTrigger)}%`, width: `${Math.max(0, at(upperTrigger) - at(lowerTrigger))}%` }}
          />
        ) : null}
        {[lowerTrigger, upperTrigger].map((trigger) => trigger === null ? null : (
          <div key={trigger} className="absolute top-1 h-6 w-px bg-current/60" style={{ left: `${at(trigger)}%` }} />
        ))}
        {livePrice !== null && Number.isFinite(livePrice) ? (
          <div
            className="absolute top-2 h-4 w-1 -translate-x-1/2 rounded-full bg-current/40"
            style={{ left: `${at(livePrice)}%` }}
          />
        ) : null}
        <div
          className="absolute top-1 h-6 w-1.5 -translate-x-1/2 rounded-full bg-current"
          style={{ left: `${at(referenceClose)}%` }}
        />
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-1 text-[11px] text-slate-300 sm:grid-cols-2">
        <ZoneRow
          label="ถ้าปิดเหนือ"
          value={upperTrigger}
          distance={zones.upperDistance}
          distanceAtr={zones.upperDistanceAtr}
          note="จะเข้าเงื่อนไขโซนขาขึ้น"
        />
        <ZoneRow
          label="ถ้าปิดต่ำกว่า"
          value={lowerTrigger}
          distance={zones.lowerDistance}
          distanceAtr={zones.lowerDistanceAtr}
          note="จะเข้าเงื่อนไขโซนขาลง"
        />
      </dl>

      <p className="mt-2 text-[11px] leading-5 text-slate-400">
        {zones.positionPct === null
          ? ZONE_MODE_COPY[zones.mode]
          : `อยู่ที่ ${zones.positionPct}% ของกรอบ · ${ZONE_MODE_COPY[zones.mode]}`}
        {' · '}
        โซนนี้ยืนมา {zones.zoneAgeBars} แท่ง
        {zones.lastTestedBarsAgo === null ? '' : ` · แตะแนวล่าสุดเมื่อ ${zones.lastTestedBarsAgo} แท่งก่อน`}
      </p>

      {livePrice !== null && Number.isFinite(livePrice) ? (
        <p className="mt-1 text-[11px] leading-5 text-slate-400">
          ราคาสด {livePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          {liveCrossedUp || liveCrossedDown
            ? ` ผ่านแนว${liveCrossedUp ? 'บน' : 'ล่าง'}ไปแล้ว — รอปิดแท่งยืนยัน`
            : ' (ยังไม่ผ่านแนวทั้งสองฝั่ง)'}
        </p>
      ) : null}

      <p className="mt-1 text-[11px] leading-5 text-slate-500">ใช้ราคาปิดยืนยันเท่านั้น ไส้เทียนที่ทะลุแนวไม่นับ</p>
    </div>
  );
}

function ZoneRow({ label, value, distance, distanceAtr, note }: {
  label: string;
  value: number | null;
  distance: number | null;
  distanceAtr: number | null;
  note: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 py-0.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-mono text-white">
        {value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
      </dd>
      {value === null ? (
        <span className="text-slate-500">ไม่มีแนวที่ยืนยันแล้วฝั่งนี้</span>
      ) : (
        <span className="text-slate-500">
          ({distance === null ? '—' : distance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          {distanceAtr === null ? '' : ` · ${distanceAtr} ATR`}) {note}
        </span>
      )}
    </div>
  );
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
