'use client';

import React, { useState } from 'react';
import { Activity, Info, Minus, TrendingDown, TrendingUp, TriangleAlert, Zap } from 'lucide-react';
import type { MarketSignalActionable, MarketSignalBias, MarketSignalHistory, MarketSignalResult, MarketSignalState, MarketSignalZones } from '@/src/lib/analytics/market-signal/types';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
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
          score={result.score}
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

/** A tilt inside a zone, worded as a lean rather than as a direction. */
function tiltCopy(score: number): string {
  const magnitude = Math.abs(score);
  if (magnitude < 15) return 'ยังไม่เอียงไปทางไหน';
  const direction = score > 0 ? 'ขึ้น' : 'ลง';
  return magnitude >= 40 ? `เอียง${direction}ชัด (${signed(score)})` : `เอียง${direction}เล็กน้อย (${signed(score)})`;
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
 */
function relativeCopy(distance: number | null, reference: number, side: 'above' | 'below'): string {
  if (distance === null || !Number.isFinite(distance) || !Number.isFinite(reference) || reference === 0) return '';
  if (distance < 0) return side === 'above' ? 'ราคาผ่านขึ้นไปแล้ว' : 'ราคาหลุดลงมาแล้ว';
  return `${side === 'above' ? 'สูงกว่า' : 'ต่ำกว่า'}ตอนนี้ ${percentText(distance, reference)}`;
}

/**
 * Where a floating label may sit without leaving the track it belongs to.
 *
 * A label centred on its marker is the readable arrangement and it is also the
 * one that hangs off the end of the bar: at 390px there is no gutter to hang
 * into, so the line runs under the card's own padding. Centring is therefore
 * only used in the middle fifth of the track, where it is safe for a label up
 * to 80% of the track's width. Anywhere else the label ANCHORS to the marker
 * and grows inward — its near edge sits on the mark, so it still reads as that
 * mark's label, and it cannot overhang unless it is wider than the whole track.
 *
 * The first version of this clamped on position alone (edge-pin below 14%,
 * above 86%) and `qa:signal-zone-bar` caught what that misses: "ตอนนี้
 * 121,884.35" is 103px of a 290px track, so centring it at 84% put 4px of the
 * price under the card's padding. A rule that ignores the label's own width
 * cannot be right at both ends of the corpus, and growing inward is the rule
 * that needs no width at all.
 *
 * Exported because this is the whole mobile-safety argument for the bar, and it
 * is worth a test rather than an eyeball.
 */
export function zoneLabelStyle(position: number): React.CSSProperties {
  if (position <= 40) return { left: `${Math.max(0, position)}%` };
  if (position >= 60) return { right: `${Math.max(0, 100 - position)}%` };
  return { left: `${position}%`, transform: 'translateX(-50%)' };
}

/**
 * Where a field writes its own name, given where the price marker is standing.
 *
 * Centred, unless the marker is standing in this field — then the name moves to
 * whichever half the marker is not in. The marker is the one mark a reader has
 * to find and the name is the one word that explains the field, so letting a
 * 6px bar sit across the first glyph costs both of them for no reason.
 */
function nameAlignment(segment: { id: string; left: number; width: number }, markerAt: number): string {
  const inside = segment.width > 0 && markerAt >= segment.left && markerAt <= segment.left + segment.width;
  if (!inside) return 'justify-center';
  return (markerAt - segment.left) / segment.width < 0.5 ? 'justify-end' : 'justify-start';
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
 * the price the trigger was measured from. The close is the one labelled
 * "ตอนนี้", because it is the price every percentage on this card is measured
 * from; the live one is labelled as live and is never the base of a percentage.
 */
function ZoneBar({ zones, score, livePrice, actionable }: {
  zones: MarketSignalZones;
  score: number;
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
  const liveCrossedUp = livePrice !== null && upperTrigger !== null && livePrice > upperTrigger;
  const liveCrossedDown = livePrice !== null && lowerTrigger !== null && livePrice < lowerTrigger;
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
    <div className="mt-4 rounded-xl border border-current/20 p-3" data-testid="signal-zone-bar">
      <p className="text-sm font-semibold">
        {ZONE_COPY[zone]}
        {freshlyFormed ? <span className="font-normal text-slate-300"> แต่เพิ่งผ่านมาไม่นาน ยังพลิกกลับได้ง่าย</span> : null}
      </p>
      <p className="mt-1 text-[11px] leading-5 text-slate-400">
        {tiltCopy(score)}
        {/*
          Scoped to what P4a actually measured. The band predicts how long the
          LABEL lasts over about five bars and nothing else: directional
          accuracy is indistinguishable across all three bands at every horizon.
          So `near_trigger` says the label may not last, and `deep_range` says
          only where price is — it must NOT read as the more trustworthy
          signal, because it is not one.
        */}
        {zones.proximity === 'near_trigger' ? (
          <>
            {' · '}
            {zones.nearestTriggerAtr < 0
              ? 'ราคาเลยขอบกรอบมาแล้ว'
              : `ราคาใกล้ขอบกรอบแล้ว (ห่างอีก ${percentText(nearestDistance, referenceClose)})`}
            {' โซนนี้จึงเปลี่ยนได้ในไม่กี่วันทำการ'}
          </>
        ) : zones.proximity === 'deep_range' ? (
          <>{' · ราคายังอยู่กลางกรอบ ห่างขอบที่ใกล้ที่สุด '}{percentText(nearestDistance, referenceClose)}</>
        ) : null}
      </p>

      {/*
        The picture, hidden from assistive tech on purpose: every number drawn
        on it is stated again in the list underneath, which is the version a
        screen reader can actually walk.
      */}
      <div className="mt-3" aria-hidden="true">
        {/*
          "ตอนนี้" rides ABOVE the bar and the edge prices sit BELOW it, so the
          two rows of floating text can never land on top of each other however
          close the marker gets to a cut.
        */}
        <div className="relative h-5">
          <span
            className="absolute top-0 whitespace-nowrap rounded-md bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold text-white"
            style={zoneLabelStyle(closeAt)}
          >
            ตอนนี้ {markerPriceText(referenceClose)}
          </span>
        </div>

        <div className="relative h-9">
          {segments.map((segment) => (
            <div
              key={segment.id}
              data-zone={segment.id}
              data-active={zone === segment.id ? 'true' : 'false'}
              className={`absolute inset-y-0 flex items-center ${nameAlignment(segment, closeAt)} ${segment.round} ${zone === segment.id ? segment.activeTone : segment.tone}`}
              style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
            >
              {/* Below this width the name would spill into the next field. The
                  list underneath still names both directions, so nothing is lost. */}
              {segment.width >= 12 ? (
                <span className="px-1 text-[10px] font-semibold tracking-wide">{ZONE_SEGMENT_COPY[segment.id]}</span>
              ) : null}
            </div>
          ))}
          {hasFrame ? [lowerAt, upperAt].map((position) => (
            <div key={position} className="absolute inset-y-0 w-px bg-white/40" style={{ left: `${position}%` }} />
          )) : null}
          {livePrice !== null && Number.isFinite(livePrice) ? (
            <div
              className="absolute top-1 h-7 w-1 -translate-x-1/2 rounded-full bg-white/45"
              style={{ left: `${at(livePrice)}%` }}
            />
          ) : null}
          {/*
            The one mark a reader has to find, so it is the highest-contrast ink
            the theme has rather than a literal white: plain `bg-white` is mapped
            to the SURFACE colour for the light appearance, which turned this
            marker into a white bar on a white field.
          */}
          <div
            className="absolute -top-0.5 h-10 w-1.5 -translate-x-1/2 rounded-full bg-white/90"
            style={{ left: `${closeAt}%` }}
          />
        </div>

        {/*
          The edge prices, under the cut each one makes. They used to sit in the
          first and last cell of a grid, i.e. hard against the ends of the bar,
          pointing at nothing.
        */}
        <div className="relative mt-1 h-4">
          {hasFrame ? (
            <>
              <span className="absolute top-0 whitespace-nowrap font-mono text-[10px] text-slate-400" style={zoneLabelStyle(lowerAt)}>
                {markerPriceText(lowerTrigger)}
              </span>
              <span className="absolute top-0 whitespace-nowrap font-mono text-[10px] text-slate-400" style={zoneLabelStyle(upperAt)}>
                {markerPriceText(upperTrigger)}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {/* Down on the left, up on the right — the same order as the bar. */}
      <dl className="mt-2 grid gap-x-4 gap-y-2 text-[11px] text-slate-300 sm:grid-cols-2">
        <ZoneRow
          label="ถ้าปิดต่ำกว่า"
          value={lowerTrigger}
          relative={relativeCopy(zones.lowerDistance, referenceClose, 'below')}
          note="ถือว่าเข้าโซนขาลง"
          dotClass="bg-red-400/70"
        />
        <ZoneRow
          label="ถ้าปิดเหนือ"
          value={upperTrigger}
          relative={relativeCopy(zones.upperDistance, referenceClose, 'above')}
          note="ถือว่าเข้าโซนขาขึ้น"
          dotClass="bg-emerald-400/70"
        />
      </dl>

      {livePrice !== null && Number.isFinite(livePrice) ? (
        <p className="mt-2 text-[11px] leading-5 text-slate-400">
          ราคาสด {priceText(livePrice)}
          {liveCrossedUp || liveCrossedDown
            ? ` ผ่าน${liveCrossedUp ? 'ขอบบน' : 'ขอบล่าง'}ไปแล้ว — ต้องรอราคาปิดยืนยันก่อน`
            : ' — ยังไม่ผ่านขอบกรอบทั้งสองฝั่ง'}
        </p>
      ) : null}

      {actionable ? <ActionableRows zones={zones} actionable={actionable} /> : null}

      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        ตัวเลขทั้งหมดวัดจากราคาปิด {priceText(referenceClose)} วันที่ {zones.referenceDate}
      </p>
      <p className="text-[11px] leading-5 text-slate-500">นับเฉพาะราคาปิดของวัน ไม่นับที่แตะระหว่างวัน</p>
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
function ActionableRows({ zones, actionable }: { zones: MarketSignalZones; actionable: MarketSignalActionable }) {
  const { invalidation, invalidationPct, invalidationBasis, target, riskReward } = actionable;
  if (invalidation === null && target === null) return null;
  const close = zones.referenceClose;
  const ends = zones.zone === 'uptrend' ? 'ปิดต่ำกว่า' : 'ปิดสูงกว่า';
  // The percent the engine already reported, when it reported one; otherwise
  // the same quantity off the two prices, so the row is never blank.
  const invalidationRelative = invalidation === null
    ? ''
    : invalidationPct !== null
      ? `${invalidationBasis === 'zone_ceiling' ? 'สูงกว่า' : 'ต่ำกว่า'}ตอนนี้ ${Math.abs(invalidationPct).toFixed(1)}%`
      : relativeCopy(Math.abs(invalidation - close), close, invalidation > close ? 'above' : 'below');
  const targetRelative = target === null
    ? ''
    : relativeCopy(Math.abs(target - close), close, target > close ? 'above' : 'below');

  return (
    <dl className="mt-3 space-y-2 border-t border-current/15 pt-2 text-[11px] leading-5 text-slate-300" data-testid="signal-actionable">
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
      {riskReward === null ? null : (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-slate-400">เทียบระยะสองฝั่ง</dt>
          <dd className="text-slate-500">
            {riskReward < 1
              ? 'ระยะที่จะรู้ว่าโซนนี้จบ ยาวกว่าระยะไปถึงเป้า'
              : 'ระยะไปถึงเป้า ยาวกว่าระยะที่จะรู้ว่าโซนนี้จบ'}
            {/*
              Said on the row, not in a footnote. A big ratio here comes from a
              tiny denominator — price sitting on its own invalidation — and the
              measurements say those signals are no better than any other.
            */}
            {actionable.notes.includes('risk_leg_inside_noise')
              ? ' · แต่ตอนนี้ราคาอยู่ชิดจุดที่โซนจะจบมาก การเทียบนี้จึงแกว่งแรงทุกวัน และไม่ได้แปลว่าโอกาสดีกว่า'
              : ''}
          </dd>
        </div>
      )}
    </dl>
  );
}

function ZoneRow({ label, value, relative, note, dotClass }: {
  label: string;
  value: number | null;
  relative: string;
  note: string;
  dotClass: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 py-0.5">
      <dt className="flex items-center gap-1.5 text-slate-400">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
        {label}
      </dt>
      <dd className="font-mono text-white">{value === null ? '—' : priceText(value)}</dd>
      {value === null ? (
        <dd className="text-slate-500">ยังไม่มีขอบกรอบฝั่งนี้</dd>
      ) : (
        <dd className="text-slate-500">{relative ? `${relative} · ` : ''}{note}</dd>
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
