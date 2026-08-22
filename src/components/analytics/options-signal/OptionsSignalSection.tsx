'use client';

import { useEffect, useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { DataStatusBadge } from '@/src/components/market-data/DataProvenance';
import { LockedNotice } from '@/src/components/subscription/EntitlementGate';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import type {
  OptionsSignalBreakdownDto,
  OptionsSignalDto,
  OptionsSignalSummaryDto,
} from '@/src/lib/analytics/options-signal/dto';
import type {
  OptionsSignalFactorId,
  OptionsSignalFactorScore,
} from '@/src/lib/analytics/options-signal/types';
import type { GlossaryTermId } from '@/src/lib/analytics/glossary';
import { formatBangkokDateTimeCE } from '@/src/lib/presentation/datetime';
import { requestOptionsSignal, type OptionsSignalOutcome } from './signal-client';
import {
  DATA_STATE_LABEL,
  FACTOR_COPY,
  HISTORY_DEGRADED_NOTICE,
  IV_LEVEL_LABEL,
  LIQUIDITY_BADGE,
  OPTIONS_SIGNAL_PRESENTATION,
  STALE_MIX_BADGE,
  displayStatusOf,
  ivBasisLabel,
  ivPercentileText,
  riskRewardDirectionNote,
  signedPoints,
} from './presentation';

const DISCLAIMER = 'Options Signal Engine เป็นการสรุปหลักฐานเชิงเทคนิคและข้อมูลตลาดจริงเพื่อการเรียนรู้ ไม่ใช่คำแนะนำซื้อขาย และไม่รับประกันผลลัพธ์';

const FACTOR_ORDER: OptionsSignalFactorId[] = ['macro', 'trend', 'momentum', 'sentiment', 'riskReward'];

export interface OptionsSignalSectionProps {
  symbol: string;
  /** True only while the Analysis tab is mounted, so the signal loads lazily. */
  active: boolean;
}

/**
 * Options Signal Engine card.
 *
 * Everything is computed on the server and served already projected onto the
 * reader's plan: the gauge needs `options.signal.summary`, the numbers behind it
 * need `options.signal.breakdown`. This component renders what arrived and
 * nothing else — when the breakdown is absent from the payload, it is absent
 * from the page too, and the locked control explains why.
 */
export function OptionsSignalSection(props: OptionsSignalSectionProps) {
  const { can } = useEntitlement();
  const summaryEntitled = can('options.signal.summary');
  const breakdownEntitled = can('options.signal.breakdown');
  const projection = summaryEntitled
    ? (breakdownEntitled ? 'breakdown' : 'summary')
    : 'locked';

  return (
    <OptionsSignalContent
      key={`${props.symbol}:${projection}`}
      {...props}
      summaryEntitled={summaryEntitled}
      breakdownEntitled={breakdownEntitled}
    />
  );
}

function OptionsSignalContent({
  symbol,
  active,
  summaryEntitled,
  breakdownEntitled,
}: OptionsSignalSectionProps & {
  summaryEntitled: boolean;
  breakdownEntitled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<OptionsSignalOutcome | null>(null);

  useEffect(() => {
    if (!active || !summaryEntitled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        setOutcome(await requestOptionsSignal(symbol, controller.signal));
      } catch {
        if (!controller.signal.aborted) {
          setOutcome({ status: 'unavailable', message: 'ยังโหลดข้อมูลพื้นฐานของสัญญาณไม่สำเร็จ จึงไม่แสดงผลลัพธ์ที่เดาขึ้นเอง' });
        }
      }
    })();
    return () => controller.abort();
  }, [symbol, active, summaryEntitled]);

  if (!summaryEntitled) {
    return (
      <section aria-label="Options Signal Engine" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5" data-testid="options-signal-locked">
        <Header timeframe="1D" />
        <p className="mt-3 text-sm leading-6 text-slate-400">
          สรุปทิศทางจากข้อมูลตลาดจริง พร้อมคะแนนความมั่นใจ
        </p>
        <div className="mt-3">
          <LockedNotice capability="options.signal.summary" source="analysis.options-signal" />
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  if (!outcome) {
    return (
      <section aria-label="Options Signal Engine" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <Header timeframe="1D" />
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-400">
          <Loader2 aria-hidden="true" size={15} className="motion-safe:animate-spin" />
          {active ? 'กำลังคำนวณสัญญาณจากข้อมูลตลาดจริง' : 'กำลังเตรียมข้อมูลสัญญาณ'}
        </p>
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  if (outcome.status === 'locked') {
    return (
      <section aria-label="Options Signal Engine" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5" data-testid="options-signal-locked">
        <Header timeframe="1D" />
        <p className="mt-3 text-sm text-slate-400">{outcome.message}</p>
        <div className="mt-3">
          <LockedNotice capability="options.signal.summary" source="analysis.options-signal.server-denial" />
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  if (outcome.status !== 'ready') {
    return (
      <section aria-label="Options Signal Engine" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <Header timeframe="1D" />
        <p className="mt-3 text-sm text-slate-400">{outcome.message}</p>
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  return (
    <SignalCard
      signal={outcome.signal}
      breakdownEntitled={breakdownEntitled}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

/**
 * The card itself, exported so the two probes that cannot go through the
 * fetching wrapper can render it: the jsdom test drives the wrapper, while
 * `scripts/qa/options-signal-header-qa.mts` needs the real markup at a real
 * width in a real browser and has no endpoint to answer it.
 */
export function SignalCard({ signal, breakdownEntitled, open, onOpenChange }: {
  signal: OptionsSignalDto;
  breakdownEntitled: boolean;
  open: boolean;
  onOpenChange(next: boolean): void;
}) {
  const summary = signal.summary;
  // The endpoint is the security boundary. This local check also prevents a
  // just-expired Elite view from rendering its previous in-memory breakdown
  // during the first client render after the page entitlement drops to Pro.
  const breakdown = breakdownEntitled ? signal.breakdown : null;

  if (summary.status === 'insufficient-data' || summary.signalType === null) {
    return (
      <section aria-label="Options Signal Engine" data-signal="insufficient-data" className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <Header timeframe={summary.timeframe} />
        <p className="mt-3 text-sm text-slate-300">ข้อมูลไม่เพียงพอ · {summary.reason ?? 'ปัจจัยหลักยังไม่พร้อม'}</p>
        {breakdown && <SourceStates breakdown={breakdown} />}
        <p className="mt-3 text-xs leading-5 text-slate-500">{DISCLAIMER}</p>
      </section>
    );
  }

  const presentation = OPTIONS_SIGNAL_PRESENTATION[summary.signalType];
  const highlights = (breakdown?.reasoning ?? [])
    .filter((reason) => reason.polarity === 'positive' || reason.polarity === 'caution')
    .slice(0, 4);

  return (
    <section
      aria-label="Options Signal Engine"
      data-signal={summary.signalType}
      className={`rounded-2xl border p-5 ${presentation.tone}`}
    >
      <Header timeframe={summary.timeframe} />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 font-mono text-base font-bold sm:text-lg ${presentation.badgeTone}`}>
          <span aria-hidden="true">{presentation.dot}</span>
          {presentation.title}
        </p>
        {/*
          * TWO numbers, each labelled, and neither of them derived here.
          *
          * The card used to print one bare "55 / 100" that the modal contradicted
          * with "+13 / 90 -> 14", because the card was showing confidence and the
          * modal was showing the signed sum. Both now come from the payload, the
          * direction score is the SAME field the modal renders, and each carries
          * the word for what it measures so no reader has to guess which is which.
          *
          * LABELLING THEM WAS NOT ENOUGH, and this is the second fix.
          *
          * The pair used to be two right-aligned blocks 16px apart, which put
          * the two value runs on one line as `63 / 100  60 / 100` — a single
          * strip of digits whose only break was smaller than the distance from
          * either number to the word above it. Measured in Chrome at both 1280px
          * and 380px: 16px between the groups against a 22px label-to-value
          * distance inside each one, so by proximity alone the numbers belonged
          * to each other more than to their own labels, and `63` read as
          * Confidence's as easily as the score's.
          *
          * Each pair is now ONE column that centres its value under its own
          * label (measured offset 0.0px, was 4.7px), the groups are separated by
          * 33px AND a hairline rule, and the hint moved onto the word it
          * explains so the value line is a clean number in both columns.
          */}
        <div className="flex items-stretch text-center" data-testid="options-signal-headline-pair">
          <p className="flex flex-col items-center gap-0.5 pr-4">
            <span
              className="flex h-[1lh] items-center justify-center text-[11px] font-normal leading-tight text-slate-400"
              data-testid="options-signal-score-label"
            >
              คะแนนทิศทาง
            </span>
            <span className="font-mono leading-tight" data-testid="options-signal-score-value">
              <span className="text-lg font-bold text-white" data-testid="options-signal-score-card">
                {summary.directionScore0to100 ?? '—'}
              </span>
              <span className="text-sm font-normal text-slate-400"> / 100</span>
            </span>
          </p>
          <p className="flex flex-col items-center gap-0.5 border-l border-white/20 pl-4">
            <span
              className="flex h-[1lh] items-center justify-center gap-1 text-[11px] font-normal leading-tight text-slate-400"
              data-testid="options-signal-confidence-label"
            >
              Confidence
              <InfoHint term="optionsSignalConfidence" align="end" />
            </span>
            <span className="font-mono leading-tight" data-testid="options-signal-confidence-value">
              <span className="text-lg font-bold text-white" data-testid="options-signal-confidence-card">
                {summary.confidenceScore}
              </span>
              <span className="text-sm font-normal text-slate-400"> / 100</span>
            </span>
          </p>
        </div>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-300">{presentation.headline}</p>

      <SignalBadges summary={summary} />

      {breakdown ? (
        <EliteBody breakdown={breakdown} summary={summary} highlights={highlights} open={open} onOpenChange={onOpenChange} />
      ) : (
        <div className="mt-4 space-y-2" data-testid="options-signal-breakdown-locked">
          <p className="text-xs leading-5 text-slate-400">
            คะแนนรายปัจจัย เหตุผล Risk:Reward และ Trade Setup อยู่ในแพ็กเกจที่สูงขึ้น
          </p>
          <LockedNotice capability="options.signal.breakdown" source="analysis.signal-breakdown" />
        </div>
      )}

      <p className="mt-3 text-xs leading-5 text-slate-400">{DISCLAIMER}</p>
    </section>
  );
}

function EliteBody({ breakdown, summary, highlights, open, onOpenChange }: {
  breakdown: OptionsSignalBreakdownDto;
  summary: OptionsSignalSummaryDto;
  highlights: OptionsSignalBreakdownDto['reasoning'];
  open: boolean;
  onOpenChange(next: boolean): void;
}) {
  const diagnostics = breakdown.diagnostics;
  const iv = diagnostics.iv;
  const event = diagnostics.event;
  const presentationTitle = summary.signalType
    ? OPTIONS_SIGNAL_PRESENTATION[summary.signalType].title
    : 'Options Signal';

  return (
    <>
      <dl className="mt-4 space-y-1.5" aria-label="คะแนนแต่ละปัจจัย">
        {FACTOR_ORDER.map((id) => (
          <FactorRow key={id} factor={diagnostics.factors[id]} />
        ))}
      </dl>

      <dl className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-sm">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-6 gap-y-1">
          <dt className="flex items-center gap-1.5 text-slate-300">
            {ivBasisLabel(iv.basis, null, iv.dte)}
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
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-6 gap-y-1">
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

      <SetupBlock setup={breakdown.suggestedOptionsSetup} />

      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(true)}
        className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/20 px-3 text-sm font-semibold text-white hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00] sm:w-auto"
      >
        <Info aria-hidden="true" size={17} />
        ดูรายละเอียดการคำนวณ
      </button>

      <ResponsiveDialog
        isOpen={open}
        onClose={() => onOpenChange(false)}
        title={`รายละเอียดการคำนวณ · ${presentationTitle}`}
      >
        <DetailBody breakdown={breakdown} summary={summary} />
      </ResponsiveDialog>
    </>
  );
}

/**
 * The two things a reader must see before acting, on the card itself.
 *
 * The liquidity grade because the setup warnings already tell them to check it
 * and the engine now actually measures it; STALE-MIX because a signal whose
 * sources are hours apart is not the single-moment reading the layout implies,
 * and the published `asOf` beside it is the OLDEST of them, in CE years like
 * every other year on this card.
 */
function SignalBadges({ summary }: { summary: OptionsSignalSummaryDto }) {
  const liquidity = summary.liquidityGrade ? LIQUIDITY_BADGE[summary.liquidityGrade] : null;
  if (!liquidity && !summary.staleMix && !summary.asOf && !summary.historyDegraded) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
      {liquidity && (
        <span
          data-testid="options-signal-liquidity-badge"
          className={`inline-flex items-center rounded-full border px-2 py-1 font-semibold ${liquidity.tone}`}
        >
          {liquidity.label}
        </span>
      )}
      {summary.staleMix && (
        <span
          data-testid="options-signal-stale-mix"
          title={STALE_MIX_BADGE.helper}
          className={`inline-flex items-center rounded-full border px-2 py-1 font-mono font-semibold ${STALE_MIX_BADGE.tone}`}
        >
          {STALE_MIX_BADGE.label}
        </span>
      )}
      {summary.historyDegraded && (
        <span
          data-testid="options-signal-history-degraded"
          title={HISTORY_DEGRADED_NOTICE.helper}
          className={`inline-flex items-center rounded-full border px-2 py-1 font-semibold ${HISTORY_DEGRADED_NOTICE.tone}`}
        >
          {HISTORY_DEGRADED_NOTICE.label}
        </span>
      )}
      {summary.asOf && (
        <span className="text-slate-400">ข้อมูล ณ {formatBangkokDateTimeCE(summary.asOf)}</span>
      )}
    </div>
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
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-6 gap-y-1 text-sm">
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

function SetupBlock({ setup }: { setup: OptionsSignalBreakdownDto['suggestedOptionsSetup'] }) {
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

function SourceStates({ breakdown }: { breakdown: OptionsSignalBreakdownDto }) {
  const factors = breakdown.diagnostics.factors;
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

function DetailBody({ breakdown, summary }: {
  breakdown: OptionsSignalBreakdownDto;
  summary: OptionsSignalSummaryDto;
}) {
  const diagnostics = breakdown.diagnostics;
  const squeeze = diagnostics.squeeze;
  const riskReward = diagnostics.riskReward;
  const iv = diagnostics.iv;
  const event = diagnostics.event;
  const liquidity = diagnostics.liquidity;
  const provenance = diagnostics.provenance;
  /*
   * Present only when the side Risk:Reward was measured on and the side the card
   * finally printed actually disagree. See `riskRewardDirectionNote`: they are
   * read at different points in the pipeline, which is correct and is also
   * exactly what makes two sentences on one page look like a contradiction.
   */
  const directionNote = riskRewardDirectionNote({
    scoredSide: riskReward.scoredSide,
    signalType: summary.signalType,
    underlyingBias: summary.underlyingBias,
    trendVeto: diagnostics.trendVeto,
  });

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
                {/*
                  * Beside the sentence that causes the confusion, not only at
                  * the bottom of section 3. "หลักฐานอื่นชี้ขาขึ้น จึงวัดจากฝั่ง Call"
                  * is printed HERE, and a reader meets it a screen and a half
                  * before the block that explains it.
                  */}
                {id === 'riskReward' && directionNote && (
                  <p className="mt-2 text-xs leading-5 text-amber-300" data-testid="options-signal-rr-direction-note-factor">
                    {directionNote}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  <DataStatusBadge status={displayStatusOf(factor.state)} />
                  <span>{factor.provider ?? 'ไม่ทราบผู้ให้บริการ'}</span>
                  {factor.asOf && <span>{formatBangkokDateTimeCE(factor.asOf)}</span>}
                </div>
              </div>
            );
          })}
          <div className="border-t border-slate-700 px-3 pt-3">
            <div className="flex items-center justify-between font-semibold text-white">
              <span>รวม (เทียบเฉพาะปัจจัยที่มีข้อมูล)</span>
              <span className="font-mono">
                {signedPoints(diagnostics.rawDirectionPoints)} / {diagnostics.availableWeight}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between font-semibold text-white">
              <span>คะแนนทิศทางที่แสดงบนการ์ด</span>
              <span className="font-mono" data-testid="options-signal-score-modal">{diagnostics.directionScore0to100} / 100</span>
            </div>
            {/*
              * The conversion, written out. The card and this dialog read the
              * same field, and this line is how a reader can check that for
              * themselves instead of taking it on trust.
              */}
            <p className="mt-2 font-mono text-xs leading-5 text-slate-400" data-testid="options-signal-score-formula">
              {diagnostics.scoreFormula}
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              สูตร: (ผลรวมคะแนน + น้ำหนักที่มีข้อมูล) ÷ (2 × น้ำหนักที่มีข้อมูล) × 100 · 50 คือกลาง ไม่เอียงไปทางไหน
            </p>
          </div>
        </div>
      </section>

      <section>
        <h3 className="font-semibold text-white">2. TTM Squeeze และ RVOL</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="สถานะ Squeeze" value={squeeze.state ?? '—'} term="ttmSqueeze" />
          <Detail label="Squeeze Momentum" value={numberText(squeeze.momentum)} />
          {/*
            * The measurement and the scale it was put on, as two rows.
            *
            * They were one row while the saturation was 1.0 ATR, because the two
            * numbers were then identical. At 3.5 they are not, and collapsing
            * them would print "0.68" beside the words "Momentum ÷ ATR" for a
            * chart whose momentum is 2.4 ATR.
            */}
          <Detail label="Momentum ÷ ATR" value={numberText(squeeze.breakdown.rawAtr)} />
          <Detail
            label={`หลัง normalize (เพดาน ${squeeze.breakdown.saturation} ATR)`}
            value={squeeze.normalizedMomentum === null
              ? '—'
              : `${squeeze.normalizedMomentum.toFixed(3)}${squeeze.normalizedMomentumCapped ? ' (capped)' : ''}`}
          />
          <Detail label="RVOL 20 วัน" value={squeeze.relativeVolume === null ? '—' : `${squeeze.relativeVolume.toFixed(2)}×`} term="relativeVolume" />
          <Detail label="ระดับการยืนยันจาก RVOL" value={squeeze.confirmation === null ? 'ไม่มีข้อมูล' : `${Math.round(squeeze.confirmation * 100)}%`} />
        </dl>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Squeeze ON คือความผันผวนกำลังบีบตัว ไม่ได้แปลว่าขาขึ้น และ RVOL บอกความคึกคักของการซื้อขาย จึงใช้ยืนยันทิศทางเดิมเท่านั้น ไม่สร้างทิศทางใหม่
          {squeeze.normalizedMomentumCapped
            && ` · ค่า Momentum ÷ ATR จริงเกินเพดาน ${squeeze.breakdown.saturation} ATR จึงคิดเท่าเพดาน (capped) ค่าหลัง normalize ที่แสดงคือ 1 เต็ม`}
        </p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          ระดับการยืนยันจาก RVOL เป็นเส้นโค้งต่อเนื่องรอบ 1.00× ไม่ใช่การกระโดดเป็นขั้น RVOL 1.00× คือ 50%
        </p>
      </section>

      <section>
        <h3 className="font-semibold text-white">3. แนวรับ/แนวต้าน และ Risk:Reward</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="ราคาที่ใช้คำนวณ" value={numberText(riskReward.price)} />
          <Detail label="แนวรับใกล้สุด" value={numberText(riskReward.support)} />
          <Detail label="แนวต้านใกล้สุด" value={numberText(riskReward.resistance)} />
          <Detail label="ระยะขึ้น / ระยะลง" value={`${percentText(riskReward.upsidePercent)} / ${percentText(riskReward.downsidePercent)}`} />
          {/*
            * The same two distances in ATR. A +2.96% / -12.53% pair looks wildly
            * lopsided until you know one daily range is 3% of price, at which
            * point it is 1 ATR up and 4 ATR down — which is the sentence a reader
            * can actually use.
            */}
          <Detail
            label="ระยะขึ้น / ระยะลง (หน่วย ATR)"
            value={`${atrText(riskReward.upsideAtr)} / ${atrText(riskReward.downsideAtr)}`}
          />
          <Detail
            label="ระยะขึ้น / ระยะลง (เทียบ Expected Move)"
            value={`${atrText(riskReward.upsideExpectedMoves)} / ${atrText(riskReward.downsideExpectedMoves)}`}
          />
          {/*
            * The expected move NEVER appears without its horizon. Six dollars
            * over four days and six dollars over sixty are not the same
            * statement about the same chart, and the ratio above is measured in
            * whichever one this straddle happens to be.
            */}
          <Detail
            label="Expected Move (ATM straddle)"
            value={riskReward.expectedMove === null
              ? '—'
              : `${numberText(riskReward.expectedMove)} · ${riskReward.expectedMoveDte === null ? 'ไม่ทราบอายุสัญญา' : `เหลือ ${riskReward.expectedMoveDte} วัน`}`}
          />
          <Detail label="R:R ฝั่ง Call" value={numberText(riskReward.callRewardRisk)} />
          <Detail label="R:R ฝั่ง Put" value={numberText(riskReward.putRewardRisk)} />
          <Detail
            label="ฝั่งที่ใช้ให้คะแนน"
            value={riskReward.scoredSide === 'call'
              ? 'Call (หลักฐานอื่นชี้ขาขึ้น)'
              : riskReward.scoredSide === 'put'
                ? 'Put (หลักฐานอื่นชี้ขาลง)'
                : 'ยังไม่เลือกทาง จึงคิดเป็นคุณภาพ setup ไม่ใช่คะแนนทิศทางเต็ม'}
          />
          <Detail
            label="คุณภาพ setup ของฝั่งที่ดีที่สุด"
            value={riskReward.setupQuality === null ? '—' : `${Math.round(riskReward.setupQuality * 100)}%`}
          />
        </dl>
        {riskReward.expectedMoveHorizonWarning && (
          <p className="mt-2 text-xs leading-5 text-amber-300" data-testid="options-signal-em-horizon-warning">
            {riskReward.expectedMoveHorizonWarning}
          </p>
        )}
        {directionNote && (
          <p className="mt-2 text-xs leading-5 text-amber-300" data-testid="options-signal-rr-direction-note">
            {directionNote}
          </p>
        )}
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Risk:Reward วัดจากฝั่งที่หลักฐานอื่นชี้ไป ไม่ได้วัดจากฝั่ง Call เสมอ ถ้ายังไม่มีทิศทาง คะแนนจะถูกลดทอนเพราะเรขาคณิตของราคาบอกได้แค่คุณภาพของ setup ไม่ได้บอกทิศทาง
        </p>
        {/*
          * The order of operations, printed once and always.
          *
          * The conditional note above fires only when the two directions
          * actually differ. This one is the standing explanation of WHY they
          * can, so a reader who has never seen them differ still knows the two
          * sentences come from different steps rather than from one step
          * disagreeing with itself.
          */}
        <p className="mt-1 text-xs leading-5 text-slate-500">
          ลำดับการคำนวณ: ฝั่งที่ใช้วัด R:R มาจากปัจจัยอื่นอีก 4 ตัว (Macro, Trend, Momentum, Options Sentiment) ซึ่งอ่านค่า
          <b className="text-slate-300"> ก่อน</b> นำคะแนน R:R มารวม และ<b className="text-slate-300">ก่อน</b>หักด้วย trend veto
          ส่วนป้ายบนการ์ดคือผลหลังทั้งสองขั้นนั้นแล้ว ทิศทั้งสองจึงต่างกันได้โดยไม่ขัดกัน
        </p>
      </section>

      <section>
        <h3 className="font-semibold text-white">4. ราคาพรีเมียม (IV) และ Put/Call</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="เกณฑ์ที่ใช้" value={ivBasisLabel(iv.basis, iv.realizedWindowDays, iv.dte)} />
          <Detail label="IV Rank" value={iv.ivRank === null ? 'ไม่พร้อมใช้งาน' : String(iv.ivRank)} />
          {/*
            * "ไม่พร้อมใช้งาน" was the wrong word for a series that fills itself
            * in one reading per day. A countdown is the truth and it also tells
            * the reader that waiting is what fixes it.
            */}
          <Detail
            label="IV Percentile (เทียบตัวเอง)"
            value={ivPercentileText(iv.ivPercentile, iv.percentilePending, iv.percentileStoreUnavailable)}
          />
          <Detail label="IV ปัจจุบัน (ATM)" value={iv.impliedVolatility === null ? '—' : `${(iv.impliedVolatility * 100).toFixed(1)}%`} />
          <Detail
            label={iv.realizedWindowDays === null ? 'ความผันผวนจริง' : `ความผันผวนจริง ${iv.realizedWindowDays} วัน`}
            value={iv.realizedVolatility === null ? '—' : `${(iv.realizedVolatility * 100).toFixed(1)}%`}
          />
          <Detail label="อายุสัญญาที่ใช้เทียบ (DTE)" value={iv.dte === null ? '—' : `${iv.dte} วัน`} />
          <Detail label="IV ÷ ความผันผวนจริง" value={numberText(iv.ratio)} />
          <Detail label="ระดับความแพง" value={iv.level === null ? 'ไม่พร้อมใช้งาน' : IV_LEVEL_LABEL[iv.level]} />
          <Detail label="สถานะข้อมูล IV" value={DATA_STATE_LABEL[iv.state]} />
          <Detail label="แหล่งข้อมูล IV" value={iv.source ?? 'ไม่พร้อมใช้งาน'} />
          <Detail label="ดึงข้อมูลเมื่อ" value={iv.fetchedAt ? formatBangkokDateTimeCE(iv.fetchedAt) : '—'} />
          <Detail label="Put/Call (Open Interest)" value={diagnostics.factors.sentiment.detail} term="putCallRatio" />
        </dl>
        {iv.percentileStoreUnavailable && (
          <p className="mt-2 text-xs leading-5 text-amber-300" data-testid="options-signal-percentile-outage">
            {HISTORY_DEGRADED_NOTICE.helper}
          </p>
        )}
        {iv.reason && <p className="mt-2 text-xs leading-5 text-amber-300">{iv.reason}</p>}
      </section>

      <section>
        <h3 className="font-semibold text-white">5. สภาพคล่องของ chain</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail
            label="ระดับสภาพคล่อง"
            value={liquidity.grade === null ? 'ไม่พร้อมใช้งาน' : LIQUIDITY_BADGE[liquidity.grade].label}
          />
          <Detail label="คะแนนรวม" value={liquidity.score === null ? '—' : `${liquidity.score} / 100`} />
          <Detail
            label="ตลาดเปิดตอนเก็บข้อมูล"
            value={liquidity.marketOpenAtCapture === null
              ? '—'
              : liquidity.marketOpenAtCapture ? 'เปิด' : 'ปิด'}
          />
          {liquidity.offHoursAssessment && (
            <Detail
              label="ถ้าดูเฉพาะ OI และ Volume"
              value={`${LIQUIDITY_BADGE[liquidity.offHoursAssessment.grade].label} · ${liquidity.offHoursAssessment.score} / 100`}
            />
          )}
          <Detail label="Open Interest (ค่ากลาง)" value={numberText(liquidity.medianOpenInterest)} />
          <Detail label="Volume (ค่ากลาง)" value={numberText(liquidity.medianVolume)} />
          <Detail
            label="ส่วนต่าง Bid/Ask (ค่ากลาง)"
            value={liquidity.medianSpreadPercent === null ? '—' : `${liquidity.medianSpreadPercent.toFixed(2)}% ของราคากลาง`}
          />
          <Detail label="สัญญาที่ใช้ประเมิน" value={liquidity.contractsExamined === null ? '—' : `${liquidity.contractsExamined} สัญญา`} />
          <Detail label="สถานะข้อมูล" value={DATA_STATE_LABEL[liquidity.state]} />
        </dl>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          สภาพคล่องไม่ได้เป็นส่วนหนึ่งของคะแนนทิศทาง หุ้นจะขึ้นหรือลงไม่เกี่ยวกับว่า chain ซื้อขายง่ายแค่ไหน แต่สัญญาณบน chain ที่ออกยากคือสัญญาณที่ผู้เริ่มต้นไม่ควรลงมือตาม
        </p>
        {liquidity.marketOpenAtCapture === false && (
          <p className="mt-2 text-xs leading-5 text-amber-300" data-testid="options-signal-liquidity-closed">
            ส่วนต่าง Bid/Ask ที่เห็นเก็บตอนตลาดปิด ซึ่งกว้างกว่าตอนเปิดเป็นปกติ จึงยังไม่ใช้ตัดสินสภาพคล่อง ให้ดูอีกครั้งตอนตลาดเปิด
          </p>
        )}
        {liquidity.reason && <p className="mt-2 text-xs leading-5 text-amber-300">{liquidity.reason}</p>}
      </section>

      <section>
        <h3 className="font-semibold text-white">6. ความเสี่ยงจากเหตุการณ์ (Earnings)</h3>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="วันประกาศงบ" value={event.reportDate ?? 'ไม่พร้อมใช้งาน'} />
          <Detail label="เหลืออีก" value={event.daysToEarnings === null ? '—' : `${event.daysToEarnings} วัน`} />
          <Detail label="ช่วงเวลา" value={event.timeOfDay ?? '—'} />
          <Detail label="สถานะข้อมูล" value={DATA_STATE_LABEL[event.state]} />
          <Detail label="แหล่งข้อมูล" value={event.source ?? 'ไม่พร้อมใช้งาน'} />
          <Detail label="ดึงข้อมูลเมื่อ" value={event.fetchedAt ? formatBangkokDateTimeCE(event.fetchedAt) : '—'} />
        </dl>
        {event.reason && <p className="mt-2 text-xs leading-5 text-amber-300">{event.reason}</p>}
      </section>

      <section>
        <h3 className="font-semibold text-white">7. Confidence และการหักคะแนน</h3>
        <p className="mt-2 leading-6">
          Confidence วัดว่าหลักฐานหนักแน่นและไปทางเดียวกันแค่ไหน <b className="text-white">ไม่ใช่โอกาสทำกำไร</b>
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          คิดจากการคูณสามค่าเข้าด้วยกัน โดย<b className="text-slate-300">ยกกำลังตามน้ำหนักของแต่ละค่าก่อน</b> (weighted geometric mean) ไม่ใช่การเฉลี่ย
          ค่าใดค่าหนึ่งที่ต่ำมากจึงดึงผลรวมลงเสมอ และความสอดคล้องมีเลขชี้กำลังสูงที่สุด เพราะเป็นค่าที่การเฉลี่ยแบบเดิมกลบไว้
        </p>
        {/*
          * The arithmetic, printed from the engine's own constants.
          *
          * Without the exponents this paragraph read as a plain product, and a
          * reader who multiplied the three percentages below landed two orders
          * of magnitude away from the number beside them.
          */}
        <p className="mt-2 font-mono text-xs leading-5 text-slate-400" data-testid="options-signal-confidence-formula">
          {diagnostics.confidenceFormula}
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
        <h3 className="font-semibold text-white">8. เงื่อนไขที่ทำให้ยังไม่เป็น PRIME</h3>
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
        <h3 className="font-semibold text-white">9. เวลาของข้อมูลแต่ละแหล่ง</h3>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          แหล่งข้อมูลปิดคนละเวลากัน สัญญาณจึงยึด<b className="text-slate-300">เวลาที่เก่าที่สุด</b>เป็นเวลาของตัวเอง
          เพราะสัญญาณจะใหม่กว่าข้อมูลที่เก่าที่สุดของมันไม่ได้ ทุกปีในหน้านี้เป็น ค.ศ. ทั้งหมด
        </p>
        <dl className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800 px-3">
          <Detail label="เวลาของสัญญาณ (เก่าที่สุด)" value={formatBangkokDateTimeCE(provenance.asOf)} />
          <Detail label="แหล่งที่ใหม่ที่สุด" value={formatBangkokDateTimeCE(provenance.newestAsOf)} />
          <Detail
            label="ห่างกัน"
            value={provenance.spreadHours === null ? '—' : `${provenance.spreadHours} ชั่วโมง`}
          />
          <Detail label="STALE-MIX" value={provenance.staleMix ? 'ใช่ · ข้อมูลมาจากคนละเวลากันเกินเกณฑ์' : 'ไม่'} />
        </dl>
        <ul className="mt-2 space-y-1 text-xs text-slate-400">
          {provenance.sources.map((source) => (
            <li key={source.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-slate-300">{source.id}</span>
              <span className="font-mono">
                {source.provider ?? 'ไม่ทราบผู้ให้บริการ'} · {formatBangkokDateTimeCE(source.asOf)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="font-semibold text-white">10. เหตุผลทั้งหมด</h3>
        <ul className="mt-2 space-y-1.5">
          {breakdown.reasoning.map((reason) => (
            <li key={reason.id} className="flex gap-2">
              <span aria-hidden="true">{reason.polarity === 'caution' ? '⚠' : '•'}</span>
              <span>{reason.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="rounded-xl border border-slate-800 p-3 text-xs leading-5 text-slate-400">
        <p>Timeframe: {summary.timeframe} · แท่งที่ปิดแล้ว: {summary.finalizedCandles}</p>
        <p>แท่งล่าสุดที่ใช้: {summary.latestCandleAt ?? 'ไม่พร้อมใช้งาน'} (ค.ศ.)</p>
        <p>ข้อมูล ณ: {formatBangkokDateTimeCE(summary.asOf)}</p>
        <p>คำนวณเมื่อ: {formatBangkokDateTimeCE(summary.calculatedAt)}</p>
        <p>เวอร์ชันการคำนวณ: {summary.configVersion}</p>
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

/** A multiple, printed as `1.24×`. Used for both ATR and Expected Move units. */
function atrText(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}×`;
}

function percentText(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}
