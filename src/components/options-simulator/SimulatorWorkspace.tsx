'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CalendarDays, Check, Copy, HelpCircle, LoaderCircle, Plus, Save, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import Header from '@/src/components/layout/Header';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Modal } from '@/src/components/ui/Modal';
import { Tabs } from '@/src/components/ui/Tabs';
import { useToast } from '@/src/components/ui/Toast';
import { fetchFxRate } from '@/src/lib/market-data/fx/client';
import type { FxQuote } from '@/src/lib/market-data/fx/types';
import type { MarketDataEnvelope, Quote, SymbolSearchResult } from '@/src/lib/market-data/types';
import { optionsChainSchema } from '@/src/lib/market-data/options/contracts';
import { boundedExpirationProfitFloor } from '@/src/lib/options-simulator/monte-carlo';
import { importOptionContract } from '@/src/lib/options-simulator/contract-import';
import { detectStrategy, portfolioProfitLossBasis, valuePortfolio } from '@/src/lib/options-simulator/portfolio';
import { priceOption } from '@/src/lib/options-simulator/pricing';
import type { CallPutScenarioScore } from '@/src/lib/options-simulator/scenario-score';
import type { DataStatus, MonteCarloResult, OptionLeg, PortfolioValuation, ScenarioInput, SimulationType, SimulationWorkspace } from '@/src/lib/options-simulator/types';
import { calculationValidationMessages } from '@/src/lib/options-simulator/validation';
import { runExclusiveSave, type SaveFeedbackStatus } from './save-feedback';
import { addCalendarDays, aggregatePortfolioSensitivity, auditResultReconciliation, BASIC_PATH_OPTIONS, buildProfitLossSummary, calendarDaysBetween, clampTargetDate, convertUsdForDisplay, displayValidationMessage, engineVolatilityToPercent, formatPremiumDigits, formatResultMoney, formatResultNumber, formatSignedPercent, isBasicPathOption, normalizePercentDraft, parseFiniteDraft, parsePercentDraft, parsePremiumPaste, percentVolatilityToEngine, premiumDigitsFromValue, premiumFromDigitString, profitLossState, profitLossStateLabel, profitLossToneClass, safeProfitLossPercent, targetDateError, validationMessageParts, validationPathUnit, type ResultCurrency } from './simulator-ux';

type Saved = SimulationWorkspace & { id: string; createdAt: string; updatedAt: string; version: number };
type MonteCarloDisplayResult = MonteCarloResult & {
  validPaths?: number;
  discardedPaths?: number;
  terminalPriceHistogram?: Array<{ lower: number; upper: number; count: number }>;
};

function monteCarloSnapshot(result: MonteCarloDisplayResult): MonteCarloResult {
  const snapshot = { ...result };
  delete snapshot.validPaths;
  delete snapshot.discardedPaths;
  delete snapshot.terminalPriceHistogram;
  return snapshot;
}

const box = 'rounded-2xl border border-slate-800 bg-[#151B28] p-4 shadow-xl md:p-6';
const label = 'mb-1 block text-xs text-slate-400';
const select = 'h-10 w-full rounded-md border border-slate-700 bg-[#151B28] px-3 text-sm text-white';
const day = (offset = 0) => {
  const value = new Date();
  value.setDate(value.getDate() + offset);
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
};
const uid = () => crypto.randomUUID();

function focusFirstValidationField(messages: string[]) {
  const path = validationMessageParts(messages[0] ?? '').path;
  if (!path) return;
  window.requestAnimationFrame(() => {
    const field = [...document.querySelectorAll<HTMLElement>('[data-validation-path]')]
      .find((element) => element.dataset.validationPath === path);
    field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    field?.focus({ preventScroll: true });
  });
}

function newLeg(): OptionLeg {
  return { id: uid(), kind: 'call', side: 'buy', quantity: 1, strike: 0, expiration: day(30), entryPremium: 0,
    impliedVolatility: 0, multiplier: 100, fees: 0, style: 'european' };
}
function newScenario(): ScenarioInput {
  return { id: uid(), name: 'Base', targetPrice: 0, valuationDate: day(1), volatilityShift: 0, rate: 0, dividendYield: 0 };
}

function optionQuoteValue(value: number | null | undefined): string {
  return value === null || value === undefined ? 'N/A' : `$${value.toFixed(2)}`;
}
function fresh(type: SimulationType): SimulationWorkspace {
  return { name: 'Options Simulation ใหม่', description: '', symbol: '', companyName: '', exchange: null, currency: 'USD',
    simulationType: type, strategyType: 'Custom Multi-Leg', underlyingPrice: null, stockQuantity: 0, cashPosition: 0,
    entryDate: day(), valuationDate: day(), legs: [newLeg()], scenarios: [newScenario()],
    monteCarlo: { paths: 10_000, seed: 42, horizonDays: 30, steps: 30, drift: 0, volatility: 0.2, rate: 0, dividendYield: 0 },
    dataSource: null, dataTimestamp: null, dataStatus: 'unavailable', resultSnapshot: null, methodologyVersion: 'options-simulator-v1' };
}
function normalizeUiWorkspace(value: SimulationWorkspace): SimulationWorkspace {
  const defaultMonteCarlo = fresh(value.simulationType ?? 'what-if').monteCarlo;
  const legacyMonteCarlo = value.monteCarlo ?? defaultMonteCarlo;
  const scenarios = value.scenarios?.length ? value.scenarios : [newScenario()];
  return {
    ...value,
    stockQuantity: Number.isFinite(value.stockQuantity) ? value.stockQuantity : 0,
    cashPosition: Number.isFinite(value.cashPosition) ? value.cashPosition : 0,
    legs: (value.legs?.length ? value.legs : [newLeg()]).map((leg) => ({ ...leg, fees: Number.isFinite(leg.fees) ? leg.fees : 0, style: leg.style ?? 'european' })),
    scenarios: scenarios.map((scenario) => ({
      ...scenario,
      volatilityShift: Number.isFinite(scenario.volatilityShift) ? scenario.volatilityShift : 0,
      rate: Number.isFinite(scenario.rate) ? scenario.rate : 0,
      dividendYield: Number.isFinite(scenario.dividendYield) ? scenario.dividendYield : 0,
    })),
    monteCarlo: { ...defaultMonteCarlo, ...legacyMonteCarlo, paths: isBasicPathOption(legacyMonteCarlo.paths) ? legacyMonteCarlo.paths : 10_000 },
  };
}

function modelGreeks(workspace: SimulationWorkspace, leg: OptionLeg) {
  if (!workspace.underlyingPrice || leg.strike <= 0 || leg.impliedVolatility <= 0 || leg.expiration <= workspace.valuationDate) return null;
  try {
    return priceOption({
      spot: workspace.underlyingPrice,
      strike: leg.strike,
      timeYears: calendarDaysBetween(workspace.valuationDate, leg.expiration) / 365,
      volatility: leg.impliedVolatility,
      rate: workspace.scenarios[0]?.rate ?? 0,
      dividendYield: workspace.scenarios[0]?.dividendYield ?? 0,
      kind: leg.kind,
      style: leg.style,
    }).greeks;
  } catch { return null; }
}

function legSensitivity(workspace: SimulationWorkspace, leg: OptionLeg) {
  const model = modelGreeks(workspace, leg);
  return {
    delta: Number.isFinite(leg.delta) ? leg.delta as number : model?.delta ?? null,
    theta: Number.isFinite(leg.theta) ? leg.theta as number : model?.theta ?? null,
    deltaSource: Number.isFinite(leg.delta) ? leg.deltaSource ?? 'manual' : 'model',
    thetaSource: Number.isFinite(leg.theta) ? leg.thetaSource ?? 'manual' : 'model',
  } as const;
}

function aggregateSensitivity(workspace: SimulationWorkspace) {
  return aggregatePortfolioSensitivity(workspace.legs.map((leg) => {
    const sensitivity = legSensitivity(workspace, leg);
    return {
      side: leg.side,
      quantity: leg.quantity,
      multiplier: leg.multiplier,
      delta: sensitivity.delta,
      theta: sensitivity.theta,
    };
  }));
}

