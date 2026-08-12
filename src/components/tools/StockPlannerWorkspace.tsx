'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Target, TriangleAlert } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { SymbolPreview } from '@/src/components/portfolio/SymbolPreview';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { Tabs } from '@/src/components/ui/Tabs';
import type { MarketDataEnvelope, Quote, SymbolSearchResult } from '@/src/lib/market-data/types';
import {
  entryMarkerPercent,
  evaluateStockPlan,
  formatPlanMoney,
  formatPlanPercent,
  formatPlanShares,
  formatRiskRewardRatio,
  parsePlanNumber,
  stockPlanSummary,
  type StockPlanField,
  type StockPlanSizingMode,
} from '@/src/lib/tools/stock-plan';

/**
 * วางแผนหุ้นรายตัว (Stock Planner).
 *
 * A stock tool, deliberately built from the pieces the options tools already
 * use: the same symbol search and the same `/api/market/quote` snapshot, the
 * shared glossary popovers, the shared card and input styling. Nothing here
 * fetches a price a second way or computes a figure of its own — the whole
 * arithmetic lives in `@/src/lib/tools/stock-plan`, and this file is the form
 * around it.
 *
 * The reader's entitlement is decided on the server before this component is
 * ever sent (see `app/tools/stock-planner/page.tsx`). There is no client gate
 * here, because a client gate is not what keeps a locked reader out.
 */

const card = 'rounded-2xl border border-slate-800 bg-[#151B28] p-4 shadow-xl md:p-6';
const stepHeading = 'text-base font-bold text-white';
const fieldLabel = 'flex items-center gap-1 text-sm font-medium text-slate-200';

const SIZING_TABS: Readonly<Record<string, StockPlanSizingMode>> = {
  'เงินที่ต้องการลงทุน': 'budget',
  'จำนวนหุ้น': 'shares',
};
const SIZING_LABEL: Readonly<Record<StockPlanSizingMode, string>> = {
  budget: 'เงินที่ต้องการลงทุน',
  shares: 'จำนวนหุ้น',
};

type QuoteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; quote: Quote }
  | { status: 'unavailable' };

