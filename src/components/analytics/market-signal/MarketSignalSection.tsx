'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Info, Minus, TrendingDown, TrendingUp, TriangleAlert, Zap } from 'lucide-react';
import type { MarketSignalActionable, MarketSignalBias, MarketSignalHistory, MarketSignalResult, MarketSignalState, MarketSignalZones } from '@/src/lib/analytics/market-signal/types';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { formatBangkokDateTime, formatThaiDateOnly } from '@/src/lib/presentation/datetime';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import { LockedNotice } from '@/src/components/subscription/EntitlementGate';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';

const DISCLAIMER = 'Market Signal เป็นการสรุปข้อมูลทางเทคนิค ไม่รับประกันทิศทางราคา และไม่ใช่คำแนะนำซื้อขาย';

/*
 * The sentence P4a made unavoidable.
 *
 * The disclaimer under it has always said the card does not guarantee a
 * direction. That is a legal sentence, and readers have been trained by every
 * other product they use to read it as one. This is the different thing: a
 * statement of what the harness actually found when it followed 3,628
 * directional labels — that they were right about as often as the market was up
 * anyway. It goes ABOVE the disclaimer because it is the more useful of the two
 * and because a reader who stops after one line should stop after this one.
 *
 * It says "ยังไม่พบ" and not "ไม่มี". No edge was FOUND, over one corpus and one
 * period; that is a smaller claim than "there is no edge", and it is the one the
 * evidence supports. The provenance line under it is what lets a reader tell the
 * difference — a period and a corpus size, so the claim has edges.
 *
 * Every figure here is interpolated from `MARKET_SIGNAL_MEASURED`, never typed
 * in, and `src/config/signal-measured.test.ts` fails the build if that block
 * stops matching the newest run in `__calibration__/`. So the day a harness pass
 * finds something, this copy cannot stay as it is.
 */
const NOT_A_FORECAST = 'การ์ดนี้อธิบายสิ่งที่ราคาทำไปแล้ว ไม่ได้พยากรณ์สิ่งที่ราคาจะทำ — ผลทดสอบย้อนหลังยังไม่พบว่าทิศทางที่ระบุแม่นกว่าอัตราพื้นฐานของตลาด';
const MEASURED_PROVENANCE = `วัดจาก ${MARKET_SIGNAL_MEASURED.corpusInstruments} สินทรัพย์ · ${MARKET_SIGNAL_MEASURED.period.thai}`;

/**
 * The card's footer, in one component so that no render path can ship without it.
 *
 * There are four ways this card can render — locked, failed to load, not enough
 * data, and the real thing — and the honest lines belong on all four. A locked
 * preview is where somebody decides whether to pay for this, which makes it the
 * single most important place for the sentence to appear, not the one place it
 * would be convenient to leave out.
 *
 * Nothing here truncates, clamps or hides below a breakpoint. That is a
 * deliberate constraint rather than an accident of styling: a disclosure that
 * collapses on the screen most readers use is a disclosure that was not made.
 * `MarketSignalSection.test.tsx` asserts the classes stay that way.
 */
function SignalFooter({ tone }: { tone: string }) {
  return (
    <div className={`mt-3 space-y-1 ${tone}`} data-testid="signal-footer">
      <p className="text-xs leading-5">{NOT_A_FORECAST}</p>
      <p className="text-[11px] leading-5 opacity-80">{MEASURED_PROVENANCE}</p>
      <p className="text-xs leading-5">{DISCLAIMER}</p>
    </div>
  );
}

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
/*
 * Chip wording, and one place it was quietly making a forecast.
 *
 * "รอปิดยืนยันเบรกขึ้น" reads as a breakout that is on its way. P4a followed 299
 * of them: 53% confirm within five bars, 21% are still directional at twenty,
 * and 71% are back to sideways by then. So the chip now names an unresolved
 * STATE rather than an impending event, and the reason line underneath carries
 * the measured numbers.
 */
/*
 * The order, and the two that were promoted to the front of it.
 *
 * `conflicting_evidence` and `low_volume_confirmation` lead because they are the
 * two that tell a reader the card itself is on shaky ground — the evidence
 * disagrees with itself, or the move has no volume behind it. Everything below
 * them colours a reading that still stands. With only three chips drawn, an
 * ordering that let `pending_breakout` outrank "หลักฐานขัดแย้งกัน" would push the
 * warning into the dialog and leave the reassuring chip on the card.
 */
const FLAG_COPY: Record<string, string> = {
  conflicting_evidence: 'หลักฐานขัดแย้งกัน',
  low_volume_confirmation: 'วอลุ่มไม่ยืนยัน',
  pending_breakout: 'ผ่านขอบกรอบ ยังไม่ยืนยัน',
  pending_breakdown: 'หลุดขอบกรอบ ยังไม่ยืนยัน',
  stale_or_partial_data: 'ข้อมูลไม่สดหรือไม่ครบ',
  earnings_imminent: 'ใกล้ประกาศงบมาก',
  earnings_soon: 'ใกล้ประกาศงบ',
  pre_earnings_breakout: 'เบรกก่อนงบ',
  weak_confirmation: 'ยังยืนยันไม่ชัด',
  unfavorable_risk_reward: 'ระยะเสี่ยงมากกว่าระยะเป้า',
  risk_leg_inside_noise: 'ราคาชิดจุดที่โซนจะจบ',
  recent_flip: 'ป้ายเพิ่งเปลี่ยน',
  stale_zone: 'ไม่มีการแตะขอบกรอบมานาน',
  narrow_range: 'กรอบแคบผิดปกติ',
  overextended: 'ราคาไกลค่าเฉลี่ย',
  squeeze: 'ความผันผวนบีบตัว',
  bearish_divergence: 'ราคาขึ้นแต่แรงเริ่มหมด',
  bullish_divergence: 'ราคาลงแต่แรงขายเริ่มหมด',
  strong_momentum: 'โมเมนตัมแรง',
  high_volume: 'วอลุ่มสูง',
};
const FLAG_ORDER = Object.keys(FLAG_COPY);
/*
 * Three, down from four.
 *
 * A row of chips is read left to right until the reader stops, and on a 390px
 * screen four of them wrap to a second line that reads as decoration. Three fit
 * on one line at every width the card renders at, and the ordering above is what
 * makes the cut safe: the ones that survive it are the ones that change how the
 * card should be read. The rest are listed in "ทำไม?", not dropped.
 */
const MAX_FLAG_CHIPS = 3;

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
        {/*
          The locked preview is the one surface where the old promise and the new
          honesty would have met: this line sits a few centimetres above the
          footer saying the card does not forecast, so selling "ความมั่นใจ" here
          would contradict the sentence directly underneath it.
        */}
        <p className="mt-3 text-sm leading-6 text-slate-400" data-testid="technical-outlook-locked-summary">สรุปแนวโน้ม คะแนนทิศทาง และตัวชี้วัดทางเทคนิคจริง พร้อมเหตุผลว่าทำไมถึงสรุปแบบนั้น</p>
        <div className="mt-3">
          {/* The notice derives its own wording and its own required plan from
              the capability, so a commodity page asks for Pro and a stock page
              asks for Elite without either naming a tier here. */}
          <LockedNotice capability={capability} source="financials.technical-outlook" />
        </div>
        <SignalFooter tone="text-slate-500" />
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
        <SignalFooter tone="text-slate-500" />
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
        <SignalFooter tone="text-slate-500" />
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
        {/*
          NOT a percentage, and not on the headline line any more.
          P4a measured what this number is worth as a forecast: the 90-99 band
          hits 53-55% of the time, which is what the 20-29 band hits. A reader
          shown "93%" beside a direction reads a probability, and there is no
          honest way to print that figure large. So the headline carries the
          WORD — how well the evidence agrees — and the number itself moved into
          the breakdown, where it sits beside the terms that produced it.
        */}
        <span className="inline-flex min-h-11 items-center gap-2">
          ความสอดคล้องของหลักฐาน
          <strong className="font-mono text-white">{AGREEMENT_COPY[result.evidenceAgreementLabel]}</strong>
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
      {result.zones ? (
        <ZoneBar
          zones={result.zones}
          livePrice={livePrice}
          actionable={result.actionable ?? null}
        />
      ) : null}
      {result.history ? <HistoryStrip history={result.history} /> : null}
      <SignalFooter tone="text-slate-400" />

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
            <p className="mt-2 leading-6">ใช้ finalized 1D candles และหลักฐานจาก EMA, Momentum, ADX/DMI, Volume และ Price Structure</p>
            <p className="mt-2 leading-6 text-slate-400">
              ตัวเลขความสอดคล้อง {result.evidenceAgreement}/100 วัดว่าหลักฐานทั้งห้าหมวดไปทางเดียวกันแค่ไหน
              จากการวัดย้อนหลังพบว่าตัวเลขนี้ไม่ได้บอกโอกาสที่ราคาจะไปทางที่ระบุ
              ค่าสูงกับค่าต่ำให้ผลใกล้เคียงกัน จึงห้ามอ่านเป็นเปอร์เซ็นต์ความน่าจะเป็น
            </p>
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

          {result.zones ? (
            <ZoneDetails zones={result.zones} actionable={result.actionable ?? null} atr={result.metrics.atr14} />
          ) : null}

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
            <p>ความสอดคล้องของหลักฐาน: {AGREEMENT_COPY[result.evidenceAgreementLabel]} ({result.evidenceAgreement}/100 — ไม่ใช่ % โอกาสที่ราคาจะไปทางนั้น)</p>
            <p>Timeframe: {result.timeframe} · Finalized candles: {result.dataPoints.finalized}</p>
            <p>Updated: {formatBangkokDateTime(result.calculatedAt)}</p>
            <p>Source: {result.source ?? 'ไม่พร้อมใช้งาน'}</p>
            {/* The run every measured figure on this card came from, so a
                reader who wants to check one has a name to ask about. */}
            <p>Calibration run: {MARKET_SIGNAL_MEASURED.runId}</p>
          </div>
          <SignalFooter tone="text-slate-500" />
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



