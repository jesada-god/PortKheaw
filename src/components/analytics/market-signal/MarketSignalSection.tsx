'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Info, Minus, TrendingDown, TrendingUp, TriangleAlert, Zap } from 'lucide-react';
import type { MarketSignalActionable, MarketSignalBias, MarketSignalHistory, MarketSignalMetrics, MarketSignalReason, MarketSignalResult, MarketSignalState, MarketSignalZones } from '@/src/lib/analytics/market-signal/types';
import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import { BANGKOK_TIME_ZONE, formatBangkokDateTime, formatThaiDateOnly, THAI_LOCALE } from '@/src/lib/presentation/datetime';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import { LockedNotice } from '@/src/components/subscription/EntitlementGate';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { MARKET_SIGNAL_HISTORY, MARKET_SIGNAL_MEASURED } from '@/src/config/signal';
import { reasonContextFor, reasonHeadline, reasonText, type ReasonBaseContext } from './reason-copy';

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
/** §6.6's four figures, so the SIDEWAYS disclosure reads them and never types them. */
const SIDEWAYS_MEASURED = MARKET_SIGNAL_MEASURED.sidewaysPersistence;

/**
 * The button, named for what is behind it rather than for a question.
 *
 * "ทำไม?" asked something the card had already started answering above it, and
 * gave no clue that the thing behind it was the arithmetic — every metric, both
 * sets of edges, the calibration run and the source. A reader who wanted the
 * working had to guess that a two-word question led to it.
 *
 * It is a const because three places say it: the button, the chip row's
 * overflow count, and the reason list's. A second spelling of a button's name
 * is a reader looking for a control that is not there.
 */
const ADVANCED_TOGGLE = 'ดูรายละเอียดการคำนวณ';

/**
 * The footer's finding, in one line, for the layer that has room for one.
 *
 * NOT a shortening of the disclaimer — the disclaimer is a legal sentence and
 * this is the useful one: what the card is describing (what price has already
 * done) against what a reader assumes it is describing (what price will do).
 * `NOT_A_FORECAST` says the same thing with its evidence attached, and it is
 * still printed in full, with its provenance and the disclaimer, at the bottom
 * of the advanced layer and on all three of the card's other render paths.
 */
const SHORT_NOTE = 'สถานะนี้อธิบายแนวโน้มจากข้อมูลที่ผ่านมา ไม่ใช่การคาดการณ์ว่าราคาจะไปทางไหน';

/**
 * The score's name, and the reading that made it need one.
 *
 * "Score +7 / 100" was being read as "a 7% chance of going up", and it handed a
 * reader three separate invitations to read it that way: an English word that
 * names a grade, a denominator that reads as "out of", and no sign anywhere in
 * the label. The number is neither. It is the sum of the five evidence rows in
 * §3, on an axis running from -100 to +100, and its SIGN is the direction.
 *
 * NOT "ความชัดเจนของสัญญาณ", and each half of that is separately disqualifying.
 * The sign is a direction, so a card holding -45 would be calling a downtrend
 * unclear. And "ความชัด" is already spent twice in the dialog this label now
 * sits in — `ความชัดของภาวะตลาด` is regimeClarity — while the other number on
 * the same block is `ความสอดคล้องของหลักฐาน`. A third quantity under a name two
 * others already wear is the collision this const exists to avoid.
 *
 * The wording is not a coinage. It is the sentence the card ALREADY says about
 * this exact field, promoted to the label: `คะแนนรวมเอนไปทาง${leaning}` in
 * `descriptionFor`, `(คะแนนรวม …)` in the gate block, `รวม` at the foot of §3.
 * `เอน` and not `เอียง` because `reason-copy` spends `เอียง` on the MACD tilt,
 * which is a different and much more local lean.
 */
const SCORE_LABEL = 'คะแนนรวมเอนไปทางไหน';

/**
 * The axis, printed under the number, because the number cannot carry it.
 *
 * This is what replaces `/ 100` on this reading. A denominator says "out of",
 * which IS the percentage reading; a range says where zero sits and that there
 * is a negative half at all — which is the half that makes -45 legible. §3's
 * total row keeps its `/ 100`, because down there 100 is the sum of the
 * maxPoints column standing above it, which is the one place it is true.
 */
const SCORE_SCALE = 'ช่วง -100 ถึง +100 · เครื่องหมายคือทิศทางที่หลักฐานเอนไป ตัวเลขคือน้ำหนัก ไม่ใช่เปอร์เซ็นต์';

/** Said once, under the figure it qualifies, rather than in two blocks of the same dialog. */
const AGREEMENT_NOT_A_CHANCE = 'ไม่ใช่ % โอกาสที่ราคาจะไปทางนั้น';

/**
 * How many reasons the beginner layer draws before it starts counting.
 *
 * Four, because four short lines is still a glance and five is a list. The rest
 * are counted rather than dropped, and every one of them is drawn in full one
 * tap away — see `beginnerReasons`.
 */
const MAX_BEGINNER_REASONS = 4;

/**
 * THE ROWS THAT ANSWER "WHY WAS NO DIRECTION NAMED?", which is the question a
 * SIDEWAYS card is standing there asking.
 *
 * Three ids, one per mechanism the engine actually has for declining to commit:
 *
 *   `component-conflict`   two component groups point opposite ways, so the
 *                          gate refuses to read the sum of them as a direction.
 *                          calculations.ts raises it from `gate.conflicts`.
 *   `narrow-range-band`    the frame's edges are closer together than one ATR,
 *                          so there is no distance for a break to be measured
 *                          over and an ATR band stands in for the frame.
 *   `pending-zone-break`   a close IS through an edge and the zone has not
 *                          followed, because confirmation has not been met.
 *
 * Nothing else on the list is that fact. A strong EMA slope explains why the
 * score leans; only these explain why the leaning stopped short of a label.
 *
 * WHY THIS IS NOT THE ENGINE'S JOB. It already published all three, each as a
 * row with an impact. What it does not publish is which of its rows a READER
 * needs first, because that depends on the question the layer is answering —
 * the dialog is answering "what is the evidence", this list is answering "why
 * does the top of the card say SIDEWAYS". Choosing between rows the engine
 * already ranked is presentation; changing their ranks would not be.
 */
const WHY_NO_DIRECTION_WAS_NAMED: readonly string[] = [
  'component-conflict',
  'narrow-range-band',
  'pending-zone-break',
];

/**
 * The mark drawn beside a bullet, and why the list needed one at all.
 *
 * The dialog files every row under ปัจจัยสนับสนุน or ปัจจัยที่ต้องระวัง, so a
 * reader down there always knows which side a row is on. The beginner list has
 * no headings — it is four lines under a state name — and it had been drawing
 * every one of them behind the same "•". A CL-F card shipped four bullets that
 * all scanned as good news directly under a label saying no direction had been
 * named, and one of the four was a close through the low.
 *
 * `effectivePolarity` is what decides it, which is the same function the two
 * dialog headings are chosen with: one answer to "which side is this row on",
 * used in both places, so the card cannot file a row two ways.
 *
 * THE GLYPH IS NEVER THE ONLY TELLING. It is `aria-hidden` and it is a colour,
 * which makes it unavailable to a screen reader and unreliable for a reader who
 * does not separate red from green. Every directional label states its own
 * direction in words — see the structure rows in `reason-copy.ts` — and this is
 * the redundant third telling, not the fact.
 */
