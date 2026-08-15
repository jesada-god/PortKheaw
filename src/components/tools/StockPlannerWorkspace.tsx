'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, TriangleAlert } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { SymbolPreview } from '@/src/components/portfolio/SymbolPreview';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { Tabs } from '@/src/components/ui/Tabs';
import { useToast } from '@/src/components/ui/Toast';
import type { SymbolSearchResult } from '@/src/lib/market-data/types';
import { hasToolHandoff, parseEquityToolHandoff, type EquityToolContext } from '@/src/lib/tools/handoff';
import { SavedStockPlans, type SavedPlanView } from './SavedStockPlans';
import { PlanDetails } from './PlanDetails';
import {
  evaluateStockPlan,
  formatPlanMoney,
  formatPlanPercent,
  parsePlanNumber,
  type StockPlanSizingMode,
} from '@/src/lib/tools/stock-plan';
import {
  DEFAULT_HORIZON_PRESET,
  HORIZON_PRESETS,
  HORIZON_PRESET_LABEL,
  OUTLOOK_NOT_PROBABILITY_NOTICE,
  evaluatePlanOutlook,
  formatRewardRisk,
  horizonDateForPreset,
  planToday,
  type PlanHorizonPreset,
  type PlanOutlookField,
} from '@/src/lib/tools/stock-plan-outlook';

/**
 * วางแผนหุ้นรายตัว (Stock Planner).
 *
 * The first screen asks four things and nothing else: which stock, where the
 * reader thinks it is going, the level at which they would accept it did not work
 * out, and by when. The current price is on the page but is not one of the four —
 * it is read-only, and it arrives from `/api/tools/planner-price`, which runs the
 * same loader and the same canonical resolver the Stock Detail header runs. That
 * is what makes the baseline the header's own number rather than a second opinion
 * about a quote.
 *
 * Everything the tool then says is one of those four restated. There is no
 * signal, no rating, no confidence and no recommendation anywhere in this file,
 * and the one number a reader is most likely to misread — "โอกาสขึ้น" — carries
 * {@link OUTLOOK_NOT_PROBABILITY_NOTICE} beside it saying in plain Thai that it
 * is a distance and not a probability.
 *
 * What was here before is not gone. The entry/stop/size planner this tool
 * shipped with still exists, in full, inside ดูรายละเอียด — a reader who used it
 * to size a position can still do that, and the portfolio handoff that fills it
 * in still works. It moved because the first screen answers a smaller question
 * and should look like it.
 *
 * The reader's entitlement is decided on the server before this component is ever
 * sent (see `app/tools/stock-planner/page.tsx`), and every write goes to a route
 * that checks the same capability again. There is no client gate here, because a
 * client gate is not what keeps a locked reader out.
 */

const card = 'rounded-2xl border border-slate-800 bg-[#151B28] p-4 shadow-xl md:p-6';
const stepHeading = 'text-base font-bold text-white';
const fieldLabel = 'flex items-center gap-1 text-sm font-medium text-slate-200';

interface PlannerPricePayload {
  symbol: string;
  name: string | null;
  assetType: string;
  exchange: string | null;
  currency: string;
  acceptedPrice: number | null;
  session: string;
  asOf: string | null;
  unsupported: string | null;
}

type PriceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; price: PlannerPricePayload }
  | { status: 'unsupported'; price: PlannerPricePayload }
  | { status: 'unavailable' };

/** The plan being edited, when the reader is editing a saved one rather than making one. */
interface EditingPlan { id: string; baselinePrice: number; symbol: string }