/**
 * The colour of one recorded day.
 *
 * By STATE and by nothing else. There is deliberately no ramp, no fade and no
 * opacity that grows with age: `docs/market-signal/p6-history-findings.md`
 * measured whether an older label is a more accurate one and found nothing —
 * not one age bucket beat the base rate by more than its own sampling error,
 * and the buckets old enough to be interesting contain 76, 4 and 0
 * observations. A visual that made older cells look more solid would be an
 * argument the evidence does not support, made in a language nobody reads
 * critically.
 */
const HISTORY_CELL_TONE: Record<MarketSignalState, string> = {
  STRONG_BULLISH: 'bg-emerald-400/80',
  BULLISH: 'bg-green-500/60',
  SIDEWAYS: 'bg-sky-400/40',
  SQUEEZE: 'bg-amber-400/60',
  OVEREXTENDED: 'bg-orange-400/60',
  BEARISH: 'bg-red-500/60',
  STRONG_BEARISH: 'bg-red-700/80',
};

/**
 * P6 — what this card said, for as long as anyone has been looking.
 *
 * ONE CELL PER RECORDED DAY, not per calendar day. A row exists for a day only
 * if somebody opened the card that day, so a fixed grid of thirty would be
 * mostly weekends and absences, and filling those cells with the neighbouring
 * label would put a label on a day the card never published. The density is
 * therefore stated as a number — "N of the last 30 days" — which is the same
 * disclosure without the invented cells.
 *
 * The age line sits with the three the zone bar already carries (zone, frame,
 * last touch) because it is the fourth member of the same family: a duration,
 * stated plainly, that a reader must not mistake for a confidence.
 */
function HistoryStrip({ history }: { history: MarketSignalHistory }) {
  const { entries, windowDays, currentLabelDays, recentFlip } = history;
  const latest = entries[entries.length - 1];

  return (
    <div className="mt-3" data-testid="signal-history">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-slate-400">ป้ายย้อนหลัง</span>
        <div className="flex flex-1 items-end gap-[2px]" aria-label="ประวัติป้าย 30 วัน" role="img">
          {entries.map((entry) => (
            <span
              key={entry.asOf}
              title={`${entry.asOf} · ${entry.state}`}
              className={`h-4 min-w-[3px] flex-1 rounded-[1px] ${HISTORY_CELL_TONE[entry.state]}`}
            />
          ))}
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-5 text-slate-400">
        {/*
          The label's own age, said as a duration and never as a score. The
          measurement behind the wording: a SIDEWAYS label is still SIDEWAYS
          twenty bars later 72.6% of the time while price is still inside the
          frame it named only 25.7% of the time, at EVERY age. So a long run is
          a fact about the engine's willingness to change its mind, and the
          sentence says exactly that rather than leaving a number to be read as
          endorsement.
        */}
        {currentLabelDays === null
          ? `${latest.state} บันทึกไว้วันเดียว ยังบอกไม่ได้ว่ายืนมานานแค่ไหน`
          : `ป้าย ${latest.state} นี้ยืนมา ${currentLabelDays} วัน`}
        {' · '}
        บันทึกได้ {entries.length} วัน จาก {windowDays} วันที่ผ่านมา
      </p>
      <p className="text-[11px] leading-5 text-slate-500">
        ป้ายที่ยืนนานไม่ได้แปลว่าแม่นกว่า — วัดย้อนหลังแล้วไม่พบว่าอายุของป้ายสัมพันธ์กับความแม่น
        {recentFlip ? ' · ป้ายเพิ่งเปลี่ยนภายในไม่กี่วัน จึงยังไม่นิ่ง' : ''}
      </p>
    </div>
  );
}

/**
 * The zone, said the way somebody who has never read a chart would say it.
 *
 * The old wording ("อยู่เหนือโครงสร้างที่ยืนยันแล้ว") is accurate and unreadable:
 * "โครงสร้าง" is a chartist's word for the frame drawn on the bar right below
 * this sentence, and a reader who does not already know that learns nothing.
 * These three name the SAME three fields the bar is divided into, in the same
 * words, so the sentence and the picture teach each other.
 */
const ZONE_COPY = {
  uptrend: 'ราคาขึ้นมาเหนือกรอบเดิมแล้ว',
  sideways: 'ราคายังอยู่ในกรอบเดิม',
  downtrend: 'ราคาหลุดลงมาใต้กรอบเดิมแล้ว',
} as const;

/**
 * The names written ON the bar, left to right, low to high.
 *
 * Left is down and right is up, which is the one arrangement a reader does not
 * have to be taught: it is how every price axis they have ever seen is drawn.
 * Before this the two conditions sat in a two-column grid with "ถ้าปิดเหนือ" in
 * the left cell, so the bar said one thing and the labels under it said the
 * opposite.
 */
const ZONE_SEGMENT_COPY = {
  downtrend: 'ขาลง',
  sideways: 'กรอบเดิม',
  uptrend: 'ขาขึ้น',
} as const;

/**
 * The three agreement levels, worded so none of them reads as a probability.
 *
 * "High confidence" is a sentence about the future. "หลักฐานไปทางเดียวกันมาก" is
 * a sentence about the evidence on the card, which is the only thing this number
 * has ever measured.
 */
const AGREEMENT_COPY = {
  High: 'หลักฐานไปทางเดียวกันมาก',
  Medium: 'หลักฐานไปทางเดียวกันบ้าง',
  Low: 'หลักฐานยังกระจัดกระจาย',
  Insufficient: 'ข้อมูลไม่พอ',
} as const;

/*
 * Where the frame's edges came from — now dialog-only.
 *
 * "swing high/low" is the term of art for the pivots the frame is anchored to.
 * It is the right word and it is meaningless to the reader this card is for, so
 * it moved into "ทำไม?" with the rest of the machinery rather than being
 * softened into something that no longer names the thing.
 */
const ZONE_MODE_COPY = {
  structural: 'กรอบยึดจาก swing high/low ล่าสุด',
  atr_band: 'ยังไม่มี swing ที่ใช้ได้ จึงใช้กรอบ ATR รอบ EMA20',
} as const;

/**
 * Which of the bar's three fields a price is standing in.
 *
 * This is NOT `zones.zone`. The engine's label is the zone of the last
 * FINALIZED close after confirmation and hysteresis, and neither of those
 * applies to a price that is still moving. What the bar draws is geometry —
 * which side of which cut a mark is on — so the sentence about the live price
 * is derived the same way, off the same two triggers the picture is cut with.
 */
type ZoneSide = 'below' | 'inside' | 'above';

function sideOf(price: number, lowerTrigger: number, upperTrigger: number): ZoneSide {
  if (Number.isFinite(upperTrigger) && price > upperTrigger) return 'above';
  if (Number.isFinite(lowerTrigger) && price < lowerTrigger) return 'below';
  return 'inside';
}

/**
 * The live price, when it is standing where the close is standing.
 *
 * The line this replaced said "ยังไม่ผ่านขอบกรอบทั้งสองฝั่ง", which is true of a
 * price sitting in the middle of the frame and equally true of one sitting a
 * hair under the trigger, and says nothing about the case that matters — a live
 * price in a different field from the close. These name the field instead.
 */
const LIVE_SAME_SIDE_COPY = {
  above: 'ยังอยู่เหนือกรอบเดิมเหมือนราคาปิด',
  inside: 'ยังอยู่ในกรอบเดิมเหมือนราคาปิด',
  below: 'ยังอยู่ใต้กรอบเดิมเหมือนราคาปิด',
} as const;

/**
 * The live price, when it has left the field the close is in.
 *
 * Said as the move that happened rather than as a crossing, because "ผ่านขอบบน
 * ไปแล้ว" reads as an event the card is endorsing. The second half is the rule
 * that actually governs the label, and it is on this line rather than in a
 * footnote because this line is the one a reader lands on when the two numbers
 * disagree.
 */
function liveMoveCopy(live: ZoneSide, close: ZoneSide): string {
  if (live === 'above') return 'ขึ้นไปเหนือกรอบเดิมแล้ว';
  if (live === 'below') return 'หลุดลงใต้กรอบเดิมแล้ว';
  return close === 'above' ? 'ตกกลับเข้ากรอบเดิมแล้ว' : 'ขึ้นกลับเข้ากรอบเดิมแล้ว';
}

/** How fresh a zone or frame has to be before the card says so out loud. */
const FRESH_ZONE_BARS = 3;

/** One distance as a percentage of the price it is measured from. */
function percentText(distance: number, reference: number): string {
  return `${(Math.abs(distance) / Math.abs(reference) * 100).toFixed(1)}%`;
}

/**
 * A distance, in the only unit a beginner already owns.
 *
 * ATR is the honest unit — it is what makes "3.18 away" mean something on an
 * instrument that moves 4.06 on an average day — and it is also a unit nobody
 * outside a trading desk has ever met. So every distance on the card is now a
 * percentage of the price the reader is looking at, and the ATR figure it was
 * derived alongside is in "ทำไม?" for anyone who wants the other unit.
 *
 * `distance` keeps the engine's sign convention: positive means the level is
 * still ahead of the close, negative means price has already gone through it.
 * Deriving the percentage from the ENGINE's distance rather than from the two
 * prices is deliberate — it is the same number the payload reports, in another
 * unit, and cannot drift away from it.
 *
 * It says "สูงกว่าราคาปิด" and never "สูงกว่าตอนนี้". The base is the last
 * finalized close, which on an open market is not the price on screen, so a
 * percentage that called itself "ตอนนี้" was measured from one number and named
 * after another. Naming the base is the whole fix: the reader can now tell,
 * without opening anything, which of the two prices on the bar this is off.
 */