export default function SimulatorWorkspace({ initialType }: { initialType: SimulationType }) {
  const router = useRouter();
  const { addToast } = useToast();
  const [workspace, setWorkspace] = useState(() => fresh(initialType));
  const [tab, setTab] = useState(initialType === 'monte-carlo' ? 'Monte Carlo Simulation' : 'What-If Analysis');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SymbolSearchResult[]>([]);
  const [pending, setPending] = useState<SymbolSearchResult | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [valuation, setValuation] = useState<PortfolioValuation | null>(null);
  const [mc, setMc] = useState<MonteCarloDisplayResult | null>(null);
  const [callPutScore, setCallPutScore] = useState<CallPutScenarioScore | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [savedState, setSavedState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [savedQuery, setSavedQuery] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveFeedbackStatus | 'Offline draft'>('Unsaved');
  const [savingMode, setSavingMode] = useState<'save' | 'copy' | null>(null);
  const [selectedLegId, setSelectedLegId] = useState('portfolio');
  const [resultsOutdated, setResultsOutdated] = useState(false);
  const [inputsOutdated, setInputsOutdated] = useState(false);
  const [scenarioDirty, setScenarioDirty] = useState(false);
  const [resultCurrency, setResultCurrency] = useState<ResultCurrency>('USD');
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  const [fxState, setFxState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const worker = useRef<Worker | null>(null);
  const workerRunId = useRef(0);
  const hasResults = useRef(false);
  const saveInFlight = useRef(false);
  const lastSaveMode = useRef<'save' | 'copy'>('save');
  const hydrated = useRef(false);
  const contractImportHandled = useRef(false);
  const analysisWorkspaceValue = useMemo(() => (
    selectedLegId === 'portfolio' || !workspace.legs.some((leg) => leg.id === selectedLegId)
      ? workspace
      : { ...workspace, legs: workspace.legs.filter((leg) => leg.id === selectedLegId) }
  ), [selectedLegId, workspace]);

  const cancelWorker = useCallback(() => {
    workerRunId.current += 1;
    worker.current?.terminate();
    worker.current = null;
    setRunning(false);
  }, []);
  const change = useCallback((patch: Partial<SimulationWorkspace>) => {
    if (worker.current) cancelWorker();
    setWorkspace((current) => ({ ...current, ...patch }));
    setValidationErrors([]);
    setOperationError(null);
    setSaveStatus('Unsaved');
    if (hasResults.current) setResultsOutdated(true);
  }, [cancelWorker]);
  const loadSaved = useCallback(async () => {
    setSavedState('loading');
    try {
      const response = await fetch('/api/option-simulations?page=1&pageSize=50');
      if (response.status === 401) { setSaved([]); setSavedState('ready'); return; }
      if (!response.ok) throw new Error();
      const payload = await response.json() as { data: { items: Saved[] } }; setSaved(payload.data.items); setSavedState('ready');
    } catch { setSavedState('error'); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSaved(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSaved]);
  useEffect(() => {
    let active = true;
    void fetchFxRate().then((result) => {
      if (!active) return;
      setFxQuote(result.quote);
      setFxState(result.quote ? 'ready' : 'unavailable');
    }).catch(() => {
      if (!active) return;
      setFxQuote(null);
      setFxState('unavailable');
      setResultCurrency('USD');
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).has('contract')) {
        hydrated.current = true;
        return;
      }
      const draft = localStorage.getItem('nexora-options-simulator-draft-v1');
      if (draft) try {
        const parsed = normalizeUiWorkspace(JSON.parse(draft) as SimulationWorkspace);
        if (!calculationValidationMessages(parsed).length) setWorkspace(parsed);
      } catch { /* invalid drafts are ignored */ }
      hydrated.current = true;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (contractImportHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const symbol = params.get('symbol');
    const expiration = params.get('expiration');
    const contractSymbol = params.get('contract');
    const acceptedPrice = Number(params.get('underlyingPrice'));
    const acceptedProvider = params.get('underlyingProvider');
    const acceptedAsOf = params.get('underlyingAsOf');
    const acceptedMode = params.get('underlyingMode');
    const hasAcceptedPrice = Number.isFinite(acceptedPrice) && acceptedPrice > 0;
    const acceptedStatus: DataStatus | null = acceptedMode === 'REAL-TIME' ? 'live'
      : acceptedMode === 'STALE' || acceptedMode === 'CACHED' ? 'stale'
        : acceptedMode === 'DELAYED' || acceptedMode === 'END-OF-DAY' ? 'delayed'
          : null;
    if (!symbol || !expiration || !contractSymbol) return;
    contractImportHandled.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const query = new URLSearchParams({ symbol, expiration });
        const response = await fetch(`/api/market/options/chain?${query.toString()}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
        const payload = await response.json() as { data: unknown; error?: { code?: string } };
        if (!response.ok) throw new Error(`นำเข้าสัญญาไม่ได้ (${payload.error?.code ?? response.status})`);
        const parsed = optionsChainSchema.safeParse(payload.data);
        if (!parsed.success) throw new Error('Options chain response ไม่ผ่าน schema validation');
        let imported = false;
        setWorkspace((current) => {
          const next = importOptionContract(current, parsed.data, contractSymbol);
          imported = Boolean(next);
          if (!next) return current;
          const canonicalUnderlying = hasAcceptedPrice && acceptedStatus ? {
            ...next,
            underlyingPrice: acceptedPrice,
            dataSource: acceptedProvider?.slice(0, 80) || next.dataSource,
            dataTimestamp: acceptedAsOf && Number.isFinite(Date.parse(acceptedAsOf)) ? acceptedAsOf : next.dataTimestamp,
            dataStatus: acceptedStatus,
            scenarios: next.scenarios.map((scenario, index) => index === 0
              ? { ...scenario, targetPrice: acceptedPrice }
              : scenario),
          } : next;
          return normalizeUiWorkspace(canonicalUnderlying);
        });
        if (!imported) throw new Error('ไม่พบ contract identity ที่เลือกใน chain snapshot นี้');
        setSelectedLegId('portfolio');
        setValuation(null); setMc(null); setCallPutScore(null);
        setSaveStatus('Unsaved'); setTab('Inputs');
        addToast({ title: 'นำเข้าสัญญาจริงแล้ว', message: `${contractSymbol} · ${parsed.data.provider}`, type: 'success' });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setOperationError(cause instanceof Error ? cause.message : 'นำเข้าสัญญาจริงไม่ได้');
      }
    })();
    return () => controller.abort();
  }, [addToast]);
  useEffect(() => {
    if (!hydrated.current || saveStatus !== 'Unsaved') return;
    const timer = setTimeout(() => { localStorage.setItem('nexora-options-simulator-draft-v1', JSON.stringify(workspace)); if (!navigator.onLine) setSaveStatus('Offline draft'); }, 800);
    return () => clearTimeout(timer);
  }, [workspace, saveStatus]);
  useEffect(() => { hasResults.current = Boolean(valuation || mc); }, [valuation, mc]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (saveStatus !== 'Saved') event.preventDefault(); };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [saveStatus]);
  useEffect(() => () => { worker.current?.terminate(); }, []);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/market/search?q=${encodeURIComponent(query)}&limit=8`, { signal: controller.signal });
        const payload = await response.json() as MarketDataEnvelope<SymbolSearchResult[]>;
        setMatches((payload.data ?? []).filter((item) => item.status === 'active' && ['Stock', 'ETF'].includes(item.assetType)));
      } catch { if (!controller.signal.aborted) setMatches([]); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  async function setSymbol(asset: SymbolSearchResult, duplicate = false) {
    let quote: MarketDataEnvelope<Quote> | null = null;
    try { quote = await (await fetch(`/api/market/quote/${encodeURIComponent(asset.symbol)}`)).json() as MarketDataEnvelope<Quote>; } catch { /* explicit unavailable state */ }
    const price = quote?.data?.price ?? null;
    const freshness = quote?.meta.freshness.status;
    const dataStatus = !price ? 'unavailable' : freshness === 'realtime' ? 'live' : freshness === 'stale' ? 'stale' : 'delayed';
    if (hasResults.current) setInputsOutdated(true);
    change({ id: undefined, updatedAt: undefined, name: duplicate ? `${workspace.name} (copy)` : `New ${asset.symbol} simulation`, symbol: asset.symbol,
      companyName: asset.name, exchange: asset.exchange, currency: asset.currency ?? 'USD', underlyingPrice: price,
      legs: duplicate ? workspace.legs.map(() => newLeg()) : [newLeg()], scenarios: workspace.scenarios.map((item) => ({ ...item, id: uid(), targetPrice: price ?? 0 })),
      dataSource: quote?.meta.provider ?? null, dataTimestamp: quote?.meta.freshness.asOf ?? quote?.meta.timestamp ?? null, dataStatus });
    setPending(null); setQuery(''); setMatches([]);
  }
  function choose(asset: SymbolSearchResult) { workspace.symbol && workspace.symbol !== asset.symbol ? setPending(asset) : void setSymbol(asset); }
  function legChange(index: number, patch: Partial<OptionLeg>) {
    const legs = workspace.legs.map((item, itemIndex) => itemIndex === index ? {
      ...item,
      ...patch,
      ...(item.inputMode === 'provider' ? { inputMode: 'custom' as const } : {}),
      ...('entryPremium' in patch ? { premiumSource: 'manual' as const } : {}),
    } : item);
    const changedLeg = legs[index];
    const syncsSelectedContract = (selectedLegId === 'portfolio' && index === 0) || workspace.legs[index]?.id === selectedLegId;
    const dte = Math.max(1, calendarDaysBetween(workspace.valuationDate, changedLeg.expiration));
    if (hasResults.current) setInputsOutdated(true);
    change({ legs, strategyType: detectStrategy(legs, workspace.stockQuantity), monteCarlo: syncsSelectedContract ? {
      ...workspace.monteCarlo,
      volatility: patch.impliedVolatility ?? workspace.monteCarlo.volatility,
      horizonDays: patch.expiration ? dte : workspace.monteCarlo.horizonDays,
      steps: patch.expiration ? Math.min(366, dte) : workspace.monteCarlo.steps,
    } : workspace.monteCarlo });
  }
  function scenarioChange(index: number, patch: Partial<ScenarioInput>) {
    setScenarioDirty(true);
    change({ scenarios: workspace.scenarios.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
  }
  function monteCarloChange(patch: Partial<SimulationWorkspace['monteCarlo']>) {
    setScenarioDirty(true);
    change({ monteCarlo: { ...workspace.monteCarlo, ...patch } });
  }
  function validate(): boolean {
    const selectedLegIndex = workspace.legs.findIndex((leg) => leg.id === selectedLegId);
    const issues = calculationValidationMessages(analysisWorkspace()).map((message) => (
      selectedLegIndex >= 0 ? message.replace(/^legs\.0(?=[:.])/, `legs.${selectedLegIndex}`) : message
    ));
    if (tab === 'Monte Carlo Simulation' && !isBasicPathOption(workspace.monteCarlo.paths)) issues.push('monteCarlo.paths: Paths ต้องเป็น 1,000, 5,000, 10,000, 25,000 หรือ 50,000');
    setValidationErrors(issues);
    if (issues.length > 0) {
      const firstPath = validationMessageParts(issues[0]).path;
      if (firstPath?.startsWith('legs.')) setTab('Inputs');
      if (process.env.NODE_ENV === 'development') {
        console.debug('[Options Simulator validation]', issues.map((message) => {
          const path = validationMessageParts(message).path ?? 'simulation';
          return { path, unit: validationPathUnit(path) };
        }));
      }
      focusFirstValidationField(issues);
      return false;
    }
    return true;
  }
  function analysisWorkspace(): SimulationWorkspace {
    return analysisWorkspaceValue;
  }
  function analyze() {
    if (!validate()) return;
    if (analysisWorkspace().legs.some((leg) => leg.contractStatus === 'stale') && !confirm('ข้อมูลสัญญาที่นำเข้ามีสถานะ stale ต้องการคำนวณต่อด้วยสมมติฐานนี้หรือไม่?')) return;
    if (tab === 'Monte Carlo Simulation') return runMonteCarlo();
    const result = valuePortfolio(analysisWorkspace(), workspace.scenarios[0]);
    hasResults.current = true; setResultsOutdated(false); setInputsOutdated(false); setScenarioDirty(false); setValuation(result); setWorkspace((current) => ({ ...current, resultSnapshot: { ...current.resultSnapshot, whatIf: result } })); setSaveStatus('Unsaved');
  }
  function runMonteCarlo() {
    cancelWorker(); const runId = ++workerRunId.current; setRunning(true); setProgress(0); setValidationErrors([]); setOperationError(null); setCallPutScore(null);
    const instance = new Worker(new URL('../../workers/optionsMonteCarlo.worker.ts', import.meta.url)); worker.current = instance;
    instance.onmessage = (event: MessageEvent<{ result?: MonteCarloDisplayResult; scenarioScore?: CallPutScenarioScore; error?: string; progress?: { completed: number; total: number } }>) => {
      if (runId !== workerRunId.current || worker.current !== instance) return;
      if (event.data.progress) { setProgress(event.data.progress.completed); return; }
      instance.terminate(); worker.current = null; setRunning(false);
      if (event.data.result) {
        hasResults.current = true; setResultsOutdated(false); setInputsOutdated(false); setScenarioDirty(false); setMc(event.data.result); setCallPutScore(event.data.scenarioScore ?? { status: 'unavailable', reason: 'ผลลัพธ์เดิมไม่มี Call/Put Scenario Score กรุณารัน Monte Carlo ใหม่', auditStatus: 'not-run' }); setWorkspace((current) => ({ ...current, monteCarlo: settings, resultSnapshot: { ...current.resultSnapshot, monteCarlo: monteCarloSnapshot(event.data.result as MonteCarloDisplayResult) } })); setSaveStatus('Unsaved');
      } else setOperationError(event.data.error ?? 'ไม่สามารถจำลองได้ กรุณาลองใหม่');
    };
    instance.onerror = () => { if (runId !== workerRunId.current) return; instance.terminate(); worker.current = null; setRunning(false); setOperationError('ไม่สามารถจำลอง Monte Carlo ได้ กรุณาลองใหม่'); };
    const scoped = analysisWorkspace();
    const targetDte = Math.max(1, calendarDaysBetween(workspace.valuationDate, workspace.scenarios[0].valuationDate));
    const settings = { ...workspace.monteCarlo, horizonDays: targetDte, steps: Math.min(workspace.monteCarlo.steps, targetDte) };
    instance.postMessage({ workspace: scoped, comparisonWorkspace: workspace, settings, targetPrice: workspace.scenarios[0].targetPrice });
  }

  function selectAnalysisContract(nextSelection: string) {
    if (nextSelection === analysisSelection) return;
    if (scenarioDirty && !confirm('ค่าจำลองที่ยังไม่ได้คำนวณจะถูกรีเซ็ต ต้องการเปลี่ยนสัญญาหรือไม่?')) return;
    cancelWorker();
    const nextLeg = workspace.legs.find((leg) => leg.id === nextSelection) ?? null;
    const nextLegs = nextLeg ? [nextLeg] : workspace.legs;
    const expiration = nextLegs.map((leg) => leg.expiration).sort()[0] ?? workspace.valuationDate;
    setSelectedLegId(nextLeg?.id ?? 'portfolio');
    setWorkspace((current) => ({ ...current,
      scenarios: current.scenarios.map((item, index) => index === 0 ? { ...item, targetPrice: current.underlyingPrice ?? item.targetPrice,
        valuationDate: clampTargetDate(addCalendarDays(current.valuationDate, 1), current.valuationDate, expiration), volatilityShift: 0 } : item),
      monteCarlo: { ...current.monteCarlo, volatility: nextLeg?.impliedVolatility ?? current.legs[0]?.impliedVolatility ?? current.monteCarlo.volatility },
    }));
    setScenarioDirty(false); setValidationErrors([]); setSaveStatus('Unsaved');
    if (hasResults.current) setResultsOutdated(true);
  }
  async function save(copy = false) {
    if (!validate()) return;
    const mode = copy ? 'copy' : 'save';
    lastSaveMode.current = mode;
    const updating = workspace.id && workspace.updatedAt && !copy;
    const attempt = await runExclusiveSave(saveInFlight, async () => {
      const response = await fetch(updating ? `/api/option-simulations/${workspace.id}` : '/api/option-simulations', {
        method: updating ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updating ? { workspace, expectedUpdatedAt: workspace.updatedAt } : { ...workspace, id: undefined, updatedAt: undefined }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'ข้อมูลมีการเปลี่ยนแปลง กรุณาเปิดเวอร์ชันล่าสุดหรือบันทึกเป็นสำเนา' : response.status === 401 ? 'กรุณาเข้าสู่ระบบเพื่อบันทึก ระบบยังเก็บฉบับร่างไว้ในเครื่อง' : 'ไม่สามารถบันทึกได้ กรุณาลองใหม่');
      const payload = await response.json() as { data: Saved };
      setWorkspace(payload.data);
      localStorage.removeItem('nexora-options-simulator-draft-v1');
      void loadSaved();
      return payload.data;
    }, (status) => {
      setSaveStatus(status);
      if (status === 'Saving') setSavingMode(mode);
    });
    if (!attempt.started) return;
    setSavingMode(null);
    if (attempt.ok) {
      setOperationError(null);
      addToast({ title: mode === 'copy' ? 'บันทึกสำเนาแล้ว' : 'บันทึกแล้ว', type: 'success' });
      return;
    }
    const message = attempt.error instanceof Error ? attempt.error.message : 'ไม่สามารถบันทึกได้ กรุณาลองใหม่';
    setOperationError(message);
    addToast({ title: 'บันทึกไม่สำเร็จ', message, type: 'error' });
  }
  async function remove(item: Saved) {
    if (!confirm(`Delete “${item.name}”?`)) return;
    if ((await fetch(`/api/option-simulations/${item.id}`, { method: 'DELETE' })).ok) void loadSaved();
  }

  const tabLabels: Record<string, string> = { Inputs: 'ข้อมูลสัญญา', 'What-If': 'What-If', 'Monte Carlo': 'Monte Carlo', Payoff: 'Payoff', Greeks: 'Greeks' };
  const displayedSaveStatus: Record<string, string> = { Unsaved: 'ยังไม่บันทึก', Saving: 'กำลังบันทึก', Saved: 'บันทึกแล้ว', Failed: 'บันทึกไม่สำเร็จ', 'Offline draft': 'ฉบับร่างออฟไลน์' };
  const activeLeg = selectedLegId === 'portfolio' ? null : workspace.legs.find((leg) => leg.id === selectedLegId) ?? null;
  const analysisSelection = activeLeg ? selectedLegId : 'portfolio';
  const scopedLegs = activeLeg ? [activeLeg] : workspace.legs;
  const earliestExpiration = scopedLegs.map((leg) => leg.expiration).sort()[0] ?? workspace.valuationDate;
  const minimumTargetDate = addCalendarDays(workspace.valuationDate, 1);
  const dte = Math.max(0, calendarDaysBetween(workspace.scenarios[0].valuationDate, earliestExpiration));
  const monteCarloDte = Math.max(1, calendarDaysBetween(workspace.valuationDate, earliestExpiration));
  const scenario = workspace.scenarios[0];
  const currentIv = activeLeg?.impliedVolatility ?? scopedLegs[0]?.impliedVolatility ?? 0;
  const dateIssue = targetDateError(scenario.valuationDate, workspace.valuationDate, earliestExpiration);
  const sensitivity = useMemo(() => aggregateSensitivity(analysisWorkspaceValue), [analysisWorkspaceValue]);
  const priceImpactApprox = workspace.underlyingPrice === null ? null : sensitivity.delta * (scenario.targetPrice - workspace.underlyingPrice);
  const timeImpactApprox = sensitivity.theta * Math.max(0, calendarDaysBetween(workspace.valuationDate, scenario.valuationDate));
  const progressPercent = workspace.monteCarlo.paths > 0 ? Math.min(100, progress / workspace.monteCarlo.paths * 100) : 0;
  const calculateLabel = tab === 'Monte Carlo Simulation' ? 'Start Simulation' : 'คำนวณ What-If';
  const calculateDisabledReason = running ? 'กำลังคำนวณอยู่ กรุณารอให้เสร็จหรือกดยกเลิกก่อน' : null;
  const isSaving = saveStatus === 'Saving';
  const fieldError = (path: string) => {
    const issue = validationErrors.find((message) => validationMessageParts(message).path === path);
    return issue ? validationMessageParts(issue).reason : undefined;
  };
  const tabDisplay = tab === 'What-If Analysis' ? 'What-If' : tab === 'Monte Carlo Simulation' ? 'Monte Carlo' : tabLabels[tab];

  return <div><Header title="Options Portfolio Simulator" subtitle="จำลองและวิเคราะห์เท่านั้น ไม่มีการส่งคำสั่งซื้อขายจริง" />
    <main className="mx-auto max-w-7xl space-y-5 p-4 pb-[calc(9rem+env(safe-area-inset-bottom))] md:p-8">
      <div className="flex flex-wrap justify-between gap-2"><Button variant="ghost" onClick={() => router.push('/tools')}><ArrowLeft size={16} className="mr-2" />Tools</Button><div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto"><span role="status" aria-live="polite" aria-atomic="true" className="inline-flex min-h-10 items-center gap-1.5 text-xs text-slate-400">{saveStatus === 'Saving' && <LoaderCircle aria-hidden="true" size={14} className="animate-spin motion-reduce:animate-none" />}{saveStatus === 'Saved' && <Check aria-hidden="true" size={14} className="text-emerald-400" />}{displayedSaveStatus[saveStatus] ?? saveStatus}</span><Button variant="outline" disabled={isSaving} onClick={() => void save(true)}>{isSaving && savingMode === 'copy' ? <LoaderCircle aria-hidden="true" size={15} className="mr-2 animate-spin motion-reduce:animate-none" /> : <Copy aria-hidden="true" size={15} className="mr-2" />}บันทึกเป็นสำเนา</Button><Button disabled={isSaving} onClick={() => void save(saveStatus === 'Failed' && lastSaveMode.current === 'copy')}>{isSaving && savingMode === 'save' ? <LoaderCircle aria-hidden="true" size={15} className="mr-2 animate-spin motion-reduce:animate-none" /> : saveStatus === 'Saved' ? <Check aria-hidden="true" size={15} className="mr-2" /> : <Save aria-hidden="true" size={15} className="mr-2" />}{saveStatus === 'Failed' ? 'ลองบันทึกอีกครั้ง' : 'บันทึก'}</Button></div></div>
      <section className={box}><h2 className="mb-3 text-lg font-bold">1. เลือกหุ้นหรือ ETF</h2><div className="relative max-w-xl"><Search size={16} className="absolute left-3 top-3 text-slate-500" /><Input className="pl-9" value={query} data-validation-path="symbol" onChange={(event) => { setQuery(event.target.value); if (!event.target.value.trim()) setMatches([]); }} placeholder="ค้นหา Symbol หรือชื่อบริษัท" />{matches.length > 0 && <div className="absolute z-20 mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 shadow-2xl">{matches.map((asset) => <button key={asset.symbol} onClick={() => choose(asset)} className="flex w-full justify-between p-3 text-left hover:bg-slate-800"><span><strong>{asset.symbol}</strong> <span className="text-sm text-slate-400">{asset.name}</span></span><small>{asset.exchange} · {asset.assetType}</small></button>)}</div>}</div>
        {workspace.symbol ? <div className="mt-4 flex flex-wrap gap-4 rounded-xl bg-slate-900 p-3 text-sm"><strong>{workspace.symbol} · {workspace.companyName}</strong><span>{workspace.exchange ?? 'ไม่มีข้อมูลตลาด'}</span><span>{workspace.currency}</span><span>{workspace.underlyingPrice ?? 'ไม่มีข้อมูลราคา'}</span><span className="uppercase">{workspace.dataStatus}</span><span className="text-slate-500">{workspace.dataTimestamp ? new Date(workspace.dataTimestamp).toLocaleString() : 'ไม่มีเวลาข้อมูล'}</span></div> : <p className="mt-3 text-sm text-amber-300">เลือกหุ้นจากระบบ ข้อมูลราคาหรือสัญญาจะไม่ถูกสร้างขึ้นเอง</p>}
        {workspace.symbol && <div className="mt-3 max-w-xs"><Numeric title="Underlying Price" placeholder="เช่น 130" helper="กรอกเองเมื่อไม่มีราคาจากผู้ให้บริการ" value={workspace.underlyingPrice ?? 0} min={0.0000001} validationPath="underlyingPrice" onChange={(value) => { if (hasResults.current) setInputsOutdated(true); change({ underlyingPrice: value || null, dataStatus: 'manual' }); }} /></div>}
      </section>
      <Tabs tabs={Object.values(tabLabels)} activeTab={tabDisplay} onChange={(next) => {
        const key = Object.keys(tabLabels).find((item) => tabLabels[item] === next) ?? next;
        setTab(key === 'What-If' ? 'What-If Analysis' : key === 'Monte Carlo' ? 'Monte Carlo Simulation' : key);
      }} />
      {(tab === 'What-If Analysis' || tab === 'Monte Carlo Simulation') && <>
        <ContractSummary workspace={workspace} selectedLegId={analysisSelection} onSelect={selectAnalysisContract} onEdit={() => setTab('Inputs')} />
      </>}
      {tab === 'What-If Analysis' && <section className={box} data-testid="what-if-controls">
        <h1 className="text-xl font-bold">What-If Analysis</h1>
        <p className="mb-5 text-sm text-slate-400">ทดลองเปลี่ยนราคา เวลา และ IV เพื่อดูผลกระทบต่อมูลค่าสัญญาและ P&amp;L</p>
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-700 p-4"><Numeric title="Target Stock Price" placeholder="เช่น 130" helper="ราคาหุ้นที่ต้องการทดลองว่าจะขึ้นหรือลงไปถึงระดับใด" min={0.0000001} externalError={fieldError('scenarios.0.targetPrice')} validationPath="scenarios.0.targetPrice" value={scenario.targetPrice} onChange={(value) => scenarioChange(0, { targetPrice: value })} />
            <input aria-label="Target price change percent" className="mt-3 w-full accent-[#D4FF00]" type="range" min="-50" max="100" value={workspace.underlyingPrice ? Math.round((scenario.targetPrice / workspace.underlyingPrice - 1) * 100) : 0} onChange={(event) => scenarioChange(0, { targetPrice: (workspace.underlyingPrice ?? 0) * (1 + Number(event.target.value) / 100) })} />
            <p className="mt-1 text-xs text-slate-400">Current Stock Price {workspace.underlyingPrice?.toFixed(2) ?? 'N/A'} · Change {workspace.underlyingPrice ? `${((scenario.targetPrice / workspace.underlyingPrice - 1) * 100).toFixed(1)}%` : 'N/A'}</p></div>
          <div className="rounded-xl border border-slate-700 p-4"><FieldLabel title="Target Date" helper="เลือกวันในอนาคต แต่ต้องไม่เกินวันหมดอายุ" /><div className="relative"><Input className="cursor-pointer pr-9" type="date" aria-label="Target Date" min={minimumTargetDate} max={earliestExpiration} placeholder="เลือกวันที่จากปฏิทิน" value={scenario.valuationDate} data-validation-path="scenarios.0.valuationDate" onChange={(event) => scenarioChange(0, { valuationDate: clampTargetDate(event.target.value, workspace.valuationDate, earliestExpiration) })} /><CalendarDays aria-hidden="true" size={16} className="pointer-events-none absolute right-3 top-3 text-slate-500" /></div>
            <p className="mt-2 text-xs text-slate-400">Expiration {earliestExpiration} · DTE ที่เหลือ {dte} วัน</p>{dateIssue && <p role="alert" className="mt-1 text-xs text-red-300">{dateIssue}</p>}</div>
          <div className="rounded-xl border border-slate-700 p-4"><PercentInput title="IV (%)" placeholder="เช่น 114.50" helper="กรอกเป็นเปอร์เซ็นต์ เช่น 114.50 = 114.50%" value={currentIv * (1 + scenario.volatilityShift) * 100} onChange={(value) => scenarioChange(0, { volatilityShift: currentIv > 0 ? Math.max(-0.99, value / (currentIv * 100) - 1) : 0 })} />
            <input aria-label="IV shock percent" className="mt-3 w-full accent-[#D4FF00]" type="range" min="-90" max="200" value={Math.round(scenario.volatilityShift * 100)} onChange={(event) => scenarioChange(0, { volatilityShift: Number(event.target.value) / 100 })} />
            <p className="mt-1 text-xs text-slate-400">Current IV {(currentIv * 100).toFixed(1)}% · IV Shock {scenario.volatilityShift >= 0 ? '+' : ''}{(scenario.volatilityShift * 100).toFixed(1)}%</p></div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="sensitivity-summary"><Metric title="Delta (ทั้งสถานะ)" value={`${formatResultMoney(sensitivity.delta, 'USD', null, true)} ต่อราคาหุ้นเปลี่ยน $1 USD`} helper="รวมตาม Buy/Sell, Quantity และ Multiplier ของสัญญาที่เลือก เป็น sensitivity ของทั้งสถานะ" /><Metric title="Theta/day (ทั้งสถานะ)" value={`${formatResultMoney(sensitivity.theta, 'USD', null, true)}/วัน`} helper="รวม Time Decay โดยประมาณของทั้งสถานะต่อหนึ่งวัน" /><Metric title="Price Impact (ประมาณ)" value={priceImpactApprox === null ? 'ไม่มีข้อมูล' : formatResultMoney(priceImpactApprox, 'USD', null, true)} helper="คำนวณเร็วจาก Delta; Estimated Premium ยังใช้ pricing engine" /><Metric title="Time Impact (ประมาณ)" value={formatResultMoney(timeImpactApprox, 'USD', null, true)} helper="คำนวณเร็วจาก Theta/day; ไม่แทน pricing engine" /></div>
        <div className="mt-5 hidden justify-end md:flex" data-testid="desktop-calculate-action"><div><Button disabled={running} aria-describedby={calculateDisabledReason ? 'desktop-calculate-disabled-reason' : undefined} onClick={analyze}>{calculateLabel}</Button>{calculateDisabledReason && <p id="desktop-calculate-disabled-reason" className="mt-1 text-xs text-amber-300">{calculateDisabledReason}</p>}</div></div>
      </section>}
      {tab === 'Monte Carlo Simulation' && <section className={box} data-testid="monte-carlo-controls">
        <h1 className="text-xl font-bold">Monte Carlo Simulation</h1><p className="mb-5 text-sm text-slate-400">จำลองเส้นทางราคาหุ้นจำนวนมาก เพื่อประเมินความน่าจะเป็นของผลลัพธ์ออปชัน</p>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"><div><Numeric title="Target Stock Price" placeholder="เช่น 130" helper="ราคาที่ต้องการตรวจสอบว่ามีโอกาสไปถึงมากน้อยเพียงใด" min={0.0000001} externalError={fieldError('scenarios.0.targetPrice')} validationPath="scenarios.0.targetPrice" value={scenario.targetPrice} onChange={(value) => scenarioChange(0, { targetPrice: value })} /><p className="mt-1 text-xs text-slate-400">ต่างจาก Current Price {workspace.underlyingPrice ? `${((scenario.targetPrice / workspace.underlyingPrice - 1) * 100).toFixed(2)}%` : 'N/A'}</p></div>
          <div><FieldLabel title="Target Date" helper="วันที่ต้องการตรวจสอบโอกาสที่ราคาจะไปถึงเป้าหมาย" /><div className="relative"><Input className="cursor-pointer pr-9" type="date" aria-label="Monte Carlo Target Date" min={minimumTargetDate} max={earliestExpiration} value={scenario.valuationDate} data-validation-path="scenarios.0.valuationDate" onChange={(event) => scenarioChange(0, { valuationDate: clampTargetDate(event.target.value, workspace.valuationDate, earliestExpiration) })} /><CalendarDays aria-hidden="true" size={16} className="pointer-events-none absolute right-3 top-3 text-slate-500" /></div><p className="mt-2 text-xs text-slate-400">เหลือ {Math.max(0, calendarDaysBetween(workspace.valuationDate, scenario.valuationDate))} วัน · ไม่เกิน {earliestExpiration}</p>{dateIssue && <p role="alert" className="mt-1 text-xs text-red-300">{dateIssue}</p>}{analysisSelection === 'portfolio' && new Set(scopedLegs.map((leg) => leg.expiration)).size > 1 && <p className="mt-1 text-xs text-amber-300">ทั้งพอร์ตใช้วันหมดอายุที่เร็วที่สุดเป็นขอบเขต</p>}</div>
          <PercentInput title="IV (%)" placeholder="เช่น 114.50" helper="กรอกเป็นเปอร์เซ็นต์ เช่น 114.50 = 114.50%" value={engineVolatilityToPercent(workspace.monteCarlo.volatility)} onChange={(value) => monteCarloChange({ volatility: percentVolatilityToEngine(value) })} />
          <div><FieldLabel title="Pricing / Forecast Mode" helper="Forecast ใช้ drift ที่เปิดเผย; Risk-neutral ใช้ rate สำหรับความสอดคล้องด้าน pricing และไม่ใช่โอกาสจริง" /><select aria-label="Pricing or forecast mode" className={select} value={workspace.monteCarlo.driftMode ?? 'forecast'} onChange={(event) => monteCarloChange({ driftMode: event.target.value as 'forecast' | 'risk-neutral' })}><option value="forecast">Forecast probability</option><option value="risk-neutral">Risk-neutral probability</option></select></div>
          <div><FieldLabel title="Paths" helper="จำนวนรอบจำลอง ยิ่งมากผลยิ่งนิ่ง แต่ใช้เวลาคำนวณนานขึ้น" /><select aria-label="Paths" className={select} value={workspace.monteCarlo.paths} data-validation-path="monteCarlo.paths" onChange={(event) => monteCarloChange({ paths: Number(event.target.value) })}>{BASIC_PATH_OPTIONS.map((value) => <option key={value} value={value}>{value.toLocaleString()}</option>)}</select>{fieldError('monteCarlo.paths') && <p role="alert" className="mt-1 text-xs text-red-300">{fieldError('monteCarlo.paths')}</p>}</div>
          <Metric title="Delta (ทั้งสถานะ)" value={`${formatResultMoney(sensitivity.delta, 'USD', null, true)} ต่อราคาหุ้นเปลี่ยน $1 USD`} helper="ใช้แสดง sensitivity ของทั้งสถานะเท่านั้น ไม่ใช้สร้าง GBM paths" /><Metric title="Theta/day (ทั้งสถานะ)" value={`${formatResultMoney(sensitivity.theta, 'USD', null, true)}/วัน`} helper="ค่าประมาณ Time Decay ของทั้งสถานะต่อหนึ่งวัน" /><Metric title="Days to Expiration" value={`${monteCarloDte} วัน`} helper="ดึงจาก Expiration ใน Inputs" /><Metric title="Premium Paid" value={formatResultMoney(scopedLegs.reduce((sum, leg) => sum + leg.entryPremium * leg.quantity * leg.multiplier + leg.fees, 0), 'USD', null)} helper="ดึงจาก Inputs" /></div>
        <p className="mt-4 text-xs text-slate-500">ระบบใช้ Random Seed, drift, rates, time steps และ policy เดิมภายในโดยไม่เปิดเป็นช่องกรอก</p>
        {running && <div className="mt-5"><div className="mb-1 flex justify-between text-xs text-slate-400"><span>{progress.toLocaleString()} / {workspace.monteCarlo.paths.toLocaleString()}</span><span>{progressPercent.toFixed(0)}%</span></div><div className="h-2 rounded bg-slate-800"><div className="h-2 rounded bg-[#D4FF00]" style={{ width: `${progressPercent}%` }} /></div><Button className="mt-3 min-h-11" variant="danger" onClick={cancelWorker}>Cancel</Button></div>}
        <div className="mt-5 hidden justify-end md:flex" data-testid="desktop-simulation-action"><div><Button disabled={running} aria-describedby={calculateDisabledReason ? 'desktop-simulation-disabled-reason' : undefined} onClick={analyze}>{calculateLabel}</Button>{calculateDisabledReason && <p id="desktop-simulation-disabled-reason" className="mt-1 text-xs text-amber-300">{calculateDisabledReason}</p>}</div></div>
      </section>}
      {resultsOutdated && (valuation || mc) && <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">{inputsOutdated ? 'ข้อมูลสัญญามีการเปลี่ยนแปลง กรุณาคำนวณใหม่' : 'ข้อมูลมีการเปลี่ยนแปลง กรุณาคำนวณใหม่'}</p>}
      {tab === 'What-If Analysis' && valuation && <WhatIfHighlights workspace={analysisWorkspace()} valuation={valuation} sensitivity={sensitivity} currency={resultCurrency} fxQuote={fxQuote} fxState={fxState} onCurrencyChange={setResultCurrency} />}
      {tab === 'Monte Carlo Simulation' && mc && <MonteCarloHighlights workspace={analysisWorkspace()} result={mc} scenarioScore={callPutScore} currency={resultCurrency} fxQuote={fxQuote} fxState={fxState} onCurrencyChange={setResultCurrency} />}
      {tab === 'Inputs' && <section className={box} data-testid="option-legs-form"><div className="grid gap-3 md:grid-cols-3"><Field title="ชื่อแบบจำลอง" placeholder="เช่น Earnings Call" helper="ชื่อสำหรับค้นหาแบบจำลองภายหลัง" value={workspace.name} onChange={(value) => change({ name: value })} /><Field title="Strategy" placeholder="เช่น Long Call" helper="ชื่อกลยุทธ์ที่ตรวจจับจาก Option Legs" value={workspace.strategyType} onChange={(value) => change({ strategyType: value })} /><div><FieldLabel title="Valuation Date" helper="วันที่ฐานสำหรับการคำนวณ" /><Input type="date" aria-label="Valuation Date" value={workspace.valuationDate} onChange={(event) => { if (hasResults.current) setInputsOutdated(true); change({ valuationDate: event.target.value, scenarios: workspace.scenarios.map((item, index) => index === 0 ? { ...item, valuationDate: clampTargetDate(item.valuationDate, event.target.value, workspace.legs.map((leg) => leg.expiration).sort()[0] ?? item.valuationDate) } : item) }); }} /></div></div>
        <div className="my-4"><h2 className="text-lg font-bold">2. Option Legs</h2><p className="text-xs text-slate-400">สร้างและแก้ไขข้อมูลสัญญาที่นี่เพียงจุดเดียว</p></div>
        <div className="space-y-4">{workspace.legs.map((leg, index) => { const resolved = legSensitivity(workspace, leg); return <article key={leg.id} className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/20 p-4"><div className="mb-4 flex items-start justify-between gap-3"><div className="flex flex-wrap items-center gap-2"><strong>Leg {index + 1}</strong><span className="rounded-full bg-violet-500/10 px-2 py-1 text-[10px] font-semibold text-violet-300">{leg.kind === 'call' ? 'Call' : 'Put'}</span><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${leg.side === 'buy' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>{leg.side === 'buy' ? 'Buy' : 'Sell'}</span>{leg.inputMode && <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${leg.inputMode === 'provider' ? 'bg-sky-500/10 text-sky-300' : 'bg-amber-500/10 text-amber-300'}`}>{leg.inputMode === 'provider' ? 'ข้อมูลจริง' : 'กำหนดเอง'}</span>}</div><div className="flex shrink-0 gap-1"><Button className="min-h-11 px-3" variant="ghost" aria-label={`ทำสำเนา Leg ${index + 1}`} onClick={() => change({ legs: [...workspace.legs.slice(0, index + 1), { ...leg, id: uid(), inputMode: 'custom' }, ...workspace.legs.slice(index + 1)] })}><Copy size={15} /><span className="sr-only sm:not-sr-only sm:ml-2">Duplicate</span></Button><Button className="min-h-11 min-w-11" variant="danger" aria-label={`ลบ Leg ${index + 1}`} disabled={workspace.legs.length === 1} onClick={() => change({ legs: workspace.legs.filter((_, i) => i !== index) })}><Trash2 size={15} /></Button></div></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"><Choice title="Option Type" value={leg.kind} options={['call', 'put']} optionLabels={{ call: 'Call', put: 'Put' }} validationPath={`legs.${index}.kind`} onChange={(value) => legChange(index, { kind: value as OptionLeg['kind'] })} /><Choice title="Side" value={leg.side} options={['buy', 'sell']} optionLabels={{ buy: 'Buy', sell: 'Sell' }} validationPath={`legs.${index}.side`} onChange={(value) => legChange(index, { side: value as OptionLeg['side'] })} /><Numeric title="Quantity" placeholder="เช่น 1" min={1} integer helper="จำนวนสัญญาที่ต้องการวิเคราะห์" externalError={fieldError(`legs.${index}.quantity`)} validationPath={`legs.${index}.quantity`} value={leg.quantity} onChange={(value) => legChange(index, { quantity: value })} /><Numeric title="Strike Price" placeholder="เช่น 120" min={0.0000001} helper="ราคาใช้สิทธิตามสัญญา" externalError={fieldError(`legs.${index}.strike`)} validationPath={`legs.${index}.strike`} value={leg.strike} onChange={(value) => legChange(index, { strike: value })} /></div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"><div><FieldLabel title="Expiration" helper="วันหมดอายุของสัญญา" /><Input type="date" aria-label={`Leg ${index + 1} Expiration`} min={addCalendarDays(workspace.valuationDate, 1)} value={leg.expiration} data-validation-path={`legs.${index}.expiration`} onChange={(event) => legChange(index, { expiration: event.target.value })} />{fieldError(`legs.${index}.expiration`) && <p role="alert" className="mt-1 text-xs text-red-300">{fieldError(`legs.${index}.expiration`)}</p>}</div><PremiumInput value={leg.entryPremium} helper="ต้นทุนต่อหุ้น เช่น $1.40" externalError={fieldError(`legs.${index}.entryPremium`)} validationPath={`legs.${index}.entryPremium`} onChange={(value) => legChange(index, { entryPremium: value })} /><PercentInput title="IV (%)" value={engineVolatilityToPercent(leg.impliedVolatility)} placeholder="เช่น 114.50" helper="กรอกเป็นเปอร์เซ็นต์ เช่น 114.50 = 114.50%" externalError={fieldError(`legs.${index}.impliedVolatility`)} validationPath={`legs.${index}.impliedVolatility`} onChange={(value) => legChange(index, { impliedVolatility: percentVolatilityToEngine(value) })} /><Numeric title="Contract Multiplier" placeholder="เช่น 100" min={0.0000001} helper="หุ้นสหรัฐฯ ส่วนใหญ่ 1 สัญญา = 100 หุ้น" externalError={fieldError(`legs.${index}.multiplier`)} validationPath={`legs.${index}.multiplier`} value={leg.multiplier} onChange={(value) => legChange(index, { multiplier: value })} /></div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-[50%]"><GreekInput title="Delta" placeholder="เช่น 0.35" helper="Premium เปลี่ยนโดยประมาณเมื่อหุ้นขยับ $1" value={leg.delta ?? null} fallbackValue={resolved.delta} source={leg.deltaSource ?? (leg.delta == null ? 'model' : 'manual')} timestamp={leg.deltaTimestamp} min={-1} max={1} externalError={fieldError(`legs.${index}.delta`)} validationPath={`legs.${index}.delta`} onChange={(value) => legChange(index, { delta: value, deltaSource: value === null ? 'model' : 'manual', deltaTimestamp: null })} /><GreekInput title="Theta/day" placeholder="เช่น -0.04" helper="มูลค่าที่ลดลงโดยประมาณต่อวันจาก Time Decay" value={leg.theta ?? null} fallbackValue={resolved.theta} source={leg.thetaSource ?? (leg.theta == null ? 'model' : 'manual')} timestamp={leg.thetaTimestamp} externalError={fieldError(`legs.${index}.theta`)} validationPath={`legs.${index}.theta`} onChange={(value) => legChange(index, { theta: value, thetaSource: value === null ? 'model' : 'manual', thetaTimestamp: null })} /></div>
          {leg.contractSymbol && <div className={`mt-3 rounded-lg p-2 text-xs ${leg.contractStatus === 'stale' ? 'bg-amber-500/10 text-amber-200' : 'bg-sky-500/5 text-slate-400'}`}><p>{leg.contractSymbol} · {leg.contractProvider ?? 'provider unavailable'} · {leg.contractAsOf ? new Date(leg.contractAsOf).toLocaleString() : 'asOf unavailable'} · {leg.contractStatus ?? 'status unavailable'}</p><p className="mt-1 font-mono">Market Last {optionQuoteValue(leg.last)} · Bid {optionQuoteValue(leg.bid)} · Ask {optionQuoteValue(leg.ask)} · Mid {optionQuoteValue(leg.midpoint)}</p><p className="mt-1">Entry basis: {leg.premiumSource === 'ask' ? 'live Ask (buy)' : leg.premiumSource === 'bid' ? 'live Bid (sell)' : 'manual / unavailable'}{leg.premiumSource === 'manual' ? ' · Last is reference only and was not used as an executable fill.' : ''}</p>{leg.contractStatus === 'stale' && <p className="mt-1">ระบบจะแจ้งเตือนอีกครั้งก่อนคำนวณ</p>}</div>}
        </article>; })}</div><Button className="mt-4 min-h-11 w-full border-dashed" variant="outline" onClick={() => change({ legs: [...workspace.legs, newLeg()] })}><Plus size={16} className="mr-2" />เพิ่ม Option Leg</Button></section>}
      {validationErrors.length > 0 && <section role="alert" data-testid="validation-warning" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4"><strong>กรุณาตรวจสอบข้อมูลก่อนคำนวณ:</strong><ul className="list-disc pl-5 text-sm">{[...new Set(validationErrors.map(displayValidationMessage))].map((error) => <li key={error}>{error}</li>)}</ul></section>}
      {operationError && <section role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm">{operationError}</section>}
      {tab === 'Payoff' && valuation && <Payoff valuation={valuation} spot={workspace.underlyingPrice} currency={resultCurrency} usdThbRate={fxQuote ? Number(fxQuote.rate) : null} />}
      {tab === 'Greeks' && valuation && <section className={box}><div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Object.entries(valuation.greeks).map(([key, value]) => <Metric key={key} title={key === 'delta' ? 'Delta (ทั้งสถานะ)' : key[0].toUpperCase() + key.slice(1)} value={key === 'delta' ? `${formatResultMoney(value, 'USD', null, true)} ต่อราคาหุ้นเปลี่ยน $1 USD` : formatResultNumber(value, 4)} helper={greekHelpers[key]} />)}</div></section>}
      <section className={box}><div className="mb-3 flex flex-wrap justify-between gap-2"><h2 className="text-lg font-bold">แบบจำลองของฉัน</h2><div className="flex gap-2"><Input className="w-56" value={savedQuery} onChange={(event) => setSavedQuery(event.target.value)} placeholder="ค้นหาชื่อ Symbol หรือ Strategy" /><Button size="sm" variant="outline" onClick={() => { if (saveStatus === 'Saved' || confirm('Discard unsaved inputs?')) setWorkspace(fresh(initialType)); }}><Plus size={14} /> สร้างใหม่</Button><Button size="sm" variant="danger" onClick={() => { if (confirm('Reset the entire current simulation?')) { setWorkspace(fresh(initialType)); setSaveStatus('Unsaved'); } }}>ล้างข้อมูล</Button></div></div>{savedState === 'loading' ? <div className="h-20 animate-pulse rounded bg-slate-800" /> : savedState === 'error' ? <Button onClick={() => void loadSaved()}>ลองใหม่</Button> : saved.length === 0 ? <p className="text-sm text-slate-400">ยังไม่มีแบบจำลองบนเซิร์ฟเวอร์ เข้าสู่ระบบเพื่อบันทึก โดยระบบจะเก็บฉบับร่างไว้ในเครื่อง</p> : <div className="grid gap-3 md:grid-cols-2">{saved.filter((item) => `${item.name} ${item.symbol} ${item.strategyType} ${item.simulationType}`.toLowerCase().includes(savedQuery.toLowerCase())).map((item) => <article key={item.id} className="rounded-xl border border-slate-700 p-3"><strong>{item.name}</strong><p className="text-xs text-slate-400">{item.symbol} · {item.strategyType} · {item.simulationType} · {new Date(item.updatedAt).toLocaleString()} · {item.dataStatus}</p><div className="mt-2 flex gap-2"><Button size="sm" onClick={() => { if (saveStatus === 'Saved' || confirm('Discard unsaved inputs?')) { setWorkspace(normalizeUiWorkspace(item)); setValuation(item.resultSnapshot?.whatIf ?? null); setMc(item.resultSnapshot?.monteCarlo ?? null); setCallPutScore(null); setSaveStatus('Saved'); } }}>เปิด</Button><Button size="sm" variant="outline" onClick={() => { setWorkspace(normalizeUiWorkspace({ ...item, id: undefined, updatedAt: undefined, name: `${item.name} (copy)`, legs: item.legs.map((leg) => ({ ...leg, id: uid() })), scenarios: item.scenarios.map((scenario) => ({ ...scenario, id: uid() })) })); setSaveStatus('Unsaved'); }}>ทำสำเนา</Button><Button size="sm" variant="danger" onClick={() => void remove(item)}>ลบ</Button></div></article>)}</div>}</section>
      <p className="rounded-xl border border-slate-800 p-4 text-xs text-slate-500"><strong>Methodology:</strong> Black‑Scholes with continuous dividend yield prices European options. A 200-step binomial tree prices American options; its Greeks use finite differences. GBM assumes constant disclosed drift/volatility and log-normal returns. Liquidity and spreads affect confidence but the pricing model still excludes assignment, taxes and volatility smile. Results are analysis, not advice or a guarantee.</p>
    </main>{(tab === 'What-If Analysis' || tab === 'Monte Carlo Simulation') && <div data-testid="mobile-calculate-action" className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-slate-800 bg-slate-950/95 p-3 backdrop-blur md:hidden"><Button className="min-h-11 w-full" disabled={running} aria-describedby={calculateDisabledReason ? 'mobile-calculate-disabled-reason' : undefined} onClick={analyze}>{calculateLabel}</Button>{calculateDisabledReason && <p id="mobile-calculate-disabled-reason" className="mt-1 text-center text-xs text-amber-300">{calculateDisabledReason}</p>}</div>}
    <Modal isOpen={Boolean(pending)} onClose={() => setPending(null)} title="Change underlying?"><p className="mb-3 text-sm">Strike, expiry, premium and IV will be reset; they are never carried to a new symbol.</p><div className="space-y-2"><Button className="w-full" onClick={() => pending && void setSymbol(pending)}>Start new</Button><Button className="w-full" variant="outline" onClick={() => pending && void setSymbol(pending, true)}>Duplicate settings and reset contracts</Button><Button className="w-full" variant="ghost" onClick={() => setPending(null)}>Cancel</Button></div></Modal>
  </div>;
}

const greekHelpers: Record<string, string> = {
  delta: 'ราคาสัญญาเปลี่ยนเมื่อหุ้นขยับ $1',
  gamma: 'การเปลี่ยนแปลงของ Delta',
  theta: 'มูลค่าที่ลดลงจากเวลาโดยประมาณต่อวัน',
  vega: 'ผลกระทบจาก IV เปลี่ยน 1%',
  rho: 'ผลกระทบจากอัตราดอกเบี้ยเปลี่ยน 1%',
};

function Helper({ children, id }: { children?: string; id?: string }) { return children ? <p id={id} className="mt-1 text-[10px] leading-tight text-slate-500">{children}</p> : null; }
function FieldLabel({ title, tooltip, helper, htmlFor }: { title: string; tooltip?: string; helper?: string; htmlFor?: string }) { return <><label htmlFor={htmlFor} className={label}><span className="inline-flex items-center gap-1">{title}{tooltip && <span title={tooltip} aria-label={`${title}: ${tooltip}`} tabIndex={0}><HelpCircle size={12} className="cursor-help" /></span>}</span></label>{helper && <Helper id={htmlFor ? `${htmlFor}-helper` : undefined}>{helper}</Helper>}</>; }
type NumericProps = { title: string; value: number; step?: string; helper?: string; tooltip?: string; suffix?: string; placeholder?: string; min?: number; max?: number; validationPath?: string; onChange: (value: number) => void };
type ValidatedNumericProps = NumericProps & { integer?: boolean; externalError?: string };
function Numeric({ title, value, step = 'any', helper, tooltip, suffix, placeholder, min, max, integer = false, externalError, validationPath, onChange }: ValidatedNumericProps) {
  const id = useId();
  const focused = useRef(false);
  const [draft, setDraft] = useState(() => Number.isFinite(value) ? String(value) : '');
  const [draftError, setDraftError] = useState<string | null>(null);
  useEffect(() => { if (!focused.current) setDraft(Number.isFinite(value) ? String(value) : ''); }, [value]);
  const commit = () => {
    focused.current = false;
    const parsed = parseFiniteDraft(draft);
    if (parsed === null || (integer && !Number.isInteger(parsed)) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
      setDraftError(`${title} มีค่าไม่ถูกต้อง`);
      setDraft(Number.isFinite(value) ? String(value) : '');
      return;
    }
    setDraftError(null); onChange(parsed); setDraft(String(parsed));
  };
  const error = draftError ?? externalError;
  return <div><FieldLabel htmlFor={id} title={title} tooltip={tooltip} helper={helper} /><div className="relative"><Input id={id} aria-describedby={helper ? `${id}-helper` : undefined} aria-invalid={Boolean(error)} className={suffix ? 'pr-10' : undefined} type="text" inputMode="decimal" placeholder={placeholder} value={draft} onFocus={(event) => { focused.current = true; if (value === 0) event.currentTarget.select(); }} onChange={(event) => { setDraft(event.target.value); setDraftError(null); }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} data-step={step} data-validation-path={validationPath} />{suffix && <span className="pointer-events-none absolute right-3 top-2.5 text-xs text-slate-500">{suffix}</span>}</div>{error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}</div>;
}

function PremiumInput({ value, helper, externalError, validationPath, onChange }: { value: number; helper: string; externalError?: string; validationPath?: string; onChange: (value: number) => void }) {
  const id = useId();
  const focused = useRef(false);
  const [digits, setDigits] = useState(() => premiumDigitsFromValue(value));
  const [draftError, setDraftError] = useState<string | null>(null);
  useEffect(() => { if (!focused.current) setDigits(premiumDigitsFromValue(value)); }, [value]);
  const commitDigits = (next: string) => {
    const normalized = next.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    setDigits(normalized);
    onChange(premiumFromDigitString(normalized) ?? 0);
  };
  const error = draftError ?? externalError;
  return <div><FieldLabel htmlFor={id} title="Premium" helper={helper} /><div className="relative"><span className="pointer-events-none absolute left-3 top-2.5 text-sm text-slate-400">$</span><Input id={id} className="pl-8" type="text" inputMode="decimal" placeholder="เช่น 1.40" value={formatPremiumDigits(digits)} aria-invalid={Boolean(error)} data-validation-path={validationPath} onFocus={() => { focused.current = true; }} onChange={(event) => { commitDigits(event.target.value); setDraftError(null); }} onPaste={(event) => { event.preventDefault(); const parsed = parsePremiumPaste(event.clipboardData.getData('text')); if (parsed === null) { setDraftError('Premium ต้องเป็นจำนวนเงินที่ไม่ติดลบ'); return; } setDraftError(null); commitDigits(premiumDigitsFromValue(parsed)); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x'].includes(event.key.toLowerCase())) return; if (/^\d$/.test(event.key)) { event.preventDefault(); commitDigits(`${digits}${event.key}`); } else if (event.key === 'Backspace') { event.preventDefault(); commitDigits(digits.slice(0, -1)); } else if (event.key === 'Delete') { event.preventDefault(); commitDigits(''); } else if (event.key === 'Enter') event.currentTarget.blur(); }} onBlur={() => { focused.current = false; if (digits && premiumFromDigitString(digits) === null) setDraftError('Premium ต้องเป็นจำนวนเงินที่ไม่ติดลบ'); }} /></div>{error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}</div>;
}

function PercentInput({ title, value, helper, placeholder, externalError, validationPath, onChange }: { title: string; value: number; helper: string; placeholder: string; externalError?: string; validationPath?: string; onChange: (value: number) => void }) {
  const id = useId();
  const focused = useRef(false);
  const [draft, setDraft] = useState(() => value > 0 && Number.isFinite(value) ? value.toFixed(2) : '');
  const [draftError, setDraftError] = useState<string | null>(null);
  useEffect(() => { if (!focused.current) setDraft(value > 0 && Number.isFinite(value) ? value.toFixed(2) : ''); }, [value]);
  const commit = () => {
    focused.current = false;
    const parsed = parsePercentDraft(draft);
    if (parsed === null || parsed <= 0) { setDraftError('IV ต้องมากกว่า 0'); return; }
    setDraftError(null); onChange(parsed); setDraft(parsed.toFixed(2));
  };
  const error = draftError ?? externalError;
  return <div><FieldLabel htmlFor={id} title={title} helper={helper} /><div className="relative"><Input id={id} className="pr-8" type="text" inputMode="decimal" placeholder={placeholder} value={draft} aria-invalid={Boolean(error)} data-validation-path={validationPath} onFocus={() => { focused.current = true; }} onChange={(event) => { const normalized = normalizePercentDraft(event.target.value); if (normalized === null) return; setDraft(normalized); setDraftError(null); const parsed = parsePercentDraft(normalized); onChange(parsed !== null && parsed > 0 ? parsed : 0); }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><span className="pointer-events-none absolute right-3 top-2.5 text-xs text-slate-500">%</span></div>{error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}</div>;
}

function GreekInput({ title, value, fallbackValue, source, timestamp, helper, placeholder, min, max, externalError, validationPath, onChange }: { title: string; value: number | null; fallbackValue: number | null; source: OptionLeg['deltaSource']; timestamp?: string | null; helper: string; placeholder: string; min?: number; max?: number; externalError?: string; validationPath?: string; onChange: (value: number | null) => void }) {
  const id = useId();
  const focused = useRef(false);
  const shownValue = value ?? fallbackValue;
  const [draft, setDraft] = useState(() => shownValue === null ? '' : String(shownValue));
  const [draftError, setDraftError] = useState<string | null>(null);
  useEffect(() => { if (!focused.current) setDraft(shownValue === null ? '' : String(shownValue)); }, [shownValue]);
  const commit = () => {
    focused.current = false;
    if (!draft.trim()) { setDraftError(null); onChange(null); setDraft(fallbackValue === null ? '' : String(fallbackValue)); return; }
    const parsed = parseFiniteDraft(draft);
    if (parsed === null || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)) { setDraftError(title === 'Delta' ? 'Delta ต้องอยู่ระหว่าง -1 ถึง 1' : 'Theta ต้องเป็นตัวเลขที่ถูกต้อง'); return; }
    setDraftError(null); onChange(parsed); setDraft(String(parsed));
  };
  const labelText = source === 'provider' ? 'Provider data' : source === 'manual' ? 'Manual' : 'Model Estimate';
  const error = draftError ?? externalError;
  return <div><div className="flex items-start justify-between gap-2"><FieldLabel htmlFor={id} title={title} helper={helper} />{source === 'manual' && <button type="button" className="text-[10px] text-[#D4FF00]" onClick={() => onChange(null)}>ใช้ค่าระบบ</button>}</div><Input id={id} type="text" inputMode="decimal" placeholder={placeholder} value={draft} aria-invalid={Boolean(error)} data-validation-path={validationPath} onFocus={(event) => { focused.current = true; event.currentTarget.select(); }} onChange={(event) => { setDraft(event.target.value); setDraftError(null); }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><p className={`mt-1 text-[10px] ${source === 'manual' ? 'text-amber-300' : source === 'provider' ? 'text-emerald-300' : 'text-slate-400'}`}>{labelText}{source === 'provider' && timestamp ? ` · ${new Date(timestamp).toLocaleString()}` : ''}</p>{error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}</div>;
}
function Field({ title, value, helper, placeholder, onChange }: { title: string; value: string; helper?: string; placeholder?: string; onChange: (value: string) => void }) { const id = useId(); return <div><FieldLabel htmlFor={id} title={title} helper={helper} /><Input id={id} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} /></div>; }
function Choice({ title, value, options, optionLabels = {}, helper, validationPath, onChange }: { title: string; value: string; options: string[]; optionLabels?: Record<string, string>; helper?: string; validationPath?: string; onChange: (value: string) => void }) { const id = useId(); return <div><FieldLabel htmlFor={id} title={title} helper={helper} /><select id={id} className={select} value={value} data-validation-path={validationPath} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{optionLabels[option] ?? option}</option>)}</select></div>; }
function Metric({ title, value, helper }: { title: string; value: string; helper?: string }) { return <div className="min-w-0 rounded-xl bg-slate-900 p-3"><small className="inline-flex items-center gap-1 text-slate-500">{title}{helper && <span title={helper} aria-label={`${title}: ${helper}`} tabIndex={0}><HelpCircle size={11} className="cursor-help" /></span>}</small><p className="break-words font-mono font-bold">{value}</p><Helper>{helper}</Helper></div>; }
function ContractSummary({ workspace, selectedLegId, onSelect, onEdit }: { workspace: SimulationWorkspace; selectedLegId: string; onSelect: (value: string) => void; onEdit: () => void }) {
  const date = workspace.valuationDate;
  const selectorId = useId();
  const summaryLegs = useMemo(() => workspace.legs
    .filter((leg) => selectedLegId === 'portfolio' || leg.id === selectedLegId)
    .map((leg) => ({
      leg,
      dte: Math.max(0, calendarDaysBetween(date, leg.expiration)),
      legNumber: workspace.legs.findIndex((item) => item.id === leg.id) + 1,
      resolved: legSensitivity(workspace, leg),
    })), [date, selectedLegId, workspace]);
  return <section className={box} data-testid="contract-summary"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold">เลือกสัญญาที่ต้องการวิเคราะห์</h2><p className="text-xs text-slate-400">เลือกทั้งพอร์ตหรือรายสัญญา ระบบจะ autofill จากแท็บ Inputs</p></div><Button size="sm" variant="outline" onClick={onEdit}>แก้ไขข้อมูลสัญญา</Button></div>
    <div className="mb-4 max-w-md"><FieldLabel htmlFor={selectorId} title="สัญญา" helper="เปลี่ยนสัญญาแล้วจะรีเซ็ตเฉพาะค่าจำลองที่ขึ้นกับสัญญา" /><select id={selectorId} aria-label="เลือกสัญญาที่ต้องการวิเคราะห์" className={select} value={selectedLegId} onChange={(event) => onSelect(event.target.value)}><option value="portfolio">ทั้งพอร์ต</option>{workspace.legs.map((leg, index) => <option key={leg.id} value={leg.id}>Leg {index + 1} · {leg.side === 'buy' ? 'Buy' : 'Sell'} {leg.kind === 'call' ? 'Call' : 'Put'} · Strike {leg.strike}</option>)}</select></div>
    <div className="space-y-3">{summaryLegs.map(({ leg, dte, legNumber, resolved }) => <article key={leg.id} className="grid grid-cols-2 gap-3 rounded-xl border border-slate-700 p-3 text-sm sm:grid-cols-3 lg:grid-cols-6"><span className="sr-only">Leg {legNumber}</span><SummaryValue label="Option Type" value={leg.kind === 'call' ? 'Call' : 'Put'} /><SummaryValue label="Side" value={leg.side === 'buy' ? 'Buy' : 'Sell'} /><SummaryValue label="Quantity" value={leg.quantity.toString()} /><SummaryValue label="Strike" value={leg.strike.toString()} /><SummaryValue label="Expiration" value={leg.expiration} /><SummaryValue label="Premium" value={`$${leg.entryPremium.toFixed(2)}`} /><SummaryValue label="IV" value={`${engineVolatilityToPercent(leg.impliedVolatility).toFixed(2)}%`} /><SummaryValue label="Delta ต่อหุ้น" value={resolved.delta === null ? 'ไม่มีข้อมูล' : `${formatResultMoney(resolved.delta, 'USD', null, true)}/หุ้น ต่อราคาหุ้นเปลี่ยน $1 USD · ${sourceLabel(resolved.deltaSource)}`} /><SummaryValue label="Theta/day ต่อหุ้น" value={resolved.theta === null ? 'ไม่มีข้อมูล' : `${formatResultMoney(resolved.theta, 'USD', null, true)}/หุ้น/วัน · ${sourceLabel(resolved.thetaSource)}`} /><SummaryValue label="Multiplier" value={leg.multiplier.toString()} /><SummaryValue label="Current DTE" value={`${dte} วัน`} />{(leg.deltaSource === 'provider' || leg.thetaSource === 'provider') && <SummaryValue label="Market data time" value={leg.deltaTimestamp ?? leg.thetaTimestamp ?? 'ไม่มีข้อมูล'} />}</article>)}</div></section>;
}
function sourceLabel(source: OptionLeg['deltaSource']) { return source === 'provider' ? 'Provider' : source === 'manual' ? 'Manual' : 'Model Estimate'; }
function SummaryValue({ label: title, value }: { label: string; value: string }) { return <div><small className="text-slate-500">{title}</small><p className="font-medium text-slate-100">{value}</p></div>; }
interface ResultDisplayProps {
  currency: ResultCurrency;
  fxQuote: FxQuote | null;
  fxState: 'loading' | 'ready' | 'unavailable';
  onCurrencyChange: (currency: ResultCurrency) => void;
}

function ResultCurrencyControl({ currency, fxQuote, fxState, onCurrencyChange }: ResultDisplayProps) {
  const thbAvailable = fxState === 'ready' && fxQuote !== null;
  const status = fxQuote?.stale ? 'stale' : fxQuote?.cached ? 'cached' : fxQuote ? 'live' : null;
  return <div className="rounded-xl border border-slate-700 bg-slate-950/40 p-3" data-testid="result-currency-control">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex rounded-lg border border-slate-700 p-1" role="group" aria-label="สกุลเงินผลลัพธ์">
        {(['USD', 'THB'] as const).map((item) => <button key={item} type="button" aria-pressed={currency === item} disabled={item === 'THB' && !thbAvailable} onClick={() => onCurrencyChange(item)} className={`min-h-10 rounded-md px-4 text-sm font-semibold ${currency === item ? 'bg-[#D4FF00] text-slate-950' : 'text-slate-300'} disabled:cursor-not-allowed disabled:opacity-40`}>{item}</button>)}
      </div>
      {fxQuote ? <div className="text-right text-xs text-slate-400"><p>1 USD = {Number(fxQuote.rate).toFixed(2)} THB <span className={`ml-1 rounded-full px-2 py-0.5 font-semibold uppercase ${fxQuote.stale ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`}>{status}</span></p><p>อัตรา ณ {new Date(fxQuote.asOf).toLocaleString('th-TH')} · {fxQuote.source}</p></div>
        : <p role="status" className="text-xs text-amber-300">{fxState === 'loading' ? 'กำลังโหลดอัตรา USD/THB — ยังเลือก THB ไม่ได้' : 'ไม่มีอัตรา USD/THB ที่ใช้งานได้ — ปิดการแสดงผล THB'}</p>}
    </div>
    <p className="mt-2 text-[11px] text-slate-500">ผลคำนวณ USD เป็น source of truth; การเลือก THB แปลงเฉพาะตอนแสดงผลและไม่รัน pricing หรือ Monte Carlo ใหม่</p>
  </div>;
}

function ProfitLossValue({ amount, denominator, currency, usdThbRate, prefix }: { amount: number; denominator: number | null; currency: ResultCurrency; usdThbRate: number | null; prefix?: string }) {
  const state = profitLossState(amount);
  const percentage = safeProfitLossPercent(amount, denominator);
  const label = profitLossStateLabel(state);
  const value = `${formatResultMoney(amount, currency, usdThbRate, true)} (${formatSignedPercent(percentage)})`;
  return <div className="min-w-0" role="status" aria-label={`${prefix ? `${prefix} ` : ''}${label} ${value}`}><p className={`break-words font-mono font-bold ${profitLossToneClass(state)}`}>{value}</p><p className={`text-xs ${profitLossToneClass(state)}`}>{percentage === null ? `${label} · ไม่มีฐานเงินสำหรับคำนวณเปอร์เซ็นต์` : `${label} · เทียบกับฐานเงินที่เสี่ยงเริ่มต้น`}</p></div>;
}

function ProfitLossMetric({ title, amount, denominator, currency, usdThbRate, helper }: { title: string; amount: number; denominator: number | null; currency: ResultCurrency; usdThbRate: number | null; helper?: string }) {
  return <div className="min-w-0 rounded-xl bg-slate-900 p-3"><small className="inline-flex items-center gap-1 text-slate-500">{title}{helper && <span title={helper} aria-label={`${title}: ${helper}`} tabIndex={0}><HelpCircle size={11} className="cursor-help" /></span>}</small><ProfitLossValue amount={amount} denominator={denominator} currency={currency} usdThbRate={usdThbRate} prefix={title} /><Helper>{helper}</Helper></div>;
}

function ExplainedProfitLossMetric({ title, amount, currency, usdThbRate, helper }: { title: string; amount: number; currency: ResultCurrency; usdThbRate: number | null; helper: string }) {
  const state = profitLossState(amount);
  return <div className="min-w-0 rounded-xl bg-slate-900 p-3">
    <small className="text-slate-400">{title}</small>
    <p className={`mt-1 break-words font-mono font-bold ${profitLossToneClass(state)}`}>{formatResultMoney(amount, currency, usdThbRate, true)}</p>
    <details className="mt-2 text-xs text-slate-400">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[#D4FF00]"><HelpCircle size={12} aria-hidden="true" />ดูคำอธิบาย</summary>
      <p className="mt-1 leading-relaxed">{helper}</p>
    </details>
  </div>;
}

function profitLossFormula(policy: ReturnType<typeof portfolioProfitLossBasis>['policy']): string {
  if (policy === 'absolute-net-debit') return 'P&L % = P&L ÷ absolute net debit × 100';
  if (policy === 'gross-premium-at-risk') return 'P&L % = P&L ÷ gross premium-at-risk ตาม portfolio credit policy เดิม × 100';
  return 'คำนวณ % ไม่ได้ เพราะ denominator เป็น 0 หรือไม่มีความหมาย';
}

function ExplainedResultMetric({ title, value, helper, toneClass = 'text-slate-100', secondary }: { title: string; value: string; helper: string; toneClass?: string; secondary?: string }) {
  return <div className="min-w-0 rounded-xl bg-slate-900 p-3">
    <small className="text-slate-400">{title}</small>
    <p className={`mt-1 break-words font-mono font-bold ${toneClass}`}>{value}</p>
    {secondary && <p className="mt-1 text-xs text-slate-400">{secondary}</p>}
    <details className="mt-2 text-xs text-slate-400">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[#D4FF00]"><HelpCircle size={12} aria-hidden="true" />ดูคำอธิบาย</summary>
      <p className="mt-1 leading-relaxed">{helper}</p>
    </details>
  </div>;
}

function ResultGroup({ title, testId, summary, children }: { title: string; testId: string; summary?: string; children: ReactNode }) {
  return <section className="mt-4 rounded-xl border border-slate-700 bg-slate-950/30 p-3" data-testid={testId}>
    <h3 className="font-semibold text-slate-100">{title}</h3>
    {summary && <p className="mt-1 text-xs text-slate-400">{summary}</p>}
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  </section>;
}

function WhatIfHighlights({ workspace, valuation, sensitivity, currency, fxQuote, fxState, onCurrencyChange }: { workspace: SimulationWorkspace; valuation: PortfolioValuation; sensitivity: { delta: number; theta: number } } & ResultDisplayProps) {
  const scenario = workspace.scenarios[0];
  const whatIfCalculation = useMemo(() => {
    const currentScenario = { ...scenario, targetPrice: workspace.underlyingPrice ?? scenario.targetPrice, valuationDate: workspace.valuationDate, volatilityShift: 0 };
    try {
      const current = valuePortfolio(workspace, currentScenario);
      const afterPrice = valuePortfolio(workspace, { ...currentScenario, targetPrice: scenario.targetPrice });
      const afterTime = valuePortfolio(workspace, { ...currentScenario, targetPrice: scenario.targetPrice, valuationDate: scenario.valuationDate });
      return {
        current,
        priceImpact: afterPrice.theoreticalValue - current.theoreticalValue,
        timeImpact: afterTime.theoreticalValue - afterPrice.theoreticalValue,
        ivImpact: valuation.theoreticalValue - afterTime.theoreticalValue,
      };
    } catch {
      return { current: null, priceImpact: null, timeImpact: null, ivImpact: null };
    }
  }, [scenario, valuation, workspace]);
  const { current, priceImpact, timeImpact, ivImpact } = whatIfCalculation;
  const usdThbRate = fxQuote ? Number(fxQuote.rate) : null;
  const basis = portfolioProfitLossBasis(workspace);
  const difference = current ? valuation.theoreticalValue - current.theoreticalValue : null;
  const initialCostOrCredit = valuation.netDebitCredit + workspace.stockQuantity * (workspace.underlyingPrice ?? 0);
  const audit = auditResultReconciliation({
    currentValue: current?.theoreticalValue ?? null,
    simulatedValue: valuation.theoreticalValue,
    changeFromCurrent: difference,
    initialCostOrCredit,
    projectedProfitLoss: valuation.profitLoss,
    priceImpact,
    timeDecayImpact: timeImpact,
    ivImpact,
    deltaEstimate: sensitivity.delta,
  });
  const state = profitLossState(valuation.profitLoss);
  const percentage = safeProfitLossPercent(valuation.profitLoss, basis.amount);
  const breakEvenValue = valuation.breakEvens
    .filter(Number.isFinite)
    .map((value) => `${formatResultMoney(value, currency, usdThbRate)}/หุ้น`)
    .join(', ') || 'ไม่มีข้อมูล';
  const reconciled = audit.valueChange.status === 'matched'
    && audit.projectedProfitLoss.status === 'matched'
    && audit.impactDecomposition.status === 'matched';
  const reconciliationMessage = reconciled
    ? 'ตรวจสอบแล้ว: มูลค่า, กำไร/ขาดทุน และองค์ประกอบผลกระทบสอดคล้องกัน'
    : audit.impactDecomposition.status === 'unavailable'
      ? 'ยังตรวจสอบองค์ประกอบผลกระทบไม่ได้ เพราะข้อมูลบางส่วนไม่มี'
      : 'พบส่วนต่างจากการตรวจสอบ โปรดดู Other Impact และวิธีคำนวณ';
  return <section className={box} data-testid="what-if-results"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold">ผลลัพธ์ What-If</h2><p className="text-xs text-slate-400">สรุป Premium และกำไร/ขาดทุนจากสถานการณ์ที่เลือก</p></div><span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">สกุลเงินที่เลือก: {currency}</span></div>
    <ResultCurrencyControl currency={currency} fxQuote={fxQuote} fxState={fxState} onCurrencyChange={onCurrencyChange} />
    <p className={`mt-4 rounded-xl border p-4 text-sm ${state === 'profit' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : state === 'loss' ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-slate-600 bg-slate-800/60 text-slate-200'}`} role="status">
      {buildProfitLossSummary(valuation.profitLoss, basis.amount, currency, usdThbRate)}
    </p>

    <div data-testid="result-summary">
      <ResultGroup title="สรุปผลสำคัญ" testId="result-group-key-summary">
        <ExplainedResultMetric title="กำไร/ขาดทุนรวมหลังจำลอง (Projected P&L)" value={formatResultMoney(valuation.profitLoss, currency, usdThbRate, true)} toneClass={profitLossToneClass(state)} helper="ผลต่างระหว่างมูลค่าสถานะหลังจำลองกับต้นทุนหรือเครดิตเริ่มต้นตามนโยบายของพอร์ต รวมค่าธรรมเนียมที่มีอยู่ในข้อมูลคำนวณ" />
        <ExplainedResultMetric title="กำไร/ขาดทุน (%)" value={formatSignedPercent(percentage)} toneClass={profitLossToneClass(state)} helper="นำกำไรหรือขาดทุนรวมเทียบกับเงินที่เสี่ยงเริ่มต้น ถ้าฐานนี้เป็นศูนย์หรือหาไม่ได้ ระบบจะแสดงว่าคำนวณเปอร์เซ็นต์ไม่ได้" />
        <ExplainedResultMetric title="จุดคุ้มทุนต่อหุ้น (Break-even)" value={breakEvenValue} helper="ราคาหุ้น ณ วันหมดอายุที่ทำให้กำไร/ขาดทุนของสถานะเท่ากับศูนย์ คำนวณใน USD แล้วแปลงเฉพาะตอนแสดงผลเมื่อเลือก THB" />
      </ResultGroup>

      <ResultGroup title="มูลค่าสถานะ" testId="result-group-position-value">
        <ExplainedResultMetric title="มูลค่าสถานะปัจจุบัน (Current Value)" value={current ? formatResultMoney(current.theoreticalValue, currency, usdThbRate) : 'ไม่มีข้อมูล'} helper="มูลค่าตาม pricing engine เมื่อใช้ราคาหุ้น วันที่ และ IV ปัจจุบันของสถานะ ตัวเลขติดลบอาจเกิดกับสถานะขาย" />
        <ExplainedResultMetric title="มูลค่าสถานะหลังจำลอง (Simulated Value)" value={formatResultMoney(valuation.theoreticalValue, currency, usdThbRate)} helper="มูลค่าตาม pricing engine หลังใช้ Target Price, Target Date และ IV ที่จำลอง ตัวเลขนี้ยังไม่หักต้นทุนเริ่มต้น" />
        <ExplainedResultMetric title="เปลี่ยนแปลงจากมูลค่าปัจจุบัน (Change from Current)" value={difference === null ? 'ไม่มีข้อมูล' : formatResultMoney(difference, currency, usdThbRate, true)} toneClass={difference === null ? 'text-slate-100' : profitLossToneClass(profitLossState(difference))} helper="มูลค่าสถานะหลังจำลองลบด้วยมูลค่าสถานะปัจจุบัน จึงบอกว่าสถานะมีมูลค่าเพิ่มขึ้นหรือลดลงเท่าไร" />
      </ResultGroup>

      <ResultGroup title="ความเสี่ยงสูงสุด" testId="result-group-maximum-risk">
        <ExplainedResultMetric title="กำไรสูงสุด (Max Profit)" value={valuation.unlimitedProfit ? 'ไม่จำกัด (Unlimited)' : formatResultMoney(valuation.maxProfit ?? Number.NaN, currency, usdThbRate, true)} toneClass="text-emerald-400" helper="กำไรสูงสุดของ payoff ณ วันหมดอายุภายในโครงสร้างสถานะ ถ้ากำไรเพิ่มได้ต่อเนื่องจะแสดงว่าไม่จำกัด" />
        <ExplainedResultMetric title="ขาดทุนสูงสุด (Max Loss)" value={valuation.unlimitedLoss ? 'ไม่จำกัด (Unlimited)' : formatResultMoney(valuation.maxLoss ?? Number.NaN, currency, usdThbRate, true)} toneClass="text-red-400" helper="ขาดทุนสูงสุดของ payoff ณ วันหมดอายุภายในโครงสร้างสถานะ ถ้าขาดทุนเพิ่มได้ต่อเนื่องจะแสดงว่าไม่จำกัด" />
      </ResultGroup>

      <ResultGroup title="รายละเอียดการประมาณ" testId="result-group-estimate-details" summary="คำนวณแบบลำดับ Price → Time → IV เพื่อให้ผลรวมตรวจสอบกับ Change from Current ได้">
        <ExplainedResultMetric title="ผลกระทบจากราคา (Price Impact)" value={priceImpact === null ? 'ไม่มีข้อมูล' : formatResultMoney(priceImpact, currency, usdThbRate, true)} helper="เปลี่ยนเฉพาะราคาหุ้นจากค่าปัจจุบันเป็น Target Price โดยยังคงวันที่และ IV ปัจจุบัน" />
        <ExplainedResultMetric title="ผลกระทบจาก Time Decay" value={timeImpact === null ? 'ไม่มีข้อมูล' : formatResultMoney(timeImpact, currency, usdThbRate, true)} helper="หลังปรับราคาแล้ว จึงเลื่อนเวลาไป Target Date โดยยังคง IV เดิม เพื่อแยกผลของเวลาที่ผ่านไป" />
        <ExplainedResultMetric title="ผลกระทบจาก IV" value={ivImpact === null ? 'ไม่มีข้อมูล' : formatResultMoney(ivImpact, currency, usdThbRate, true)} helper="หลังปรับราคาและเวลาแล้ว จึงเปลี่ยน IV ตามสถานการณ์ เพื่อแยกผลของความผันผวนโดยนัย" />
        <ExplainedResultMetric title="ค่าประมาณจาก Delta (ทั้งสถานะ)" value={audit.deltaEstimate === null ? 'ไม่มีข้อมูล' : `${formatResultMoney(audit.deltaEstimate, currency, usdThbRate, true)} ต่อราคาหุ้นเปลี่ยน $1 USD`} helper="Delta ของทั้งสถานะบอกว่ามูลค่าอาจเปลี่ยนประมาณเท่าไรเมื่อราคาหุ้นขยับ $1 ต่อหุ้น เป็นข้อมูลเปรียบเทียบเท่านั้น ไม่ใช่กำไรเพิ่มเติมและไม่นำไปบวกกับ Price Impact" />
        {audit.impactDecomposition.residual !== null && audit.impactDecomposition.residual !== 0 && <ExplainedResultMetric title="ผลกระทบอื่น (Other Impact)" value={formatResultMoney(audit.impactDecomposition.residual, currency, usdThbRate, true)} helper="ส่วนต่างคงเหลือที่ทำให้ Price Impact, Time Decay และ IV Impact รวมกันตรงกับ Change from Current อาจมาจาก interaction ของปัจจัยหรือข้อจำกัดเชิงตัวเลข" />}
      </ResultGroup>
    </div>

    <p className={`mt-4 rounded-lg p-3 text-xs ${reconciled ? 'bg-emerald-500/10 text-emerald-200' : 'bg-amber-500/10 text-amber-200'}`} data-testid="reconciliation-status" role="status">{reconciliationMessage}</p>
    <details className="mt-3 rounded-xl border border-slate-700 bg-slate-950/40 p-3 text-xs text-slate-300">
      <summary className="cursor-pointer font-semibold text-[#D4FF00]">วิธีคำนวณ</summary>
      <div className="mt-3 space-y-2 leading-relaxed">
        <p>Change from Current = Simulated Value − Current Value</p>
        <p>Projected P&amp;L = Simulated Value − ต้นทุนหรือเครดิตเริ่มต้นแบบ signed ตามนโยบายเดิมของพอร์ต</p>
        <p>{profitLossFormula(basis.policy)}</p>
        <p>Price Impact + Time Decay + IV Impact + Other Impact = Change from Current</p>
        <p>Delta เป็นข้อมูลเปรียบเทียบเท่านั้น ห้ามนำไปบวกซ้ำในผลรวมข้างต้น</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Value audit: {audit.valueChange.status}</li>
          <li>P&amp;L audit: {audit.projectedProfitLoss.status}</li>
          <li>Impact audit: {audit.impactDecomposition.status}</li>
        </ul>
      </div>
    </details>
    <p className="mt-4 text-xs text-slate-500">ผลลัพธ์เป็นค่าประมาณจากโมเดล ไม่ใช่ราคาตลาดจริงหรือคำแนะนำซื้อขาย</p></section>;
}
function CallPutScenarioScoreCard({ score }: { score: CallPutScenarioScore | null }) {
  if (!score || score.status === 'unavailable') {
    return <section className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" data-testid="call-put-scenario-score">
      <h3 className="font-semibold text-slate-100">Option Strategy Edge Score</h3>
      <p className="mt-2 font-medium text-amber-200">Score Unavailable</p>
      <p className="mt-1 text-xs text-amber-100/80">{score?.reason ?? 'ผลลัพธ์ที่บันทึกไว้ไม่มี Scenario Score กรุณารัน Monte Carlo ใหม่'}</p>
      <p className="mt-3 text-xs text-slate-400">คะแนนนี้ประเมินคุณภาพภายใต้สมมติฐานของแบบจำลอง ไม่ใช่คำสั่งหรือการรับประกันผลลัพธ์</p>
    </section>;
  }
  const tone = (classification: string) => classification.includes('Positive') || classification.includes('Bullish') || classification.includes('Bearish')
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
    : classification === 'No Positive Edge'
      ? 'border-red-500/30 bg-red-500/10 text-red-200'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  const summary = score.mode === 'comparison'
    ? score.comparisonClassification ?? 'Not directly comparable'
    : score.strategies[0]?.classification ?? 'Score Unavailable';
  return <section className="mt-4 rounded-xl border border-slate-700 bg-slate-950/40 p-4" data-testid="call-put-scenario-score">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><h3 className="font-semibold text-slate-100">{score.mode === 'comparison' ? 'Call/Put Comparison' : 'Scenario Quality Score'}</h3><p className="mt-1 text-xs text-slate-400">คะแนน absolute แยกต่อ strategy จากการ reprice บน underlying paths ชุดเดียวกัน จึงไม่บังคับรวมเป็น 100</p></div>
      <div className="flex flex-wrap gap-2"><span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200">{score.probabilityLabel}</span><span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">shared path {score.pathSet.id}</span></div>
    </div>
    <p className={`mt-3 rounded-lg border p-3 text-sm font-semibold ${tone(summary)}`}>{summary}{score.mode === 'comparison' && !score.comparable ? ' · แสดงคะแนนแยกโดยไม่ประกาศฝั่งนำ' : ''}</p>
    <div className={`mt-4 grid gap-3 ${score.strategies.length > 1 ? 'lg:grid-cols-2' : ''}`}>
      {score.strategies.map((strategy) => <article key={strategy.id} className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-100">{strategy.strategy}</p><p className="mt-1 text-xs uppercase text-slate-500">{strategy.side} · {strategy.status}</p></div><div className="text-right"><p className="text-3xl font-bold text-[#D4FF00]">{strategy.edgeScore === null ? 'N/A' : strategy.edgeScore.toFixed(2)}</p><p className="text-[10px] text-slate-500">EdgeScore / 100</p></div></div>
        <p className={`mt-3 rounded-md border px-2 py-1 text-xs font-semibold ${tone(strategy.classification)}`}>{strategy.classification}</p>
        {strategy.status === 'available' && strategy.metrics && strategy.confidence && <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <div><dt className="text-slate-500">POP</dt><dd>{formatResultNumber(strategy.metrics.probabilityOfProfit * 100)}%</dd></div>
            <div><dt className="text-slate-500">Expected P&amp;L</dt><dd>${formatResultNumber(strategy.metrics.expectedPnL)}</dd></div>
            <div><dt className="text-slate-500">EVR</dt><dd>{formatResultNumber(strategy.metrics.evr * 100)}%</dd></div>
            <div><dt className="text-slate-500">MedianR</dt><dd>{formatResultNumber(strategy.metrics.medianR * 100)}%</dd></div>
            <div><dt className="text-slate-500">ES95R</dt><dd>{formatResultNumber(strategy.metrics.es95R * 100)}%</dd></div>
            <div><dt className="text-slate-500">ProfitFactor</dt><dd>{strategy.metrics.profitFactor === null ? 'N/A' : formatResultNumber(strategy.metrics.profitFactor)}</dd></div>
            <div><dt className="text-slate-500">Robustness</dt><dd>{formatResultNumber(strategy.metrics.robustness * 100)}%</dd></div>
            <div><dt className="text-slate-500">MaxLoss / RiskCapital</dt><dd>${formatResultNumber(strategy.metrics.maxLoss)}</dd></div>
            <div><dt className="text-slate-500">Confidence</dt><dd>{formatResultNumber(strategy.confidence.score)} / 100</dd></div>
          </dl>
          {!strategy.positiveEdge && <p className="mt-3 rounded-md bg-red-500/10 p-2 text-xs text-red-200">Positive-edge gate ไม่ผ่าน: {strategy.positiveEdgeReasons.join('; ')}</p>}
        </>}
        {strategy.reason && <p className="mt-3 text-xs text-amber-200">{strategy.reason}</p>}
        <details className="mt-3 rounded-lg border border-slate-700 p-3 text-xs text-slate-300"><summary className="cursor-pointer font-semibold text-[#D4FF00]">Metrics, confidence และ provenance</summary><div className="mt-2 space-y-2">
          <p>Premium ${formatResultNumber(strategy.assumptions.premium)} · Fees ${formatResultNumber(strategy.assumptions.fees)} · Multiplier {strategy.assumptions.multiplier.join(', ')} · Quantity {strategy.assumptions.quantity.join(', ')}</p>
          <p>Premium source {strategy.assumptions.premiumSources.join(', ')} · Provider {strategy.assumptions.source ?? 'unavailable'} · As of {strategy.assumptions.asOf ? new Date(strategy.assumptions.asOf).toLocaleString() : 'unavailable'}</p>
          {strategy.scoreComponents && <p>Components — POP {formatResultNumber(strategy.scoreComponents.pop)}, EV {formatResultNumber(strategy.scoreComponents.ev)}, Median {formatResultNumber(strategy.scoreComponents.median)}, Tail {formatResultNumber(strategy.scoreComponents.tail)}, Payoff {formatResultNumber(strategy.scoreComponents.payoff)}, Robustness {formatResultNumber(strategy.scoreComponents.robustness)}</p>}
          {strategy.metrics && <p>Precision — POP SE {formatResultNumber(strategy.metrics.popStandardError * 100, 4)}% · Expected P&amp;L SE ${formatResultNumber(strategy.metrics.expectedPnLStandardError, 4)} · 95% CI ${formatResultNumber(strategy.metrics.expectedPnLConfidence95[0])} to ${formatResultNumber(strategy.metrics.expectedPnLConfidence95[1])}</p>}
          {strategy.stressScenarios.length > 0 && <p>Stress EVR — {strategy.stressScenarios.map((item) => `${item.id}: ${formatResultNumber(item.evr * 100)}%`).join(' · ')}</p>}
          {strategy.confidence && <><p>Confidence — Input {formatResultNumber(strategy.confidence.inputQuality.score)}, Stability {formatResultNumber(strategy.confidence.scenarioStability.score)}, Precision {formatResultNumber(strategy.confidence.statisticalPrecision.score)}, Liquidity {formatResultNumber(strategy.confidence.liquidityQuality.score)}</p><ul className="list-disc space-y-1 pl-5">{[...strategy.confidence.inputQuality.reasons, ...strategy.confidence.scenarioStability.reasons, ...strategy.confidence.statisticalPrecision.reasons, ...strategy.confidence.liquidityQuality.reasons].map((reason) => <li key={reason}>{reason}</li>)}</ul></>}
        </div></details>
      </article>)}
    </div>
    {score.mode === 'comparison' && <div className="mt-3 grid gap-2 rounded-lg border border-slate-700 p-3 text-xs sm:grid-cols-3"><p>Comparable: <strong>{score.comparable ? 'yes' : 'no'}</strong></p><p>Score difference: <strong>{score.scoreDifference === null ? 'N/A' : formatResultNumber(score.scoreDifference)}</strong></p><p>Comparison confidence: <strong>{score.comparisonConfidence === null ? 'N/A' : formatResultNumber(score.comparisonConfidence)}</strong></p></div>}
    <div className="mt-3 rounded-lg border border-slate-700 p-3 text-xs text-slate-300"><p className="font-semibold text-slate-100">Market Direction Probability (แยกจาก Option Edge)</p><p className="mt-1">เหนือ starting spot {formatResultNumber(score.marketDirectionProbability.probabilityAboveStartingSpot * 100)}% · ถึง/เหนือ target ${formatResultNumber(score.marketDirectionProbability.targetPrice)}: {formatResultNumber(score.marketDirectionProbability.probabilityAtOrAboveTarget * 100)}%</p><p className="mt-1 text-slate-500">ค่าชุดนี้มาจาก shared underlying paths และไม่ได้ใช้เป็นส่วนประกอบ EdgeScore</p></div>
    <details className="mt-4 rounded-lg border border-slate-700 p-3 text-xs text-slate-300">
      <summary className="cursor-pointer font-semibold text-[#D4FF00]">สูตร, paths และสมมติฐาน</summary>
      <div className="mt-2 space-y-1 leading-relaxed">
        <p>EdgeScore = 30% POP + 25% EV + 10% Median + 15% Tail (ES95 เท่านั้น) + 10% Payoff + 10% Robustness</p>
        <p>EVR, MedianR และ ES95R หารด้วย finite positive MaxLoss; ES95PnL คือค่าเฉลี่ย P&amp;L ของ worst 5% paths</p>
        <p>Requested / generated / common valid / dropped: {score.pathSet.requestedPaths.toLocaleString()} / {score.pathSet.generatedPaths.toLocaleString()} / {score.pathSet.commonValidPaths.toLocaleString()} / {score.pathSet.droppedPaths.toLocaleString()}</p>
        <p>Seed {score.pathSet.seed} · Spot ${formatResultNumber(score.assumptions.startingSpot)} · Volatility {formatResultNumber(score.assumptions.volatility * 100)}% · Drift {formatResultNumber(score.assumptions.drift * 100)}% · Rate {formatResultNumber(score.assumptions.rate * 100)}% · Dividend {formatResultNumber(score.assumptions.dividendYield * 100)}%</p>
        <p>{score.pricingMode === 'risk-neutral' ? 'Risk-neutral valuation ใช้เพื่อ pricing/model consistency ไม่ใช่โอกาสจริง' : 'Forecast mode ขึ้นกับ drift/distribution ที่ระบุและไม่ได้รับประกันผลในอนาคต'}</p>
      </div>
    </details>
    <p className="mt-3 text-xs text-slate-400">เป็นผลจากแบบจำลองภายใต้สมมติฐานที่แสดง ไม่ใช่คำสั่งหรือการรับประกันผลลัพธ์</p>
  </section>;
}

function MonteCarloHighlights({ workspace, result, scenarioScore, currency, fxQuote, fxState, onCurrencyChange }: { workspace: SimulationWorkspace; result: MonteCarloDisplayResult; scenarioScore: CallPutScenarioScore | null } & ResultDisplayProps) {
  const usdThbRate = fxQuote ? Number(fxQuote.rate) : null;
  const basis = portfolioProfitLossBasis(workspace);
  const validPaths = typeof result.validPaths === 'number' && Number.isFinite(result.validPaths) ? result.validPaths : result.paths;
  const discardedPaths = typeof result.discardedPaths === 'number' && Number.isFinite(result.discardedPaths) ? result.discardedPaths : Math.max(0, result.paths - validPaths);
  const pnl = useMemo(() => result.histogram.flatMap((bucket) => {
    const lower = convertUsdForDisplay(bucket.lower, currency, usdThbRate);
    const upper = convertUsdForDisplay(bucket.upper, currency, usdThbRate);
    if (lower === null || upper === null) return [];
    return [{ x: (lower + upper) / 2, lower, upper, count: bucket.count }];
  }), [currency, result.histogram, usdThbRate]);
  const terminal = useMemo(() => (result.terminalPriceHistogram ?? []).map((bucket) => ({
    x: (bucket.lower + bucket.upper) / 2,
    lower: bucket.lower,
    upper: bucket.upper,
    count: bucket.count,
  })), [result.terminalPriceHistogram]);
  const breakEvens = useMemo(() => {
    try { return valuePortfolio(workspace, workspace.scenarios[0]).breakEvens; } catch { return []; }
  }, [workspace]);
  const terminalReferences = useMemo(() => [
    ...(workspace.underlyingPrice === null ? [] : [{ value: workspace.underlyingPrice, label: 'Current Price', color: '#f59e0b', description: `ราคาปัจจุบัน $${formatResultNumber(workspace.underlyingPrice)}` }]),
    ...workspace.legs.map((leg, index) => ({ value: leg.strike, label: `Strike L${index + 1}`, color: '#94a3b8', description: `Strike ของ Leg ${index + 1}: $${formatResultNumber(leg.strike)}` })),
    ...breakEvens.map((value, index) => ({ value, label: breakEvens.length === 1 ? 'Break-even' : `Break-even ${index + 1}`, color: '#a78bfa', description: `จุดคุ้มทุน $${formatResultNumber(value)}` })),
    ...(result.targetPrice === undefined ? [] : [{ value: result.targetPrice, label: 'Target', color: '#22d3ee', description: `ราคาเป้าหมาย $${formatResultNumber(result.targetPrice)}` }]),
  ], [breakEvens, result.targetPrice, workspace.legs, workspace.underlyingPrice]);
  const shownPaths = useMemo(() => result.samplePaths.slice(0, 8), [result.samplePaths]);
  const samples = useMemo(() => {
    const pointCount = Math.max(0, ...shownPaths.map((path) => path.length));
    return Array.from({ length: pointCount }, (_, step) => {
      const dayOffset = pointCount <= 1 ? 0 : Math.round(step / (pointCount - 1) * workspace.monteCarlo.horizonDays);
      return Object.fromEntries([['date', addCalendarDays(workspace.valuationDate, dayOffset)], ...shownPaths.map((path, index) => [`path${index}`, path[step] ?? null])]);
    });
  }, [shownPaths, workspace.monteCarlo.horizonDays, workspace.valuationDate]);
  const formatProbability = (value: number | undefined) => value === undefined || !Number.isFinite(value) || value < 0 || value > 1 ? 'ไม่มีข้อมูล' : `${(value * 100).toFixed(2)}%`;
  const totalFees = workspace.legs.reduce((sum, leg) => sum + leg.fees, 0);
  const p5Pnl = result.percentiles.p5;
  const p50Pnl = result.medianProfitLoss;
  const p95Pnl = result.percentiles.p95;
  const var95Pnl = -result.valueAtRisk.p95;
  const es95Pnl = -result.expectedShortfall.p95;
  const maximumLoss = boundedExpirationProfitFloor(workspace);
  const closeAboveLabel = formatProbability(result.probabilityClosingAboveTarget);
  const closeBelowLabel = result.probabilityClosingAboveTarget !== undefined
    && result.probabilityClosingBelowTarget !== undefined
    && Number.isFinite(result.probabilityClosingAboveTarget)
    && Number.isFinite(result.probabilityClosingBelowTarget)
    && Math.abs(result.probabilityClosingAboveTarget + result.probabilityClosingBelowTarget - 1) <= 1e-10
    ? `${(100 - Number((result.probabilityClosingAboveTarget * 100).toFixed(2))).toFixed(2)}%`
    : formatProbability(result.probabilityClosingBelowTarget);
  return <section className={box} data-testid="monte-carlo-results"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold">ผลลัพธ์ Monte Carlo</h2><p className="text-xs text-slate-400">สรุปความน่าจะเป็นและการกระจายกำไร/ขาดทุน</p></div><span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">สกุลเงินที่เลือก: {currency}</span></div>
    <ResultCurrencyControl currency={currency} fxQuote={fxQuote} fxState={fxState} onCurrencyChange={onCurrencyChange} />
    <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/40 p-4" data-testid="result-summary">
      <h3 className="font-semibold text-slate-100">สรุปแบบมือใหม่</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-200">จาก valid paths ทั้งหมด {validPaths.toLocaleString()} จาก {result.paths.toLocaleString()} paths ผลเฉลี่ยคือ {buildProfitLossSummary(result.expectedProfitLoss, basis.amount, currency, usdThbRate)}, ค่ากลางคือ {buildProfitLossSummary(result.medianProfitLoss, basis.amount, currency, usdThbRate)} และหางล่าง 5% มี Expected Shortfall 95% ที่ {formatResultMoney(es95Pnl, currency, usdThbRate, true)} โดย POP เท่ากับ {formatProbability(result.probabilityOfProfit)}</p>
      {discardedPaths > 0 && <p className="mt-2 text-xs text-amber-300">ตัด {discardedPaths.toLocaleString()} paths ที่ให้ค่า NaN หรือ Infinity ออกจากตัวหารและสถิติทั้งหมด</p>}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric title="ขาดทุนสูงสุด" value={maximumLoss === null ? 'ไม่จำกัด' : formatResultMoney(maximumLoss, currency, usdThbRate, true)} helper="ขอบเขต P&L ต่ำสุดของ payoff ตามโครงสร้างสถานะ ไม่ได้เดาจาก path ที่แย่ที่สุดเพียงเส้นเดียว" />
        <Metric title="POP" value={formatProbability(result.probabilityOfProfit)} helper="สัดส่วน valid paths ที่ P&L มากกว่า 0 หลังหักต้นทุนและค่าธรรมเนียม" />
        <ExplainedProfitLossMetric title="Expected P&L" amount={result.expectedProfitLoss} currency={currency} usdThbRate={usdThbRate} helper="ค่าเฉลี่ย P&L จาก valid paths ทั้งหมด" />
        <ExplainedProfitLossMetric title="Median P&L" amount={result.medianProfitLoss} currency={currency} usdThbRate={usdThbRate} helper="P&L ค่ากลางจาก valid paths ทั้งหมด" />
        <ExplainedProfitLossMetric title="P5" amount={p5Pnl} currency={currency} usdThbRate={usdThbRate} helper="ประมาณ 5% ของ valid paths มี P&L ต่ำกว่าหรือเท่าค่านี้" />
        <ExplainedProfitLossMetric title="VaR 95%" amount={var95Pnl} currency={currency} usdThbRate={usdThbRate} helper="P5 ของ lower tail ในรูป P&L ติดลบหรือศูนย์" />
        <ExplainedProfitLossMetric title="Expected Shortfall 95%" amount={es95Pnl} currency={currency} usdThbRate={usdThbRate} helper="ค่าเฉลี่ย P&L ของ valid paths ในหางล่างที่แย่กว่า VaR 95%" />
      </div>
    </div>
    <CallPutScenarioScoreCard score={scenarioScore} />
    <ResultGroup title="สรุปผล" testId="monte-carlo-group-summary" summary="ภาพรวมกำไร/ขาดทุนและสถานะสัญญา ณ Target Date">
      <ProfitLossMetric title="กำไร/ขาดทุนคาดหวัง (Expected P&L)" amount={result.expectedProfitLoss} denominator={basis.amount} currency={currency} usdThbRate={usdThbRate} helper="ค่าเฉลี่ย P&L ของ valid paths ทั้งหมดหลังหักต้นทุนและค่าธรรมเนียม" />
      <Metric title="โอกาสทำกำไร (POP)" value={formatProbability(result.probabilityOfProfit)} helper="POP = จำนวน valid paths ที่ P&L > 0 หลังหักต้นทุนและค่าธรรมเนียม ÷ valid paths ทั้งหมด" />
      <ProfitLossMetric title="ค่ากลางของกำไร/ขาดทุน (Median P&L)" amount={result.medianProfitLoss} denominator={basis.amount} currency={currency} usdThbRate={usdThbRate} helper="P&L ค่ากลางหลังเรียงจากน้อยไปมาก; ไม่ใช่ค่าเฉลี่ย" />
      <Metric title="โอกาสจบแบบ ITM" value={formatProbability(result.probabilityItm)} helper="ITM ดูจากราคาปลายทางเทียบ Strike ตาม Call/Put เท่านั้น; ITM ไม่เท่ากับกำไร เพราะยังมี Premium และค่าธรรมเนียม" />
    </ResultGroup>
    <ResultGroup title="ราคาเป้าหมาย" testId="monte-carlo-group-target" summary="Touch ดูทุก time step ส่วน Close ดูเฉพาะราคาปลายทาง ณ Target Date">
      <Metric title="Touch Target" value={formatProbability(result.probabilityReachingTarget)} helper="เคยแตะหรือผ่าน Target ระหว่างทางอย่างน้อยหนึ่งครั้ง รวมทุก time step จนถึง Target Date" />
      <Metric title="Close ≥ Target" value={closeAboveLabel} helper="ราคาหุ้นปลายทาง ณ Target Date มากกว่าหรือเท่ากับ Target" />
      <Metric title="Close < Target" value={closeBelowLabel} helper="ราคาหุ้นปลายทาง ณ Target Date ต่ำกว่า Target; เมื่อรวมกับ Close ≥ Target ต้องเท่ากับ 100% แม้หลังจัดรูปแบบทศนิยม" />
    </ResultGroup>
    <ResultGroup title="ช่วงผลลัพธ์/ความเสี่ยง" testId="monte-carlo-group-risk" summary="ทุกค่าเป็น P&L หลังหักต้นทุนและค่าธรรมเนียม โดยคำนวณใน USD ก่อนแปลงเพื่อแสดงผล">
      <ExplainedProfitLossMetric title="P5" amount={p5Pnl} currency={currency} usdThbRate={usdThbRate} helper="P5 คือระดับที่ประมาณ 5% ของ valid paths มี P&L ต่ำกว่าหรือเท่าค่านี้ ใช้ดูฝั่งผลลัพธ์ที่ค่อนข้างแย่" />
      <ExplainedProfitLossMetric title="P50" amount={p50Pnl} currency={currency} usdThbRate={usdThbRate} helper="P50 คือ Median P&L: ครึ่งหนึ่งของ valid paths อยู่ต่ำกว่า และอีกครึ่งหนึ่งอยู่สูงกว่า" />
      <ExplainedProfitLossMetric title="P95" amount={p95Pnl} currency={currency} usdThbRate={usdThbRate} helper="P95 คือระดับที่ประมาณ 95% ของ valid paths มี P&L ต่ำกว่าหรือเท่าค่านี้ ใช้ดูฝั่งผลลัพธ์ที่ค่อนข้างดี" />
      <ExplainedProfitLossMetric title="VaR 95% (P&L)" amount={var95Pnl} currency={currency} usdThbRate={usdThbRate} helper="VaR 95% ใช้ P5 ของ lower P&L tail แล้วแสดงเป็น P&L ติดลบหรือศูนย์: ประมาณ 5% ของ paths แย่กว่าระดับนี้" />
      <ExplainedProfitLossMetric title="Expected Shortfall 95% (P&L)" amount={es95Pnl} currency={currency} usdThbRate={usdThbRate} helper="ES 95% คือค่าเฉลี่ย P&L ของ paths ในหางล่างที่แย่กว่า VaR; เมื่อแสดงเป็น P&L ค่า ES ต้องน้อยกว่าหรือเท่ากับ VaR" />
    </ResultGroup>
    <section className="mt-4 rounded-xl border border-slate-700 bg-slate-950/30 p-3" data-testid="monte-carlo-group-charts">
      <h3 className="font-semibold text-slate-100">กราฟและสมมติฐาน</h3>
      <p className="mt-1 text-xs text-slate-400">Histogram ใช้ valid paths ทั้งหมด ส่วนเส้นราคาแสดงเพียงตัวอย่างเพื่ออธิบายการกระจาย ไม่ใช่คำทำนายหลัก</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <HistogramChart title={`P&L Distribution (${currency})`} ariaLabel={`ฮิสโตแกรม P&L จาก ${validPaths.toLocaleString()} paths แกน X เป็น P&L ${currency} แกน Y เป็นจำนวน paths`} data={pnl} xAxisLabel={`P&L (${currency})`} referenceXs={[{ value: 0, label: 'Break-even P&L', color: '#94a3b8', description: 'P&L เท่ากับศูนย์' }]} />
        {terminal.length > 0 ? <HistogramChart title="Terminal Stock Price Distribution (USD)" ariaLabel={`ฮิสโตแกรมราคาหุ้นปลายทางจาก ${validPaths.toLocaleString()} paths แกน X เป็นราคาหุ้นปลายทาง USD แกน Y เป็นจำนวน paths`} data={terminal} xAxisLabel="ราคาหุ้นปลายทาง (USD)" referenceXs={terminalReferences} /> : <div className="min-w-0 rounded-xl border border-slate-700 p-3 text-sm text-amber-300">ผลลัพธ์เดิมไม่มี terminal histogram กรุณารัน Monte Carlo ใหม่เพื่อดูกราฟจากทุก paths</div>}
        <div className="h-80 min-w-0 rounded-xl border border-slate-700 p-3 lg:col-span-2" role="group" aria-label={`เส้นทางราคาตัวอย่าง ${shownPaths.length} จาก ${validPaths} paths ตั้งแต่ ${workspace.valuationDate} ถึง ${workspace.scenarios[0].valuationDate}`}>
          <h4 className="text-sm font-semibold">Sample Price Paths (USD)</h4>
          <p className="mb-2 text-xs text-slate-400">แสดงตัวอย่าง {shownPaths.length.toLocaleString()} จาก {validPaths.toLocaleString()} paths · เส้นทุกเส้นมีน้ำหนักเท่ากันและไม่ใช่เส้นคาดการณ์หลัก</p>
          <ResponsiveContainer width="100%" height="85%"><LineChart data={samples} margin={{ bottom: 16, left: 4, right: 12 }}><CartesianGrid stroke="#334155" /><XAxis dataKey="date" minTickGap={28} tickFormatter={(value) => new Date(`${value}T00:00:00Z`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: 'UTC' })} label={{ value: 'วัน/วันที่', position: 'insideBottom', offset: -10 }} /><YAxis label={{ value: 'ราคาหุ้น (USD)', angle: -90, position: 'insideLeft' }} /><Tooltip />{shownPaths.map((_, index) => <Line key={index} dataKey={`path${index}`} name={`ตัวอย่าง ${index + 1}`} dot={false} stroke={['#94a3b8', '#7dd3fc', '#c4b5fd', '#86efac'][index % 4]} strokeOpacity={0.55} strokeWidth={1.25} isAnimationActive={false} />)}<ReferenceLine y={workspace.underlyingPrice ?? undefined} stroke="#f59e0b" strokeDasharray="4 4" /></LineChart></ResponsiveContainer>
        </div>
      </div>
      <details className="mt-4 rounded-xl border border-slate-700 bg-slate-950/40 p-3 text-xs text-slate-300" data-testid="monte-carlo-assumptions">
        <summary className="cursor-pointer font-semibold text-[#D4FF00]">สมมติฐานที่ใช้</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          <div><dt className="text-slate-500">Model</dt><dd>Geometric Brownian Motion (GBM), options-simulator-v1</dd></div>
          <div><dt className="text-slate-500">Paths / Seed</dt><dd>{result.paths.toLocaleString()} / {result.seed}</dd></div>
          <div><dt className="text-slate-500">Current Price</dt><dd>{workspace.underlyingPrice === null ? 'ไม่มีข้อมูล' : `$${formatResultNumber(workspace.underlyingPrice)} USD`}</dd></div>
          <div><dt className="text-slate-500">Target Date / Days</dt><dd>{workspace.scenarios[0].valuationDate} / {workspace.monteCarlo.horizonDays} วัน</dd></div>
          <div><dt className="text-slate-500">IV / Drift</dt><dd>{formatResultNumber(workspace.monteCarlo.volatility * 100)}% / {formatResultNumber(workspace.monteCarlo.drift * 100)}%</dd></div>
          <div><dt className="text-slate-500">Rate / Dividend</dt><dd>{formatResultNumber(workspace.monteCarlo.rate * 100)}% / {formatResultNumber(workspace.monteCarlo.dividendYield * 100)}%</dd></div>
          <div><dt className="text-slate-500">Quantity</dt><dd>{workspace.legs.map((leg, index) => `L${index + 1}: ${leg.quantity}`).join(' · ')}</dd></div>
          <div><dt className="text-slate-500">Multiplier</dt><dd>{workspace.legs.map((leg, index) => `L${index + 1}: ${leg.multiplier}`).join(' · ')}</dd></div>
          <div><dt className="text-slate-500">ค่าธรรมเนียม</dt><dd>รวมใน P&amp;L แล้ว · ${formatResultMoney(totalFees, 'USD', null)}</dd></div>
        </dl>
        <p className="mt-3 text-slate-500">GBM paths ใช้ drift, IV และ dividend ตามสูตรของ methodology v1; rate แสดงเพื่อ audit แต่ไม่ถูกนำไปสร้าง paths ในเวอร์ชันนี้</p>
      </details>
    </section>
    <p className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">ผลลัพธ์เป็นความน่าจะเป็นจากสมมติฐาน ไม่ใช่การทำนายราคาที่แน่นอน</p></section>;
}
interface HistogramMarker { value: number; label: string; color: string; description: string }
function HistogramChart({ title, ariaLabel, data, xAxisLabel, referenceXs = [] }: { title: string; ariaLabel: string; data: Array<{ x: number; lower: number; upper: number; count: number }>; xAxisLabel: string; referenceXs?: HistogramMarker[] }) {
  return <div className="h-80 min-w-0 rounded-xl border border-slate-700 p-3" role="group" aria-label={ariaLabel}>
    <h4 className="text-sm font-semibold">{title}</h4>
    {referenceXs.length > 0 && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400" aria-label="Markers">{referenceXs.map((reference, index) => <span key={`${reference.label}-${reference.value}-${index}`} title={reference.description} tabIndex={0}><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: reference.color }} />{reference.label}</span>)}</div>}
    <ResponsiveContainer width="100%" height="82%"><BarChart data={data} margin={{ bottom: 20, left: 4, right: 12, top: 12 }}><CartesianGrid stroke="#334155" /><XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(value) => formatResultNumber(Number(value), 0)} label={{ value: xAxisLabel, position: 'insideBottom', offset: -12 }} /><YAxis allowDecimals={false} label={{ value: 'จำนวน paths', angle: -90, position: 'insideLeft' }} /><Tooltip labelFormatter={(_, payload) => payload?.[0]?.payload ? `${formatResultNumber(payload[0].payload.lower)} – ${formatResultNumber(payload[0].payload.upper)}` : ''} formatter={(value) => [Number(value).toLocaleString(), 'จำนวน paths']} />{referenceXs.map((reference, index) => <ReferenceLine key={`${reference.label}-${reference.value}-${index}`} x={reference.value} stroke={reference.color} strokeDasharray="4 4" label={{ value: reference.label, fill: reference.color, fontSize: 9, position: 'insideTop' }} />)}<Bar dataKey="count" name="จำนวน paths" fill="#D4FF00" isAnimationActive={false} /></BarChart></ResponsiveContainer>
  </div>;
}
function Payoff({ valuation, spot, currency, usdThbRate }: { valuation: PortfolioValuation; spot: number | null; currency: ResultCurrency; usdThbRate: number | null }) {
  const payoff = valuation.payoff.map((point) => ({ ...point, profitLoss: convertUsdForDisplay(point.profitLoss, currency, usdThbRate) ?? point.profitLoss }));
  return <section className={box}><div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500"><span><i className="mr-1 inline-block h-0.5 w-3 bg-amber-500" />Current Price — ราคาปัจจุบัน (USD)</span><span><i className="mr-1 inline-block h-0.5 w-3 bg-slate-400" />Zero P/L — จุดกำไร/ขาดทุนเป็นศูนย์</span><span><i className="mr-1 inline-block h-0.5 w-3 bg-[#D4FF00]" />At Expiration — P/L ณ วันหมดอายุ ({currency})</span></div><div className="h-72 min-w-0"><ResponsiveContainer><LineChart data={payoff}><CartesianGrid stroke="#334155" /><XAxis dataKey="price" /><YAxis /><Tooltip /><ReferenceLine y={0} stroke="#94a3b8" />{spot && <ReferenceLine x={spot} stroke="#f59e0b" />}{valuation.breakEvens.map((value) => <ReferenceLine key={value} x={value} stroke="#a78bfa" />)}<Line dataKey="profitLoss" dot={false} stroke="#D4FF00" isAnimationActive={false} /></LineChart></ResponsiveContainer></div></section>;
}