const REASON_SIDE_MARK = {
  up: { glyph: '▲', tone: 'text-emerald-300' },
  down: { glyph: '▼', tone: 'text-rose-300' },
  none: { glyph: '•', tone: 'text-slate-500' },
} as const;

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
    thai: 'กำลังขึ้นอย่างแข็งแรง',
    description: 'ราคากำลังขึ้นอย่างแข็งแรง • ทั้งตัวราคาและแรงส่งของราคาไปทางเดียวกัน และมีแรงซื้อหนุนอยู่',
    icon: TrendingUp,
    tone: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300',
  },
  BULLISH: {
    thai: 'แนวโน้มกำลังขึ้น',
    description: 'แนวโน้มโดยรวมกำลังขึ้น • แต่ยังไม่มีอะไรยืนยันหนักแน่น ควรดูต่ออีกสักพัก',
    icon: TrendingUp,
    tone: 'border-green-500/35 bg-green-500/10 text-green-300',
  },
  /*
   * SIDEWAYS, bound to now instead of to a state that keeps being true.
   *
   * "ราคายังไม่ไปทางไหนชัด" is unconditional: it names no moment, so a reader
   * takes it as a description of how this instrument IS. §6.6 measured what
   * that is worth — twenty bars on from a sideways call the LABEL is still
   * sideways 72.6% of the time and price is still inside the frame it named
   * 25.7% of the time (n=10525). Three quarters of the population has already
   * left; the sentence had been describing the label's own inertia.
   *
   * "ตอนนี้" is the whole fix in one word, and it is deliberately the smallest
   * one available: nothing here promises the reading will change, which would
   * be the same mistake pointed the other way.
   *
   * THIS ENTRY IS THE NO-FRAME WORDING and may not say "กรอบ". With
   * `SIGNAL_ZONES` off there is no frame in the payload and no rectangle on the
   * card — CL-F renders SIDEWAYS in exactly that state today — so the frame's
   * word would name nothing the reader can see. `descriptionFor` carries the
   * wording for the cards that do have one, where it can read `zones`.
   */
  SIDEWAYS: {
    thai: 'ตอนนี้ราคายังไม่ไปทางขึ้นหรือทางลง',
    description: 'ตอนนี้ราคายังไม่ไปทางขึ้นหรือทางลง ไม่ได้ขึ้นต่อเนื่องและไม่ได้ลงต่อเนื่อง',
    icon: Minus,
    tone: 'border-sky-500/30 bg-slate-500/10 text-sky-200',
  },
  SQUEEZE: {
    thai: 'ราคาแกว่งแคบลงกว่าปกติ',
    description: 'ช่วงที่ราคาแกว่งในแต่ละวันแคบลงกว่าปกติ • ยังบอกไม่ได้ว่าจะออกทางไหน',
    icon: Zap,
    tone: 'border-amber-400/40 bg-amber-500/10 text-amber-200',
  },
  OVEREXTENDED: {
    thai: 'ราคาไกลจากค่าเฉลี่ย',
    description: 'ราคาอยู่ห่างจากค่าเฉลี่ยของตัวเองมากกว่าปกติ • ยังไม่ได้แปลว่าจะกลับ แต่ระยะห่างนี้ผิดจากที่เคยเป็น',
    icon: TriangleAlert,
    tone: 'border-orange-400/40 bg-orange-500/10 text-orange-200',
  },
  BEARISH: {
    thai: 'แนวโน้มกำลังลง',
    description: 'แนวโน้มโดยรวมกำลังลง • แรงขายยังมีมากกว่าแรงซื้อ',
    icon: TrendingDown,
    tone: 'border-red-500/35 bg-red-500/10 text-red-300',
  },
  STRONG_BEARISH: {
    thai: 'กำลังลงอย่างแข็งแรง',
    description: 'ราคากำลังลงอย่างแข็งแรง • ทั้งตัวราคา แรงส่งของราคา และแรงขายไปทางเดียวกัน',
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
  low_volume_confirmation: 'ปริมาณซื้อขายน้อย',
  pending_breakout: 'ปิดเหนือกรอบ รอครบเกณฑ์',
  pending_breakdown: 'ปิดใต้กรอบ รอครบเกณฑ์',
  stale_or_partial_data: 'ข้อมูลไม่สดหรือไม่ครบ',
  earnings_imminent: 'ใกล้ประกาศงบมาก',
  earnings_soon: 'ใกล้ประกาศงบ',
  /*
   * NOT "กรอบ". This chip is raised from `breakout || breakdown` — the
   * CONFIRMED-PIVOT break, the same pair that raises
   * `structure-volume-unconfirmed` — and not from `zones`, so the frame's word
   * would be describing a boundary the frame does not own. The two chips above
   * it are the frame's and keep the word. Direction is unnamed here because
   * the flag is raised from either side and carries none.
   */
  pre_earnings_breakout: 'ผ่านจุดเดิมก่อนงบ',
  weak_confirmation: 'ยังยืนยันไม่ชัด',
  unfavorable_risk_reward: 'ระยะเสี่ยงมากกว่าระยะเป้า',
  risk_leg_inside_noise: 'ราคาชิดจุดที่รอบนี้จะจบ',
  recent_flip: 'ป้ายเพิ่งเปลี่ยน',
  stale_zone: 'ไม่มีการแตะขอบกรอบมานาน',
  narrow_range: 'กรอบแคบผิดปกติ',
  overextended: 'ราคาไกลค่าเฉลี่ย',
  squeeze: 'ความผันผวนบีบตัว',
  bearish_divergence: 'ราคาขึ้นแต่แรงเริ่มหมด',
  bullish_divergence: 'ราคาลงแต่แรงขายเริ่มหมด',
  strong_momentum: 'ราคามีแรงส่ง',
  high_volume: 'ปริมาณซื้อขายสูง',
};
const FLAG_ORDER = Object.keys(FLAG_COPY);
/*
 * Three, down from four.
 *
 * A row of chips is read left to right until the reader stops, and the ordering
 * above is what makes the cut safe: the ones that survive it are the ones that
 * change how the card should be read. The rest are listed in "ทำไม?", not
 * dropped.
 *
 * WHAT THIS COMMENT USED TO CLAIM, AND WHAT MEASURING IT FOUND. It said "three
 * fit on one line at every width the card renders at". They do not, and the
 * reason is the chip the sentence forgot: when anything is cut there is a
 * fourth box after them reading "+N ใน ทำไม?", so the phone case is four boxes
 * and not three. `qa:signal-zone-bar` measures the row at every width — one
 * line at 1280 and 1440, TWO at 390, 360 and 320.
 *
 * Left at three anyway, and the count is not the interesting part. Cutting to
 * two to win one line would push a chip that changes how the card reads into a
 * dialog to save 20px of vertical space, and a second line of chips is legible
 * — it was never the failure. What was wrong here was a number justified by a
 * measurement nobody took; the number stays and the justification is now the
 * measurement. The harness fails above two lines, which is where the claim
 * actually is.
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
  priceStructure: { label: 'Price Structure', helper: 'ดูว่าจุดสูงและจุดต่ำของราคาขยับไปทางไหน และผ่านแนวสำคัญไปแล้วหรือยัง' },
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
        {/*
          The plain sentence first, the engine's own words underneath.

          `result.reason` is payload — it is what the engine recorded about its
          own refusal, in the engine's vocabulary ("ต้องมี finalized 1D candles
          อย่างน้อย 60 แท่ง"), and it is snapshotted, so it cannot be reworded
          here without moving a gate that has nothing to do with copy. What it
          CAN stop being is the whole message: a reader who does not know what a
          finalized candle is now learns what happened from the first line, and
          the engine's sentence is kept below it, labelled as detail, for
          whoever the exact count is useful to.
        */}
        <p className="mt-3 text-sm leading-6 text-slate-400" data-testid="signal-insufficient-summary">
          ยังมีข้อมูลราคาไม่พอจะสรุปอะไรได้ ระบบจึงไม่แสดงผลที่เดาขึ้นเอง
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-500" data-testid="signal-insufficient-detail">รายละเอียด: {result.reason}</p>
        {result.warnings.map((warning) => <p key={warning} className="mt-2 text-xs text-amber-300">{warning}</p>)}
        <SignalFooter tone="text-slate-500" />
      </section>
    );
  }

  const presentation = MARKET_SIGNAL_PRESENTATION[result.state];
  const Icon = presentation.icon;
  const cautions = result.reasons.filter((reason) => readsAsCaution(reason, result.metrics, result.bias));
  const supporting = result.reasons.filter((reason) => !readsAsCaution(reason, result.metrics, result.bias));
  const unconfirmed = result.warnings;
  const biasLabel = result.bias === 'bullish' ? 'Bullish Bias' : result.bias === 'bearish' ? 'Bearish Bias' : 'Neutral Bias';
  const beginnerDescription = descriptionFor(result.state, result.bias, result.zones ?? null, presentation.description);
  const beginnerHeadline = headlineFor(result.state, result.zones ?? null, presentation.thai);
  /*
   * THE BASE RATE, SAID UNDER THE LABEL RATHER THAN LEFT IN A REPORT.
   *
   * The state line says where price stands now. This says what "now" has been
   * worth: §6.6 followed 10,525 sideways calls and found the LABEL still
   * sideways at twenty bars 72.6% of the time while price was still inside the
   * frame it named 25.7% of the time. A reader who is told only the first half
   * of that reads a durable state; both halves together are the finding.
   *
   * Every figure is interpolated from `MARKET_SIGNAL_MEASURED`, never typed in,
   * and `src/config/signal-measured.test.ts` reads the same four numbers out of
   * the run's own `report.md`. A fresh calibration pass that moves them fails
   * the suite rather than leaving this paragraph quoting a run nobody re-read.
   *
   * IT IS DRAWN ONLY WHERE THE FRAME IS. The measurement is `zone === 'sideways'`
   * against `frame.support/resistance`; with no frame in the payload there is
   * no "inside" for the second number to be about, and quoting it at a label
   * derived some other way would be attaching a measurement to a mechanism it
   * did not measure.
   *
   * PAST TENSE THROUGHOUT, and no advice. It reports what happened to earlier
   * observations over a fixed window — not which side price leaves on, not
   * when, and not what to do about it. §6.8 additionally forbids the opposite
   * reading, that a label which lasts is a label that can be trusted; the
   * second sentence exists to close that door rather than to leave it ajar.
   */
  const sidewaysBaseRate = frameNamedTheLabel(result.state, result.zones ?? null)
    ? [
      `จากการวัดย้อนหลัง ${SIDEWAYS_MEASURED.sampleSize.toLocaleString('en-US')} ครั้ง`
      + ` เมื่อผ่านไป ${SIDEWAYS_MEASURED.horizonBars} แท่ง`
      + ` ป้ายนี้ยังเป็นแบบเดิม ${SIDEWAYS_MEASURED.labelStillSidewaysPct}%`
      + ` แต่ราคายังอยู่ในกรอบเดิมเพียง ${SIDEWAYS_MEASURED.priceInsideFramePct}%`,
      'แปลว่าป้ายมักอยู่ต่อ ส่วนราคามักออกจากกรอบไปก่อนแล้ว จึงอ่านป้ายนี้เป็นสถานะตอนนี้ ไม่ใช่สิ่งที่จะอยู่ต่อไป',
    ]
    : null;
  /*
   * Thai wording and the four-chip cap arrive with the first phase that adds
   * flags. Without a phase on, the card keeps the raw list it has always drawn,
   * so a reader with every flag off sees the pixels they saw yesterday.
   */
  const chipsOrdered = Boolean(result.gate ?? result.zones);
  /* Gathered once: every reason row reads the same payload, and rebuilding it
     per row would be the same object seven times. */
  const reasonContext = reasonContextFor(result);
  /*
   * THE THREE OR FOUR LINES SOMEBODY READS BEFORE DECIDING TO OPEN ANYTHING.
   *
   * The reasons were dialog-only, which meant the beginner layer named a state
   * and then gave no account of it: a reader who wanted to know WHY had exactly
   * one move available, and it was a modal. These are the same rows the dialog
   * draws, in `REASON_HEADLINE`'s label register rather than in sentences, and
   * nothing is chosen here that the dialog does not also show in full.
   *
   * WHICH FOUR, and why it is no longer just the four heaviest. The engine's
   * `impact` is the only ranking in the payload and it ranks EVIDENCE; this
   * list has to account for a LABEL, and on a neutral card the two answers come
   * apart — the heaviest four rows can all point one way under a line saying
   * neither way won. `selectBeginnerReasons` is where the three rules that fix
   * that are written down, in full.
   *
   * The tail is not dropped, it is counted, in the same shape the chip row
   * already uses.
   */
  const beginnerReasons = selectBeginnerReasons(result.reasons, result.state, result.bias, result.metrics);
  const hiddenReasons = result.reasons.length - beginnerReasons.length;

  /*
   * The two facts §5 already carries, so this block can stop carrying them too.
   *
   * Both are derived from what is actually RENDERED down there — the reason
   * ids in this payload — rather than from the conditions that would raise
   * them, so the two blocks cannot drift apart when the engine changes its
   * mind about when to emit a row.
   */
  const conflictNamedInReasons = result.reasons.some((reason) => reason.id === 'component-conflict')
    ? (result.gate?.conflicts.includes('ema_vs_momentum') ? 'ema_vs_momentum' : 'structure_vs_momentum')
    : null;
  const unsaidConflicts = (result.gate?.conflicts ?? []).filter((conflict) => conflict !== conflictNamedInReasons);
  /* §5's earnings row states the day count and needs one; without it the row
     falls back to the engine's sentence and this line is the only place the
     gate's own framing is said. */
  const earningsSaidHere = (result.gate?.earningsProximity === 'imminent' || result.gate?.earningsProximity === 'soon')
    && !(result.reasons.some((reason) => reason.id === 'earnings-proximity') && result.gate?.daysToEarnings !== null);

  return (
    <section aria-label="Technical Outlook" data-state={result.state} className={`rounded-2xl border p-5 ${presentation.tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">Technical Signal · 1D</p>
          <div className="mt-2 flex items-center gap-2">
            <Icon aria-hidden="true" size={22} />
            <h2 className="font-bold text-white">Technical Outlook · Market Signal</h2>
          </div>
          {/*
            THE STATE, WITHOUT THE WORD "BIAS" BESIDE IT.

            The line used to read `SIDEWAYS • Neutral Bias`. "Bias" is which way
            something LEANS, i.e. a sentence about where price is going, printed
            two rows above a footer saying this card does not say where price is
            going. On SIDEWAYS it was also the same fact twice: the state IS the
            neutral one, so the second half of the line restated the first.

            The bias is not gone — it names the dialog this button opens, where
            it sits beside the score it is derived from and can be read as the
            arithmetic it is rather than as a forecast.
          */}
          <p className="mt-2 break-words font-mono text-lg font-bold text-white sm:text-xl">
            {result.state}
          </p>
          {/*
            NEITHER OF THE TWO SENTENCES THAT USED TO SIT HERE, ON A FRAMED CARD.

            `beginnerDescription` said "ตอนนี้ราคายังอยู่ในกรอบ ยังไม่มีราคาปิดพ้น
            ขอบบนหรือขอบล่าง…" directly under a headline reading "ตอนนี้ราคายังอยู่
            ในกรอบ" and directly above a picture whose own caption says the same
            thing a third time. Three tellings of one fact in one column is not
            emphasis, it is a reader checking whether they missed a difference.

            The description went first, into §1 of the dialog. The headline goes
            now, for the same reason and by the same test — the bar below is the
            only one of the three that also shows WHERE, with both edge prices
            under the track, so it is the one the pair collapses onto. See
            `headlineFor`, which returns `null` on exactly those cards; every
            other state still draws its own label here.
          */}
          {beginnerHeadline === null ? null : (
            <p className="mt-1 text-sm font-semibold" data-testid="signal-state-headline">{beginnerHeadline}</p>
          )}
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          data-testid="signal-advanced-toggle"
          className="flex min-h-11 items-center gap-2 rounded-xl border border-current/30 px-3 text-sm font-semibold hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
        >
          <Info aria-hidden="true" size={17} />
          {ADVANCED_TOGGLE}
        </button>
      </div>

      {/*
        The account of the state, on the layer that names it.

        Short enough that four of them are still a glance, and every one of them
        is a row the dialog draws in full — this is the same list, said in the
        register of the state names above it. `reasonHeadline` falls back to the
        full sentence for an id it has no label for, so a reason the engine adds
        tomorrow is long here rather than missing.
      */}
      {beginnerReasons.length ? (
        <ul className="mt-3 max-w-2xl space-y-1.5 text-sm leading-6 text-slate-300" data-testid="signal-beginner-reasons">
          {beginnerReasons.map((reason) => {
            /* The same answer the two dialog headings are chosen with, drawn as
               a mark because this list has no headings. See `REASON_SIDE_MARK`
               for why it is never the only telling of the direction. */
            const side = reasonSide(reason, result.metrics);
            return (
              <li key={reason.id} className="flex gap-2">
                <span aria-hidden="true" className={`leading-6 ${REASON_SIDE_MARK[side].tone}`}>
                  {REASON_SIDE_MARK[side].glyph}
                </span>
                {/* `data-reason-side` so the harness can assert the mix of
                    sides without reading a glyph out of the text. */}
                <span data-reason-id={reason.id} data-reason-side={side}>{reasonHeadline(reason, reasonContext)}</span>
              </li>
            );
          })}
          {hiddenReasons > 0 ? (
            <li className="text-xs leading-5 text-slate-400">
              และอีก {hiddenReasons} ข้อ ใน “{ADVANCED_TOGGLE}”
            </li>
          ) : null}
        </ul>
      ) : null}

      {/*
        THE ONLY THING THIS LAYER KEEPS OF THE TWO NUMBERS: one of their words.

        P4.5 had already taken the FIGURE off the agreement and left the word,
        for a reason it did not then apply to the score beside it: the 90-99
        band hits what the 20-29 band hits, so a figure printed next to a
        direction is read as a likelihood it does not carry. The score was the
        same reader making the same mistake with a different number — "+7 / 100"
        read as a 7% chance — and it needed a caveat beside it saying so.

        A number that has to ship with a warning against the obvious reading of
        it does not belong on the ten-second layer. Both moved to the top of the
        dialog, where the label has room to name its axis and the terms that
        produced it are three headings below. Nothing is hidden: the word here
        is the same `AGREEMENT_COPY` entry as ever, and it is the sentence a
        glance actually needs — whether the evidence agrees with itself.
      */}
      <div className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-200" data-testid="signal-agreement-word">
        {AGREEMENT_COPY[result.evidenceAgreementLabel]}
        <InfoHint term="signalConfidence" align="start" />
      </div>
      <div className="mt-2 flex flex-wrap gap-2" aria-label="Signal flags" data-testid="signal-flags">
        {(chipsOrdered ? orderedFlags(result.flags).slice(0, MAX_FLAG_CHIPS) : result.flags).map((flag) => (
          <span key={flag} className="rounded-full border border-current/20 px-2 py-1 text-[11px] font-semibold">
            {chipsOrdered ? flagLabel(flag) : flag.replaceAll('_', ' ')}
          </span>
        ))}
        {chipsOrdered && result.flags.length > MAX_FLAG_CHIPS ? (
          <span className="rounded-full border border-current/20 px-2 py-1 text-[11px] font-semibold text-slate-400">
            +{result.flags.length - MAX_FLAG_CHIPS} ใน “{ADVANCED_TOGGLE}”
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
      {/*
        The one line of the footer that belongs on a ten-second read.

        The full footer is three lines — the not-a-forecast finding, what it was
        measured over, and the legal disclaimer — and all three are still shown,
        at the bottom of the advanced layer, unchanged. This is the sentence
        they have in common, said once, in the register of the layer it is on.
      */}
      <p className="mt-3 text-xs leading-5 text-slate-400" data-testid="signal-short-note">{SHORT_NOTE}</p>
      {/*
        AND THE LEGAL LINE, BACK ON THE CARD IT WAS TAKEN OFF.

        `git log -S` puts "no render path can ship without it" in 02c3070, whose
        message decides one thing about placement: the not-a-forecast FINDING
        goes "above the disclaimer, on every one of the four render paths
        including the locked preview". That is a decision about the finding,
        forced by the P4a run. It is not a decision about this sentence.

        This sentence predates it — 51f4f5f, a general production patch — and
        the same "ไม่ใช่คำแนะนำซื้อขาย" clause is written inline on six other
        surfaces (the options card, three places in the simulator, the decision
        panel, the planner). The instrument that actually carries the claim is
        `INVESTMENT_DISCLAIMER` in `src/lib/legal/documents.ts`, which is
        versioned and effective-dated; what sits on a card is the house habit of
        repeating it where the numbers are. So: convention, not compliance, and
        the convention is that the surface a reader acts from says it.

        Only this line comes back. The finding and its provenance stay at the
        bottom of the advanced layer, where the evidence they quote is.
      */}
      <p className="mt-1 text-xs leading-5 text-slate-400" data-testid="signal-card-disclaimer">{DISCLAIMER}</p>

      <ResponsiveDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        title={`ทำไมเป็น ${result.state} • ${biasLabel}?`}
      >
        <div className="space-y-6 text-sm text-slate-300">
          {/*
            THE TWO NUMBERS, ON THE LAYER THAT CAN AFFORD THEM.

            Both were on the beginner card and both were being read as odds.
            Here each one gets what the card had no room for: the score gets an
            axis printed under it, so -100 is visible and `+7` cannot be a
            percentage of anything; the agreement gets its figure back beside
            the word, with the same caveat it used to carry in the raw block at
            the bottom of this dialog — said here, once, instead of there.

            First in the dialog rather than last because this is what the reader
            tapped through for. §2 says what the agreement figure is made of and
            §3 sums the score row by row, both a scroll below.
          */}
          <section data-testid="signal-numbers">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h3 className="font-semibold text-white">{SCORE_LABEL}</h3>
              <span className="inline-flex min-h-11 items-center gap-2">
                <strong className="font-mono text-lg text-white">{signed(result.score)}</strong>
                <InfoHint term="directionalScore" align="end" />
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-400">{SCORE_SCALE}</p>
            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h3 className="font-semibold text-white">ความสอดคล้องของหลักฐาน</h3>
              <span className="inline-flex min-h-11 items-center gap-2">
                <strong className="font-mono text-white">{AGREEMENT_COPY[result.evidenceAgreementLabel]} · {result.evidenceAgreement}/100</strong>
                <InfoHint term="signalConfidence" align="end" />
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-400">{AGREEMENT_NOT_A_CHANCE}</p>
          </section>

          <section>
            <h3 className="font-semibold text-white">1. สถานะนี้แปลว่าอะไร</h3>
            <p className="mt-2 leading-6" data-testid="signal-state-description">{beginnerDescription}</p>
            {/* The base rate, which used to be drawn twice — once under the
                state line and once here. It reads a measurement the beginner
                layer has no room to qualify, so it is kept where the rest of
                the working is, next to the reasons rather than instead of
                them. */}
            {sidewaysBaseRate ? (
              <div className="mt-2 space-y-1 leading-6 text-slate-400" data-testid="signal-sideways-base-rate-dialog">
                {sidewaysBaseRate.map((sentence) => <p key={sentence}>{sentence}</p>)}
              </div>
            ) : null}
            {/* The label's own history, moved off the card with everything else
                that is a measurement about the engine rather than about price.
                Unchanged: same strip, same three disclosures. */}
            {result.history ? <HistoryStrip history={result.history} /> : null}
          </section>

          {result.gate ? (
            <section data-testid="signal-gate-explainer">
              <h3 className="font-semibold text-white">ทำไมถึงไม่สรุปแรงกว่านี้</h3>
              <p className="mt-2 leading-6">{BAND_COPY[result.gate.band]} (คะแนนรวม {signed(result.score)})</p>
              {/*
                WHAT THIS BLOCK NO LONGER SAYS, BECAUSE §5 ALREADY SAID IT.

                It used to list `gate.conflicts` and print an earnings sentence,
                and §5 two headings below carried the SAME two facts as reason
                rows — `component-conflict` and `earnings-proximity`, raised by
                the engine from the same two gate fields. Word for word in the
                earnings case. A reader who reached the bottom of the dialog had
                met each of them twice and had no way to tell whether the second
                telling was a second finding.

                Deduplicated toward §5, which is the fuller telling: its rows
                say what the conflict MEANS and what a report does to a chart,
                where these two only named them.

                NOTHING IS DROPPED, and that is what the filters are for rather
                than a plain deletion. `component-conflict` is one row however
                many conflicts the gate holds — it names the EMA pair when there
                is one and the structure pair otherwise — so a card with both
                would lose the second if this list simply went away. So the list
                stays and shows exactly the conflicts §5 does not reach; on the
                ordinary one-conflict card that is none, and it draws nothing.
                The earnings line is held to the same test: it is drawn only
                when §5 has no row for it, which is when the gate published a
                proximity but no day count for the reason to state.
              */}
              {unsaidConflicts.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {unsaidConflicts.map((conflict) => <li key={conflict}>{CONFLICT_COPY[conflict]}</li>)}
                </ul>
              ) : null}
              {earningsSaidHere ? (
                <p className="mt-2 leading-6">อีก {result.gate.daysToEarnings} วันจะประกาศงบ ซึ่งเป็นเหตุการณ์ที่กราฟยังมองไม่เห็น จึงลดความมั่นใจลง</p>
              ) : null}
              {result.flags.length > MAX_FLAG_CHIPS ? (
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  สัญญาณอื่นที่พบ: {orderedFlags(result.flags).slice(MAX_FLAG_CHIPS).map(flagLabel).join(' · ')}
                </p>
              ) : null}
              {/*
                The multipliers, in the order the product takes them. Confidence
                is not a sum of parts any more, so showing parts that add up
                would misdescribe it.

                AND EVERY ONE OF THEM CARRIES THE FIGURE IT WAS DERIVED FROM.
                Five of these six are `withFloor(measured, floor)` — the same
                quantity section 2 reports raw — so the dialog was printing two
                different numbers for one thing, in two blocks, with nothing
                between them saying which was which: agreement 40 there and 70
                here, regime clarity 40 there and 70 here, conflict 13 there and
                88 here. A reader who reaches this dialog is the reader who
                checks arithmetic, and two contradictory sets cost them the
                whole page. So the raw figure is printed under the factor it
                produced, in the same box, and the heading says which kind each
                block is.
              */}
              <h4 className="mt-4 text-xs font-semibold text-white">ค่าที่ใช้คูณจริง (หลังยกด้วยค่าขั้นต่ำ)</h4>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                ตัวเลขชุดนี้ไม่ใช่ค่าที่วัดได้ตรง ๆ — แต่ละตัวถูกยกขึ้นด้วยค่าขั้นต่ำ กันไม่ให้ตัวเดียวกดผลลัพธ์เหลือศูนย์
                ค่าที่วัดได้จริงกำกับไว้ใต้แต่ละช่อง และอยู่ครบทุกตัวในหัวข้อ 2
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs" data-testid="signal-confidence-factors">
                <ConfidenceDetail
                  label="ฐานจากน้ำหนักหลักฐาน"
                  value={Math.round(result.gate.confidenceFactors.base)}
                  note={`วัดได้ ${result.confidenceBreakdown.evidenceStrength}%`}
                />
                <ConfidenceDetail
                  label="× ความครบของข้อมูล"
                  value={Math.round(result.gate.confidenceFactors.completeness * 100)}
                  note={`วัดได้ ${result.confidenceBreakdown.completeness}%`}
                />
                <ConfidenceDetail
                  label="× สัดส่วนหลักฐานที่ไปทางเดียวกัน"
                  value={Math.round(result.gate.confidenceFactors.agreement * 100)}
                  note={`วัดได้ ${result.confidenceBreakdown.agreement}%`}
                />
                <ConfidenceDetail
                  label="× ความชัดของภาวะตลาด"
                  value={Math.round(result.gate.confidenceFactors.regimeClarity * 100)}
                  note={`วัดได้ ${result.confidenceBreakdown.regimeClarity}%`}
                />
                {/* NOT a floored version of the row below it: this is the share
                    that does NOT conflict, i.e. the complement of the measured
                    penalty. Said as the complement rather than as "วัดได้",
                    which would be a false claim about the same arithmetic. */}
                <ConfidenceDetail
                  label="× หักความขัดแย้ง"
                  value={Math.round(result.gate.confidenceFactors.conflict * 100)}
                  note={`หลักฐานขัดแย้งกัน ${result.confidenceBreakdown.conflictPenalty}% จึงเหลือส่วนนี้`}
                />
                <ConfidenceDetail label="× ระยะถึงวันงบ" value={Math.round(result.gate.confidenceFactors.earnings * 100)} />
              </dl>
            </section>
          ) : null}

          <section>
            <h3 className="font-semibold text-white">2. ระบบดูจากอะไร</h3>
            <p className="mt-2 leading-6">ใช้ finalized 1D candles และหลักฐานจาก EMA, Momentum, ADX/DMI, Volume และ Price Structure</p>
            {/*
              WHICH NUMBER THE HEADLINE IS, said before anything else in this
              block.

              `evidenceAgreement` is the payload's name for the COMPOSITE — the
              same field as the deprecated `confidence`, the product of all six
              terms. The row below called "Evidence agreement" was
              `confidenceBreakdown.agreement`, which is one of those terms: the
              share of evidence weight pointing the same way as the score. Two
              different quantities, one name, four centimetres apart on one
              page — 62 in the sentence and 84 in the box under it — and nothing
              telling a reader they are not the same measurement disagreeing
              with itself. The row is now named for what it measures and this
              sentence says what the headline number is made of.
            */}
            <p className="mt-2 leading-6 text-slate-400">
              ตัวเลข {result.evidenceAgreement}/100 ที่หัวหน้าต่างนี้ คือผลของทุกค่าด้านล่างนี้รวมกัน ไม่ใช่แถวใดแถวหนึ่งเพียงแถวเดียว
              ตัวเลขทั้งสองชุดจึงไม่เท่ากัน และไม่ได้ขัดกัน
              · จากการวัดย้อนหลังพบว่าตัวเลขนี้ไม่ได้บอกโอกาสที่ราคาจะไปทางที่ระบุ
              ค่าสูงกับค่าต่ำให้ผลใกล้เคียงกัน จึงห้ามอ่านเป็นเปอร์เซ็นต์ความน่าจะเป็น
            </p>
            <h4 className="mt-3 text-xs font-semibold text-white">ค่าที่วัดได้จากข้อมูลจริง</h4>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs" data-testid="signal-confidence-measured">
              <ConfidenceDetail label="ความครบของข้อมูล" value={result.confidenceBreakdown.completeness} />
              <ConfidenceDetail label="สัดส่วนหลักฐานที่ไปทางเดียวกัน" value={result.confidenceBreakdown.agreement} />
              <ConfidenceDetail label="น้ำหนักหลักฐานรวม" value={result.confidenceBreakdown.evidenceStrength} />
              <ConfidenceDetail label="วอลุ่มยืนยันทิศทาง" value={result.confidenceBreakdown.volumeConfirmation} />
              <ConfidenceDetail label="ความชัดของภาวะตลาด" value={result.confidenceBreakdown.regimeClarity} />
              <ConfidenceDetail label="สัดส่วนหลักฐานที่ขัดแย้งกัน" value={result.confidenceBreakdown.conflictPenalty} />
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

          <ReasonList title="4. ปัจจัยสนับสนุน" reasons={supporting} empty="ยังไม่มีปัจจัยสนับสนุนเด่นที่ผ่านกฎ" context={reasonContext} metrics={result.metrics} />
          <ReasonList title="5. ปัจจัยที่ต้องระวัง" reasons={cautions} empty="ยังไม่มีปัจจัยขัดแย้งเด่นที่ผ่านกฎ" context={reasonContext} metrics={result.metrics} />
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
              {/*
                NOT the frame. These are the levels nearest the current price,
                which is a different derivation from the swing anchors the zone
                bar is cut with and routinely a very different pair of numbers —
                39.27 / 46.41 here against a frame of 27.94 / 50.17. Under the
                name "Support / Resistance", four rows above a block headed
                กรอบราคา, they read as the same thing measured twice and wrong
                once. `calculations.ts` says the card labels them as the nearest
                levels; until now it did not.
              */}
              <Detail
                label="แนวรับ / แนวต้านที่ใกล้ราคาที่สุด"
                value={joined(result.metrics.nearestSupport, result.metrics.nearestResistance)}
              />
              <Detail label="Divergence" value={result.metrics.divergence ?? '—'} />
            </dl>
          </section>

          <div className="rounded-xl border border-slate-800 p-3 text-xs leading-5 text-slate-400">
            {/* The two headline figures used to be repeated here, in a second
                vocabulary ("Score:") and with the caveat attached only to one
                of them. They are the first thing in this dialog now, with the
                axis and the caveat both — so this block is back to what it is
                for: which candles, when, from where, and which run. */}
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

/**
 * WHICH SIDE OF THE DIALOG A REASON IS FILED UNDER, and the one the engine
 * cannot answer for us.
 *
 * `reason.polarity` is the ENGINE's field and it means something narrower than
 * the two headings suggest: for a supplemental observation it records how the
 * observation cuts against the prevailing move, not whether the observation
 * itself is good news. `bullish-divergence` is the case that made that
 * difference visible. The engine files it as `caution` — correctly, from where
 * it sits, because it is a caution to anybody reading the downtrend it
 * interrupts — and the card then printed "ราคาทำจุดต่ำใหม่ แต่แรงขายไม่ได้แรงขึ้น
 * ตาม" under a heading reading ปัจจัยที่ต้องระวัง, which is the opposite of what
 * the sentence says. §4 sat empty beside it.
 *
 * THE FIX IS HERE AND NOT IN THE ENGINE. `polarity` is payload, snapshotted by
 * `__golden__/signal/*.json`; changing it would move a gate that has nothing to
 * do with which heading a row is drawn under. So the engine keeps its field and
 * this layer answers the presentation question, from `metrics.divergence` — the
 * SAME field the engine raised the reason from, never from `reason.text`.
 *
 * THE PARTITION IS TOTAL, which it was not before. The old pair of filters
 * asked for `polarity === 'positive'` under a bullish bias and
 * `polarity === 'information'` under a neutral one, so an information row on a
 * directional card, and every positive or negative row on a neutral card,
 * matched neither list and was drawn nowhere at all. Every reason now lands in
 * exactly one of the two sections: a row is a caution when it IS one, or when
 * it points against the bias the card is carrying, and is support otherwise.
 */
function effectivePolarity(reason: MarketSignalReason, metrics: MarketSignalMetrics): MarketSignalReason['polarity'] {
  if (reason.id === 'bullish-divergence' && metrics.divergence === 'bullish') return 'positive';
  if (reason.id === 'bearish-divergence' && metrics.divergence === 'bearish') return 'negative';
  return reason.polarity;
}

/*
 * NEUTRAL IS NOT "NEITHER SIDE", it is "no side named yet".
 *
 * With a bias in hand the question is easy: a row is a caution when it points
 * the other way. With `bias === 'neutral'` there is no other way to point, and
 * the old filters answered that by drawing directional rows nowhere at all. The
 * heading is what decides it instead — §5 is ปัจจัยที่ต้องระวัง, and a row of
 * evidence pointing down is something to watch whether or not the card has
 * committed to a direction, while a row pointing up is not.
 */
function readsAsCaution(reason: MarketSignalReason, metrics: MarketSignalMetrics, bias: MarketSignalBias): boolean {
  const polarity = effectivePolarity(reason, metrics);
  if (polarity === 'caution') return true;
  if (polarity === 'negative') return bias !== 'bearish';
  if (polarity === 'positive') return bias === 'bearish';
  return false;
}

/**
 * Which way a row points, in the three values the beginner list can draw.
 *
 * `readsAsCaution` above answers a different question — which HEADING a row
 * goes under, which folds in the bias the card is carrying. This list has no
 * headings and no bias to fold in, so it asks the narrower question: does this
 * row point up, down, or neither. Both read `effectivePolarity`, so the two
 * cannot disagree about which side a row is on.
 */
function reasonSide(reason: MarketSignalReason, metrics: MarketSignalMetrics): keyof typeof REASON_SIDE_MARK {
  const polarity = effectivePolarity(reason, metrics);
  if (polarity === 'positive') return 'up';
  if (polarity === 'negative') return 'down';
  return 'none';
}

/**
 * THE FOUR BULLETS, CHOSEN TO EXPLAIN THE LABEL RATHER THAN TO RANK THE EVIDENCE.
 *
 * They used to be `[...reasons].sort(by |impact|).slice(0, 4)`, which is the
 * honest answer to "which rows did the engine weight most" and the wrong answer
 * to the only question this list is on the card to settle: why does the line
 * above it say what it says. On a real CL-F card the two came apart completely
 * — the four heaviest rows were all on the bullish side, drawn under a SIDEWAYS
 * label, with the row that had ACTUALLY stopped the engine committing sitting
 * below the cut in "และอีก N ข้อ".
 *
 * Three rules, in the order they are applied:
 *
 *   1. A SIDEWAYS card leads with the row that says why no direction was named
 *      — see `WHY_NO_DIRECTION_WAS_NAMED` — and leads with it literally, at the
 *      top of the list. A reader who stops after one bullet should have got the
 *      answer to the question the label posed.
 *   2. If the payload holds rows on BOTH sides, both sides are drawn. The best
 *      row of each side is reserved a slot before the list is filled by weight,
 *      so a fifth-ranked bearish row is on the card when the four above it are
 *      all bullish. This is the rule that stops the list from being a summary
 *      of one side of the evidence.
 *   3. A neutral label may not carry four bullets that all point one way. Rule
 *      2 covers this whenever the other side exists; this is the remainder,
 *      where it does not — the list reaches instead for the best row that is
 *      not directional at all (a caution, a note) rather than repeating one
 *      side four times under a label saying neither side won.
 *
 * WHAT IS NOT REORDERED. Everything after the lead is drawn in the engine's own
 * `impact` order, and nothing here changes an impact, a polarity or a row's
 * text. The rows are the engine's; which four fit on a ten-second layer is not.
 *
 * `Math.abs` throughout because impact carries a side and a rank does not: a
 * heavy caution and a heavy support are equally worth the top of this list.
 */
function selectBeginnerReasons(
  reasons: readonly MarketSignalReason[],
  state: MarketSignalState,
  bias: MarketSignalBias,
  metrics: MarketSignalMetrics,
): MarketSignalReason[] {
  const byWeight = (left: MarketSignalReason, right: MarketSignalReason) =>
    Math.abs(right.impact) - Math.abs(left.impact);
  /* A copy: `result.reasons` is payload and the dialog reads it in the engine's
     own order. */
  const ranked = [...reasons].sort(byWeight);

  // Rule 1 — the lead, and only on the label that poses the question.
  const lead = state === 'SIDEWAYS'
    ? ranked.find((reason) => WHY_NO_DIRECTION_WAS_NAMED.includes(reason.id)) ?? null
    : null;

  // Rule 2 — a reserved slot per side, but only when there are two sides to hold.
  const sidesInPayload = new Set(ranked.map((reason) => reasonSide(reason, metrics)));
  const reserved = sidesInPayload.has('up') && sidesInPayload.has('down')
    ? (['up', 'down'] as const)
      .map((side) => ranked.find((reason) => reasonSide(reason, metrics) === side))
      .filter((reason): reason is MarketSignalReason => reason !== undefined)
    : [];

  const picked: MarketSignalReason[] = [];
  const take = (reason: MarketSignalReason | null) => {
    if (reason !== null && !picked.includes(reason) && picked.length < MAX_BEGINNER_REASONS) picked.push(reason);
  };
  take(lead);
  reserved.forEach(take);
  ranked.forEach(take);

  /*
   * Rule 3 — the remainder rule, applied to the drawn list rather than to the
   * payload, because it is a fact about what the reader ends up looking at.
   *
   * It fires only when every drawn row shares ONE directional side, which after
   * rule 2 means the other side is not in the payload at all. The swap takes
   * the lowest-weighted drawn row, never the lead: dropping the answer to the
   * label's own question to relieve the monotony would trade one defect for the
   * other one.
   */
  const drawnSides = new Set(picked.map((reason) => reasonSide(reason, metrics)));
  const oneSided = drawnSides.size === 1 && !drawnSides.has('none');
  if ((state === 'SIDEWAYS' || bias === 'neutral') && oneSided && picked.length > (lead === null ? 0 : 1)) {
    const drawn = [...drawnSides][0];
    const relief = ranked.find((reason) => !picked.includes(reason) && reasonSide(reason, metrics) !== drawn);
    if (relief) picked[picked.length - 1] = relief;
  }

  // The lead first because rule 1 says so; the rest by the engine's own weight.
  const rest = picked.filter((reason) => reason !== lead).sort(byWeight);
  return lead === null ? rest : [lead, ...rest];
}

/**
 * The footnote a re-filed row cannot be shown without.
 *
 * Moving a divergence into ปัจจัยสนับสนุน answers one question and opens
 * another: a reader who now meets it under a supportive heading has no way to
 * tell that it did not move the reading. It did not. The five components in
 * `scoreBreakdown` are what the score and therefore the bias are built from,
 * and a divergence is not one of them — it is a supplemental observation the
 * engine records beside them. So the note says exactly that, and it says it
 * only on the rows this layer re-filed, never on a row the engine itself
 * classified.
 */
function reasonNote(reason: MarketSignalReason, metrics: MarketSignalMetrics): string | null {
  return effectivePolarity(reason, metrics) === reason.polarity
    ? null
    : 'น้ำหนักน้อย — เป็นข้อสังเกตประกอบ ไม่ได้ทำให้ทิศทางที่การ์ดสรุปเปลี่ยนไป';
}

/**
 * Is the rectangle on the card the thing that named this label?
 *
 * True only when the payload carries a frame AND the frame's own answer is
 * `sideways`, which is the exact population `MARKET_SIGNAL_MEASURED
 * .sidewaysPersistence` was measured over (`row.zone === 'sideways'`, on a
 * calibration run with zones on). Everything that says "กรอบ" about the state
 * line — the headline, the description, the base-rate disclosure — is gated on
 * this, so the frame's word is never used on a card that has no frame, and the
 * measured figures are never quoted at a label they were not measured on.
 *
 * With `SIGNAL_ZONES` off — the shipping default — this is always false, and
 * the state line keeps the no-frame wording from `MARKET_SIGNAL_PRESENTATION`.
 */
const frameNamedTheLabel = (state: MarketSignalState, zones: MarketSignalZones | null): boolean =>
  state === 'SIDEWAYS' && zones !== null && zones.zone === 'sideways';

/**
 * The bold line under the state name — on every card except the one that has
 * the same sentence drawn twelve pixels lower with numbers attached.
 *
 * WHAT THIS USED TO RETURN, AND WHY IT IS GONE. On a framed SIDEWAYS card it
 * returned "ตอนนี้ราคายังอยู่ในกรอบ", and the zone bar directly below it heads
 * its own block with `ZONE_COPY.sideways` — "ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไป
 * หรือลงไปพ้นกรอบ". One fact, two sentences, a thumb apart. That column has now
 * been trimmed twice for the same reason: `beginnerDescription` moved into the
 * dialog when it was the third telling, and this is the second one going.
 *
 * THE BAR IS WHAT SURVIVES, and it is the right half of the pair to keep: it
 * says the same thing AND draws where the edges are, with both trigger prices
 * printed under the track. The headline said it with no numbers at all, so
 * everything it carried the bar carries and the bar carries more. Deleting the
 * bar instead would have cost the reader the two prices.
 *
 * `null` and not an empty string, so the paragraph is not rendered at all
 * rather than rendered blank — an empty `<p>` still takes its margin, and the
 * gap would read as something that failed to load.
 *
 * Every other state keeps `MARKET_SIGNAL_PRESENTATION[state].thai` untouched.
 * It is a LABEL and not a sentence — five to eleven words, the same register as
 * the other six — so the 15-35 word rule the prose is held to does not apply.
 */
function headlineFor(state: MarketSignalState, zones: MarketSignalZones | null, fallback: string): string | null {
  return frameNamedTheLabel(state, zones) ? null : fallback;
}

function descriptionFor(
  state: MarketSignalState,
  bias: MarketSignalBias,
  zones: MarketSignalZones | null,
  fallback: string,
): string {
  if (state === 'SQUEEZE') {
    if (bias === 'bullish') return 'ยังบอกไม่ได้ว่าราคาจะออกทางไหน แต่ตอนนี้หลักฐานเอนไปทางขึ้นมากกว่า';
    if (bias === 'bearish') return 'ยังบอกไม่ได้ว่าราคาจะออกทางไหน แต่ตอนนี้หลักฐานเอนไปทางลงมากกว่า';
    return 'ช่วงที่ราคาแกว่งแคบลงกว่าปกติ และหลักฐานยังไม่เอนไปทางขึ้นหรือทางลง';
  }
  if (state === 'OVEREXTENDED') {
    if (bias === 'bullish') return 'แนวโน้มโดยรวมยังขึ้น แต่ราคาวิ่งไกลจากค่าเฉลี่ยของตัวเองมาก';
    if (bias === 'bearish') return 'แนวโน้มโดยรวมยังลง แต่ราคาลงไกลจากค่าเฉลี่ยของตัวเองมาก';
  }
  /*
   * P7 — the reading the card could not previously produce.
   *
   * A directional label while the frame still says price has not left it. It
   * used to be impossible: `zone === 'sideways'` returned SIDEWAYS before the
   * evidence was consulted, and `trend_diagnosis.md` §B measured what that cost
   * — 11,330 bars where the move was real, the direction was in the evidence
   * (the flags-OFF engine named it correctly on 95.3% of them) and the frame
   * spoke over it.
   *
   * So the card now shows both, and this sentence is the join. Without it a
   * reader gets a bullish headline directly above a picture of price sitting in
   * the middle of a rectangle and has to invent the reconciliation themselves.
   * The two facts answer different questions — where price has got to, and how
   * far the evidence leans — which is the same shape §5 of the handover already
   * uses for a conflict.
   */
  if ((state === 'BULLISH' || state === 'BEARISH') && zones !== null && zones.zone === 'sideways') {
    const leaning = state === 'BULLISH' ? 'ขึ้น' : 'ลง';
    return `คะแนนรวมเอนไปทาง${leaning}มากพอจะบอกทิศได้ แต่ราคายังอยู่ในกรอบเดิม ยังไม่ปิดพ้นขอบบนหรือขอบล่าง การ์ดจึงบอกทั้งสองอย่าง`;
  }
  if (state === 'SIDEWAYS') {
    /*
     * The same sentence twice, because the card is two cards.
     *
     * WITH A FRAME the description says where price stands relative to the
     * rectangle drawn a few rows below it, in the rectangle's own words — the
     * headline, this line and the bar then teach each other, which is the ONE
     * WORD FOR ONE THING rule applied upward from the picture to the state.
     *
     * WITHOUT ONE it says the same thing about direction and stops. There is no
     * frame in the payload to be inside of, so claiming one would be the card
     * describing an object it cannot see.
     *
     * "แรงซื้อกับแรงขายใกล้เคียงกัน" is gone from the neutral line for the
     * reason FRESH_ZONE_COPY's block gives: buyers and sellers are a cast of
     * characters this card never introduces and never measures. What it does
     * measure is where the evidence points, which is what the clause now says.
     */
    const leaning = bias === 'bullish' ? 'ขึ้น' : 'ลง';
    if (frameNamedTheLabel(state, zones)) {
      if (bias === 'neutral') {
        return 'ตอนนี้ราคายังอยู่ในกรอบ ยังไม่มีราคาปิดพ้นขอบบนหรือขอบล่าง และหลักฐานยังไม่เอนไปทางขึ้นหรือทางลง';
      }
      /*
       * SIDEWAYS with a lean, which the fallback denied outright.
       *
       * With zones on, STRUCTURE names the label and the score describes the
       * lean inside it, so "SIDEWAYS • Bullish Bias" is a normal reading. The
       * fallback under it said "ราคายังไม่มีทิศทางขึ้นหรือลงที่ชัดเจน" — a flat
       * denial of the two words directly above it. These say both things, in
       * the same shape SQUEEZE already uses for exactly this situation.
       */
      return `ตอนนี้ราคายังอยู่ในกรอบ ยังไม่มีราคาปิดพ้นขอบบนหรือขอบล่าง • แต่คะแนนรวมเอนไปทาง${leaning}`;
    }
    if (bias === 'neutral') return fallback;
    return `ตอนนี้ราคายังไม่ไปทางขึ้นหรือทางลง ไม่ได้ขึ้นต่อเนื่องและไม่ได้ลงต่อเนื่อง • แต่คะแนนรวมเอนไปทาง${leaning}`;
  }
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
 * One recorded day, written the short way, for the two ends of the strip.
 *
 * Day and month and no year: the window is thirty days, so a year would read
 * the same at both ends of every strip that is not sitting on New Year, and it
 * is the SPAN a reader is taking from this line rather than the date. The full
 * date, year and all, is on each cell — see `HistoryStrip` — where there is
 * room for it because only one is ever shown at a time.
 */
const HISTORY_SPAN_FORMAT = new Intl.DateTimeFormat(THAI_LOCALE, {
  day: 'numeric',
  month: 'short',
  timeZone: BANGKOK_TIME_ZONE,
});

/** Noon UTC, so the Bangkok formatter cannot walk a date-only value back a day. */
function formatHistorySpanDay(asOf: string): string {
  const date = new Date(`${asOf}T12:00:00.000Z`);
  return Number.isNaN(date.valueOf()) ? asOf : HISTORY_SPAN_FORMAT.format(date);
}

/**
 * P6 — what this card said, for as long as anyone has been looking.
 *
 * ONE CELL PER RECORDED DAY, NOT PER CALENDAR DAY, and the strip now has to say
 * so out loud. A row exists for a day only if somebody opened the card that day,
 * so the cells are the recorded days in the order they were recorded, packed
 * against the right-hand (newest) end of the track. Two cells side by side are
 * therefore two consecutive RECORDINGS and not necessarily two consecutive
 * days, and that is carried by the DATES rather than by a sentence: the span
 * line under the strip gives the real first and last day, and each cell names
 * its own on hover and to a screen reader. The caption tried saying it in words
 * as well and cost a fourth wrapped line for a fact already told twice.
 *
 * WHAT WENT WRONG BEFORE. Every cell was `flex-1` inside a flex row, so N cells
 * shared the full width however small N was: two recorded days drew two half-
 * width blocks, and the reader saw a FULL bar with a seam in it directly above a
 * sentence saying two days of thirty had been recorded. The picture and the
 * sentence were making opposite claims and the picture was winning. The track is
 * now `windowDays` columns wide whatever it holds, so the count and the shape of
 * the thing are one fact — twenty-eight of the thirty columns stand empty on a
 * card with two days in it.
 *
 * THE EMPTY COLUMNS ARE DRAWN, AND THEY ARE DRAWN EMPTY. §6.8 of
 * `docs/signal-handover.md` allows a gap and forbids closing it: interpolating,
 * or stretching a neighbouring cell across it, puts a label on a day the card
 * never published. They are a SIBLING layer rather than children of the strip,
 * for a reason worth keeping — the strip's children stay exactly the recorded
 * days, so "one cell per recorded day" is still checkable by counting them, and
 * the test that every cell of one label is styled identically keeps comparing
 * labels against labels rather than against blanks.
 *
 * The age line sits with the three the zone bar already carries (zone, frame,
 * last touch) because it is the fourth member of the same family: a duration,
 * stated plainly, that a reader must not mistake for a confidence.
 */
function HistoryStrip({ history }: { history: MarketSignalHistory }) {
  /*
   * `currentRawLabelDays`, NOT `currentLabelDays`, and the difference is the
   * whole reason both exist.
   *
   * P8 holds a changed label until the new reading has stood two bars, so every
   * published run is at least as long as the reading underneath it and some are
   * longer. `currentLabelDays` therefore now carries the hold rule's own
   * influence. §6.8 of `docs/signal-handover.md` measured that an older label is
   * not a better one — 49.2% against 49.9% at the extremes — and forbids the
   * card implying otherwise; printing a duration the engine itself lengthened
   * would be exactly that claim with an extra step. This is the run of the
   * reading, before any holding.
   *
   * `null` is a real answer here and it is more common than it was: one
   * recorded day, or any day in the run written before P8 stored a raw reading.
   * The card says it cannot tell rather than falling back to the held number.
   */
  const { entries, windowDays, currentRawLabelDays, recentFlip } = history;

  /*
   * TOO FEW RECORDED DAYS TO DRAW, so nothing is drawn — the number is
   * `minStripDays` in `src/config/signal.ts`, written down there as the product
   * choice it is rather than passed off as a measurement.
   *
   * Three marks in a thirty-column track is not a small amount of evidence, it
   * is an invitation to read a shape out of three observations: a run, a gap, a
   * drift in the colours. The count states the same fact without offering the
   * shape, so below the line the count is the whole telling.
   */
  if (entries.length < MARKET_SIGNAL_HISTORY.minStripDays) {
    return (
      <div className="mt-3" data-testid="signal-history">
        <p className="text-[11px] leading-5 text-slate-400" data-testid="signal-history-collecting">
          กำลังเก็บข้อมูล ยังไม่พอวาดแถบป้ายย้อนหลัง (บันทึกได้ {entries.length} จาก {MARKET_SIGNAL_HISTORY.minStripDays} วันที่ต้องมีก่อน)
        </p>
      </div>
    );
  }

  const latest = entries[entries.length - 1];
  /*
   * The track is as wide as the window the sentence names rather than as wide
   * as the config constant, so the picture and "N จาก M วันที่ผ่านมา" cannot
   * drift apart — they read one field. `Math.max` is the degenerate guard: a
   * window narrower than the number of rows inside it would clip days off the
   * left edge, which is the one direction this strip must never lose data in.
   */
  const slots = Math.max(entries.length, windowDays);
  const firstColumn = slots - entries.length + 1;
  const columns = { gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` };

  return (
    <div className="mt-3" data-testid="signal-history">
      <span className="text-[11px] text-slate-400">ป้ายย้อนหลัง</span>
      {/*
        WHAT THE PICTURE IS, ABOVE THE PICTURE.

        The strip shipped with no caption at all, which left a reader to work
        out from a row of coloured blocks that they were looking at days, that
        the days were days SOMEBODY OPENED THIS CARD rather than days the market
        traded, and that a blank meant no row rather than a holiday. Three
        inferences, none of them available from the drawing, all three
        load-bearing — the third most of all, because "the market was shut" and
        "nobody looked" are opposite readings of the same white space and only
        one of them is true here.

        WHAT IT DELIBERATELY NO LONGER SAYS. It carried a fourth clause — that
        cells are ordered by recording, so two side by side need not be two
        consecutive days — and at 390px the four clauses wrapped to four lines.
        A caption that long is one a reader skips, which costs all four rather
        than the one. It comes out because it is the clause with two other
        tellings: the span line under the strip gives the real first and last
        date, and every cell carries its own date on hover and to a screen
        reader. The two that stay have no second telling anywhere on the card.
      */}
      <p className="mt-1 text-[11px] leading-5 text-slate-400" data-testid="signal-history-legend">
        แต่ละช่องคือหนึ่งวันที่มีคนเปิดการ์ดนี้ สีคือป้ายของวันนั้น ·
        ช่องว่างคือวันที่ไม่มีใครเปิด จึงไม่มีแถว ไม่ใช่วันที่ตลาดปิด
      </p>
      <div className="relative mt-2 h-4">
        {/*
          The empty slots. One flat tone, no ramp and no fade: a blank is the
          absence of a row, and every absence is the same absence.

          `bg-slate-700/60` because it is a tone the compat layer already
          re-points for the light surface — `src/themes/compat-tokens.test.ts`
          fails the build on a hardcoded palette class with no mapping, and an
          unmapped one would draw a dark trough on a light card.
        */}
        <div aria-hidden="true" className="absolute inset-0 grid gap-[2px]" style={columns}>
          {Array.from({ length: slots }, (_, slot) => (
            <span key={slot} className="rounded-[1px] bg-slate-700/60" />
          ))}
        </div>
        <div
          className="relative grid h-4 gap-[2px]"
          style={columns}
          aria-label="ประวัติป้าย 30 วัน"
          role="list"
        >
          {/*
            The date and the label, on the cell, for a thumb and for a screen
            reader — and nowhere else. Thirty labelled cells on a 390px screen
            is thirty unreadable labels, so the date is spelled out for the one
            cell being asked about and for no others.
          */}
          {entries.map((entry, index) => (
            <span
              key={entry.asOf}
              role="listitem"
              style={{ gridColumnStart: firstColumn + index }}
              title={`${formatThaiDateOnly(entry.asOf)} · ${entry.state}`}
              aria-label={`${formatThaiDateOnly(entry.asOf)} · ${entry.state}`}
              className={`h-4 rounded-[1px] ${HISTORY_CELL_TONE[entry.state]}`}
            />
          ))}
        </div>
      </div>
      {/*
        The two ends of the strip, which is what makes the cells readable as
        time at all. Twenty cells spread over a month and twenty cells spread
        over three weeks draw the identical picture; only this line separates
        them.
      */}
      <p className="mt-1 text-[10px] leading-4 text-slate-500" data-testid="signal-history-span">
        {formatHistorySpanDay(entries[0].asOf)} ─ {formatHistorySpanDay(latest.asOf)}
      </p>

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
        {currentRawLabelDays === null
          ? `${latest.state} ยังไม่มีวันที่บันทึกพอจะบอกได้ว่ายืนมานานแค่ไหน`
          : `ป้าย ${latest.state} นี้ยืนมา ${currentRawLabelDays} วัน`}
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
/*
 * ONE WORD FOR ONE THING, and the word is "กรอบ".
 *
 * The card used to run two vocabularies over one object: the bar was painted
 * with "กรอบเดิม" while the three sentences around it said "โซน". They are the
 * same rectangle. A reader who has never traded has no way to know that, and
 * the two words a thumb-length apart read as two different measurements that
 * happen to disagree. Everything in this block — headline, live row, change
 * row, proximity row, and the names drawn ON the bar — now says "กรอบ", and
 * `MarketSignalSection.test.tsx` fails the build if "โซน" comes back.
 *
 * "หลุด" went with it. It is the chartist's verb for leaving a level downward
 * and it carries a verdict the payload does not support; "ลงไปอยู่ใต้กรอบ" is
 * the same event with the judgement taken out.
 *
 * Each line also says what the state IS rather than naming it. "ราคายังอยู่ใน
 * กรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ" is longer than "ไซด์เวย์" and it is the
 * whole point: the reader finishes the sentence knowing what happened.
 */
const ZONE_COPY = {
  uptrend: 'ราคาขึ้นไปอยู่เหนือกรอบเดิมแล้ว',
  sideways: 'ราคายังอยู่ในกรอบเดิม ไม่ได้ขึ้นไปหรือลงไปพ้นกรอบ',
  downtrend: 'ราคาลงไปอยู่ใต้กรอบเดิมแล้ว',
} as const;

/**
 * The freshness clause, and why it cannot be one sentence for three zones.
 *
 * It used to be one: " แต่เพิ่งผ่านมาไม่นาน ยังพลิกกลับได้ง่าย", appended to
 * whichever of the three lines above it was drawn. On `uptrend` and `downtrend`
 * that reads correctly, because something WAS crossed to get there. On
 * `sideways` the headline is "ราคายังอยู่ในกรอบเดิม" — nothing has been
 * crossed at all — so the two halves of one sentence contradicted each other,
 * and the half that was wrong was the half claiming an event.
 *
 * `freshlyFormed` is `min(zoneAge, frameAge) <= FRESH_ZONE_BARS`, so on a
 * sideways card it fires for the OTHER reason in that minimum: the frame itself
 * was re-anchored a few bars ago. That is what the sideways clause says.
 */
/**
 * The close is through an edge and the label has not moved yet.
 *
 * `pendingBreakout` is `zone !== 'uptrend' && close > upperTrigger`, so it is
 * true on a SIDEWAYS zone whose close is already above the frame — the engine
 * names the state, raises a chip for it and writes a reason about it, and the
 * headline above all of that still read "ราคายังอยู่ในกรอบเดิม". Meanwhile the
 * proximity line one row down said "ราคาเลยขอบกรอบมาแล้ว". Two sentences a
 * thumb-length apart, describing the same close, disagreeing about which side
 * of a line it is on.
 *
 * Said as the two facts it actually is: price went through, and the label did
 * not follow because confirmation has not been met. Worded for any zone, not
 * just sideways — a gap through the whole frame makes `pendingBreakout` true on
 * a downtrend zone too, where "ราคาหลุดลงมาใต้กรอบเดิมแล้ว" is the same
 * contradiction in the other direction.
 *
 * No number for the confirmation rule, because the payload does not carry one
 * and inventing one here would be the card describing an engine it cannot see.
 */
const PENDING_ZONE_COPY = {
  up: 'ราคาปิดขึ้นไปเหนือกรอบแล้ว แต่ยังไม่ผ่านเกณฑ์ที่จะนับว่าออกจากกรอบจริง จึงยังถือว่าอยู่ในกรอบเดิม',
  down: 'ราคาปิดลงไปใต้กรอบแล้ว แต่ยังไม่ผ่านเกณฑ์ที่จะนับว่าออกจากกรอบจริง จึงยังถือว่าอยู่ในกรอบเดิม',
} as const;

/*
 * "พลิกกลับ" and "ยังไม่มีฝั่งไหนคุมได้" are both gone, for the same reason.
 *
 * The first is a trader's word for a reversal and says nothing a beginner can
 * picture. The second is about buyers and sellers — "ฝั่ง" — which is a cast of
 * characters this card has never introduced and does not measure. Both are now
 * the concrete thing that would happen next: price coming back inside the
 * rectangle drawn directly underneath the sentence.
 *
 * THERE IS DELIBERATELY NO CLAUSE FOR AN OLD FRAME. `docs/market-signal/
 * p6-history-findings.md` measured whether an older label is a more accurate
 * one and found nothing — no age bucket beat the base rate by more than its own
 * sampling error. "กรอบนี้อยู่มานานแล้ว" would be read as reassurance, which is
 * the single reading the evidence rules out, so the card says nothing at all.
 */
const FRESH_ZONE_COPY = {
  uptrend: ' · เพิ่งขึ้นไปได้ไม่กี่วัน ยังลงกลับเข้ากรอบได้ง่าย',
  downtrend: ' · เพิ่งลงไปได้ไม่กี่วัน ยังขึ้นกลับเข้ากรอบได้ง่าย',
  sideways: ' · กรอบนี้เพิ่งตั้งได้ไม่กี่วัน ยังไม่นิ่ง',
} as const;

/*
 * The two things about the frame ITSELF that the card never said out loud.
 *
 * `atr_band` means no usable pivot existed, so the frame is a volatility
 * envelope recomputed around EMA20 every bar rather than prices the market has
 * actually traded against. That was dialog-only, which left the headline making
 * the same claim on both kinds of frame — and it is precisely the reader who
 * never opens "ทำไม?" who needs to know the rectangle is arithmetic rather than
 * history. It is a clause on the headline, not a row of its own, so the
 * four-line budget under the picture is untouched.
 *
 * The no-frame case is the other half: `hasFrame` false means there are no edge
 * numbers at all, and until now the headline still spoke of "กรอบเดิม" over a
 * bar with nothing cut into it.
 */
const ZONE_FRAME_NOTE_COPY = {
  atrBand: ' · กรอบนี้คำนวณจากความเหวี่ยงของราคา ไม่ใช่ราคาที่ตลาดเคยชนจริง และขยับทุกวัน',
  noFrame: ' · ข้อมูลยังไม่พอจะตีกรอบ ตัวเลขขอบจึงยังไม่มี',
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
/*
 * AND THEY ARE THE SAME WORDS THE SENTENCES USE.
 *
 * They used to be "ขาลง / กรอบเดิม / ขาขึ้น": two trend names on the outside and
 * a frame name in the middle, i.e. three fields of one picture labelled in two
 * different vocabularies, neither of which matched the prose around it. A
 * beginner reading "ราคาขึ้นไปอยู่เหนือกรอบเดิมแล้ว" then looking down at a
 * field called "ขาขึ้น" has to be told those are the same claim.
 *
 * Now the three names are positions — where price is relative to the rectangle
 * — which is the only thing the geometry actually encodes. `sideOf` reads the
 * same three states off the same two triggers, so the name on the field, the
 * headline and the live row cannot drift apart.
 */
const ZONE_SEGMENT_COPY = {
  downtrend: 'ใต้กรอบ',
  sideways: 'ในกรอบ',
  uptrend: 'เหนือกรอบ',
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
  Insufficient: 'ข้อมูลยังไม่พอจะเทียบ',
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
  structural: 'ขอบกรอบมาจากจุดที่ราคาเคยกลับตัวจริงล่าสุด',
  atr_band: 'ไม่มีจุดกลับตัวที่ใช้ได้ จึงคำนวณกรอบจากความเหวี่ยงเฉลี่ยรอบเส้นค่าเฉลี่ย 20 วัน',
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
 *
 * "เหมือนราคาปิด" is gone from all three. It was there to say the two marks
 * agree, and it reads two ways: that the two prices are EQUAL — which is false,
 * and is the one reading a beginner reaches for when two numbers sit in one
 * sentence — or that they are on the same side of the same line, which is what
 * was meant. The distinction it was carrying is already drawn twice over: the
 * bar shows both marks, and the divergent case is set in the warning weight
 * while this one is not. An ambiguous clause is not worth a third telling.
 */
const LIVE_SAME_SIDE_COPY = {
  above: 'ยังอยู่เหนือกรอบ',
  inside: 'ยังไม่ออกจากกรอบ',
  below: 'ยังอยู่ใต้กรอบ',
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
  if (live === 'above') return 'ขึ้นไปเหนือกรอบแล้ว';
  if (live === 'below') return 'ลงไปใต้กรอบแล้ว';
  return close === 'above' ? 'ลงกลับเข้ากรอบแล้ว' : 'ขึ้นกลับเข้ากรอบแล้ว';
}

/*
 * Why the price on screen does not move the label, said as the mechanism.
 *
 * It used to read "โซนจะเปลี่ยนก็ต่อเมื่อปิดแบบนี้" — a rule stated in the
 * card's private vocabulary, which tells a reader what the engine does without
 * telling them why the number they are looking at changed nothing. This is the
 * same rule as the fact behind it: only a daily close is counted, and the price
 * currently trading is not one. It is the same sentence the block's footnote
 * already ends with, so the two agree by construction.
 */
const LIVE_INTRADAY_RULE = ' · แต่ต้องรอราคาปิดของวัน ราคาระหว่างวันยังไม่นับ';

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
  if (distance < 0) return side === 'above' ? 'ราคาขึ้นไปถึงแล้ว' : 'ราคาลงมาถึงแล้ว';
  return `${side === 'above' ? 'สูงกว่า' : 'ต่ำกว่า'}ราคาปิดล่าสุด ${percentText(distance, reference)}`;
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
    /** The live marker's, for the same question asked of the pair. */
    liveMarkPx: 4,
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
    liveMarkPx: 6,
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

/**
 * Closer than this and two MARKS read as one thick mark.
 *
 * The same number as `LABEL_MIN_GAP_PX` and for the same reason: below about
 * four pixels of clear air between two painted edges a reader sees one line,
 * and the bar is then telling them there is one price when it drew two. QA
 * measured 2.8px between the close and live marks at 320px and reported the
 * case clean, because the only marker rule it had was about labels overlapping.
 *
 * Measured in PAINTED EDGES rather than in centres, because that is what the
 * eye is separating: two 6px marks whose centres are 7px apart have 1px of gap.
 * When there is not enough, the bar draws ONE mark and the difference between
 * the two prices is stated in the sentence under it — a picture that cannot
 * carry a distinction has to hand it to the prose rather than pretend.
 */
const MARKER_MIN_GAP_PX = 4;

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
  /** A close through an edge that the label has not followed. See `PENDING_ZONE_COPY`. */
  const pendingSide = zones.pendingBreakout ? 'up' as const : zones.pendingBreakdown ? 'down' as const : null;

  /*
   * "WHAT WOULD CHANGE THIS?", on the two zones that were answering it only
   * sometimes.
   *
   * `sideways` has had a row naming its two triggers since P5. `uptrend` and
   * `downtrend` never had one — they had `ActionableRows`, which prints the
   * SAME level ("ถ้าราคาปิดลงต่ำกว่า 42.24") whenever the engine publishes an
   * invalidation. So the question was answered on those two zones by accident
   * of another row existing, and went unanswered entirely on the cards where
   * that row is withheld: an `atr_band` frame, or an edge the close has already
   * gone past. On today's corpus that is most instruments.
   *
   * This is the fallback for exactly those cards, and it is drawn ONLY when
   * `ActionableRows` will not draw the level itself. Printing both would be one
   * price twice in four lines and would break the four-line budget the test
   * below the picture enforces.
   *
   * The level is `resistance` / `support` — the frame's own anchors, which are
   * what a zone is LEFT by closing back through, and the same two the engine
   * hands to `calculateActionable`. The card computes nothing: it re-reads the
   * payload's own numbers.
   *
   * `reentryAhead` is the engine's `invalidation_behind_close` refusal applied
   * to the same geometry. A level the close is already past is not a condition
   * a reader can wait for; it is an event, and stating it as a condition would
   * have the card asking for something that already happened.
   */
  const reentryLevel = zone === 'uptrend' ? zones.resistance : zone === 'downtrend' ? zones.support : null;
  const reentryAhead = reentryLevel !== null && Number.isFinite(reentryLevel)
    && (zone === 'uptrend' ? referenceClose > reentryLevel : referenceClose < reentryLevel);
  const invalidationDrawn = actionable !== null && actionable.invalidation !== null;
  const changeCopy = !hasFrame ? null
    : zone === 'sideways'
      ? (pendingSide === null
        ? `ราคาปิดต้องขึ้นเหนือ ${priceText(upperTrigger)} หรือลงต่ำกว่า ${priceText(lowerTrigger)} ถึงจะนับว่าออกจากกรอบ`
        : 'ราคาปิดออกนอกกรอบไปแล้ว ต้องปิดแบบนี้ต่ออีกจนผ่านเกณฑ์ ถึงจะนับว่าออกจากกรอบจริง')
      : invalidationDrawn || !reentryAhead || reentryLevel === null ? null
        : zone === 'uptrend'
          ? `ราคาปิดต้องลงต่ำกว่า ${priceText(reentryLevel)} ถึงจะนับว่ากลับเข้ากรอบ`
          : `ราคาปิดต้องขึ้นเหนือ ${priceText(reentryLevel)} ถึงจะนับว่ากลับเข้ากรอบ`;

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

  /*
   * TWO MARKS OR ONE, decided on the pixels between their painted edges.
   *
   * Everything else on this bar is placed by measurement and the marks were the
   * exception: they were drawn at their two percentages whatever that came to
   * in pixels, and at 320px "whatever that came to" was 2.8px of gap on a case
   * QA reported as clean. Two lines a reader cannot separate are worse than one
   * line plus a sentence, because the picture is then making a distinction the
   * eye cannot collect and the reader has no way to know it was there.
   *
   * Unmeasured (`track` 0 — the server render and the first client render) the
   * answer is TWO, the same as every other concession on this bar: collapsing
   * is a decision about room, and a decision about room made without a
   * measurement is a guess. Both halves of hydration therefore draw two marks
   * and the layout effect collapses them before the first paint if it must.
   */
  const markerCentreGapPx = liveAt === null || !(track > 0)
    ? null
    : (Math.abs(liveAt - closeAt) / 100) * track;
  const markersMerged = markerCentreGapPx !== null
    && markerCentreGapPx - (size.closeMarkPx + size.liveMarkPx) / 2 < MARKER_MIN_GAP_PX;

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
    /*
     * A collapsed pair of marks takes its captions with it, and it has to: the
     * live caption's leader points at `data-marker="live"`, and that element is
     * no longer on the page. Two captions naming one drawn line is also the
     * exact confusion the merge exists to prevent, one row higher up.
     */
    const spread = markersMerged ? null : spreadLabels(closeCaption, liveCaption, track);
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
    <div
      className="mt-4 w-full rounded-xl border border-current/20 p-3"
      data-testid="signal-zone-bar"
      /* So the harness can tell "the live mark is missing" from "the live mark
         was deliberately drawn into the close one". The first is a bug. */
      data-markers-collapsed={markersMerged ? 'true' : 'false'}
    >
      <p className={`${size.prose.headline} font-semibold`} data-zone-row="headline">
        {pendingSide === null ? ZONE_COPY[zone] : PENDING_ZONE_COPY[pendingSide]}
        {/* The freshness clause is about a settled zone being young. On a close
            that has already gone through an edge the zone's age is not the
            unsettled thing about it, and "ยังไม่มีฝั่งไหนคุมได้" beside "ราคาปิด
            เลยขอบบนแล้ว" is the contradiction again in smaller type. */}
        {freshlyFormed && pendingSide === null
          ? <span className="font-normal text-slate-300">{FRESH_ZONE_COPY[zone]}</span>
          : null}
        {/* What KIND of rectangle it is, when it is not the usual kind. Both
            clauses are mutually exclusive with each other by construction: a
            frame that could not be drawn has no mode worth reporting. */}
        {!hasFrame
          ? <span className="font-normal text-slate-300" data-zone-note="no-frame">{ZONE_FRAME_NOTE_COPY.noFrame}</span>
          : zones.mode === 'atr_band'
            ? <span className="font-normal text-slate-300" data-zone-note="atr-band">{ZONE_FRAME_NOTE_COPY.atrBand}</span>
            : null}
      </p>
      {/*
        Position only, and no direction at all.

        This line used to open with the tilt — "ยังไม่เอียงไปทางไหน" on a card
        whose headline three lines above it reads "BULLISH · Bullish Bias". Two
        sentences a thumb-length apart said opposite things, and the one a fast
        reader believes is the big one at the top. Direction is the headline's
        job and the chips' job; the score itself is one tap away, at the head of
        the dialog, under `SCORE_LABEL`. What is left here is where price is STANDING,
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
          {/* "ราคา" alone, in a block whose other rows say "ราคาตอนนี้", left
              the reader to guess which of the two marks this distance was off.
              Every figure here is measured from the close, and now says so. */}
          {zones.nearestTriggerAtr < 0
            ? 'ราคาปิดออกนอกขอบกรอบไปแล้ว'
            : `ราคาปิดใกล้ขอบกรอบแล้ว เหลืออีก ${percentText(nearestDistance, referenceClose)}`}
          {' · อีกไม่กี่วันทำการก็เปลี่ยนได้'}
        </p>
      ) : zones.proximity === 'deep_range' ? (
        <p className={`mt-1 ${size.prose.note} text-slate-400`} data-zone-row="proximity">
          {'ราคาปิดยังอยู่กลางกรอบ ห่างขอบที่ใกล้ที่สุด '}{percentText(nearestDistance, referenceClose)}
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
          {liveAt !== null && !markersMerged ? (
            <div
              data-marker="live"
              /* The width the collapse arithmetic above used, published so the
                 harness can check it against the width Chrome actually paints.
                 `liveMarkPx` is a hand-copy of the `w-1` / `w-1.5` in the class
                 beside it, and a hand-copy is a number that drifts silently. */
              data-mark-px={size.liveMarkPx}
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
            data-mark-px={size.closeMarkPx}
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
              ? ` ${liveMoveCopy(liveSide, closeSide)}${LIVE_INTRADAY_RULE}`
              : ` ${LIVE_SAME_SIDE_COPY[liveSide]}`}
          {/* Where the picture had to give the distinction up, the prose takes
              it: the two prices are still two prices and this row still states
              both, so nothing is lost except a line nobody could have seen. */}
          {/* "ห่างจากราคาปิดน้อยมาก" reads as a distance the card is reporting;
              what it is actually saying is that two figures are close enough
              that one mark had to stand for both. */}
          {markersMerged ? ' · ราคาทั้งสองต่างกันน้อยมาก บนแถบจึงวาดทับกันเป็นเส้นเดียว' : ''}
        </p>
      ) : null}

      {/*
        THE QUESTION THE WHOLE BLOCK EXISTS TO ANSWER, on the one zone that was
        not answering it.

        `uptrend` and `downtrend` get `ActionableRows`: "ถ้าปิดต่ำกว่า X ถือว่า
        ขาขึ้นรอบนี้จบ" — a level and the rule attached to it. `sideways` gets
        nothing, because the engine publishes no invalidation for a zone that
        claims no direction (`no_direction_to_invalidate`), so the card fell
        silent on exactly the state where "what would change this?" is the only
        question a reader has. The bar draws both edge prices, but a picture is
        not a rule and nothing on the card said crossing one is what moves the
        label.

        Both numbers are already in the payload — they are the same two triggers
        the picture is cut with and the same two `sideOf` reads — so nothing is
        computed here. The wording is conditional and names no action.
      */}
      {/* Naming the two prices is the answer ONLY while both are still ahead of
          the close. Once one has been closed through, "ต้องขึ้นเหนือ 47.24" is a
          condition the reader can see has already been met, and the row would be
          telling them to wait for something that happened. What is left to wait
          for is the confirmation rule. See `changeCopy` for the directional
          zones' half of this. */}
      {changeCopy === null ? null : (
        <p className={`mt-2 ${size.prose.note} text-slate-400`} data-testid="signal-zone-change" data-zone-row="change">
          {changeCopy}
        </p>
      )}

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
        ทุกตัวเลขในกล่องนี้วัดจากราคาปิดล่าสุด {priceText(referenceClose)} ({formatThaiDateOnly(zones.referenceDate)}) · นับเฉพาะราคาปิดของวัน ราคาที่แตะระหว่างวันไม่นับ
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
  const up = zones.zone === 'uptrend';
  const ends = up ? 'ถ้าราคาปิดลงต่ำกว่า' : 'ถ้าราคาปิดขึ้นสูงกว่า';
  /*
   * THE LABEL THAT DID NOT KNOW WHICH WAY IT WAS POINTING.
   *
   * This was one constant string — "กรอบเดิมสูงเท่าไร ก็มักไปได้อีกเท่านั้น" —
   * printed on both directional zones. On a `downtrend` card the projection is
   * BELOW the close (`broken.level - broken.height`), so the row read "ก็มักไป
   * ได้อีกเท่านั้น" beside a price lower than the one it was measured from, with
   * the percentage underneath it correctly saying "ต่ำกว่าราคาปิดล่าสุด". The
   * label and its own value disagreed about direction on every bearish card
   * that reached this row. Both halves now come off `zones.zone`, which is the
   * same field the projection itself was computed from.
   */
  const targetLabel = up
    ? 'ถ้าขึ้นต่ออีกเท่ากับความสูงกรอบเดิม จะถึง'
    : 'ถ้าลงต่ออีกเท่ากับความสูงกรอบเดิม จะถึง';
  // The percent the engine already reported, when it reported one; otherwise
  // the same quantity off the two prices, so the row is never blank.
  const invalidationRelative = invalidation === null
    ? ''
    : invalidationPct !== null
      ? `${invalidationBasis === 'zone_ceiling' ? 'สูงกว่า' : 'ต่ำกว่า'}ราคาปิดล่าสุด ${Math.abs(invalidationPct).toFixed(1)}%`
      : relativeCopy(Math.abs(invalidation - close), close, invalidation > close ? 'above' : 'below');
  const targetRelative = target === null
    ? ''
    : relativeCopy(Math.abs(target - close), close, target > close ? 'above' : 'below');

  return (
    <dl className={`mt-3 space-y-2 border-t border-current/15 pt-2 ${size.prose.note} text-slate-300`} data-testid="signal-actionable" data-zone-row="actionable">
      {invalidation === null ? null : (
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-slate-400">{ends}</dt>
          <dd className="font-mono text-white">{priceText(invalidation)}</dd>
          <dd className="text-slate-500">
            {invalidationRelative ? `${invalidationRelative} · ` : ''}
            {/* This row IS the "what would change this?" answer on a directional
                zone — see `changeCopy`, which fills in only where this row is
                withheld — so it now says what changes rather than only that
                something ends. "ขาขึ้น/ขาลง" went with it: the bar under this
                list calls the same two states "เหนือกรอบ" and "ใต้กรอบ". */}
            ถือว่าราคากลับเข้ากรอบ และการ{up ? 'ขึ้น' : 'ลง'}รอบนี้จบ
          </dd>
        </div>
      )}
      {target === null ? null : (
        <div className="flex flex-wrap items-baseline gap-x-2">
          {/* The measured move, said as the rule of thumb it is rather than as
              "ระยะที่กรอบเดิมวัดได้", which named the arithmetic and not the idea.
              And said in the direction this card is actually pointing — see
              `targetLabel`. */}
          <dt className="text-slate-400">{targetLabel}</dt>
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
            เป็นแค่การคาดคะเนตามธรรมเนียมของคนอ่านกราฟ ยังไม่เคยทดสอบว่าแม่นจริงไหม
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

/**
 * The reasons, in the card's own words.
 *
 * `reason.text` is the engine's sentence and it stays in the payload untouched;
 * `reasonText` is a lookup over it that rebuilds the same fact from the same
 * fields in the vocabulary the rest of this card uses. An id with no entry
 * falls through to `reason.text`, so a reason the engine adds tomorrow shows up
 * in full rather than disappearing — see `reason-copy.ts`.
 */
function ReasonList({ title, reasons, empty, context, metrics }: {
  title: string;
  reasons: MarketSignalResult['reasons'];
  empty: string;
  context: ReasonBaseContext;
  /** For `reasonNote`, which is the only thing here that is not the sentence. */
  metrics: MarketSignalMetrics;
}) {
  return (
    <section>
      <h3 className="font-semibold text-white">{title}</h3>
      {reasons.length ? (
        <ul className="mt-2 space-y-2">
          {reasons.map((reason) => {
            const note = reasonNote(reason, metrics);
            return (
              <li key={reason.id} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span data-reason-id={reason.id}>
                  {reasonText(reason, context)}
                  {/* Under the row, not beside it: the note qualifies the whole
                      sentence and a reader who stops at the dash has already
                      taken the fact. */}
                  {note ? <span className="mt-1 block text-xs leading-5 text-slate-500" data-testid="signal-reason-note">{note}</span> : null}
                </span>
              </li>
            );
          })}
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

/**
 * One term of the confidence product, and — where the two are different numbers
 * — the figure it was derived from.
 *
 * `note` exists because the dialog carries two blocks of six percentages that
 * measure the same six things, and five of the pairs disagree by construction:
 * the factor is `floor + (1 - floor) * measured`, and the conflict factor is
 * the complement of the measured penalty. Printed apart with no relation
 * stated, that is a page contradicting itself; printed together, it is the
 * working. So the note goes in the SAME box as the factor, not in a legend.
 */
function ConfidenceDetail({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 p-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 font-mono text-white">{value}%</dd>
      {note ? <dd className="mt-0.5 text-[11px] leading-4 text-slate-500">{note}</dd> : null}
    </div>
  );
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
      {/*
        The one sentence that keeps two similar-sounding pairs apart.

        "Support / Resistance" in the metrics list and the two edges of this
        frame are both levels, both drawn from price, and on IREN they are
        39.27 / 46.41 against 27.94 / 50.17. Without this they read as the same
        measurement reported twice and disagreeing.
      */}
      {/*
        The frame's provenance is NOT always swing structure. `mode` is
        'atr_band' whenever no usable swing existed, and this paragraph claimed
        swing high/low unconditionally — true on most instruments and false on
        exactly the ones where a reader most needs to know the frame is a
        volatility envelope rather than levels the market traded against. The
        clause is taken from `ZONE_MODE_COPY`, which is the same sentence the
        row two below this one already prints.
      */}
      <p className="mt-2 text-xs leading-5 text-slate-400" data-testid="signal-frame-vs-levels">
        ขอบกรอบสองเส้นนี้คือเส้นที่ใช้ตัดสินว่าราคาออกจากกรอบหรือยัง — {ZONE_MODE_COPY[zones.mode]}
        {' · ส่วน “แนวรับ / แนวต้านที่ใกล้ราคาที่สุด” ในหัวข้อ Metrics เลือกจากระยะถึงราคาปัจจุบัน'}
        {' จึงเป็นคนละตัวกัน และตามปกติไม่เท่ากัน'}
      </p>
      <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
        {/* The two numbers the picture is cut with, spelled out where the
            comparison with the metrics list can actually be made. */}
        {/* Entry cut and exit anchor, one above the other, because they are a
            buffer apart and the card shows both without naming the gap. */}
        <Detail label="ขอบที่ใช้ตัดสินว่าออกจากกรอบ ล่าง / บน (เส้นที่วาดบนแถบ)" value={joined(zones.lowerTrigger, zones.upperTrigger)} />
        <Detail label="ขอบที่ใช้ตัดสินว่ากลับเข้ากรอบ ล่าง / บน (จุดยึดของกรอบ)" value={joined(zones.support, zones.resistance)} />
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
        <Detail label="สถานะนี้อยู่มากี่แท่ง" value={`${zones.zoneAgeBars} แท่ง`} />
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
              label="ระยะถึงจุดที่รอบนี้จบ"
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
        THE TWO LINES THAT ARE NOT THE SAME LINE.

        A zone is ENTERED by closing past `resistance + buffer` — the cut the
        picture is drawn with — and LEFT by closing back through `resistance`
        itself. So an uptrend card shows a cut at 47.24 and a row underneath
        saying the zone ends at 46.23: two right numbers a buffer apart, and
        until now nothing anywhere said they were different lines, which leaves
        a reader who compares them with two boundaries for one zone and no way
        to tell which is wrong. Neither is.

        It lives here and not on the card because the card holds a deliberate
        four-line budget under the picture — see the test that enforces it — and
        because the reader who spots a 1.01 discrepancy between a drawn cut and
        a printed level is exactly the reader who opens this dialog.
      */}
      <p className="mt-2 text-xs leading-5 text-slate-400" data-testid="signal-hysteresis-note">
        เส้นที่ใช้ตัดสินว่าออกจากกรอบ กับเส้นที่ใช้ตัดสินว่ากลับเข้ากรอบ เป็นคนละราคาโดยตั้งใจ กันไม่ให้สถานะสลับไปมาทุกวัน
        ขอบที่วาดบนแถบคือเส้นเข้า ส่วนแถว “ถ้าปิด...” บนการ์ดใช้เส้นออก
      </p>

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
            ? 'ระยะที่จะรู้ว่ารอบนี้จบ ยาวกว่าระยะไปถึงเป้า'
            : 'ระยะไปถึงเป้า ยาวกว่าระยะที่จะรู้ว่ารอบนี้จบ'}
          {actionable.notes.includes('risk_leg_inside_noise')
            ? ' · แต่ราคาปิดอยู่ชิดจุดที่รอบนี้จะจบมาก การเทียบนี้จึงแกว่งแรงทุกวัน และไม่ได้แปลว่าโอกาสดีกว่า'
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