function relativeCopy(distance: number | null, reference: number, side: 'above' | 'below'): string {
  if (distance === null || !Number.isFinite(distance) || !Number.isFinite(reference) || reference === 0) return '';
  if (distance < 0) return side === 'above' ? 'ราคาผ่านขึ้นไปแล้ว' : 'ราคาหลุดลงมาแล้ว';
  return `${side === 'above' ? 'สูงกว่า' : 'ต่ำกว่า'}ราคาปิด ${percentText(distance, reference)}`;
}

/**
 * Roughly how wide a label will be drawn, in pixels, without measuring it.
 *
 * The bar is laid out on the server at a width nobody knows yet, so the two
 * decisions this file has to make — is this label about to hang off the track,
 * is it about to land on the label beside it — need the label's own width
 * BEFORE any browser has drawn it. A per-glyph estimate is the only version of
 * that which works in one pass, and it deliberately runs a little wide: an
 * estimate that is too big pins a label closer to its mark than it had to be,
 * an estimate that is too small puts one label on top of another, and only the
 * second one costs a reader anything.
 *
 * The numbers are Chrome's, measured on the labels this bar actually draws over
 * the app's own font stack at the size `text-[10px]` really renders (12px — the
 * `.text-\[10px\]` override in `globals.css` lifts every one of these captions):
 * digits 5.75px, Thai base glyphs 8.24px, a monospace advance of 6.6px. Each is
 * rounded up from there. `qa:signal-zone-bar` re-measures every drawn label
 * against the estimate the layout used, so a font change that invalidates this
 * table fails there rather than in front of a reader.
 */
const LABEL_GLYPH_PX = {
  mono: 6.9,
  digit: 6.2,
  space: 4,
  punctuation: 3.6,
  middot: 6.6,
  /** Thai vowels and tone marks stack ON their consonant and advance nothing. */
  combining: 0.5,
  other: 9,
} as const;

/**
 * The Thai combining marks the captions on this bar use: ปิดล่าสุด, ราคาตอนนี้.
 * Written as code points rather than as glyphs because a mark on its own is
 * invisible in most editors, and an invisible character in a character class is
 * a bug nobody can see.
 */
const THAI_COMBINING = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;

/**
 * The two sizes the bar is drawn at, and why the switch is on the TRACK.
 *
 * The block used to be capped at 640px, which fixed the wrong half of the
 * problem it was aimed at. Stretched across a desktop card the bar was hard to
 * read for two separate reasons: every distance on it grew, AND nothing drawn
 * on it grew with the distance, so a 12px field name floated in 600px of its
 * own colour. Capping the width fixed the first and made the second permanent —
 * a block two thirds the width of the card, with phone-sized type on it, and a
 * hand's width of empty card beside it.
 *
 * So the cap is gone and the drawing scales instead. Everything a reader takes
 * off the picture — the three field names, the two edge prices, the price
 * captions, the bar itself, the marks on it and the sentences under it — has a
 * compact size and a wide one, and the wide one is chosen from the MEASURED
 * width of the track rather than from the viewport. The track is what the
 * picture is drawn on: the same window gives the bar a different width inside a
 * two-column layout than inside a full-bleed one, and a viewport breakpoint
 * cannot tell those apart.
 *
 * `estimate` is the multiplier on `LABEL_GLYPH_PX`, whose table is measured at
 * the 12px `text-[10px]` actually renders (`globals.css` lifts it). It is the
 * ratio of the drawn size to that 12px, so the first-paint estimate is in the
 * same units at both sizes; once the browser has measured the real spans the
 * estimate is not consulted at all. `padding` is what each kind of caption's
 * own horizontal padding costs, both sides, and it does NOT scale with the
 * glyphs because padding is a spacing utility rather than a length in ems.
 */
const WIDE_TRACK_PX = 900;

const ZONE_SCALE = {
  compact: {
    caption: {
      price: 'px-1.5 py-0.5 text-[10px] font-semibold',
      level: 'font-mono text-[10px]',
      name: 'px-1 text-[10px] font-semibold tracking-wide',
    },
    padding: { price: 12, name: 8 },
    estimate: { price: 1, level: 1, name: 1 },
    prose: { headline: 'text-sm', note: 'text-[11px] leading-5' },
    row: {
      prices: 'h-7',
      priceMark: 'top-[21px]',
      priceStem: 'h-[7px]',
      bar: 'h-9',
      edges: 'mt-1 h-6',
      edgeStem: 'h-[7px]',
      edgeLeader: 'top-[7px]',
      edgeLabel: 'top-[8px]',
    },
    marker: { close: '-top-0.5 h-10 w-1.5', live: 'top-1 h-7 w-1' },
    /** The close marker's own thickness, which is what it can hide behind it. */
    closeMarkPx: 6,
  },
  wide: {
    caption: {
      price: 'px-2 py-1 text-[14px] leading-5 font-semibold',
      level: 'font-mono text-[13px] leading-5',
      name: 'px-1.5 text-[15px] leading-5 font-semibold tracking-wide',
    },
    padding: { price: 16, name: 12 },
    estimate: { price: 14 / 12, level: 13 / 12, name: 15 / 12 },
    prose: { headline: 'text-base', note: 'text-[13px] leading-6' },
    row: {
      prices: 'h-9',
      priceMark: 'top-[29px]',
      priceStem: 'h-[7px]',
      bar: 'h-12',
      edges: 'mt-1.5 h-[30px]',
      edgeStem: 'h-[9px]',
      edgeLeader: 'top-[9px]',
      edgeLabel: 'top-[10px]',
    },
    marker: { close: '-top-0.5 h-[52px] w-2', live: 'top-1.5 h-9 w-1.5' },
    closeMarkPx: 8,
  },
} as const;

type ZoneScale = (typeof ZONE_SCALE)[keyof typeof ZONE_SCALE];

/**
 * Which size a track of this width is drawn at.
 *
 * A track of 0 means "not measured yet", never "no room": the server render and
 * the first client render both land there, and they have to agree or hydration
 * is comparing two different cards. Compact is the answer for both, and the
 * measured answer arrives in the layout effect, before the first paint.
 */
export function zoneScaleFor(track: number): ZoneScale {
  return track > WIDE_TRACK_PX ? ZONE_SCALE.wide : ZONE_SCALE.compact;
}

export function estimateLabelWidth(text: string, { padding = 0, mono = false, scale = 1 } = {}): number {
  let width = 0;
  for (const character of text) {
    if (mono) width += LABEL_GLYPH_PX.mono;
    else if (character >= '0' && character <= '9') width += LABEL_GLYPH_PX.digit;
    else if (character === ' ') width += LABEL_GLYPH_PX.space;
    else if (character === '.' || character === ',') width += LABEL_GLYPH_PX.punctuation;
    else if (character === '·') width += LABEL_GLYPH_PX.middot;
    else if (THAI_COMBINING.test(character)) width += LABEL_GLYPH_PX.combining;
    else width += LABEL_GLYPH_PX.other;
  }
  return Math.ceil(width * scale + padding);
}

/**
 * Which part of a label sits on the mark it names.
 *
 * `centre` is the readable arrangement and the default. The other two are for
 * the one case centring cannot serve: two labels whose marks are close enough
 * that centred boxes would overlap. Then each grows AWAY from the other — the
 * lower one ends on its mark, the upper one starts on its mark — which buys the
 * full width of the track between them without either label leaving its mark.
 */
export const LABEL_BIAS = { centre: 0.5, growLeft: 1, growRight: 0 } as const;

/** A caption, and everything needed to place it: `at` is a percent of the track. */
export interface FloatingLabel { at: number; width: number; bias: number }

/** Closer than this and two captions read as one run of text. */
const LABEL_MIN_GAP_PX = 4;

/** Where a label's left edge lands on a track this wide, in px. */
function labelLeftPx(track: number, label: FloatingLabel): number {
  const anchored = (label.at / 100) * track - label.width * label.bias;
  return Math.min(Math.max(anchored, 0), Math.max(0, track - label.width));
}

/**
 * Would these two labels touch?
 *
 * Answered on the track the reader actually has, which is why `track` is a
 * required argument rather than a constant. The version this replaced answered
 * it on a hypothetical 216px track at every width, so a 640px bar with 90px of
 * clear air between two captions merged them anyway — and a merged caption is
 * strictly worse than two, because "ปิดล่าสุด 44.9 · ราคาตอนนี้ 42.14" over two
 * marks a centimetre apart no longer says which number belongs to which line.
 *
 * The two boxes are the whole rule. Not the distance between the prices, not a
 * percentage of the frame, not a threshold: where the two captions are actually
 * drawn, and whether those rectangles touch. `ZoneBar` feeds this the widths it
 * measured off the rendered spans, so the answer is the one a reader can see.
 */
export function labelsCollide(a: FloatingLabel, b: FloatingLabel, track: number): boolean {
  const aLeft = labelLeftPx(track, a);
  const bLeft = labelLeftPx(track, b);
  return aLeft < bLeft + b.width + LABEL_MIN_GAP_PX && bLeft < aLeft + a.width + LABEL_MIN_GAP_PX;
}

const trackPct = (value: number) => `${Math.round(Math.min(100, Math.max(0, value)) * 100) / 100}%`;
const trackPx = (value: number) => `${Math.round(value * 100) / 100}px`;

/** The label's left edge, as CSS, before it is clamped into the track. */
function labelAnchor(label: FloatingLabel): string {
  return `${trackPct(label.at)} - ${trackPx(label.width * label.bias)}`;
}

/** The same edge, clamped so no part of the label can leave the track. */
function labelLeft(label: FloatingLabel): string {
  return `clamp(0px, ${labelAnchor(label)}, 100% - ${trackPx(label.width)})`;
}