export function StockPlannerWorkspace() {
  const { addToast } = useToast();
  const [symbolDraft, setSymbolDraft] = useState('');
  const [asset, setAsset] = useState<SymbolSearchResult | null>(null);
  const [priceState, setPriceState] = useState<PriceState>({ status: 'idle' });
  const [targetDraft, setTargetDraft] = useState('');
  const [invalidationDraft, setInvalidationDraft] = useState('');
  const [preset, setPreset] = useState<PlanHorizonPreset>(DEFAULT_HORIZON_PRESET);
  const [customDate, setCustomDate] = useState('');
  const [analyzed, setAnalyzed] = useState(false);
  const [editing, setEditing] = useState<EditingPlan | null>(null);

  /* The shipped entry/size planner, preserved inside ดูรายละเอียด. */
  const [entryDraft, setEntryDraft] = useState('');
  const [sizingMode, setSizingMode] = useState<StockPlanSizingMode>('budget');
  const [sizeDraft, setSizeDraft] = useState('');
  const [holding, setHolding] = useState<EquityToolContext | null>(null);

  const [plans, setPlans] = useState<SavedPlanView[]>([]);
  const [planPrices, setPlanPrices] = useState<Record<string, number | null>>({});
  const [saving, setSaving] = useState(false);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);

  const request = useRef(0);
  // Resolved once per mount: a plan's horizon is a calendar date, and it must not
  // change under the reader because a render happened after midnight.
  const today = useMemo(() => planToday(), []);

  useEffect(() => () => { request.current += 1; }, []);

  /*
    A new stock is a new plan. Carrying the previous stock's target and
    invalidation over would leave two prices from one company sitting under
    another company's name, and every figure on the page would be about neither.
  */
  const selectAsset = useCallback(async (result: SymbolSearchResult, entryOverride?: string) => {
    const requestId = ++request.current;
    setAsset(result);
    setTargetDraft(''); setInvalidationDraft(''); setAnalyzed(false); setEditing(null);
    setEntryDraft(entryOverride ?? ''); setSizeDraft('');
    setPriceState({ status: 'loading' });
    let payload: { data?: PlannerPricePayload } | null = null;
    try {
      const response = await fetch(`/api/tools/planner-price/${encodeURIComponent(result.symbol)}`);
      payload = await response.json() as { data?: PlannerPricePayload };
    } catch { payload = null; }
    if (requestId !== request.current) return;
    const price = payload?.data ?? null;
    if (!price) { setPriceState({ status: 'unavailable' }); return; }
    if (price.unsupported) { setPriceState({ status: 'unsupported', price }); return; }
    if (price.acceptedPrice === null) { setPriceState({ status: 'unavailable' }); return; }
    setPriceState({ status: 'ready', price });
    if (entryOverride === undefined) setEntryDraft(String(price.acceptedPrice));
  }, []);

  /* One handoff, applied once, at mount. Later edits belong to the reader. */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const context = parseEquityToolHandoff(params);
      if (context) {
        setHolding(context);
        setSymbolDraft(context.symbol);
        setSizingMode('shares');
        void selectAsset(plannerSearchResult(context.symbol, context.type), context.price === null ? '' : String(context.price));
        setSizeDraft(String(context.quantity));
        return;
      }
      /*
        The Stock Detail CTA, which carries a symbol and nothing else. It is a
        different arrival from the portfolio handoff: there is no position behind
        it, so nothing is prefilled but the stock itself.

        `hasToolHandoff` guards it, and that guard is the point. A portfolio
        handoff that `parseEquityToolHandoff` REFUSED — an option contract — still
        has a `symbol` in its URL, and without this the refusal would be undone
        one line later by planning the contract's underlying as if the reader had
        asked for it. A refused handoff must open an empty workspace.
      */
      if (hasToolHandoff(window.location.search)) return;
      const symbol = params.get('symbol')?.trim().toUpperCase() ?? '';
      if (/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol)) {
        setSymbolDraft(symbol);
        void selectAsset(plannerSearchResult(symbol, 'stock'));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectAsset]);

  /*
    Fetching and storing are kept apart on purpose: this returns the plans and
    touches no state, so the mount effect below can own its own cancellation and
    the mutation handlers can reuse the same request without either of them
    setting state from inside an effect body.
  */
  const fetchPlans = useCallback(async (): Promise<SavedPlanView[] | null> => {
    try {
      const response = await fetch('/api/stock-plans');
      if (!response.ok) return null;
      const payload = await response.json() as { data?: SavedPlanView[] };
      return payload.data ?? [];
    } catch { return null; }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchPlans();
      if (!cancelled && next) setPlans(next);
    })();
    return () => { cancelled = true; };
  }, [fetchPlans]);

  /** Re-read after a write. A failed refresh leaves the list as it was. */
  async function refreshPlans() {
    const next = await fetchPlans();
    if (next) setPlans(next);
  }

  /*
    One accepted price per distinct saved symbol, fetched from the same route the
    form uses. Saved cards show "% เทียบราคาตั้งต้น", which is only meaningful
    against the same canonical price the plan was made from.
  */
  useEffect(() => {
    const symbols = [...new Set(plans.map((plan) => plan.symbol))];
    const missing = symbols.filter((symbol) => !(symbol in planPrices));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(missing.map(async (symbol) => {
        try {
          const response = await fetch(`/api/tools/planner-price/${encodeURIComponent(symbol)}`);
          const payload = await response.json() as { data?: PlannerPricePayload };
          return [symbol, payload?.data?.acceptedPrice ?? null] as const;
        } catch { return [symbol, null] as const; }
      }));
      if (!cancelled) setPlanPrices((current) => ({ ...current, ...Object.fromEntries(entries) }));
    })();
    return () => { cancelled = true; };
  }, [plans, planPrices]);

  const currency = priceState.status === 'ready' || priceState.status === 'unsupported'
    ? priceState.price.currency
    : asset?.currency ?? 'USD';

  /*
    The baseline. While editing a saved plan it is the plan's OWN stored baseline,
    not today's price: the plan's percentages have always been measured from where
    the price was when it was made, and an edit changes the plan, never its past.
  */
  const baselinePrice = editing
    ? editing.baselinePrice
    : priceState.status === 'ready' ? priceState.price.acceptedPrice : null;

  const horizonDate = preset === 'custom' ? (customDate || null) : horizonDateForPreset(preset, today);

  const evaluation = useMemo(() => evaluatePlanOutlook({
    baselinePrice,
    targetPrice: parsePlanNumber(targetDraft),
    invalidationPrice: parsePlanNumber(invalidationDraft),
    horizonDate,
    today,
  }), [baselinePrice, targetDraft, invalidationDraft, horizonDate, today]);

  /* The shipped sizing planner's own evaluation, for the details section. */
  const sizingEvaluation = useMemo(() => evaluateStockPlan({
    entry: parsePlanNumber(entryDraft),
    stopLoss: parsePlanNumber(invalidationDraft),
    target: parsePlanNumber(targetDraft),
    sizing: { mode: sizingMode, amount: parsePlanNumber(sizeDraft) },
  }), [entryDraft, invalidationDraft, targetDraft, sizingMode, sizeDraft]);

  /*
    Messages are held back until the reader has asked for the analysis. An empty
    box is not a mistake they have made yet, and a form that starts life covered
    in red is telling somebody off for not having typed yet.
  */
  const started = analyzed || [targetDraft, invalidationDraft].some((draft) => draft.trim() !== '');
  function issueFor(field: PlanOutlookField): string | null {
    const issue = evaluation.issues.find((item) => item.field === field);
    if (!issue) return null;
    if (!started && issue.message.startsWith('กรอก')) return null;
    if (!analyzed && issue.message.startsWith('เลือก')) return null;
    return issue.message;
  }

  const { outlook, scenarios } = evaluation;
  const showResult = analyzed && outlook !== null && scenarios !== null;

  async function savePlan() {
    if (!asset || baselinePrice === null || !outlook || !horizonDate) return;
    setSaving(true);
    const body = {
      targetPrice: parsePlanNumber(targetDraft),
      invalidationPrice: parsePlanNumber(invalidationDraft),
      horizonDate,
    };
    try {
      const response = editing
        ? await fetch(`/api/stock-plans/${editing.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        : await fetch('/api/stock-plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // `baselinePrice` travels only on create. There is no field for it on
          // the edit path, which is how an edit cannot move a baseline.
          body: JSON.stringify({ ...body, symbol: asset.symbol, baselinePrice }),
        });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        addToast({ title: payload?.error ?? 'ยังบันทึกแผนไม่ได้', type: 'error' });
        return;
      }
      addToast({ title: editing ? 'แก้ไขแผนแล้ว' : 'บันทึกแผนแล้ว', type: 'success' });
      setEditing(null);
      await refreshPlans();
    } catch {
      addToast({ title: 'ยังบันทึกแผนไม่ได้', type: 'error' });
    } finally { setSaving(false); }
  }

  function editPlan(plan: SavedPlanView) {
    setEditing({ id: plan.id, baselinePrice: plan.baselinePrice, symbol: plan.symbol });
    setSymbolDraft(plan.symbol);
    setTargetDraft(String(plan.targetPrice));
    setInvalidationDraft(String(plan.invalidationPrice));
    setPreset('custom');
    setCustomDate(plan.horizonDate);
    setAnalyzed(true);
    if (asset?.symbol !== plan.symbol) setAsset(plannerSearchResult(plan.symbol, 'stock'));
    // Guarded: jsdom and older embedded webviews do not implement it.
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function deletePlan(plan: SavedPlanView) {
    setBusyPlanId(plan.id);
    try {
      const response = await fetch(`/api/stock-plans/${plan.id}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 204) {
        addToast({ title: 'ยังลบแผนไม่ได้', type: 'error' });
        return;
      }
      if (editing?.id === plan.id) setEditing(null);
      addToast({ title: 'ลบแผนแล้ว', type: 'success' });
      /*
        Removed from the list the moment the server confirms it, rather than
        after a second round trip to re-read the list. The delete has already
        succeeded at this point, so waiting for the refetch only leaves the row
        the reader just deleted sitting on screen for as long as the network
        takes — which on a cold serverless function is long enough to look
        broken, and did on the first production smoke run. The refresh still
        follows, to pick up anything else that changed.
      */
      setPlans((current) => current.filter((saved) => saved.id !== plan.id));
      await refreshPlans();
    } catch {
      addToast({ title: 'ยังลบแผนไม่ได้', type: 'error' });
    } finally { setBusyPlanId(null); }
  }

  return (
    <div className="min-w-0">
      <Header
        title="วางแผนหุ้น"
        subtitle="กำหนดเป้าหมาย ระดับความเสี่ยง และดู Risk : Reward ของแผนก่อนตัดสินใจ"
        backFallbackHref="/tools"
      />

      <div className="w-full min-w-0 max-w-full space-y-6 p-4 md:p-8">
        <section className={card} aria-labelledby="stock-planner-plan">
          <h2 id="stock-planner-plan" className={stepHeading}>แผนของคุณ</h2>
          <p className="mt-1 break-words text-xs text-slate-400">
            ราคาเป้าหมายและระดับที่แผนไม่เป็นไปตามคาดเป็นค่าที่คุณกำหนดเอง ระบบไม่ได้คาดการณ์ราคาให้
          </p>

          <div className="mt-4 min-w-0">
            <SymbolPreview
              label="หุ้น"
              placeholder="เช่น AAPL หรือ Apple"
              value={symbolDraft}
              onChange={(value) => {
                setSymbolDraft(value);
                if (asset && value !== asset.symbol) {
                  setAsset(null); setPriceState({ status: 'idle' }); setAnalyzed(false); setEditing(null);
                }
              }}
              onSelect={(result) => { void selectAsset(result); }}
            />
          </div>

          {asset && (
            <div data-testid="stock-planner-asset" className="mt-4 flex min-w-0 items-start gap-3 rounded-xl border border-slate-800 bg-[#0A0E17] p-3">
              <InstrumentLogo symbol={asset.symbol} companyName={asset.name} logoUrl={asset.logoUrl ?? null} size={40} />
              <div className="min-w-0 flex-1">
                <p className="min-w-0 break-words text-sm font-bold text-white">{asset.symbol}</p>
                <p className="min-w-0 break-words text-xs text-slate-300">
                  {priceState.status === 'ready' ? priceState.price.name ?? asset.name : asset.name}
                </p>
              </div>
              <div className="min-w-0 shrink-0 text-right">
                {priceState.status === 'loading' && <Skeleton className="h-9 w-24" />}
                {priceState.status === 'ready' && (
                  <>
                    <p data-testid="stock-planner-current-price" className="break-words font-mono text-sm font-bold text-white">
                      {formatPlanMoney(priceState.price.acceptedPrice as number, currency)}
                    </p>
                    <p className="break-words text-[10px] uppercase tracking-wider text-slate-500">
                      {priceState.price.session}
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {/*
            The fail-safe. A refused instrument gets a sentence naming what the
            planner does not do, and no plan form at all — never a baseline for
            something it will not plan.
          */}
          {priceState.status === 'unsupported' && (
            <p data-testid="stock-planner-unsupported" role="status" className="mt-3 min-w-0 break-words rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-amber-300">
              {priceState.price.unsupported}
            </p>
          )}
          {priceState.status === 'unavailable' && (
            <p data-testid="stock-planner-price-unavailable" role="status" className="mt-3 min-w-0 break-words text-xs text-amber-300">
              ยังดึงราคาล่าสุดของหุ้นตัวนี้ไม่ได้ จึงยังวางแผนต่อไม่ได้ ลองใหม่อีกครั้งภายหลัง
            </p>
          )}

          {(priceState.status === 'ready' || editing) && (
            <>
              <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="min-w-0">
                  <span className={fieldLabel}>
                    <span className="min-w-0 break-words">ราคาปัจจุบัน</span>
                    <InfoHint term="planCurrentPrice" />
                  </span>
                  {/*
                    Read-only by design, not disabled: a disabled input is skipped
                    by the keyboard and unreadable to a screen reader, and this
                    value is the one the whole plan is measured from.
                  */}
                  <input
                    id="stock-planner-current" data-testid="stock-planner-baseline"
                    className="form-input mt-1.5 cursor-not-allowed text-slate-300"
                    readOnly value={baselinePrice === null ? '' : formatPlanMoney(baselinePrice, currency)}
                    aria-describedby="stock-planner-current-note"
                  />
                  <p id="stock-planner-current-note" className="mt-1 break-words text-[11px] text-slate-500">
                    {editing ? 'ราคาตั้งต้นของแผนเดิม แก้ไขไม่ได้' : 'ดึงจากแหล่งเดียวกับหน้ารายละเอียดหุ้น'}
                  </p>
                </div>

                <PriceField
                  id="stock-planner-target" term="planTarget" label="ราคาเป้าหมาย"
                  value={targetDraft} onChange={(value) => { setTargetDraft(value); setAnalyzed(false); }}
                  error={issueFor('target')} currency={currency} align="end"
                />
              </div>

              <div className="mt-4 min-w-0 sm:max-w-[calc(50%-0.5rem)]">
                <PriceField
                  id="stock-planner-invalidation" term="planInvalidation" label="ระดับที่แผนไม่เป็นไปตามคาด"
                  value={invalidationDraft} onChange={(value) => { setInvalidationDraft(value); setAnalyzed(false); }}
                  error={issueFor('invalidation')} currency={currency}
                />
              </div>

              <div className="mt-5 min-w-0">
                <span className={fieldLabel}><span className="min-w-0 break-words">ระยะเวลา</span></span>
                <div className="mt-2 flex min-w-0 flex-wrap gap-2" role="group" aria-label="ระยะเวลาของแผน">
                  {HORIZON_PRESETS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      data-testid={`stock-planner-horizon-${option}`}
                      aria-pressed={preset === option}
                      onClick={() => { setPreset(option); setAnalyzed(false); }}
                      className={`min-h-[44px] shrink-0 rounded-lg border px-3 text-sm transition-colors ${
                        preset === option
                          ? 'border-[#D4FF00] bg-[#D4FF00]/10 font-semibold text-[#D4FF00]'
                          : 'border-slate-700 text-slate-300'
                      }`}
                    >
                      {HORIZON_PRESET_LABEL[option]}
                    </button>
                  ))}
                </div>
                {preset === 'custom' && (
                  <input
                    type="date" id="stock-planner-custom-date" data-testid="stock-planner-custom-date"
                    className="form-input mt-3 sm:max-w-xs" min={today}
                    value={customDate} onChange={(event) => { setCustomDate(event.target.value); setAnalyzed(false); }}
                  />
                )}
                <p className="mt-2 break-words text-[11px] text-slate-500">
                  {horizonDate ? `แผนนี้มีระยะเวลาถึง ${horizonDate}` : 'เลือกวันสิ้นสุดของแผน'}
                </p>
                {issueFor('horizon') && (
                  <p role="alert" className="mt-1 break-words text-xs text-amber-300">{issueFor('horizon')}</p>
                )}
              </div>

              <button
                type="button"
                data-testid="stock-planner-analyze"
                onClick={() => setAnalyzed(true)}
                className="mt-5 min-h-[44px] w-full rounded-xl bg-[var(--accent)] px-4 text-sm font-bold text-[var(--accent-fg)] sm:w-auto sm:px-8"
              >
                วิเคราะห์แผน
              </button>
            </>
          )}
        </section>

        {!asset && priceState.status === 'idle' && (
          <EmptyState
            icon={Search}
            title="ยังไม่ได้เลือกหุ้น"
            description="เลือกหุ้นที่สนใจก่อน แล้วกำหนดราคาเป้าหมาย ระดับที่แผนไม่เป็นไปตามคาด และระยะเวลา เพื่อดู Risk : Reward ของแผน"
          />
        )}

        {showResult && (
          <section className={card} aria-labelledby="stock-planner-result-heading" data-testid="stock-planner-result">
            <h2 id="stock-planner-result-heading" className={stepHeading}>ผลของแผนนี้</h2>

            <dl className="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
              <Figure
                label="โอกาสขึ้น" term="planUpside" tone="positive"
                value={`+${formatPlanPercent(outlook.upsidePercent)}`}
                testId="stock-planner-upside"
              />
              <Figure
                label="ความเสี่ยงลง" term="planDownside" tone="negative"
                value={`-${formatPlanPercent(outlook.downsidePercent)}`}
                testId="stock-planner-downside"
              />
              <Figure
                label="Risk : Reward" term="planRiskReward" termAlign="end"
                value={formatRewardRisk(outlook.rewardRisk)}
                testId="stock-planner-reward-risk"
              />
            </dl>

            {/*
              The sentence that keeps the number honest, next to the number rather
              than at the foot of the page where it would be read by nobody.
            */}
            <p data-testid="stock-planner-not-probability" className="mt-4 flex min-w-0 gap-2 rounded-xl border border-slate-800 bg-[#0A0E17] p-3 text-xs leading-5 text-slate-400">
              <TriangleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0 break-words">{OUTLOOK_NOT_PROBABILITY_NOTICE}</span>
            </p>

            <h3 className="mt-6 text-sm font-bold text-white">ถ้าราคาไปถึงระดับที่คุณกำหนด</h3>
            <p className="mt-1 break-words text-[11px] leading-5 text-slate-500">
              ทั้งสามกรณีนี้คือระดับราคาที่คุณกำหนดไว้เอง ไม่ใช่การคาดการณ์ว่าราคาจะไปทางไหน
            </p>
            <ul data-testid="stock-planner-scenarios" className="mt-3 min-w-0 space-y-2">
              {scenarios.map((scenario) => (
                <li
                  key={scenario.kind}
                  data-testid={`stock-planner-scenario-${scenario.kind}`}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#0A0E17] p-3"
                >
                  <span className="min-w-0 break-words text-sm text-slate-200">{scenario.label}</span>
                  <span className="flex shrink-0 items-baseline gap-2">
                    <span className="font-mono text-sm text-white">{formatPlanMoney(scenario.price, currency)}</span>
                    <span className={`font-mono text-xs ${
                      scenario.changePercent < 0 ? 'text-[var(--negative)]'
                        : scenario.changePercent > 0 ? 'text-[var(--positive)]' : 'text-slate-400'
                    }`}>
                      {scenario.changePercent > 0 ? '+' : ''}{formatPlanPercent(scenario.changePercent)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            <PlanDetails
              key={asset?.symbol ?? ''}
              symbol={asset?.symbol ?? ''}
              currency={currency}
              horizonDate={horizonDate}
              entryDraft={entryDraft}
              onEntryChange={setEntryDraft}
              sizingMode={sizingMode}
              onSizingModeChange={(mode) => { setSizingMode(mode); setSizeDraft(''); }}
              sizeDraft={sizeDraft}
              onSizeChange={setSizeDraft}
              evaluation={sizingEvaluation}
              holding={holding}
            />

            <button
              type="button"
              data-testid="stock-planner-save"
              disabled={saving}
              onClick={() => { void savePlan(); }}
              className="mt-6 min-h-[44px] w-full rounded-xl border border-[#D4FF00] px-4 text-sm font-bold text-[#D4FF00] disabled:opacity-60 sm:w-auto sm:px-8"
            >
              {saving ? 'กำลังบันทึก…' : editing ? 'บันทึกการแก้ไข' : 'บันทึกแผน'}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => { setEditing(null); setAnalyzed(false); }}
                className="ml-0 mt-3 min-h-[44px] w-full rounded-xl border border-slate-700 px-4 text-sm text-slate-300 sm:ml-3 sm:mt-6 sm:w-auto sm:px-6"
              >
                ยกเลิกการแก้ไข
              </button>
            )}
          </section>
        )}

        <section className={card} aria-labelledby="stock-planner-saved">
          <h2 id="stock-planner-saved" className={stepHeading}>แผนที่บันทึกไว้</h2>
          <p className="mt-1 break-words text-xs text-slate-400">
            เปอร์เซ็นต์ในแต่ละแผนวัดจากราคาตั้งต้นของแผนนั้น เทียบกับราคาล่าสุด
          </p>
          <div className="mt-4 min-w-0">
            <SavedStockPlans
              plans={plans} prices={planPrices} today={today} currency={currency}
              busyId={busyPlanId} onEdit={editPlan} onDelete={(plan) => { void deletePlan(plan); }}
            />
          </div>
        </section>

        <section className="min-w-0 rounded-xl border border-slate-800 p-4" data-testid="stock-planner-disclaimer">
          <p className="flex min-w-0 gap-2 text-xs leading-5 text-slate-500">
            <TriangleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
              เครื่องมือนี้ใช้สำหรับช่วยวางแผนและประเมินสถานการณ์ ไม่ใช่คำแนะนำการลงทุน
              ผลลัพธ์เป็นการคำนวณจากค่าที่คุณกำหนดเอง และไม่รับประกันผลตอบแทน
            </span>
          </p>
        </section>
      </div>
    </div>
  );
}

/**
 * A minimal search result for a symbol the reader did not pick from the list.
 *
 * Both the portfolio handoff and the Stock Detail CTA arrive with a symbol
 * already decided, so there is nobody to choose from a dropdown. The real name,
 * exchange and currency arrive with the price a moment later; this is the shape
 * the card renders from until they do.
 */
function plannerSearchResult(symbol: string, type: 'stock' | 'etf'): SymbolSearchResult {
  return {
    symbol, name: symbol,
    assetType: type === 'etf' ? 'ETF' : 'Stock',
    exchange: null, status: 'active', currency: 'USD',
    marketOpen: null, marketClose: null, timezone: null, matchScore: null,
  };
}

/** One price box: a label, its explanation, the input, and any message about it. */
function PriceField({
  id, term, label, value, onChange, error, currency, align,
}: {
  id: string;
  term: 'planTarget' | 'planInvalidation';
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
  label, value, term, termAlign, tone, testId,
}: {
  label: string;
  value: string;
  term: 'planUpside' | 'planDownside' | 'planRiskReward';
  termAlign?: 'start' | 'end';
  tone?: 'positive' | 'negative';
  testId: string;
}) {
  const toneClass = tone === 'positive'
    ? 'text-[var(--positive)]'
    : tone === 'negative' ? 'text-[var(--negative)]' : 'text-white';
  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-[#0A0E17] p-3">
      <dt className="flex min-w-0 items-center gap-1 text-xs text-slate-400">
        <span className="min-w-0 break-words">{label}</span>
        <InfoHint term={term} align={termAlign} />
      </dt>
      <dd data-testid={testId} className={`mt-1 break-words font-mono text-lg font-bold ${toneClass}`}>{value}</dd>
    </div>
  );
}

export default StockPlannerWorkspace;