export function StockPlannerWorkspace() {
  const [symbolDraft, setSymbolDraft] = useState('');
  const [asset, setAsset] = useState<SymbolSearchResult | null>(null);
  const [quoteState, setQuoteState] = useState<QuoteState>({ status: 'idle' });
  const [entryDraft, setEntryDraft] = useState('');
  const [stopDraft, setStopDraft] = useState('');
  const [targetDraft, setTargetDraft] = useState('');
  const [sizingMode, setSizingMode] = useState<StockPlanSizingMode>('budget');
  const [sizeDraft, setSizeDraft] = useState('');
  const request = useRef(0);

  useEffect(() => () => { request.current += 1; }, []);

  /*
    A new stock is a new plan. Carrying the previous stock's entry, stop and
    target over would leave three prices from one company sitting under another
    company's name, and every figure on the page would be about neither.
  */
  async function selectAsset(result: SymbolSearchResult) {
    const requestId = ++request.current;
    setAsset(result);
    setEntryDraft(''); setStopDraft(''); setTargetDraft(''); setSizeDraft('');
    setQuoteState({ status: 'loading' });
    let payload: MarketDataEnvelope<Quote> | null = null;
    try {
      const response = await fetch(`/api/market/quote/${encodeURIComponent(result.symbol)}`);
      payload = await response.json() as MarketDataEnvelope<Quote>;
    } catch { payload = null; }
    if (requestId !== request.current) return;
    const quote = payload?.data ?? null;
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
      // An unavailable price is said plainly and the plan stays usable: the
      // reader can still type the entry they had in mind.
      setQuoteState({ status: 'unavailable' });
      return;
    }
    setQuoteState({ status: 'ready', quote });
    setEntryDraft(String(quote.price));
  }

  const currency = (quoteState.status === 'ready' ? quoteState.quote.currency : null) ?? asset?.currency ?? 'USD';
  const sizingAmount = parsePlanNumber(sizeDraft);
  const evaluation = useMemo(() => evaluateStockPlan({
    entry: parsePlanNumber(entryDraft),
    stopLoss: parsePlanNumber(stopDraft),
    target: parsePlanNumber(targetDraft),
    sizing: { mode: sizingMode, amount: sizingAmount },
  }), [entryDraft, stopDraft, targetDraft, sizingMode, sizingAmount]);

  /*
    An empty box is not a mistake the reader has made yet, so the "กรอก…ก่อน"
    messages are held back until they have started filling the plan in. A wrong
    value is always reported, empty or not.
  */
  const started = [entryDraft, stopDraft, targetDraft].some((draft) => draft.trim() !== '');
  function issueFor(field: StockPlanField): string | null {
    const issue = evaluation.issues.find((item) => item.field === field);
    if (!issue) return null;
    if (!started && issue.message.startsWith('กรอก')) return null;
    return issue.message;
  }

  const { levels, position } = evaluation;
  const markerPercent = levels ? entryMarkerPercent(levels) : 50;

  return (
    <div className="min-w-0">
      <Header title="วางแผนหุ้น" subtitle="กำหนดจุดเข้า จุดตัดขาดทุน และราคาเป้าหมายของหุ้นรายตัว" backFallbackHref="/tools" />

      <div className="w-full min-w-0 max-w-full space-y-6 p-4 md:p-8">
        <section className={card} aria-labelledby="stock-planner-step-symbol">
          <h2 id="stock-planner-step-symbol" className={stepHeading}>1. เลือกหุ้น</h2>
          <p className="mt-1 text-xs text-slate-400">ค้นหาด้วยชื่อย่อ (Symbol) หรือชื่อบริษัท แล้วเลือกจากรายการ</p>

          <div className="mt-4 min-w-0">
            <SymbolPreview
              label="ค้นหาหุ้น"
              placeholder="เช่น NVDA หรือ Nvidia"
              value={symbolDraft}
              onChange={(value) => {
                setSymbolDraft(value);
                if (asset && value !== asset.symbol) { setAsset(null); setQuoteState({ status: 'idle' }); }
              }}
              onSelect={(result) => { void selectAsset(result); }}
            />
          </div>

          {asset && (
            <div data-testid="stock-planner-asset" className="mt-4 flex min-w-0 items-start gap-3 rounded-xl border border-slate-800 bg-[#0A0E17] p-3">
              <InstrumentLogo symbol={asset.symbol} companyName={asset.name} logoUrl={asset.logoUrl ?? null} size={40} />
              <div className="min-w-0 flex-1">
                <p className="min-w-0 break-words text-sm font-bold text-white">{asset.symbol}</p>
                <p className="min-w-0 break-words text-xs text-slate-300">{asset.name}</p>
                <p className="min-w-0 break-words text-[11px] text-slate-500">{asset.exchange ?? 'ไม่ระบุตลาด'} · {asset.assetType}</p>
              </div>
              <div className="min-w-0 shrink-0 text-right">
                {quoteState.status === 'loading' && <Skeleton className="h-9 w-24" />}
                {quoteState.status === 'unavailable' && <span className="text-xs text-amber-300">ยังไม่มีราคาล่าสุด</span>}
                {quoteState.status === 'ready' && (
                  <>
                    <p className="break-words font-mono text-sm font-bold text-white">{formatPlanMoney(quoteState.quote.price, currency)}</p>
                    <p className={`break-words font-mono text-xs ${
                      (quoteState.quote.changePercent ?? 0) < 0 ? 'text-[var(--negative)]' : 'text-[var(--positive)]'
                    }`}>
                      {quoteState.quote.changePercent === null || quoteState.quote.changePercent === undefined
                        ? 'ไม่มีข้อมูล'
                        : `${quoteState.quote.changePercent >= 0 ? '+' : ''}${formatPlanPercent(quoteState.quote.changePercent, 2)}`}
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
          {asset && quoteState.status === 'unavailable' && (
            <p className="mt-2 break-words text-xs text-amber-300">ยังดึงราคาล่าสุดของหุ้นตัวนี้ไม่ได้ คุณยังกรอกราคาที่สนใจเข้าเองเพื่อวางแผนต่อได้</p>
          )}
        </section>

        {!asset ? (
          <EmptyState
            icon={Search}
            title="ยังไม่ได้เลือกหุ้น"
            description="เลือกหุ้นที่สนใจก่อน แล้วจึงกำหนดจุดเข้า จุดตัดขาดทุน และราคาเป้าหมายเพื่อดูความเสี่ยงและผลตอบแทนของแผน"
          />
        ) : (
          <>
            <section className={card} aria-labelledby="stock-planner-step-prices">
              <h2 id="stock-planner-step-prices" className={stepHeading}>2. วางแผนราคา</h2>
              <p className="mt-1 text-xs text-slate-400">ทั้งสามราคาเป็นค่าที่คุณกำหนดเอง ระบบไม่ได้คาดการณ์ราคาให้</p>

              <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-3">
                <PriceField
                  id="stock-planner-entry" term="planEntry" label="ราคาที่สนใจเข้า (Entry)"
                  value={entryDraft} onChange={setEntryDraft} error={issueFor('entry')} currency={currency}
                />
                <PriceField
                  id="stock-planner-stop" term="planStopLoss" label="จุดตัดขาดทุน (Stop Loss)"
                  value={stopDraft} onChange={setStopDraft} error={issueFor('stopLoss')} currency={currency}
                />
                <PriceField
                  id="stock-planner-target" term="planTarget" label="ราคาเป้าหมาย (Target)" align="end"
                  value={targetDraft} onChange={setTargetDraft} error={issueFor('target')} currency={currency}
                />
              </div>
            </section>

            <section className={card} aria-labelledby="stock-planner-step-size">
              <h2 id="stock-planner-step-size" className={stepHeading}>3. ขนาดเงินลงทุน</h2>
              <p className="mt-1 text-xs text-slate-400">ใส่อย่างใดอย่างหนึ่ง เพื่อดูว่าแผนนี้คิดเป็นเงินเท่าไร (ไม่ใส่ก็ยังดูเปอร์เซ็นต์ได้)</p>

              <Tabs
                className="mt-4"
                tabs={Object.keys(SIZING_TABS)}
                activeTab={SIZING_LABEL[sizingMode]}
                onChange={(tab) => { setSizingMode(SIZING_TABS[tab] ?? 'budget'); setSizeDraft(''); }}
              />

              <div className="mt-4 min-w-0 sm:max-w-xs">
                <label className="block min-w-0" htmlFor="stock-planner-size">
                  <span className={fieldLabel}>{SIZING_LABEL[sizingMode]}</span>
                  <input
                    id="stock-planner-size" data-testid="stock-planner-size"
                    className="form-input mt-1.5" inputMode="decimal" autoComplete="off"
                    placeholder={sizingMode === 'budget' ? `เช่น 1,000 (${currency})` : 'เช่น 10'}
                    value={sizeDraft} onChange={(event) => setSizeDraft(event.target.value)}
                    aria-invalid={issueFor('size') ? true : undefined}
                    aria-describedby={issueFor('size') ? 'stock-planner-size-error' : undefined}
                  />
                </label>
                {issueFor('size') && (
                  <p id="stock-planner-size-error" role="alert" className="mt-1 break-words text-xs text-amber-300">{issueFor('size')}</p>
                )}
              </div>

              {position && levels && (
                <dl data-testid="stock-planner-position" className="mt-5 grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
                  <Figure label="จำนวนหุ้นโดยประมาณ" value={formatPlanShares(position.shares)} />
                  <Figure label="มูลค่าที่ใช้" value={formatPlanMoney(position.cost, currency)} />
                  <Figure label="ขาดทุนหากถึงจุดตัดขาดทุน" value={formatPlanMoney(position.lossAtStop, currency)} tone="negative" />
                  <Figure label="กำไรหากถึงเป้าหมาย" value={formatPlanMoney(position.profitAtTarget, currency)} tone="positive" />
                </dl>
              )}
            </section>

            <section className={card} aria-labelledby="stock-planner-result">
              <h2 id="stock-planner-result" className={stepHeading}>4. ผลของแผนนี้</h2>

              {!levels ? (
                <p className="mt-3 break-words text-sm text-slate-400" data-testid="stock-planner-result-pending">
                  กรอกให้ครบทั้งสามราคา โดยจุดตัดขาดทุนต่ำกว่าจุดเข้า และราคาเป้าหมายสูงกว่าจุดเข้า แล้วผลลัพธ์จะแสดงที่นี่
                </p>
              ) : (
                <div className="mt-4 min-w-0" data-testid="stock-planner-result">
                  <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
                    <Figure
                      label="ความเสี่ยง" term="planRiskPercent" tone="negative"
                      value={`-${formatPlanPercent(levels.riskPercent)}`}
                      note={`${formatPlanMoney(levels.riskPerShare, currency)} ต่อหุ้น`}
                    />
                    <Figure
                      label="ผลตอบแทนคาดหวัง" term="planRewardPercent" tone="positive"
                      value={`+${formatPlanPercent(levels.rewardPercent)}`}
                      note={`${formatPlanMoney(levels.rewardPerShare, currency)} ต่อหุ้น`}
                    />
                    <Figure
                      label="Risk / Reward" term="planRiskReward" termAlign="end"
                      value={formatRiskRewardRatio(levels.rewardToRisk)}
                      note="เสี่ยง 1 ส่วน ต่อผลตอบแทนที่หวัง"
                    />
                  </dl>

                  {/*
                    The plan in one glance: how far down the stop is, how far up
                    the target is, and where the entry sits between them. The bar
                    is proportional; the three labels sit in a fixed grid so a
                    lopsided plan can never push a label off a 320px screen.
                  */}
                  <div className="mt-6 min-w-0" data-testid="stock-planner-bar">
                    <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <span className="absolute inset-y-0 left-0 block rounded-l-full bg-[var(--negative)]/70" style={{ width: `${markerPercent}%` }} />
                      <span className="absolute inset-y-0 right-0 block rounded-r-full bg-[var(--positive)]/70" style={{ width: `${100 - markerPercent}%` }} />
                      <span aria-hidden="true" className="absolute inset-y-0 block w-0.5 bg-white" style={{ left: `${markerPercent}%` }} />
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] leading-4">
                      <div className="min-w-0">
                        <p className="break-words text-slate-400">จุดตัดขาดทุน</p>
                        <p className="break-words font-mono text-[var(--negative)]">-{formatPlanPercent(levels.riskPercent)}</p>
                      </div>
                      <div className="min-w-0 text-center">
                        <p className="break-words text-slate-400">จุดเข้า</p>
                        <p className="break-words font-mono text-slate-200">{formatPlanMoney(parsePlanNumber(entryDraft) ?? 0, currency)}</p>
                      </div>
                      <div className="min-w-0 text-right">
                        <p className="break-words text-slate-400">เป้าหมาย</p>
                        <p className="break-words font-mono text-[var(--positive)]">+{formatPlanPercent(levels.rewardPercent)}</p>
                      </div>
                    </div>
                  </div>

                  <ul className="mt-5 min-w-0 space-y-2" data-testid="stock-planner-summary">
                    {stockPlanSummary(levels).map((sentence) => (
                      <li key={sentence} className="flex min-w-0 gap-2 text-sm leading-6 text-slate-300">
                        <span aria-hidden="true" className="mt-2.5 size-1 shrink-0 rounded-full bg-[#D4FF00]" />
                        <span className="min-w-0 break-words">{sentence}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </>
        )}

        {/* The standing facts about the whole page, compact and last. */}
        <section className="min-w-0 rounded-xl border border-slate-800 p-4" data-testid="stock-planner-disclaimer">
          <p className="flex min-w-0 gap-2 text-xs leading-5 text-slate-500">
            <TriangleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
              เครื่องมือนี้ใช้สำหรับช่วยวางแผนและประเมินสถานการณ์ ไม่ใช่คำแนะนำการลงทุน
              ผลลัพธ์เป็นการคำนวณเบื้องต้นจากข้อมูลและค่าที่คุณกำหนด และไม่รับประกันผลตอบแทน
            </span>
          </p>
        </section>
      </div>
    </div>
  );
}

/** One price box: a label, its explanation, the input, and any message about it. */
function PriceField({
  id, term, label, value, onChange, error, currency, align,
}: {
  id: string;
  term: 'planEntry' | 'planStopLoss' | 'planTarget';
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  currency: string;
  align?: 'start' | 'end';
}) {
  return (
    <div className="min-w-0">
      <label className="block min-w-0" htmlFor={id}>
        <span className={fieldLabel}>
          <span className="min-w-0 break-words">{label}</span>
          <InfoHint term={term} align={align} />
        </span>
        <input
          id={id} data-testid={id} className="form-input mt-1.5" inputMode="decimal" autoComplete="off"
          placeholder={`ราคาต่อหุ้น (${currency})`}
          value={value} onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </label>
      {error && <p id={`${id}-error`} role="alert" className="mt-1 break-words text-xs text-amber-300">{error}</p>}
    </div>
  );
}

/** One derived figure, with the glossary explanation attached to its label. */
function Figure({
  label, value, note, term, termAlign, tone,
}: {
  label: string;
  value: string;
  note?: string;
  term?: 'planRiskPercent' | 'planRewardPercent' | 'planRiskReward';
  termAlign?: 'start' | 'end';
  tone?: 'positive' | 'negative';
}) {
  const toneClass = tone === 'positive' ? 'text-[var(--positive)]' : tone === 'negative' ? 'text-[var(--negative)]' : 'text-white';
  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-[#0A0E17] p-3">
      <dt className="flex min-w-0 items-center gap-1 text-xs text-slate-400">
        <span className="min-w-0 break-words">{label}</span>
        {term && <InfoHint term={term} align={termAlign} />}
      </dt>
      <dd className={`mt-1 break-words font-mono text-lg font-bold ${toneClass}`}>{value}</dd>
      {note && <dd className="mt-0.5 break-words text-[11px] text-slate-500">{note}</dd>}
    </div>
  );
}

export default StockPlannerWorkspace;