/**
 * Where a floating label sits, and why it is never off on its own.
 *
 * Two rules, in this order. The label is CENTRED on its mark, because a caption
 * centred over a line is the arrangement a reader does not have to think about.
 * And it is CLAMPED into the track, because at 390px there is no gutter to hang
 * into — an unclamped caption on a six-figure price runs out under the card's
 * padding, which `qa:signal-zone-bar` caught on "ปิดล่าสุด 121,884".
 *
 * The clamp is done in CSS rather than here on purpose. The previous version
 * switched to an edge-anchored position at fixed percentages (below 40%, above
 * 60%), which meant a label whose mark stood at 41% was drawn entirely to the
 * RIGHT of it — the caption and the line it named were a label-width apart, and
 * the reader had to work out which mark was theirs. `clamp()` mixes the two
 * units the problem is actually in: the mark is a percentage of the track, the
 * label's own width is pixels, so the caption stays exactly centred at every
 * width and moves only when it would otherwise leave the card.
 *
 * Exported because this is the whole mobile-safety argument for the bar, and it
 * is worth a test rather than an eyeball.
 */
export function zoneLabelStyle(label: FloatingLabel): React.CSSProperties {
  return { left: `clamp(0px, calc(${labelAnchor(label)}), calc(100% - ${trackPx(label.width)}))` };
}

/**
 * The hairline from a caption down to the mark it names.
 *
 * A clamped label is a label that is no longer centred on its mark, and with two
 * captions in one row that is exactly when a reader has to guess which caption
 * belongs to which line. The leader removes the guess: it runs from the mark to
 * the middle of its own caption, so it is zero-width in the ordinary centred
 * case and only appears when there is something to explain.
 *
 * It is one element rather than two because the label may end up on either side
 * of its mark, and `min()`/`max()` express "between these two x positions"
 * without the component having to know which side won.
 */
export function zoneLeaderStyle(markerAt: number, label: FloatingLabel): React.CSSProperties {
  const mark = trackPct(markerAt);
  const centre = `(${labelLeft(label)} + ${trackPx(label.width / 2)})`;
  return {
    left: `min(${mark}, ${centre})`,
    width: `calc(max(${mark}, ${centre}) - min(${mark}, ${centre}))`,
  };
}

/** A caption on the bar: what it says, which marks it names, how wide it will be. */
interface Caption extends FloatingLabel {
  key: string;
  text: string;
  /** Drawn in the monospace face, which is narrower per character. */
  mono: boolean;
  marks: Array<{ key: string; at: number }>;
}

function caption(
  key: string,
  text: string,
  at: number,
  marks: Array<{ key: string; at: number }>,
  { mono = false, width, size }: { mono?: boolean; width?: number; size: ZoneScale },
): Caption {
  return {
    key,
    text,
    at,
    marks,
    mono,
    bias: LABEL_BIAS.centre,
    // The measured width when the browser has given one, the estimate until
    // then. The estimate exists for the first paint and for the server; it is
    // not what the collision rule runs on once there is a real box to read.
    // Either way it is the estimate for the size the caption is DRAWN at — a
    // 14px caption placed on a 12px estimate is a caption placed off its box.
    width: width ?? (mono
      ? estimateLabelWidth(text, { mono: true, scale: size.estimate.level })
      : estimateLabelWidth(text, { padding: size.padding.price, scale: size.estimate.price })),
  };
}

/**
 * Two captions in one row, moved as little as it takes to keep them apart.
 *
 * Centred first, because that is the arrangement that needs no explaining. If
 * centring overlaps them, each one grows AWAY from the other — the left caption
 * ends on its mark, the right one starts on it — which is the most room two
 * labels can have while both still sit on the line they name. `null` means even
 * that is not enough, and the caller has to say both things in one caption.
 *
 * The answer is computed on the track passed in — the measured one — so a wide
 * bar keeps two captions that a phone has to collapse. Left-to-right order.
 */
export function spreadLabels<T extends FloatingLabel>(a: T, b: T, track: number): [T, T] | null {
  const [left, right] = a.at <= b.at ? [a, b] : [b, a];
  if (!labelsCollide(left, right, track)) return [left, right];
  const grown: [T, T] = [
    { ...left, bias: LABEL_BIAS.growLeft },
    { ...right, bias: LABEL_BIAS.growRight },
  ];
  return labelsCollide(grown[0], grown[1], track) ? null : grown;
}

/**
 * The clear air a field's name has to keep from the name of the field beside it.
 *
 * Two names that touch read as one word, and on this bar they are three
 * different claims about three different price ranges. 12px is a little under
 * one glyph at the compact size and a little over half of one at the wide size,
 * which is the smallest gap that still reads as a gap.
 */
const NAME_MIN_GAP_PX = 12;

/**
 * Where a field writes its own name, given where the price marker is standing.
 *
 * THE OUTER TWO are written against the cut they are about, not in the middle
 * of their own field. "ขาลง" is the name of everything BELOW the lower trigger,
 * and the trigger is that field's right-hand edge; "ขาขึ้น" is everything above
 * the upper one, whose edge is on its left. Centring put each name as far from
 * the line that defines it as the field allowed — on a wide bar that was 200px
 * of empty red before the word explaining the red.
 *
 * THE MIDDLE ONE IS ALWAYS CENTRED, and this is the fix for the bug that read
 * as "กรอบเดิม ชิดซ้ายจนเบียด ขาลง". The rule this replaced moved any name off
 * its preferred end when the marker was anywhere in that HALF of the field, so
 * a close sitting at 65% of a 600px middle field — nowhere near the 80px name
 * in the centre of it — shoved "กรอบเดิม" hard against the lower cut, where
 * "ขาลง" was already sitting with its own right edge on that same cut. The two
 * names ended up touching, which is the one arrangement that costs a reader
 * both of them.
 *
 * The middle field is the only one bounded by a name on BOTH sides, so any
 * alignment other than centred puts it flush against one of them: there is no
 * marker-avoiding position for it that is not worse than the marker. A 6px
 * translucent mark crossing one glyph of a centred name is legible; two names
 * with no gap are not. When the field is too tight to give the centred name
 * `NAME_MIN_GAP_PX` on both sides it is not drawn at all — see `fitsItsName`.
 *
 * The marker still wins the tie on the outer two, where moving away from the
 * cut also moves away from the middle name. It is asked as the question it
 * actually is — does the mark land ON the glyphs — against the measured track
 * and the measured name, rather than the half-of-the-field guess that produced
 * the bug. Unmeasured (`track` 0, i.e. the server and the first client render)
 * nothing moves, so both halves of hydration draw the same card.
 */
function nameAlignment(
  segment: { id: string; left: number; width: number },
  marker: { at: number; width: number },
  { track, nameWidth }: { track: number; nameWidth: number },
): string {
  if (segment.id === 'sideways') return 'justify-center';
  const preferred = segment.id === 'downtrend' ? 'justify-end' : 'justify-start';
  if (!(track > 0) || !(nameWidth > 0) || segment.width <= 0) return preferred;
  const fieldPx = (segment.width / 100) * track;
  if (fieldPx < nameWidth) return preferred;
  const fieldLeft = (segment.left / 100) * track;
  const nameLeft = preferred === 'justify-end'
    ? fieldLeft + fieldPx - nameWidth
    : fieldLeft;
  const markLeft = (marker.at / 100) * track - marker.width / 2;
  const clears = markLeft + marker.width <= nameLeft || markLeft >= nameLeft + nameWidth;
  return clears ? preferred : (preferred === 'justify-end' ? 'justify-start' : 'justify-end');
}

const priceText = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * The same price, short enough to sit on the bar.
 *
 * A caption on the bar is a LOCATOR — it tells a reader which mark is which —
 * and two decimal places on a six-figure instrument buy nothing there while
 * costing 25px. `qa:signal-zone-bar` found the cost: at 320px the two edge
 * prices of a BTC frame ("103,192.08" and "120,091.68") ran into each other in
 * the middle of the bar. Above a thousand the cents are dropped here and here
 * only; the list under the bar still carries every digit the engine reported.
 */
const markerPriceText = (value: number) =>
  value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 });

/**
 * What the browser says the zone block actually measures.
 *
 * Every placement decision on this bar is a question about two rectangles —
 * does this caption still fit beside that one — and until this hook there was
 * nothing on the page answering it. The layout ran on `estimateLabelWidth`
 * against a hypothetical 216px track, which is the narrowest phone; on a 640px
 * bar that answered "these two captions collide" about captions with 90px of
 * clear air between them, and merged two labels that had room to stand apart.
 *
 * So the widths are read off the rendered spans and the track is read off the
 * row itself. The estimate stays for the first paint and for the server render,
 * where there is no browser to ask, and a track of 0 means exactly that — not
 * measured — never "no room".
 *
 * The captions are measured on invisible COPIES rather than on the drawn
 * labels, because the drawn ones depend on the decision: once two captions have
 * merged, the two separate boxes no longer exist to be measured, and the bar
 * could never discover that a wider window had made room for them again. The
 * copies carry every caption the bar might draw, so the same measurement
 * answers the question in both directions and the arrangement follows the
 * window instead of latching.
 */
interface ZoneMetrics { track: number; widths: Record<string, number> }

/**
 * Measured before the browser paints, so the corrected arrangement is the first
 * one a reader sees — and `useEffect` on the server, where React warns that a
 * layout effect can do nothing and is right.
 */
const useMeasureEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useZoneMetrics(probeKey: string): [ZoneMetrics | null, React.RefObject<HTMLDivElement | null>] {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<ZoneMetrics | null>(null);

  const read = useCallback(() => {
    const node = trackRef.current;
    if (!node) return;
    const track = node.getBoundingClientRect().width;
    if (!(track > 0)) return;
    const widths: Record<string, number> = {};
    for (const probe of node.querySelectorAll<HTMLElement>('[data-measure]')) {
      const key = probe.dataset.measure;
      if (key) widths[key] = probe.getBoundingClientRect().width;
    }
    setMetrics((previous) => {
      // Re-rendering on a subpixel wobble would put the bar in a resize loop
      // for no visible gain, so an unchanged reading returns the same object.
      const unchanged = previous !== null
        && Math.abs(previous.track - track) < 0.5
        && Object.keys(widths).length === Object.keys(previous.widths).length
        && Object.entries(widths).every(([key, value]) => Math.abs((previous.widths[key] ?? -1) - value) < 0.5);
      return unchanged ? previous : { track, widths };
    });
  }, []);

  /*
   * The size the bar has just decided to draw itself at, as an effect
   * dependency.
   *
   * A wider window changes the track first and the type second: the render that
   * discovers `track > WIDE_TRACK_PX` is the render that first draws every
   * caption at the wide size, and the widths still in `metrics` at that moment
   * were measured on the compact copies. Re-running the read in the SAME layout
   * phase — which is what a changed dependency on a layout effect buys — means
   * no arrangement computed from the old widths is ever painted.
   */
  const scaleKey = zoneScaleFor(metrics?.track ?? 0) === ZONE_SCALE.wide ? 'wide' : 'compact';

  useMeasureEffect(() => {
    const node = trackRef.current;
    if (!node) return;
    read();
    // jsdom has no ResizeObserver and no layout either, so there is nothing for
    // it to observe; the one-shot read above is the whole contract there.
    if (typeof ResizeObserver === 'undefined') return;
    // The track for the window changing, and each copy for the FONT changing:
    // a webfont that arrives after first paint makes every caption wider
    // without moving the row it sits in.
    const observer = new ResizeObserver(read);
    observer.observe(node);
    for (const probe of node.querySelectorAll('[data-measure]')) observer.observe(probe);
    return () => observer.disconnect();
  }, [read, probeKey, scaleKey]);

  return [metrics, trackRef];
}

/**
 * The zone bar.
 *
 * THREE FIELDS, not one track with tick marks. The bar a reader met before this
 * drew one grey rail, tinted the middle of it, and put every number underneath
 * in a two-column grid whose LEFT cell was the UP condition. Nothing about it
 * said which side of the picture was which, so the one thing the drawing could
 * have taught for free — down is left, up is right — it taught backwards.
 * Now the two triggers cut the rail into the three zones the engine actually
 * labels, each field carries its own name, and the edge prices sit under the
 * cut they belong to instead of flush with the ends of the bar.
 *
 * The drawn extent is padded past both triggers on purpose. Every candidate
 * price used to set it, so on the common instrument the triggers WERE the
 * extremes and the two outer fields had zero width. Padding by a share of the
 * frame's own height keeps all three fields visible at every price, and marker
 * influence is clamped so a price far outside the frame cannot squeeze a field
 * down to nothing.
 *
 * Two markers, never one. The signal is computed from the last FINALIZED close;
 * the header is showing a live price that on an open market is a different
 * number. Drawing only the close would quietly invite a reader to compare a
 * trigger against the price they can see at the top of the screen, which is not
 * the price the trigger was measured from. The close is labelled "ปิดล่าสุด"
 * and it is the price every percentage on this card is measured from; the live
 * one is labelled "ราคาตอนนี้" and is never the base of a percentage.
 */
function ZoneBar({ zones, livePrice, actionable }: {
  zones: MarketSignalZones;
  livePrice: number | null;
  actionable: MarketSignalActionable | null;
}) {
  const { upperTrigger, lowerTrigger, referenceClose, zone } = zones;
  const hasFrame = Number.isFinite(lowerTrigger) && Number.isFinite(upperTrigger) && upperTrigger > lowerTrigger;
  const frameLow = Math.min(lowerTrigger, upperTrigger);
  const frameHigh = Math.max(lowerTrigger, upperTrigger);
  /*
   * The padding, and why it is a share of the frame rather than a constant.
   * The outer fields have to stay legible on an instrument trading at 4 and on
   * one trading at 40,000, and the only length on the card that scales with
   * both is the frame's own height. 0.4 on each side gives roughly 22/56/22.
   */
  const pad = hasFrame ? (frameHigh - frameLow) * 0.4 : Math.max(Math.abs(referenceClose) * 0.02, 0.01);
  const reach = pad * 2;
  const marks = [referenceClose, livePrice]
    .filter((value): value is number => value !== null && Number.isFinite(value))
    // Clamped for EXTENT only. A price three frame-heights away must not flatten
    // the far field to a sliver; `at` already pins such a marker to the end.
    .map((value) => Math.min(Math.max(value, frameLow - reach), frameHigh + reach));
  const low = Math.min(frameLow - pad, ...marks.map((value) => value - pad * 0.4));
  const high = Math.max(frameHigh + pad, ...marks.map((value) => value + pad * 0.4));
  const span = high - low;
  const at = (value: number) => span > 0 ? Math.min(100, Math.max(0, ((value - low) / span) * 100)) : 50;

  const lowerAt = hasFrame ? at(lowerTrigger) : 0;
  const upperAt = hasFrame ? at(upperTrigger) : 100;
  const closeAt = at(referenceClose);

  const nearestDistance = Math.abs(zones.upperDistance) <= Math.abs(zones.lowerDistance)
    ? zones.upperDistance : zones.lowerDistance;
  /*
   * The live price, and the one comparison the card has to make with it.
   *
   * A live price in a DIFFERENT field from the close is the case this whole
   * pair of marks exists for: the header says BULLISH off a close above the
   * frame while the price on screen has already fallen back inside it. Both
   * sides are read off the two triggers, never off `zones.zone`, so the
   * sentence and the picture can never disagree.
   */
  const hasLive = livePrice !== null && Number.isFinite(livePrice);
  const liveAt = hasLive ? at(livePrice as number) : null;
  const liveSide = hasLive ? sideOf(livePrice as number, lowerTrigger, upperTrigger) : null;
  const closeSide = sideOf(referenceClose, lowerTrigger, upperTrigger);
  const liveDiverges = hasFrame && liveSide !== null && liveSide !== closeSide;
  /*
   * P4.5, said in words instead of in two bar counts.
   *
   * The measurement behind it: 74% of sideways observations see price close
   * outside the frame within twenty bars, and two thirds of those keep the
   * label only because the frame re-anchored around the move. So a zone that is
   * old but sitting on a frame three bars old is exactly as unsettled as a new
   * one, and the reader needs to be told so — but "โซนนี้ยืนมา 45 แท่ง ·
   * กรอบปัจจุบันตั้งมา 3 แท่ง" told them by handing them the arithmetic. Taking
   * the smaller of the two ages fires the warning on precisely the same cases;
   * both numbers are in "ทำไม?" for whoever wants to check the working.
   */
  const freshlyFormed = Math.min(zones.zoneAgeBars, zones.frameAgeBars) <= FRESH_ZONE_BARS;

  /*
   * The captions, in two rows that cannot reach each other.
   *
   * ROW ONE, above the bar: the prices, one caption per mark. ROW TWO, below it:
   * the two edge prices, and nothing else ever. The live caption used to sit in
   * a third row directly under the edge prices, which put "สด 42.59" and the
   * frame's "43.23" a few pixels apart with nothing between them — two numbers
   * of different kinds reading as one row of numbers. Separating them by KIND
   * rather than by a row of padding is what makes that unrepeatable: a price the
   * card measures from is above the bar, a level the frame is made of is below
   * it, and neither row can grow into the other.
   *
   * WHAT EACH ONE IS CALLED. The close used to be "ตอนนี้" and the live price
   * "สด", which is the naming a reader arrives with turned exactly backwards:
   * "ตอนนี้" sat on a finalized close and the price actually trading right now
   * was called by a word that names nothing a beginner owns. Each mark is now
   * named by WHEN it happened — "ปิดล่าสุด" and "ราคาตอนนี้" — and every
   * percentage on the card says which of the two it was measured from.
   *
   * "ล่าสุด" and not "เมื่อวาน". Yesterday is the wrong word on a Monday and
   * after every holiday, and a US session closes in the small hours of a Thai
   * morning, so the close a Bangkok reader is looking at is routinely not from
   * the calendar day they would call yesterday. "ล่าสุด" is the same length and
   * has no exceptions to remember. The names stay short because they are drawn
   * ON the track: which session it actually was, as a date, is the footnote at
   * the bottom of the block, where a long sentence costs nothing.
   */
  const closeText = `ปิดล่าสุด ${markerPriceText(referenceClose)}`;
  /*
   * TWO PRICES OR ONE, decided on the numbers a reader can actually see.
   *
   * When the live price rounds to the same figure the close rounds to, the bar
   * was drawing "ปิดล่าสุด 42 · ราคาตอนนี้ 42" over a single mark — the two
   * marks are at the same percent, so they paint as one line — and telling the
   * reader that two identical numbers are two different facts. Nothing about
   * that is a collision the spread/merge machinery below can fix, because that
   * machinery is about ROOM and this is about the numbers being the same.
   *
   * So the second caption is dropped before any of it runs, and what is left is
   * the close: it is the price every figure on the card is measured from, and
   * on this bar it is also the live price, to every digit the bar prints.
   *
   * Compared as the STRINGS the bar draws, not as the numbers behind them, for
   * the same reason the rest of this file measures boxes instead of estimating
   * them: 42.001 and 41.997 are two numbers and one caption.
   */
  const liveOnTheBar = liveAt === null ? null : markerPriceText(livePrice as number);
  const samePriceOnTheBar = liveOnTheBar !== null && liveOnTheBar === markerPriceText(referenceClose);
  /*
   * The same question asked of the FULL figures, which is a stricter one: the
   * bar drops the cents above a thousand, so 121,884.35 and 121,884.02 share a
   * caption up there while remaining two prices everywhere else. This is what
   * the sentence under the bar is gated on — see it for why the two rules are
   * not the same rule.
   */
  const samePriceInFull = hasLive && priceText(livePrice as number) === priceText(referenceClose);
  const liveText = liveAt === null || samePriceOnTheBar ? null : `ราคาตอนนี้ ${liveOnTheBar}`;
  const mergedText = liveText === null
    ? ''
    : `ปิดล่าสุด ${markerPriceText(referenceClose)} · ${liveText}`;
  const lowerText = markerPriceText(lowerTrigger);
  const upperText = markerPriceText(upperTrigger);
  const edgesText = `${lowerText} · ${upperText}`;

  /*
   * Every caption this bar could draw, drawn once where nobody can see it.
   *
   * The merged forms are in here beside the split ones on purpose: the decision
   * between them needs both widths, and the one it did not choose is not in the
   * document to be measured. See `useZoneMetrics`.
   */
  const probes: Array<{ key: string; text: string; style: keyof ZoneScale['caption'] }> = [
    { key: 'close', text: closeText, style: 'price' },
    ...(liveText === null ? [] : [
      { key: 'live', text: liveText, style: 'price' as const },
      { key: 'prices', text: mergedText, style: 'price' as const },
    ]),
    ...(hasFrame ? [
      { key: 'edge-lower', text: lowerText, style: 'level' as const },
      { key: 'edge-upper', text: upperText, style: 'level' as const },
      { key: 'edges', text: edgesText, style: 'level' as const },
    ] : []),
    ...(Object.keys(ZONE_SEGMENT_COPY) as Array<keyof typeof ZONE_SEGMENT_COPY>).map((id) => ({
      key: `zone-${id}`,
      text: ZONE_SEGMENT_COPY[id],
      style: 'name' as const,
    })),
  ];
  const [metrics, trackRef] = useZoneMetrics(probes.map((probe) => probe.text).join('|'));
  const track = metrics?.track ?? 0;
  /*
   * How big everything on the picture is drawn — read off the track the bar was
   * given, not off the window. The measuring copies below carry the same size,
   * so every width the layout runs on is a width at the size it will be drawn.
   */
  const size = zoneScaleFor(track);
  const measured = (key: string) => metrics?.widths[key];

  const closeCaption = caption('close', closeText, closeAt, [{ key: 'close', at: closeAt }], { width: measured('close'), size });
  const liveCaption = liveAt === null || liveText === null
    ? null
    : caption('live', liveText, liveAt, [{ key: 'live', at: liveAt }], { width: measured('live'), size });
  /*
   * One caption for two prices, and only when the two boxes genuinely overlap.
   *
   * TWO captions is the normal arrangement and the one this tries hardest to
   * keep: each one names one price and has a leader down to its own mark, which
   * is the only version where a reader can tell which number belongs to which
   * line. `spreadLabels` gets first refusal on the MEASURED track — centred,
   * then each caption grown away from the other so it starts or ends on its own
   * mark — and merging happens only when even that leaves the two rectangles
   * touching. Before the browser has measured anything the answer is two
   * captions, because merging is a concession and a concession made without a
   * measurement is a guess.
   *
   * The merged caption is anchored on the CLOSE and leads to the close mark
   * alone. It used to sit at the midpoint with a leader to each mark, which put
   * "ปิดล่าสุด 44.9 · ราคาตอนนี้ 42.14" between two lines while pointing at
   * both — a reader who cannot pair a number with a line is worse off than one
   * who has to look up a second number. The close is the mark that gets it because it
   * is the price every figure on this card is measured from; the live mark is
   * still drawn, and the sentence under the bar still states the live price in
   * full.
   *
   * What does NOT collapse is the marks. Two prices are always two lines on the
   * bar, because the lines are the fact and the caption is only the reading.
   *
   * AND ONE LAST RUNG, for the case where even the merged caption does not fit.
   * A caption wider than its own track cannot be placed anywhere: `labelLeft`
   * clamps it to the left edge and the rest runs out under the card's padding.
   * So when the merge does not fit either, the bar draws the CLOSE caption
   * alone. It is the price every figure on the card is measured from, the live
   * mark is still drawn on the bar, and the live price is still stated in full
   * in the sentence two rows below — the same trade the fields make when one is
   * too narrow to carry its own name.
   *
   * The naming pass is what put this rung here. Written "ปิดเมื่อวาน", the
   * merged caption for a six-figure instrument measured 225px on the 220px
   * track a 320px phone leaves, and `qa:signal-zone-bar` caught it hanging 5px
   * past the end of its own row; at "ปิดล่าสุด" the same caption is 215px and
   * fits. Two characters is the whole margin, which is exactly why the check is
   * a measurement rather than a rule about how long a label may be.
   */
  const captions = ((): Caption[] => {
    if (liveCaption === null) return [closeCaption];
    if (track === 0) return [closeCaption, liveCaption];
    const spread = spreadLabels(closeCaption, liveCaption, track);
    if (spread) return spread;
    const merged = caption('prices', mergedText, closeAt, [{ key: 'close', at: closeAt }], { width: measured('prices'), size });
    return merged.width <= track ? [merged] : [closeCaption];
  })();

  /*
   * The edge prices, laid out by the same three rules. The two cuts are the two
   * ends of the frame, so on any track wide enough to read they never come to
   * this — but a pair that truly cannot be spread merges into one caption
   * between the cuts, in reading order and with a leader to each, rather than
   * being drawn on top of each other or quietly dropped.
   */
  const lowerEdge = caption('edge-lower', lowerText, lowerAt, [{ key: 'lower', at: lowerAt }], { mono: true, width: measured('edge-lower'), size });
  const upperEdge = caption('edge-upper', upperText, upperAt, [{ key: 'upper', at: upperAt }], { mono: true, width: measured('edge-upper'), size });
  const edges = ((): Caption[] => {
    if (!hasFrame) return [];
    if (track === 0) return [lowerEdge, upperEdge];
    return spreadLabels(lowerEdge, upperEdge, track) ?? [caption(
      'edges',
      edgesText,
      (lowerAt + upperAt) / 2,
      [lowerEdge.marks[0], upperEdge.marks[0]],
      { mono: true, width: measured('edges'), size },
    )];
  })();

  /*
   * Whether a field is wide enough to carry its own name.
   *
   * The rule used to be "at least 12% of the track", which is a percentage
   * standing in for a width: 12% of a 220px phone track is 26px and "ขาลง" is
   * 38px, so the word was drawn a pixel into the field beside it and named the
   * wrong thing. Measured, the question is the one actually being asked — is
   * this field wider than this word — and the 12% rule survives only as the
   * answer for the first paint, where nothing has been measured yet.
   *
   * A field that cannot carry its name is drawn without one. Nothing is lost:
   * the fields are still coloured in the same order, and the zone the price is
   * standing in is named in words above the bar.
   *
   * THE MIDDLE FIELD ASKS FOR MORE, and this is the other half of the
   * "กรอบเดิม" fix. It is the only field with a name on both sides of it, and
   * its name is always centred (see `nameAlignment`), so the room left over
   * either side is exactly `(field - name) / 2` — the gap to "ขาลง" on the left
   * and to "ขาขึ้น" on the right. Requiring `NAME_MIN_GAP_PX` of it on each
   * side is the same rule `qa:signal-zone-bar` now enforces on the drawn boxes,
   * asked here before the name is drawn rather than reported afterwards.
   */
  const nameWidth = (id: keyof typeof ZONE_SEGMENT_COPY) => measured(`zone-${id}`)
    ?? estimateLabelWidth(ZONE_SEGMENT_COPY[id], { padding: size.padding.name, scale: size.estimate.name });
  const nameClearance = (id: keyof typeof ZONE_SEGMENT_COPY) => (
    id === 'sideways' ? NAME_MIN_GAP_PX * 2 : 2
  );
  const fitsItsName = (id: keyof typeof ZONE_SEGMENT_COPY, width: number) => (
    track === 0 ? width >= 12 : (width / 100) * track >= nameWidth(id) + nameClearance(id)
  );

  const segments = [
    {
      id: 'downtrend' as const,
      left: 0,
      width: lowerAt,
      tone: 'bg-red-500/15 text-red-200/80',
      activeTone: 'bg-red-500/35 text-red-100',
      round: 'rounded-l-lg',
    },
    {
      id: 'sideways' as const,
      left: lowerAt,
      width: Math.max(0, upperAt - lowerAt),
      tone: 'bg-slate-500/20 text-slate-300',
      activeTone: 'bg-slate-400/35 text-white',
      round: '',
    },
    {
      id: 'uptrend' as const,
      left: upperAt,
      width: Math.max(0, 100 - upperAt),
      tone: 'bg-emerald-500/15 text-emerald-200/80',
      activeTone: 'bg-emerald-500/35 text-emerald-100',
      round: 'rounded-r-lg',
    },
  ];

  return (
    /*
      The width of the card, and nothing standing in for it.

      The bar was capped at 640px to fix a real complaint — stretched across a
      desktop card, two marks a percent apart were flung a hand's width apart
      and each field's name floated in the middle of an ocean of its own colour.
      But the cap answered a measure problem with a measure, and left the other
      half of it alone: the type on the picture stayed phone-sized, so the block
      became a small drawing in the corner of a large card with a hand's width
      of empty card beside it. What was actually wrong on a wide screen was that
      NOTHING drawn on the bar grew with the bar.

      So the block is as wide as the card's content box — `w-full` inside the
      card's own padding, which is what makes the gap on the left and the gap on
      the right the same gap by construction rather than by arithmetic — and
      `ZONE_SCALE` grows the type, the bar and the marks with it.
    */
    <div className="mt-4 w-full rounded-xl border border-current/20 p-3" data-testid="signal-zone-bar">
      <p className={`${size.prose.headline} font-semibold`} data-zone-row="headline">
        {ZONE_COPY[zone]}
        {freshlyFormed ? <span className="font-normal text-slate-300"> แต่เพิ่งผ่านมาไม่นาน ยังพลิกกลับได้ง่าย</span> : null}
      </p>
      {/*
        Position only, and no direction at all.

        This line used to open with the tilt — "ยังไม่เอียงไปทางไหน" on a card
        whose headline three lines above it reads "BULLISH · Bullish Bias". Two
        sentences a thumb-length apart said opposite things, and the one a fast
        reader believes is the big one at the top. Direction is the headline's
        job and the chips' job; the score itself is still on the card, above,
        as "Score +16 / 100". What is left here is where price is STANDING,
        which is the one thing the bar underneath is drawing.

        Scoped to what P4a actually measured. The band predicts how long the
        LABEL lasts over about five bars and nothing else: directional accuracy
        is indistinguishable across all three bands at every horizon. So
        `near_trigger` says the label may not last, and `deep_range` says only
        where price is — it must NOT read as the more trustworthy signal,
        because it is not one.
      */}
      {zones.proximity === 'near_trigger' ? (
        <p className={`mt-1 ${size.prose.note} text-slate-400`} data-zone-row="proximity">
          {zones.nearestTriggerAtr < 0
            ? 'ราคาเลยขอบกรอบมาแล้ว'
            : `ราคาใกล้ขอบกรอบแล้ว (ห่างอีก ${percentText(nearestDistance, referenceClose)})`}
          {' โซนนี้จึงเปลี่ยนได้ในไม่กี่วันทำการ'}
        </p>
      ) : zones.proximity === 'deep_range' ? (
        <p className={`mt-1 ${size.prose.note} text-slate-400`} data-zone-row="proximity">
          {'ราคายังอยู่กลางกรอบ ห่างขอบที่ใกล้ที่สุด '}{percentText(nearestDistance, referenceClose)}
        </p>
      ) : null}

      {/*
        The picture, hidden from assistive tech on purpose: every number drawn
        on it is stated again in the list underneath, which is the version a
        screen reader can actually walk.
      */}
      <div className="mt-3" aria-hidden="true" data-zone-row="picture">
        {/*
          ROW ONE — the prices, each caption on its own mark.

          Nothing else is ever in this row, and no price is ever in the row under
          the bar. The leader hairline and its stem are drawn first so the
          caption is painted over them rather than under them, and they carry no
          text, which is how `qa:signal-zone-bar` tells a label from a line.
        */}
        <div className={`relative ${size.row.prices}`} data-track="prices" data-zone-row="prices" ref={trackRef}>
          {/*
            The measuring copies: one per caption the bar could draw, invisible,
            out of the flow, and never read by anybody. `visibility:hidden` and
            not `display:none` because a box with no display has no width to
            measure, which is the entire reason they are here.
          */}
          {probes.map((probe) => (
            <span
              key={`measure-${probe.key}`}
              data-measure={probe.key}
              className={`pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap ${size.caption[probe.style]}`}
            >
              {probe.text}
            </span>
          ))}
          {captions.flatMap((price) => price.marks.map((mark) => (
            <div
              key={`leader-${price.key}-${mark.key}`}
              data-leader={mark.key}
              data-leader-for={price.key}
              className={`absolute ${size.row.priceMark} h-px bg-white/40`}
              style={zoneLeaderStyle(mark.at, price)}
            />
          )))}
          {captions.flatMap((price) => price.marks.map((mark) => (
            <div
              key={`stem-${price.key}-${mark.key}`}
              className={`absolute ${size.row.priceMark} ${size.row.priceStem} w-px -translate-x-1/2 bg-white/40`}
              style={{ left: `${mark.at}%` }}
            />
          )))}
          {captions.map((price) => (
            <span
              key={price.key}
              data-label={price.key}
              data-label-width={price.width}
              className={`absolute top-0 whitespace-nowrap ${size.caption.price} ${
                price.key === 'live' ? 'text-slate-300' : 'rounded-md bg-white/15 text-white'
              }`}
              style={zoneLabelStyle(price)}
            >
              {price.text}
            </span>
          ))}
        </div>

        <div className={`relative ${size.row.bar}`} data-track="bar" data-zone-row="bar">
          {segments.map((segment) => (
            <div
              key={segment.id}
              data-zone={segment.id}
              data-active={zone === segment.id ? 'true' : 'false'}
              className={`absolute inset-y-0 flex items-center ${
                nameAlignment(segment, { at: closeAt, width: size.closeMarkPx }, { track, nameWidth: nameWidth(segment.id) })
              } ${segment.round} ${zone === segment.id ? segment.activeTone : segment.tone}`}
              style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
            >
              {fitsItsName(segment.id, segment.width) ? (
                <span data-label={`zone-${segment.id}`} className={size.caption.name}>
                  {ZONE_SEGMENT_COPY[segment.id]}
                </span>
              ) : null}
            </div>
          ))}
          {edges.flatMap((edge) => edge.marks.map((mark) => (
            <div
              key={`cut-${mark.key}`}
              data-cut={mark.key}
              className="absolute inset-y-0 w-px bg-white/40"
              style={{ left: `${mark.at}%` }}
            />
          )))}
          {/*
            The live price, drawn thinner and fainter than the close because it
            is the softer fact: the label moves on closes, not on this. Faint is
            not the same as absent, though — `bg-white/45` is re-pointed to a
            translucent INK for the light appearance, the same mapping the close
            marker needs, because a literal white here is the surface colour and
            the mark disappears into the field it is standing on.
          */}
          {liveAt !== null ? (
            <div
              data-marker="live"
              className={`absolute ${size.marker.live} -translate-x-1/2 rounded-full bg-white/45`}
              style={{ left: `${liveAt}%` }}
            />
          ) : null}
          {/*
            The one mark a reader has to find, so it is the highest-contrast ink
            the theme has rather than a literal white: plain `bg-white` is mapped
            to the SURFACE colour for the light appearance, which turned this
            marker into a white bar on a white field.
          */}
          <div
            data-marker="close"
            className={`absolute ${size.marker.close} -translate-x-1/2 rounded-full bg-white/90`}
            style={{ left: `${closeAt}%` }}
          />
        </div>

        {/*
          ROW TWO — the two edge prices, under the cut each one makes, and
          nothing else. They used to sit in the first and last cell of a grid,
          i.e. hard against the ends of the bar, pointing at nothing; then they
          shared a border with the live caption, which is how "43.23" ended up
          reading as part of "สด 42.59". Each one now has a stem up to its own cut
          and a leader for the case where it had to move off it.
        */}
        <div className={`relative ${size.row.edges}`} data-track="edges" data-zone-row="edges">
          {edges.flatMap((edge) => edge.marks.map((mark) => (
            <div
              key={`stem-${edge.key}-${mark.key}`}
              className={`absolute top-0 ${size.row.edgeStem} w-px -translate-x-1/2 bg-white/40`}
              style={{ left: `${mark.at}%` }}
            />
          )))}
          {edges.flatMap((edge) => edge.marks.map((mark) => (
            <div
              key={`leader-${edge.key}-${mark.key}`}
              data-leader={mark.key}
              data-leader-for={edge.key}
              className={`absolute ${size.row.edgeLeader} h-px bg-white/40`}
              style={zoneLeaderStyle(mark.at, edge)}
            />
          )))}
          {edges.map((edge) => (
            <span
              key={edge.key}
              data-label={edge.key}
              data-label-width={edge.width}
              className={`absolute ${size.row.edgeLabel} whitespace-nowrap ${size.caption.level} text-slate-400`}
              style={zoneLabelStyle(edge)}
            >
              {edge.text}
            </span>
          ))}
        </div>
      </div>

      {/*
        The two trigger rows are gone, and nothing went with them.

        "ถ้าปิดต่ำกว่า 38.26 · ต่ำกว่าตอนนี้ 13.2% · ถือว่าเข้าโซนขาลง" said in a
        sentence what the drawing two rows above it draws: the number is printed
        under its own cut, the field beyond the cut is coloured and named, and
        the proximity line already carries the distance to the nearest one. It
        was the same fact a third time, in the reader's least favourite form,
        and it cost two of the eight lines under a bar that has to be read in
        ten seconds. The colour is kept — it is on the fields themselves, which
        is where it belongs.

        It was also the row that broke the block's alignment: a two-column grid
        whose right cell started at 50% and ran to about 70%, so the up
        condition ended in the middle of nowhere with a third of the block empty
        beside it. Whatever replaces a row here goes full width, and
        `qa:signal-zone-bar` now fails any row in this block that does not.
      */}

      {/*
        The live price said as a status, and weighted by whether it matters.

        "ราคาสด 42.38 — ยังไม่ผ่านขอบกรอบทั้งสองฝั่ง" was the same sentence for a
        price in the middle of the frame and for one that had just fallen back
        into it from above, which is the case a reader needs to catch: the
        headline is BULLISH off a close above the frame, and the number on
        screen is no longer up there. When the two marks are in different
        fields this line is the correction to the headline, so it is drawn in
        the warning weight rather than in the same grey as everything else.

        AND IT IS NOT DRAWN AT ALL when the live price is the close, to every
        digit either of them is printed with. "ราคาตอนนี้ 42.00 ยังอยู่ในกรอบ
        เดิมเหมือนราคาปิด" under a bar whose one caption already reads "ปิด
        ล่าสุด 42" is the same number said twice and a comparison of a number
        with itself — a reader who stops on it is looking for the difference
        between two figures that have none. Where there IS a difference, however
        small, the line stays and states it in full: the bar rounds a six-figure
        instrument to whole units, so two prices that share a caption up there
        can still be two prices, and this is the row that says so.
      */}
      {hasLive && !samePriceInFull ? (
        <p
          data-testid="signal-live-price"
          data-zone-row="live"
          data-diverges={liveDiverges ? 'true' : 'false'}
          className={`mt-2 ${size.prose.note} ${liveDiverges ? 'font-semibold text-amber-200' : 'text-slate-400'}`}
        >
          ราคาตอนนี้ {priceText(livePrice as number)}
          {!hasFrame || liveSide === null
            ? ''
            : liveDiverges
              ? ` ${liveMoveCopy(liveSide, closeSide)} · โซนจะเปลี่ยนก็ต่อเมื่อปิดแบบนี้`
              : ` ${LIVE_SAME_SIDE_COPY[liveSide]}`}
        </p>
      ) : null}

      {actionable ? <ActionableRows zones={zones} actionable={actionable} size={size} /> : null}

      {/*
        Both provenance sentences on one line, because they are one fact: which
        price every number here came from, and what counts as that price. Two
        greyed lines at the bottom of a card read as boilerplate and get skipped
        together; one reads as a footnote and gets read.

        This is also where "ปิดล่าสุด" is spelled out in full. The caption on
        the bar has to stay short — it is drawn on the track, and a label 28
        characters long lands on the name of the field beside it — so the mark
        carries the short name and this line carries the whole sentence: which
        session it was, and that only closes count. The date is in the reader's
        own calendar rather than as the ISO string the payload carries, because
        this line is read by a person and not by a machine.
      */}
      <p className={`mt-2 ${size.prose.note} text-slate-500`} data-zone-row="source">
        วัดจากราคาปิดตลาดรอบล่าสุด {priceText(referenceClose)} ({formatThaiDateOnly(zones.referenceDate)}) · นับเฉพาะราคาปิดของวัน ไม่นับที่แตะระหว่างวัน
      </p>
    </div>
  );
}

/**
 * The two rows under the zone bar, or nothing.
 *
 * A row whose number is `null` is not drawn — no em dash, no "ไม่มีข้อมูล", no
 * greyed placeholder. A placeholder in a price row reads as a value the card is
 * withholding, and invites the reader to go and find it somewhere else; an
 * absent row reads as a question this card does not answer, which is the truth.
 * On today's corpus that is four instruments in five, so this is the common
 * path, not the edge case.
 *
 * The wording is conditional throughout — "ถ้าปิดต่ำกว่า X โซนนี้จบ" is a
 * statement about the engine's own rule, which is checkable. "ตั้ง stop ที่ X"
 * would be an instruction, and the card does not give instructions.
 *
 * The RATIO has lost its digits here. 7.94 is a real quotient of two real
 * distances and it reads to a beginner as a grade — and P4a measured the
 * signals carrying the biggest ones at +0.5 / +0.5 / -0.8pp of edge, i.e. at
 * nothing. So the card says which leg is longer, in words, and the number
 * itself is in "ทำไม?" beside the two distances it came from.
 */
function ActionableRows({ zones, actionable, size }: {
  zones: MarketSignalZones;
  actionable: MarketSignalActionable;
  size: ZoneScale;
}) {
  const { invalidation, invalidationPct, invalidationBasis, target } = actionable;
  if (invalidation === null && target === null) return null;
  const close = zones.referenceClose;
  const ends = zones.zone === 'uptrend' ? 'ปิดต่ำกว่า' : 'ปิดสูงกว่า';
  // The percent the engine already reported, when it reported one; otherwise
  // the same quantity off the two prices, so the row is never blank.
  const invalidationRelative = invalidation === null
    ? ''
    : invalidationPct !== null
      ? `${invalidationBasis === 'zone_ceiling' ? 'สูงกว่า' : 'ต่ำกว่า'}ราคาปิด ${Math.abs(invalidationPct).toFixed(1)}%`
      : relativeCopy(Math.abs(invalidation - close), close, invalidation > close ? 'above' : 'below');
  const targetRelative = target === null
    ? ''
    : relativeCopy(Math.abs(target - close), close, target > close ? 'above' : 'below');

  return (
    <dl className={`mt-3 space-y-2 border-t border-current/15 pt-2 ${size.prose.note} text-slate-300`} data-testid="signal-actionable" data-zone-row="actionable">
      {invalidation === null ? null : (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-slate-400">ถ้า{ends}</dt>
          <dd className="font-mono text-white">{priceText(invalidation)}</dd>
          <dd className="text-slate-500">
            {invalidationRelative ? `${invalidationRelative} · ` : ''}
            ถือว่า{zones.zone === 'uptrend' ? 'ขาขึ้น' : 'ขาลง'}รอบนี้จบตามกฎเดิม
          </dd>
        </div>
      )}
      {target === null ? null : (
        <div className="flex flex-wrap items-baseline gap-x-2">
          {/* The measured move, said as the rule of thumb it is rather than as
              "ระยะที่กรอบเดิมวัดได้", which named the arithmetic and not the idea. */}
          <dt className="text-slate-400">กรอบเดิมสูงเท่าไร ก็มักไปได้อีกเท่านั้น</dt>
          <dd className="font-mono text-white">{priceText(target)}</dd>
          <dd className="text-slate-500">
            {targetRelative ? `${targetRelative} · ` : ''}
            {/*
              Said on the row itself, not in a footnote, and in a sentence a
              beginner finishes. A measured move is the charting convention that
              a broken range travels its own height again; it is not a property
              of this instrument that anything here has measured, and a reader
              has no way to tell those apart from the number alone.
            */}
            เป็นการคาดคะเนตามธรรมเนียมการอ่านกราฟ ยังไม่เคยทดสอบว่าแม่นจริงไหม
          </dd>
        </div>
      )}
      {/*
        "เทียบระยะสองฝั่ง" is not here any more — it is in "ทำไม?" beside the
        quotient it was a reading of. It took two lines on the card to say which
        leg was longer and then to say that a long leg is not a better trade,
        which is a row that spends its whole length telling the reader not to
        trust it. A number nobody should act on does not need to be on the
        beginner's surface at all; it needs to be findable, and it is.
      */}
    </dl>
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

/**
 * Everything the zone bar used to say in the reader's face, kept for the reader
 * who wants it.
 *
 * Nothing here is new and nothing here left the payload: it is the same fields,
 * moved off a card a beginner has to read in ten seconds and into the dialog
 * they open when ten seconds was not enough. ATR — the unit that makes every
 * distance comparable across instruments and means nothing to somebody who has
 * not been taught it — the raw risk/reward quotient, the position inside the
 * frame, the three ages, and the words "swing high/low" all live here now.
 *
 * They are together, in one block, rather than sprinkled through the sections
 * above, because the reader who opens this is looking for the working behind a
 * specific line on the card and should find all of it in one place.
 */
function ZoneDetails({ zones, actionable, atr }: {
  zones: MarketSignalZones;
  actionable: MarketSignalActionable | null;
  atr: number | null;
}) {
  return (
    <section data-testid="signal-zone-details">
      <h3 className="font-semibold text-white">กรอบราคา — ตัวเลขดิบ</h3>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        ตัวเลขชุดนี้เคยอยู่บนหน้าการ์ด ย้ายมาที่นี่เพราะอ่านยากสำหรับคนเพิ่งเริ่ม ไม่ได้ถูกตัดออกจากผลลัพธ์
      </p>
      <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
        {/* Deliberately unclamped: past 100% means price has broken out. */}
        <Detail label="ตำแหน่งในกรอบ" value={`${zones.positionPct}%`} />
        <Detail label="ที่มาของกรอบ" value={ZONE_MODE_COPY[zones.mode]} />
        <Detail label="ระยะถึงขอบบน" value={`${number(zones.upperDistance)} · ${number(zones.upperDistanceAtr)} ATR`} />
        <Detail label="ระยะถึงขอบล่าง" value={`${number(zones.lowerDistance)} · ${number(zones.lowerDistanceAtr)} ATR`} />
        <Detail label="ระยะถึงขอบที่ใกล้ที่สุด" value={`${number(zones.nearestTriggerAtr)} ATR`} />
        <Detail label="ATR14" value={number(atr)} />
        {/*
          Both ages, because the label outlasts the thing it describes. 74% of
          sideways observations see price close outside the frame within twenty
          bars, and in 66% of those the LABEL stays sideways because the frame
          re-anchored around the move rather than because price stayed put. The
          card says "เพิ่งผ่านมาไม่นาน" off the smaller of these two; this is
          where a reader checks which one was smaller.
        */}
        <Detail label="อายุโซน" value={`${zones.zoneAgeBars} แท่ง`} />
        <Detail label="อายุกรอบปัจจุบัน" value={`${zones.frameAgeBars} แท่ง`} />
        <Detail
          label="แตะขอบกรอบล่าสุด"
          value={zones.lastTestedBarsAgo === null ? 'ไม่พบในช่วงที่ดู' : `${zones.lastTestedBarsAgo} แท่งก่อน`}
        />
        {/* The falsification check for the whole design: a frame price can never
            cross would read 0 here on every instrument. */}
        <Detail label="ราคาปิดข้ามขอบกรอบ" value={`${zones.triggerCrossings} ครั้งในช่วงที่ดู`} />
        {actionable === null ? null : (
          <>
            <Detail
              label="ระยะถึงจุดที่โซนจบ"
              value={actionable.invalidationAtr === null
                ? '—'
                : `${number(actionable.invalidationAtr)} ATR · ${number(actionable.invalidationPct)}%`}
            />
            <Detail label="ระยะถึงเป้า" value={actionable.targetAtr === null ? '—' : `${number(actionable.targetAtr)} ATR`} />
            {/*
              The quotient itself, off the card and here. It is arithmetically
              correct and it reads as a grade; P4a measured the signals carrying
              the biggest ones at +0.5 / +0.5 / -0.8pp of edge.
            */}
            <Detail
              label="ระยะเป้าต่อระยะเสี่ยง (R:R)"
              value={actionable.riskReward === null ? '—' : number(actionable.riskReward)}
            />
          </>
        )}
      </dl>
      {/*
        The reading of that quotient, moved here whole from the card.
        On the card it was two lines: one saying which leg is longer, one saying
        that a longer leg is not a better trade. A reader who has to be warned
        off a number that hard is better served by not being shown it in the
        first place — so both lines live here, next to the digits and next to
        the two distances they were divided from.
      */}
      {actionable === null || actionable.riskReward === null ? null : (
        <p className="mt-2 text-xs leading-5 text-slate-400" data-testid="signal-risk-reward-note">
          {actionable.riskReward < 1
            ? 'ระยะที่จะรู้ว่าโซนนี้จบ ยาวกว่าระยะไปถึงเป้า'
            : 'ระยะไปถึงเป้า ยาวกว่าระยะที่จะรู้ว่าโซนนี้จบ'}
          {actionable.notes.includes('risk_leg_inside_noise')
            ? ' · แต่ราคาปิดอยู่ชิดจุดที่โซนจะจบมาก การเทียบนี้จึงแกว่งแรงทุกวัน และไม่ได้แปลว่าโอกาสดีกว่า'
            : ''}
        </p>
      )}
    </section>
  );
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
