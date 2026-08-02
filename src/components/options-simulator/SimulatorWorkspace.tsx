'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CalendarDays, Check, Copy, LoaderCircle, Plus, Save, Search, Trash2 } from 'lucide-react';
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
import { presentEdgeGate, presentError, presentUnavailableReason } from './error-presentation';
import { runExclusiveSave, type SaveFeedbackStatus } from './save-feedback';
import { MetricDisclosure } from './MetricDisclosure';
import { addCalendarDays, aggregatePortfolioSensitivity, auditResultReconciliation, BASIC_PATH_OPTIONS, buildProfitLossSummary, calendarDaysBetween, clampTargetDate, convertUsdForDisplay, displayValidationMessage, engineVolatilityToPercent, formatPremiumDigits, formatResultMoney, formatResultNumber, formatSignedPercent, formatTimestamp, isBasicPathOption, normalizePercentDraft, parseFiniteDraft, parsePercentDraft, parsePremiumPaste, percentVolatilityToEngine, premiumDigitsFromValue, premiumFromDigitString, profitLossState, profitLossStateLabel, profitLossToneClass, safeProfitLossPercent, targetDateError, validationMessageParts, validationPathUnit, type ResultCurrency } from './simulator-ux';

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

/*
  The five tabs are one numbered walkthrough. The chips stay short so the row
  never overflows a 320px screen; the ordinal and the beginner explanation live
  in the page heading and the line under the tab row instead.
*/
const tabLabels: Record<string, string> = { Inputs: 'ข้อมูลสัญญา', 'What-If': 'What-If', 'Monte Carlo': 'Monte Carlo', Payoff: 'Payoff', Greeks: 'Greeks' };
const stepHeadings: Record<string, string> = {
  Inputs: '1. ข้อมูลสัญญา',
  'What-If': '2. ทดลองสถานการณ์ (What-If Analysis)',
  'Monte Carlo': '3. จำลองความเป็นไปได้ (Monte Carlo Simulation)',
  Payoff: '4. กราฟกำไร/ขาดทุน (Payoff)',
  Greeks: '5. ค่าความไวของสัญญา (Greeks)',
};
const stepDescriptions: Record<string, string> = {
  Inputs: 'เลือกหุ้นและกรอกรายละเอียดสัญญาที่ต้องการวิเคราะห์',
  'What-If': 'ลองเปลี่ยนราคาหุ้น วันที่ และความผันผวน เพื่อดูว่ากำไรหรือขาดทุนจะเปลี่ยนไปเท่าไร',
  'Monte Carlo': 'จำลองราคาหุ้นหลายพันสถานการณ์ เพื่อดูโอกาสได้กำไรและระดับความเสี่ยง',
  Payoff: 'ดูกำไร/ขาดทุนของกลยุทธ์เมื่อราคาหุ้นเปลี่ยน',
  Greeks: 'ดูว่ามูลค่าสัญญาไวต่อราคาหุ้น เวลา และความผันผวนแค่ไหน',
};
/*
  One sentence per idea, written from the reader's money outwards: what the number
  means first, then what it does to their profit, loss or risk. Each string is
  declared once and reused wherever the same idea appears, so the What-If tab and
  the Monte Carlo tab never explain the same metric two different ways.
*/
const PRICE_IMPACT_HELP = 'กำไรหรือขาดทุนโดยประมาณที่เกิดจากการเปลี่ยนแปลงของราคาหุ้น';
const TIME_IMPACT_HELP = 'มูลค่าที่คาดว่าจะลดลงเมื่อเวลาผ่านไป ยิ่งถือสัญญานาน มูลค่าอาจยิ่งลดลงแม้ราคาหุ้นไม่เปลี่ยน';
const THETA_PER_DAY_HELP = 'มูลค่าที่คาดว่าจะลดลงในแต่ละวันที่ผ่านไป แม้ราคาหุ้นไม่เปลี่ยน';
const DELTA_WHAT_IF_HELP = 'หากราคาหุ้นอ้างอิงขยับขึ้น 1 ดอลลาร์ มูลค่ารวมของสถานะคุณจะเปลี่ยนประมาณเท่าไร โดยรวมจำนวนสัญญาที่ถือแล้ว';
const DELTA_MONTE_CARLO_HELP = 'แสดงว่ามูลค่ารวมของสถานะไวต่อการเปลี่ยนแปลงของราคาหุ้นมากเพียงใด ค่านี้ใช้ประกอบการดูความเสี่ยง';
const PROBABILITY_OF_PROFIT_HELP = 'โอกาสที่สถานะนี้จะจบด้วยกำไร หลังหักต้นทุนและค่าธรรมเนียมแล้ว';
const VALUE_AT_RISK_HELP = 'หากตลาดเกิดกรณีที่แย่กว่าปกติ ซึ่งพบได้ประมาณ 5% ของการจำลอง คุณอาจขาดทุนอย่างน้อยประมาณเท่าไร';
const EXPECTED_SHORTFALL_HELP = 'หากผลลัพธ์อยู่ในกลุ่ม 5% ที่แย่ที่สุด คุณอาจขาดทุนเฉลี่ยประมาณเท่าไร';
const TOUCH_TARGET_HELP = 'โอกาสที่ราคาหุ้นจะขึ้นหรือลงไปถึงเป้าหมายที่ตั้งไว้ อย่างน้อยหนึ่งครั้งก่อนวันเป้าหมาย';
const CLOSE_AT_TARGET_HELP = 'โอกาสที่ราคาหุ้นในวันเป้าหมายจะอยู่ถึงหรือผ่านระดับราคาที่ตั้งไว้';
const CLOSE_BELOW_TARGET_HELP = 'โอกาสที่ราคาหุ้นในวันเป้าหมายจะยังไม่ถึงระดับราคาที่ตั้งไว้';

const VALUE_AT_RISK_TITLE = 'ระดับขาดทุนในกรณีแย่ประมาณ 5% (VaR 95%)';
const EXPECTED_SHORTFALL_TITLE = 'ขาดทุนเฉลี่ยของกรณีแย่สุดประมาณ 5% (Expected Shortfall 95%)';

const driftModeHelp: Record<'forecast' | 'risk-neutral', string> = {
  forecast: 'คาดการณ์ราคาจากแนวโน้มในอดีต เหมาะสำหรับทดลองว่าพอร์ตอาจเป็นอย่างไรหากแนวโน้มยังดำเนินต่อ',
  'risk-neutral': 'ประเมินมูลค่าตามสมมติฐานมาตรฐานของตลาด โดยไม่คาดเดาว่าหุ้นจะขึ้นหรือลง เหมาะสำหรับดูมูลค่าโดยประมาณ',
};

/** Display wording for the stored data-freshness values; the stored value never changes. */
const dataStatusLabels: Record<string, string> = {
  live: 'ข้อมูลเรียลไทม์',
  delayed: 'ข้อมูลล่าช้า',
  stale: 'ข้อมูลเก่า',
  manual: 'กรอกเอง',
  unavailable: 'ไม่มีข้อมูล',
};
const simulationTypeLabels: Record<string, string> = { 'what-if': 'ทดลองสถานการณ์', 'monte-carlo': 'จำลองความเป็นไปได้' };
/* Display names for the engine's stress-scenario ids; the ids themselves never change. */
const stressScenarioLabels: Record<string, string> = {
  base: 'สถานการณ์ปกติ',
  'spot-down-10': 'หุ้นลง 10%',
  'spot-up-10': 'หุ้นขึ้น 10%',
  'iv-down-20': 'ความผันผวนลด 20%',
  'iv-up-20': 'ความผันผวนเพิ่ม 20%',
  'rate-down-100bp': 'ดอกเบี้ยลด 1%',
  'rate-up-100bp': 'ดอกเบี้ยเพิ่ม 1%',
  'dividend-up-100bp': 'เงินปันผลเพิ่ม 1%',
};
const strategySideLabels: Record<string, string> = { call: 'ฝั่ง Call', put: 'ฝั่ง Put', portfolio: 'ทั้งพอร์ต' };
const strategyStatusLabels: Record<string, string> = { available: 'มีคะแนน', unavailable: 'ยังไม่มีคะแนน' };

const select = 'h-10 w-full rounded-md border border-slate-700 bg-[#151B28] px-3 text-sm text-white';
const day = (offset = 0) => {
  const value = new Date();
  value.setDate(value.getDate() + offset);
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
};
const uid = () => crypto.randomUUID();
/*
  Printed wherever a calendar value is still the undated seed. Both simulator
  routes are prerendered, so the first paint has no calendar day yet; a fixed
  dash keeps that one frame stable instead of showing a build-time date.
*/
const UNDATED_TEXT = '—';

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
  return value === null || value === undefined ? 'ไม่มีข้อมูล' : `$${value.toFixed(2)}`;
}

/*
  `/tools/what-if` and `/tools/monte-carlo` are statically prerendered, so whatever
  the first render returns is frozen into build-time HTML that every later visit
  hydrates against. `new Date()` here would bake the build day into the date
  inputs and the "วันหมดอายุ … DTE …" line — the exact text mismatch that raised
  React #418 on every day after a deploy — and `crypto.randomUUID()` would bake in
  a leg id no client workspace owns, leaving the contract selector pointing at a
  contract that is not there. The seed is therefore a pure constant, and the
  reader's own calendar day is applied by `withCalendarDates` from a mount effect.
*/
const SEED_LEG_ID = 'leg-1';
const SEED_SCENARIO_ID = 'scenario-1';
function seedLeg(): OptionLeg {
  return { id: SEED_LEG_ID, kind: 'call', side: 'buy', quantity: 1, strike: 0, expiration: '', entryPremium: 0,
    impliedVolatility: 0, multiplier: 100, fees: 0, style: 'european' };
}
function seedScenario(): ScenarioInput {
  return { id: SEED_SCENARIO_ID, name: 'Base', targetPrice: 0, valuationDate: '', volatilityShift: 0, rate: 0, dividendYield: 0 };
}
export function seedWorkspace(type: SimulationType): SimulationWorkspace {
  return { name: 'Options Simulation ใหม่', description: '', symbol: '', companyName: '', exchange: null, currency: 'USD',
    simulationType: type, strategyType: 'Custom Multi-Leg', underlyingPrice: null, stockQuantity: 0, cashPosition: 0,
    entryDate: '', valuationDate: '', legs: [seedLeg()], scenarios: [seedScenario()],
    monteCarlo: { paths: 10_000, seed: 42, horizonDays: 30, steps: 30, drift: 0, volatility: 0.2, rate: 0, dividendYield: 0 },
    dataSource: null, dataTimestamp: null, dataStatus: 'unavailable', resultSnapshot: null, methodologyVersion: 'options-simulator-v1' };
}
/** Fills only the seed's still-undated fields, so a restored draft keeps its own dates. */
export function withCalendarDates(workspace: SimulationWorkspace, today: string): SimulationWorkspace {
  return {
    ...workspace,
    entryDate: workspace.entryDate || today,
    valuationDate: workspace.valuationDate || today,
    legs: workspace.legs.map((leg) => leg.expiration ? leg : { ...leg, expiration: addCalendarDays(today, 30) }),
    scenarios: workspace.scenarios.map((scenario) => scenario.valuationDate
      ? scenario
      : { ...scenario, valuationDate: addCalendarDays(today, 1) }),
  };
}
function fresh(type: SimulationType): SimulationWorkspace {
  return withCalendarDates(seedWorkspace(type), day());
}
function normalizeUiWorkspace(value: SimulationWorkspace): SimulationWorkspace {
  const defaultMonteCarlo = seedWorkspace(value.simulationType ?? 'what-if').monteCarlo;
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
  const [workspace, setWorkspace] = useState(() => seedWorkspace(initialType));
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
  /*
    Everything the prerendered seed could not know is applied here, once hydration
    has committed: the reader's own calendar day first, then whatever draft they
    left behind. Reading either during render would put a build-time value back
    into the markup and mismatch again. `withCalendarDates` fills only still-empty
    fields, so a restored draft always keeps the dates it was saved with.
  */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const today = day();
      const importing = new URLSearchParams(window.location.search).has('contract');
      const draft = importing ? null : localStorage.getItem('nexora-options-simulator-draft-v1');
      let restored: SimulationWorkspace | null = null;
      if (draft) try {
        const parsed = normalizeUiWorkspace(JSON.parse(draft) as SimulationWorkspace);
        if (!calculationValidationMessages(parsed).length) restored = parsed;
      } catch { /* invalid drafts are ignored */ }
      setWorkspace((current) => withCalendarDates(restored ?? current, today));
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
        setOperationError(presentError(cause).message);
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
    if (tab === 'Monte Carlo Simulation' && !isBasicPathOption(workspace.monteCarlo.paths)) issues.push('monteCarlo.paths: จำนวนรอบจำลองต้องเป็น 1,000, 5,000, 10,000, 25,000 หรือ 50,000');
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
    if (analysisWorkspace().legs.some((leg) => leg.contractStatus === 'stale') && !confirm('ข้อมูลสัญญาที่นำเข้ามาเป็นข้อมูลเก่าแล้ว ต้องการคำนวณต่อด้วยข้อมูลชุดนี้หรือไม่?')) return;
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
      } else setOperationError(presentError(event.data.error).message);
    };
    instance.onerror = () => { if (runId !== workerRunId.current) return; instance.terminate(); worker.current = null; setRunning(false); setOperationError('ระบบจำลองผลไม่สำเร็จ กรุณาลองกดจำลองใหม่อีกครั้ง'); };
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
    if (!confirm(`ลบแบบจำลอง “${item.name}” หรือไม่?`)) return;
    if ((await fetch(`/api/option-simulations/${item.id}`, { method: 'DELETE' })).ok) void loadSaved();
  }

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
  // True once the mount effect has applied the reader's calendar day to the seed.
  const datesReady = Boolean(workspace.valuationDate);
  const calendarText = (value: string) => value || UNDATED_TEXT;
  const dayCountText = (value: number) => datesReady ? `${value} วัน` : UNDATED_TEXT;
  const dateIssue = datesReady ? targetDateError(scenario.valuationDate, workspace.valuationDate, earliestExpiration) : null;
  const sensitivity = useMemo(() => aggregateSensitivity(analysisWorkspaceValue), [analysisWorkspaceValue]);
  const priceImpactApprox = workspace.underlyingPrice === null ? null : sensitivity.delta * (scenario.targetPrice - workspace.underlyingPrice);
  const timeImpactApprox = sensitivity.theta * Math.max(0, calendarDaysBetween(workspace.valuationDate, scenario.valuationDate));
  const progressPercent = workspace.monteCarlo.paths > 0 ? Math.min(100, progress / workspace.monteCarlo.paths * 100) : 0;
  const calculateLabel = tab === 'Monte Carlo Simulation' ? 'เริ่มจำลอง' : 'คำนวณผลลัพธ์';
  const driftMode = workspace.monteCarlo.driftMode ?? 'forecast';
  const calculateDisabledReason = running ? 'กำลังคำนวณอยู่ กรุณารอให้เสร็จหรือกดยกเลิกก่อน' : null;
  const isSaving = saveStatus === 'Saving';
  const fieldError = (path: string) => {
    const issue = validationErrors.find((message) => validationMessageParts(message).path === path);
    return issue ? validationMessageParts(issue).reason : undefined;
  };
  const tabKey = tab === 'What-If Analysis' ? 'What-If' : tab === 'Monte Carlo Simulation' ? 'Monte Carlo' : tab;
  const tabDisplay = tabLabels[tabKey] ?? tabKey;
  // Only a persisted simulation has a real creation time; a fresh draft has none and must not borrow a provider timestamp.
  const createdAt = (workspace as Partial<Saved>).createdAt ?? null;

  // Short enough to survive the header's `truncate` at 320px, where the old English title ellipsed.
  return <div><Header title="จำลองออปชัน" subtitle="จำลองและวิเคราะห์เท่านั้น ไม่มีการส่งคำสั่งซื้อขายจริง" />
    <main className="mx-auto max-w-7xl space-y-5 p-4 pb-[calc(var(--dock-clearance)+5rem)] md:p-8">
      <div className="flex flex-wrap justify-between gap-2" data-testid="workspace-top-bar"><Button variant="ghost" onClick={() => router.push('/tools')}><ArrowLeft size={16} className="mr-2" />กลับไปหน้าเครื่องมือ</Button></div>
      <section className={box}><h2 className="mb-3 text-lg font-bold">เลือกหุ้นหรือ ETF</h2><div className="relative max-w-xl"><Search size={16} className="absolute left-3 top-3 text-slate-500" /><Input className="pl-9" value={query} data-validation-path="symbol" onChange={(event) => { setQuery(event.target.value); if (!event.target.value.trim()) setMatches([]); }} placeholder="ค้นหา Symbol หรือชื่อบริษัท" />{matches.length > 0 && <div className="absolute z-20 mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 shadow-2xl">{matches.map((asset) => <button key={asset.symbol} onClick={() => choose(asset)} className="flex w-full justify-between p-3 text-left hover:bg-slate-800"><span><strong>{asset.symbol}</strong> <span className="text-sm text-slate-400">{asset.name}</span></span><small>{asset.exchange} · {asset.assetType}</small></button>)}</div>}</div>
        {workspace.symbol ? <div className="mt-4 flex flex-wrap gap-4 rounded-xl bg-slate-900 p-3 text-sm"><strong>{workspace.symbol} · {workspace.companyName}</strong><span>{workspace.exchange ?? 'ไม่มีข้อมูลตลาด'}</span><span>{workspace.currency}</span><span>{workspace.underlyingPrice ?? 'ไม่มีข้อมูลราคา'}</span><span>{dataStatusLabels[workspace.dataStatus] ?? 'ไม่มีข้อมูล'}</span><span className="text-slate-500">{formatTimestamp(workspace.dataTimestamp, 'ไม่มีเวลาข้อมูล')}</span></div> : <p className="mt-3 text-sm text-amber-300">เลือกหุ้นจากระบบ ข้อมูลราคาหรือสัญญาจะไม่ถูกสร้างขึ้นเอง</p>}
        {workspace.symbol && <div className="mt-3 max-w-xs"><Numeric title="ราคาหุ้นปัจจุบัน" placeholder="เช่น 130" helper="กรอกเองเมื่อไม่มีราคาจากผู้ให้บริการ" value={workspace.underlyingPrice ?? 0} min={0.0000001} validationPath="underlyingPrice" onChange={(value) => { if (hasResults.current) setInputsOutdated(true); change({ underlyingPrice: value || null, dataStatus: 'manual' }); }} /></div>}
      </section>
      <Tabs tabs={Object.values(tabLabels)} activeTab={tabDisplay} onChange={(next) => {
        const key = Object.keys(tabLabels).find((item) => tabLabels[item] === next) ?? next;
        setTab(key === 'What-If' ? 'What-If Analysis' : key === 'Monte Carlo' ? 'Monte Carlo Simulation' : key);
      }} />
      <p className="text-sm text-slate-400" data-testid="tab-step-description">{stepDescriptions[tabKey]}</p>
      {(tab === 'What-If Analysis' || tab === 'Monte Carlo Simulation') && <>
        <ContractSummary workspace={workspace} selectedLegId={analysisSelection} onSelect={selectAnalysisContract} onEdit={() => setTab('Inputs')} />
      </>}
      {tab === 'What-If Analysis' && <section className={box} data-testid="what-if-controls">
        <h1 className="text-xl font-bold">{stepHeadings['What-If']}</h1>
        <p className="mb-5 text-sm text-slate-400">ตั้งราคาหุ้นที่อยากลอง วันที่ที่อยากดูผล และความผันผวน แล้วดูว่ากำไรหรือขาดทุนจะเป็นเท่าไร</p>
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-700 p-4"><Numeric title="ราคาหุ้นที่อยากลอง (Target Stock Price)" placeholder="เช่น 130" helper="ราคาหุ้นที่ต้องการทดลองว่าจะขึ้นหรือลงไปถึงระดับใด" min={0.0000001} externalError={fieldError('scenarios.0.targetPrice')} validationPath="scenarios.0.targetPrice" value={scenario.targetPrice} onChange={(value) => scenarioChange(0, { targetPrice: value })} />
            <input aria-label="ปรับราคาหุ้นที่อยากลองเป็นเปอร์เซ็นต์" className="mt-3 w-full accent-[#D4FF00]" type="range" min="-50" max="100" value={workspace.underlyingPrice ? Math.round((scenario.targetPrice / workspace.underlyingPrice - 1) * 100) : 0} onChange={(event) => scenarioChange(0, { targetPrice: (workspace.underlyingPrice ?? 0) * (1 + Number(event.target.value) / 100) })} />
            <p className="mt-1 text-xs text-slate-400">ราคาหุ้นปัจจุบัน {workspace.underlyingPrice?.toFixed(2) ?? 'ไม่มีข้อมูล'} · เปลี่ยนไป {workspace.underlyingPrice ? `${((scenario.targetPrice / workspace.underlyingPrice - 1) * 100).toFixed(1)}%` : 'ไม่มีข้อมูล'}</p></div>
          <div className="rounded-xl border border-slate-700 p-4"><FieldLabel title="วันที่ต้องการดูผล (Target Date)" helper="เลือกวันในอนาคต แต่ต้องไม่เกินวันหมดอายุ" /><div className="relative"><Input className="cursor-pointer pr-9" type="date" aria-label="วันที่ต้องการดูผล (Target Date)" min={minimumTargetDate} max={earliestExpiration} placeholder="เลือกวันที่จากปฏิทิน" value={scenario.valuationDate} data-validation-path="scenarios.0.valuationDate" onChange={(event) => scenarioChange(0, { valuationDate: clampTargetDate(event.target.value, workspace.valuationDate, earliestExpiration) })} /><CalendarDays aria-hidden="true" size={16} className="pointer-events-none absolute right-3 top-3 text-slate-500" /></div>
            <p className="mt-2 text-xs text-slate-400">วันหมดอายุ {calendarText(earliestExpiration)} · จำนวนวันที่เหลือก่อนหมดอายุ (DTE) {dayCountText(dte)}</p>{dateIssue && <p role="alert" className="mt-1 text-xs text-red-300">{dateIssue}</p>}</div>
          <div className="rounded-xl border border-slate-700 p-4"><PercentInput title="ความผันผวนที่ตลาดคาด (IV %)" placeholder="เช่น 114.50" helper="กรอกเป็นเปอร์เซ็นต์ เช่น 114.50 = 114.50%" value={currentIv * (1 + scenario.volatilityShift) * 100} onChange={(value) => scenarioChange(0, { volatilityShift: currentIv > 0 ? Math.max(-0.99, value / (currentIv * 100) - 1) : 0 })} />
            <input aria-label="ปรับความผันผวนที่ตลาดคาดเป็นเปอร์เซ็นต์" className="mt-3 w-full accent-[#D4FF00]" type="range" min="-90" max="200" value={Math.round(scenario.volatilityShift * 100)} onChange={(event) => scenarioChange(0, { volatilityShift: Number(event.target.value) / 100 })} />
            <p className="mt-1 text-xs text-slate-400">ความผันผวนปัจจุบัน {(currentIv * 100).toFixed(1)}% · ปรับไป {scenario.volatilityShift >= 0 ? '+' : ''}{(scenario.volatilityShift * 100).toFixed(1)}%</p></div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="sensitivity-summary"><Metric title="Delta ของทั้งสถานะ" value={`${formatResultMoney(sensitivity.delta, 'USD', null, true)} ต่อราคาหุ้นเปลี่ยน $1`} helper={DELTA_WHAT_IF_HELP} /><Metric title="มูลค่าที่ลดลงต่อวัน (Theta)" value={`${formatResultMoney(sensitivity.theta, 'USD', null, true)}/วัน`} helper={THETA_PER_DAY_HELP} /><Metric title="ผลจากราคาหุ้น" value={priceImpactApprox === null ? 'ไม่มีข้อมูล' : formatResultMoney(priceImpactApprox, 'USD', null, true)} helper={PRICE_IMPACT_HELP} /><Metric title="ผลจากเวลาที่ผ่านไป" value={formatResultMoney(timeImpactApprox, 'USD', null, true)} helper={TIME_IMPACT_HELP} /></div>
        <div className="mt-5 hidden justify-end md:flex" data-testid="desktop-calculate-action"><div><Button disabled={running} aria-describedby={calculateDisabledReason ? 'desktop-calculate-disabled-reason' : undefined} onClick={analyze}>{calculateLabel}</Button>{calculateDisabledReason && <p id="desktop-calculate-disabled-reason" className="mt-1 text-xs text-amber-300">{calculateDisabledReason}</p>}</div></div>
      </section>}
      {tab === 'Monte Carlo Simulation' && <section className={box} data-testid="monte-carlo-controls">
        <h1 className="text-xl font-bold">{stepHeadings['Monte Carlo']}</h1><p className="mb-5 text-sm text-slate-400">ระบบจำลองราคาหุ้นหลายพันสถานการณ์ แล้วสรุปว่าสถานะของคุณมีโอกาสกำไรหรือขาดทุนแค่ไหน</p>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"><div><Numeric title="ราคาหุ้นที่อยากลอง (Target Stock Price)" placeholder="เช่น 130" helper="ราคาที่อยากรู้ว่ามีโอกาสไปถึงมากน้อยแค่ไหน" min={0.0000001} externalError={fieldError('scenarios.0.targetPrice')} validationPath="scenarios.0.targetPrice" value={scenario.targetPrice} onChange={(value) => scenarioChange(0, { targetPrice: value })} /><p className="mt-1 text-xs text-slate-400">ต่างจากราคาปัจจุบัน {workspace.underlyingPrice ? `${((scenario.targetPrice / workspace.underlyingPrice - 1) * 100).toFixed(2)}%` : 'ไม่มีข้อมูล'}</p></div>
          <div><FieldLabel title="วันที่ต้องการดูผล (Target Date)" helper="วันที่อยากรู้ผล ระบบจะดูโอกาสไปถึงเป้าหมายภายในวันนี้" /><div className="relative"><Input className="cursor-pointer pr-9" type="date" aria-label="วันที่ต้องการดูผล ของการจำลองความเป็นไปได้" min={minimumTargetDate} max={earliestExpiration} value={scenario.valuationDate} data-validation-path="scenarios.0.valuationDate" onChange={(event) => scenarioChange(0, { valuationDate: clampTargetDate(event.target.value, workspace.valuationDate, earliestExpiration) })} /><CalendarDays aria-hidden="true" size={16} className="pointer-events-none absolute right-3 top-3 text-slate-500" /></div><p className="mt-2 text-xs text-slate-400">เหลือ {dayCountText(Math.max(0, calendarDaysBetween(workspace.valuationDate, scenario.valuationDate)))} · ไม่เกิน {calendarText(earliestExpiration)}</p>{dateIssue && <p role="alert" className="mt-1 text-xs text-red-300">{dateIssue}</p>}{analysisSelection === 'portfolio' && new Set(scopedLegs.map((leg) => leg.expiration)).size > 1 && <p className="mt-1 text-xs text-amber-300">เมื่อดูทั้งพอร์ต ระบบใช้วันหมดอายุที่ใกล้ที่สุดเป็นขอบเขต</p>}</div>
          <PercentInput title="ความผันผวนที่ตลาดคาด (IV %)" placeholder="เช่น 114.50" helper="กรอกเป็นเปอร์เซ็นต์ เช่น 114.50 = 114.50%" value={engineVolatilityToPercent(workspace.monteCarlo.volatility)} onChange={(value) => monteCarloChange({ volatility: percentVolatilityToEngine(value) })} />
          <div><FieldLabel title="รูปแบบการจำลอง" helper="เลือกวิธีที่ระบบใช้ประเมินผล" /><select aria-label="รูปแบบการจำลอง" className={select} value={driftMode} onChange={(event) => monteCarloChange({ driftMode: event.target.value as 'forecast' | 'risk-neutral' })}><option value="forecast">Forecast — คาดการณ์จากแนวโน้ม</option><option value="risk-neutral">Risk-neutral — มูลค่าตามมาตรฐานตลาด</option></select><p className="mt-1 text-[10px] leading-tight text-slate-500" data-testid="drift-mode-help">{driftModeHelp[driftMode]}</p></div>
          <div><FieldLabel title="จำนวนรอบจำลอง" helper="ยิ่งจำลองหลายรอบ ผลยิ่งนิ่ง แต่ใช้เวลานานขึ้น" /><select aria-label="จำนวนรอบจำลอง" className={select} value={workspace.monteCarlo.paths} data-validation-path="monteCarlo.paths" onChange={(event) => monteCarloChange({ paths: Number(event.target.value) })}>{BASIC_PATH_OPTIONS.map((value) => <option key={value} value={value}>{value.toLocaleString()}</option>)}</select>{fieldError('monteCarlo.paths') && <p role="alert" className="mt-1 text-xs text-red-300">{fieldError('monteCarlo.paths')}</p>}</div>
          <Metric title="Delta ของทั้งสถานะ" value={`${formatResultMoney(sensitivity.delta, 'USD', null, true)} ต่อราคาหุ้นเปลี่ยน $1`} helper={DELTA_MONTE_CARLO_HELP} /><Metric title="มูลค่าที่ลดลงต่อวัน (Theta)" value={`${formatResultMoney(sensitivity.theta, 'USD', null, true)}/วัน`} helper={THETA_PER_DAY_HELP} /><Metric title="จำนวนวันที่เหลือก่อนหมดอายุ (DTE)" value={dayCountText(monteCarloDte)} helper="ดึงจากวันหมดอายุ (Expiration) ในหน้าข้อมูลสัญญา" /><Metric title="เงินที่จ่ายเป็นค่าสัญญา" value={formatResultMoney(scopedLegs.reduce((sum, leg) => sum + leg.entryPremium * leg.quantity * leg.multiplier + leg.fees, 0), 'USD', null)} helper="เงินที่คุณจ่ายไปทั้งหมดเพื่อเปิดสถานะนี้ รวมค่าธรรมเนียมแล้ว" /></div>
        <p className="mt-4 text-xs text-slate-500">ค่าตั้งต้นอื่น ๆ ของการจำลอง ระบบกำหนดให้เอง เพื่อให้ผลแต่ละครั้งเทียบกันได้</p>
        {running && <div className="mt-5"><div className="mb-1 flex justify-between text-xs text-slate-400"><span>{progress.toLocaleString()} / {workspace.monteCarlo.paths.toLocaleString()}</span><span>{progressPercent.toFixed(0)}%</span></div><div className="h-2 rounded bg-slate-800"><div className="h-2 rounded bg-[#D4FF00]" style={{ width: `${progressPercent}%` }} /></div><Button className="mt-3 min-h-11" variant="danger" onClick={cancelWorker}>ยกเลิก</Button></div>}
        <div className="mt-5 hidden justify-end md:flex" data-testid="desktop-simulation-action"><div><Button disabled={running} aria-describedby={calculateDisabledReason ? 'desktop-simulation-disabled-reason' : undefined} onClick={analyze}>{calculateLabel}</Button>{calculateDisabledReason && <p id="desktop-simulation-disabled-reason" className="mt-1 text-xs text-amber-300">{calculateDisabledReason}</p>}</div></div>
      </section>}
      {resultsOutdated && (valuation || mc) && <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">{inputsOutdated ? 'ข้อมูลสัญญามีการเปลี่ยนแปลง กรุณาคำนวณใหม่' : 'ข้อมูลมีการเปลี่ยนแปลง กรุณาคำนวณใหม่'}</p>}
      {tab === 'What-If Analysis' && valuation && <WhatIfHighlights workspace={analysisWorkspace()} valuation={valuation} sensitivity={sensitivity} currency={resultCurrency} fxQuote={fxQuote} fxState={fxState} onCurrencyChange={setResultCurrency} />}
      {tab === 'Monte Carlo Simulation' && mc && <MonteCarloHighlights workspace={analysisWorkspace()} result={mc} scenarioScore={callPutScore} currency={resultCurrency} fxQuote={fxQuote} fxState={fxState} onCurrencyChange={setResultCurrency} />}
      {tab === 'Inputs' && <section className={box} data-testid="option-legs-form">
        <div className="mb-4"><h1 className="text-xl font-bold">{stepHeadings.Inputs}</h1><p className="mt-1 text-sm text-slate-400">{stepDescriptions.Inputs}</p>{createdAt && <p className="mt-1 text-xs text-slate-500" data-testid="workspace-created-at">สร้างแบบจำลองเมื่อ {formatTimestamp(createdAt)}</p>}</div>
        <div className="grid gap-3 md:grid-cols-3"><Field title="ชื่อแบบจำลอง" placeholder="เช่น Earnings Call" helper="ชื่อสำหรับค้นหาแบบจำลองภายหลัง" value={workspace.name} onChange={(value) => change({ name: value })} /><Field title="รูปแบบกลยุทธ์ (Strategy)" placeholder="เช่น Long Call" helper="ชื่อกลยุทธ์ที่ตรวจจับจากรายละเอียดสัญญา" value={workspace.strategyType} onChange={(value) => change({ strategyType: value })} /><div><FieldLabel title="วันที่ใช้คำนวณ (Valuation Date)" helper="วันที่ฐานสำหรับการคำนวณ" /><Input type="date" aria-label="วันที่ใช้คำนวณ (Valuation Date)" value={workspace.valuationDate} onChange={(event) => { if (hasResults.current) setInputsOutdated(true); change({ valuationDate: event.target.value, scenarios: workspace.scenarios.map((item, index) => index === 0 ? { ...item, valuationDate: clampTargetDate(item.valuationDate, event.target.value, workspace.legs.map((leg) => leg.expiration).sort()[0] ?? item.valuationDate) } : item) }); }} /></div></div>
        <div className="my-4"><h2 className="text-lg font-bold">รายละเอียดสัญญา (Option Legs)</h2><p className="text-xs text-slate-400">กรอกและแก้ไขข้อมูลสัญญาได้ที่นี่ที่เดียว</p></div>
        <div className="space-y-4">{workspace.legs.map((leg, index) => { const resolved = legSensitivity(workspace, leg); return <article key={leg.id} className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/20 p-4"><div className="mb-4 flex items-start justify-between gap-3"><div className="flex flex-wrap items-center gap-2"><strong>สัญญาที่ {index + 1}</strong><span className="rounded-full bg-violet-500/10 px-2 py-1 text-[10px] font-semibold text-violet-300">{leg.kind === 'call' ? 'Call' : 'Put'}</span><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${leg.side === 'buy' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>{leg.side === 'buy' ? 'Buy' : 'Sell'}</span>{leg.inputMode && <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${leg.inputMode === 'provider' ? 'bg-sky-500/10 text-sky-300' : 'bg-amber-500/10 text-amber-300'}`}>{leg.inputMode === 'provider' ? 'ข้อมูลจริง' : 'กำหนดเอง'}</span>}</div><div className="flex shrink-0 gap-1"><Button className="min-h-11 px-3" variant="ghost" aria-label={`ทำสำเนาสัญญาที่ ${index + 1}`} onClick={() => change({ legs: [...workspace.legs.slice(0, index + 1), { ...leg, id: uid(), inputMode: 'custom' }, ...workspace.legs.slice(index + 1)] })}><Copy size={15} /><span className="sr-only sm:not-sr-only sm:ml-2">ทำสำเนา</span></Button><Button className="min-h-11 min-w-11" variant="danger" aria-label={`ลบสัญญาที่ ${index + 1}`} disabled={workspace.legs.length === 1} onClick={() => change({ legs: workspace.legs.filter((_, i) => i !== index) })}><Trash2 size={15} /></Button></div></div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"><Choice title="ประเภทสัญญา (Call/Put)" value={leg.kind} options={['call', 'put']} optionLabels={{ call: 'Call', put: 'Put' }} validationPath={`legs.${index}.kind`} onChange={(value) => legChange(index, { kind: value as OptionLeg['kind'] })} /><Choice title="ฝั่งซื้อ/ขาย (Buy/Sell)" value={leg.side} options={['buy', 'sell']} optionLabels={{ buy: 'Buy', sell: 'Sell' }} validationPath={`legs.${index}.side`} onChange={(value) => legChange(index, { side: value as OptionLeg['side'] })} /><Numeric title="จำนวนสัญญา (Quantity)" placeholder="เช่น 1" min={1} integer helper="จำนวนสัญญาที่ต้องการวิเคราะห์" externalError={fieldError(`legs.${index}.quantity`)} validationPath={`legs.${index}.quantity`} value={leg.quantity} onChange={(value) => legChange(index, { quantity: value })} /><Numeric title="ราคาใช้สิทธิ (Strike Price)" placeholder="เช่น 120" min={0.0000001} helper="ราคาใช้สิทธิตามสัญญา" externalError={fieldError(`legs.${index}.strike`)} validationPath={`legs.${index}.strike`} value={leg.strike} onChange={(value) => legChange(index, { strike: value })} /></div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"><div><FieldLabel title="วันหมดอายุ (Expiration)" helper="วันหมดอายุของสัญญา" /><Input type="date" aria-label={`วันหมดอายุ ของสัญญาที่ ${index + 1}`} min={addCalendarDays(workspace.valuationDate, 1)} value={leg.expiration} data-validation-path={`legs.${index}.expiration`} onChange={(event) => legChange(index, { expiration: event.target.value })} />{fieldError(`legs.${index}.expiration`) && <p role="alert" className="mt-1 text-xs text-red-300">{fieldError(`legs.${index}.expiration`)}</p>}</div><PremiumInput value={leg.entryPremium} helper="ต้นทุนต่อหุ้น เช่น $1.40" externalError={fieldError(`legs.${index}.entryPremium`)} validationPath={`legs.${index}.entryPremium`} onChange={(value) => legChange(index, { entryPremium: value })} /><PercentInput title="ความผันผวนที่ตลาดคาด (IV %)" value={engineVolatilityToPercent(leg.impliedVolatility)} placeholder="เช่น 114.50" helper="กรอกเป็นเปอร์เซ็นต์ เช่น 114.50 = 114.50%" externalError={fieldError(`legs.${index}.impliedVolatility`)} validationPath={`legs.${index}.impliedVolatility`} onChange={(value) => legChange(index, { impliedVolatility: percentVolatilityToEngine(value) })} /><Numeric title="จำนวนหุ้นต่อ 1 สัญญา (Contract Multiplier)" placeholder="เช่น 100" min={0.0000001} helper="หุ้นสหรัฐฯ ส่วนใหญ่ 1 สัญญา = 100 หุ้น" externalError={fieldError(`legs.${index}.multiplier`)} validationPath={`legs.${index}.multiplier`} value={leg.multiplier} onChange={(value) => legChange(index, { multiplier: value })} /></div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-[50%]"><GreekInput title="ราคาสัญญาเปลี่ยนโดยประมาณเมื่อหุ้นเปลี่ยน $1 (Delta)" invalidMessage="Delta ต้องอยู่ระหว่าง -1 ถึง 1" placeholder="เช่น 0.35" helper="ค่าบวกคือขึ้นตามหุ้น ค่าลบคือสวนทางหุ้น" value={leg.delta ?? null} fallbackValue={resolved.delta} source={leg.deltaSource ?? (leg.delta == null ? 'model' : 'manual')} timestamp={leg.deltaTimestamp} min={-1} max={1} externalError={fieldError(`legs.${index}.delta`)} validationPath={`legs.${index}.delta`} onChange={(value) => legChange(index, { delta: value, deltaSource: value === null ? 'model' : 'manual', deltaTimestamp: null })} /><GreekInput title="มูลค่าที่ลดลงโดยประมาณต่อวัน (Theta/day)" invalidMessage="Theta ต้องเป็นตัวเลขที่ถูกต้อง" placeholder="เช่น -0.04" helper="มูลค่าที่หายไปในแต่ละวันจาก Time Decay" value={leg.theta ?? null} fallbackValue={resolved.theta} source={leg.thetaSource ?? (leg.theta == null ? 'model' : 'manual')} timestamp={leg.thetaTimestamp} externalError={fieldError(`legs.${index}.theta`)} validationPath={`legs.${index}.theta`} onChange={(value) => legChange(index, { theta: value, thetaSource: value === null ? 'model' : 'manual', thetaTimestamp: null })} /></div>
          {leg.contractSymbol && <ContractMarketData leg={leg} />}
        </article>; })}</div><Button className="mt-4 min-h-11 w-full border-dashed" variant="outline" onClick={() => change({ legs: [...workspace.legs, newLeg()] })}><Plus size={16} className="mr-2" />เพิ่มสัญญาอีก 1 รายการ</Button></section>}
      {validationErrors.length > 0 && <section role="alert" data-testid="validation-warning" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4"><strong>กรุณาตรวจสอบข้อมูลก่อนคำนวณ:</strong><ul className="list-disc pl-5 text-sm">{[...new Set(validationErrors.map(displayValidationMessage))].map((error) => <li key={error}>{error}</li>)}</ul></section>}
      {operationError && <section role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm">{operationError}</section>}
      {/* Steps 4 and 5 read from the What-If valuation, so they still announce themselves and say what to do when it has not been run yet. */}
      {tab === 'Payoff' && (valuation
        ? <Payoff heading={stepHeadings.Payoff} valuation={valuation} spot={workspace.underlyingPrice} currency={resultCurrency} usdThbRate={fxQuote ? Number(fxQuote.rate) : null} />
        : <StepPlaceholder heading={stepHeadings.Payoff} onGoToWhatIf={() => setTab('What-If Analysis')} />)}
      {tab === 'Greeks' && (valuation
        ? <section className={box}><h1 className="mb-3 text-xl font-bold">{stepHeadings.Greeks}</h1><div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Object.entries(valuation.greeks).map(([key, value]) => <Metric key={key} title={key === 'delta' ? 'Delta (ทั้งสถานะ)' : key[0].toUpperCase() + key.slice(1)} value={key === 'delta' ? `${formatResultMoney(value, 'USD', null, true)} ต่อราคาหุ้นเปลี่ยน $1 USD` : formatResultNumber(value, 4)} helper={greekHelpers[key]} />)}</div></section>
        : <StepPlaceholder heading={stepHeadings.Greeks} onGoToWhatIf={() => setTab('What-If Analysis')} />)}
      <section className={box} data-testid="save-simulation-actions"><h2 className="text-lg font-bold">บันทึกแบบจำลอง</h2><p className="mt-1 text-xs text-slate-400">บันทึกทับของเดิม หรือบันทึกเป็นสำเนาเพื่อเก็บเวอร์ชันก่อนหน้าไว้</p>
        <div className="mt-3 flex flex-wrap items-center gap-2"><Button variant="outline" disabled={isSaving} onClick={() => void save(true)}>{isSaving && savingMode === 'copy' ? <LoaderCircle aria-hidden="true" size={15} className="mr-2 animate-spin motion-reduce:animate-none" /> : <Copy aria-hidden="true" size={15} className="mr-2" />}บันทึกเป็นสำเนา</Button><Button disabled={isSaving} onClick={() => void save(saveStatus === 'Failed' && lastSaveMode.current === 'copy')}>{isSaving && savingMode === 'save' ? <LoaderCircle aria-hidden="true" size={15} className="mr-2 animate-spin motion-reduce:animate-none" /> : saveStatus === 'Saved' ? <Check aria-hidden="true" size={15} className="mr-2" /> : <Save aria-hidden="true" size={15} className="mr-2" />}{saveStatus === 'Failed' ? 'ลองบันทึกอีกครั้ง' : 'บันทึก'}</Button><span role="status" aria-live="polite" aria-atomic="true" className="inline-flex min-h-10 items-center gap-1.5 text-xs text-slate-400">{saveStatus === 'Saving' && <LoaderCircle aria-hidden="true" size={14} className="animate-spin motion-reduce:animate-none" />}{saveStatus === 'Saved' && <Check aria-hidden="true" size={14} className="text-emerald-400" />}{displayedSaveStatus[saveStatus] ?? saveStatus}</span></div></section>
      <section className={box}><div className="mb-3 flex flex-wrap justify-between gap-2"><h2 className="text-lg font-bold">แบบจำลองของฉัน</h2><div className="flex gap-2"><Input className="w-56" value={savedQuery} onChange={(event) => setSavedQuery(event.target.value)} placeholder="ค้นหาชื่อ หุ้น หรือกลยุทธ์" /><Button size="sm" variant="outline" onClick={() => { if (saveStatus === 'Saved' || confirm('ข้อมูลที่ยังไม่ได้บันทึกจะหายไป ต้องการทำต่อหรือไม่?')) setWorkspace(fresh(initialType)); }}><Plus size={14} /> สร้างใหม่</Button><Button size="sm" variant="danger" onClick={() => { if (confirm('ล้างข้อมูลทั้งหมดของแบบจำลองนี้หรือไม่?')) { setWorkspace(fresh(initialType)); setSaveStatus('Unsaved'); } }}>ล้างข้อมูล</Button></div></div>{savedState === 'loading' ? <div className="h-20 animate-pulse rounded bg-slate-800" /> : savedState === 'error' ? <Button onClick={() => void loadSaved()}>ลองใหม่</Button> : saved.length === 0 ? <p className="text-sm text-slate-400">ยังไม่มีแบบจำลองบนเซิร์ฟเวอร์ เข้าสู่ระบบเพื่อบันทึก โดยระบบจะเก็บฉบับร่างไว้ในเครื่อง</p> : <div className="grid gap-3 md:grid-cols-2">{saved.filter((item) => `${item.name} ${item.symbol} ${item.strategyType} ${item.simulationType}`.toLowerCase().includes(savedQuery.toLowerCase())).map((item) => <article key={item.id} className="rounded-xl border border-slate-700 p-3"><strong>{item.name}</strong><p className="text-xs text-slate-400">{item.symbol} · {item.strategyType} · {simulationTypeLabels[item.simulationType] ?? item.simulationType} · {formatTimestamp(item.updatedAt)} · {dataStatusLabels[item.dataStatus] ?? 'ไม่มีข้อมูล'}</p><div className="mt-2 flex gap-2"><Button size="sm" onClick={() => { if (saveStatus === 'Saved' || confirm('ข้อมูลที่ยังไม่ได้บันทึกจะหายไป ต้องการทำต่อหรือไม่?')) { setWorkspace(normalizeUiWorkspace(item)); setValuation(item.resultSnapshot?.whatIf ?? null); setMc(item.resultSnapshot?.monteCarlo ?? null); setCallPutScore(null); setSaveStatus('Saved'); } }}>เปิด</Button><Button size="sm" variant="outline" onClick={() => { setWorkspace(normalizeUiWorkspace({ ...item, id: undefined, updatedAt: undefined, name: `${item.name} (copy)`, legs: item.legs.map((leg) => ({ ...leg, id: uid() })), scenarios: item.scenarios.map((scenario) => ({ ...scenario, id: uid() })) })); setSaveStatus('Unsaved'); }}>ทำสำเนา</Button><Button size="sm" variant="danger" onClick={() => void remove(item)}>ลบ</Button></div></article>)}</div>}</section>
      <p className="rounded-xl border border-slate-800 p-4 text-xs text-slate-500"><strong>สิ่งที่ควรรู้ก่อนใช้ผลลัพธ์:</strong> ตัวเลขทั้งหมดมาจากแบบจำลองมาตรฐานของตลาดออปชัน (Black-Scholes และ binomial tree) ซึ่งตั้งสมมติฐานว่าความผันผวนและแนวโน้มคงที่ แบบจำลองยังไม่รวมการถูกใช้สิทธิก่อนกำหนด ภาษี ส่วนต่างราคาซื้อขาย และสภาพคล่องที่แท้จริง ผลลัพธ์จึงเป็นเครื่องมือประกอบการวิเคราะห์ ไม่ใช่คำแนะนำซื้อขายและไม่รับประกันผลตอบแทน</p>
    </main>{(tab === 'What-If Analysis' || tab === 'Monte Carlo Simulation') && <div data-testid="mobile-calculate-action" className="fixed inset-x-0 bottom-[var(--dock-clearance)] z-40 border-t border-slate-800 bg-slate-950/95 p-3 backdrop-blur md:hidden"><Button className="min-h-11 w-full" disabled={running} aria-describedby={calculateDisabledReason ? 'mobile-calculate-disabled-reason' : undefined} onClick={analyze}>{calculateLabel}</Button>{calculateDisabledReason && <p id="mobile-calculate-disabled-reason" className="mt-1 text-center text-xs text-amber-300">{calculateDisabledReason}</p>}</div>}
    <Modal isOpen={Boolean(pending)} onClose={() => setPending(null)} title="เปลี่ยนหุ้นอ้างอิงหรือไม่?"><p className="mb-3 text-sm">ราคาใช้สิทธิ วันหมดอายุ ราคาสัญญา และความผันผวนจะถูกล้าง เพราะค่าเหล่านี้ใช้กับหุ้นตัวใหม่ไม่ได้</p><div className="space-y-2"><Button className="w-full" onClick={() => pending && void setSymbol(pending)}>เริ่มใหม่ทั้งหมด</Button><Button className="w-full" variant="outline" onClick={() => pending && void setSymbol(pending, true)}>เก็บการตั้งค่าไว้ แต่ล้างข้อมูลสัญญา</Button><Button className="w-full" variant="ghost" onClick={() => setPending(null)}>ยกเลิก</Button></div></Modal>
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
function StepPlaceholder({ heading, onGoToWhatIf }: { heading: string; onGoToWhatIf: () => void }) {
  return <section className={box} data-testid="step-placeholder">
    <h1 className="text-xl font-bold">{heading}</h1>
    <p className="mt-2 text-sm text-slate-400">ขั้นตอนนี้ใช้ผลจากขั้นที่ 2 กรุณากด “คำนวณผลลัพธ์” ก่อน แล้วกลับมาดูที่นี่</p>
    <Button className="mt-3" size="sm" variant="outline" onClick={onGoToWhatIf}>ไปที่ขั้นที่ 2 ทดลองสถานการณ์</Button>
  </section>;
}
// A field's helper is a subtitle needed to fill the field in, so it stays visible; only metric explanations are disclosed.
function FieldLabel({ title, helper, htmlFor }: { title: string; helper?: string; htmlFor?: string }) { return <><label htmlFor={htmlFor} className={label}>{title}</label>{helper && <Helper id={htmlFor ? `${htmlFor}-helper` : undefined}>{helper}</Helper>}</>; }
type NumericProps = { title: string; value: number; step?: string; helper?: string; suffix?: string; placeholder?: string; min?: number; max?: number; validationPath?: string; onChange: (value: number) => void };
type ValidatedNumericProps = NumericProps & { integer?: boolean; externalError?: string };
function Numeric({ title, value, step = 'any', helper, suffix, placeholder, min, max, integer = false, externalError, validationPath, onChange }: ValidatedNumericProps) {
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
  return <div><FieldLabel htmlFor={id} title={title} helper={helper} /><div className="relative"><Input id={id} aria-describedby={helper ? `${id}-helper` : undefined} aria-invalid={Boolean(error)} className={suffix ? 'pr-10' : undefined} type="text" inputMode="decimal" placeholder={placeholder} value={draft} onFocus={(event) => { focused.current = true; if (value === 0) event.currentTarget.select(); }} onChange={(event) => { setDraft(event.target.value); setDraftError(null); }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} data-step={step} data-validation-path={validationPath} />{suffix && <span className="pointer-events-none absolute right-3 top-2.5 text-xs text-slate-500">{suffix}</span>}</div>{error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}</div>;
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
  return <div><FieldLabel htmlFor={id} title="ราคาสัญญาต่อหุ้น (Premium)" helper={helper} /><div className="relative"><span className="pointer-events-none absolute left-3 top-2.5 text-sm text-slate-400">$</span><Input id={id} className="pl-8" type="text" inputMode="decimal" placeholder="เช่น 1.40" value={formatPremiumDigits(digits)} aria-invalid={Boolean(error)} data-validation-path={validationPath} onFocus={() => { focused.current = true; }} onChange={(event) => { commitDigits(event.target.value); setDraftError(null); }} onPaste={(event) => { event.preventDefault(); const parsed = parsePremiumPaste(event.clipboardData.getData('text')); if (parsed === null) { setDraftError('Premium ต้องเป็นจำนวนเงินที่ไม่ติดลบ'); return; } setDraftError(null); commitDigits(premiumDigitsFromValue(parsed)); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'v', 'x'].includes(event.key.toLowerCase())) return; if (/^\d$/.test(event.key)) { event.preventDefault(); commitDigits(`${digits}${event.key}`); } else if (event.key === 'Backspace') { event.preventDefault(); commitDigits(digits.slice(0, -1)); } else if (event.key === 'Delete') { event.preventDefault(); commitDigits(''); } else if (event.key === 'Enter') event.currentTarget.blur(); }} onBlur={() => { focused.current = false; if (digits && premiumFromDigitString(digits) === null) setDraftError('Premium ต้องเป็นจำนวนเงินที่ไม่ติดลบ'); }} /></div>{error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}</div>;
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

function GreekInput({ title, invalidMessage, value, fallbackValue, source, timestamp, helper, placeholder, min, max, externalError, validationPath, onChange }: { title: string; invalidMessage: string; value: number | null; fallbackValue: number | null; source: OptionLeg['deltaSource']; timestamp?: string | null; helper: string; placeholder: string; min?: number; max?: number; externalError?: string; validationPath?: string; onChange: (value: number | null) => void }) {
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
    if (parsed === null || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)) { setDraftError(invalidMessage); return; }
    setDraftError(null); onChange(parsed); setDraft(String(parsed));
  };
  const labelText = source === 'provider' ? 'ข้อมูลจากผู้ให้บริการ' : source === 'manual' ? 'คุณกรอกเอง' : 'ระบบประเมินให้';
  const error = draftError ?? externalError;
  return <div><div className="flex items-start justify-between gap-2"><FieldLabel htmlFor={id} title={title} helper={helper} />{source === 'manual' && <button type="button" className="text-[10px] text-[#D4FF00]" onClick={() => onChange(null)}>ใช้ค่าระบบ</button>}</div><Input id={id} type="text" inputMode="decimal" placeholder={placeholder} value={draft} aria-invalid={Boolean(error)} data-validation-path={validationPath} onFocus={(event) => { focused.current = true; event.currentTarget.select(); }} onChange={(event) => { setDraft(event.target.value); setDraftError(null); }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><p className={`mt-1 text-[10px] ${source === 'manual' ? 'text-amber-300' : source === 'provider' ? 'text-emerald-300' : 'text-slate-400'}`}>{labelText}{source === 'provider' && timestamp ? ` · ${formatTimestamp(timestamp)}` : ''}</p>{error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}</div>;
}
function Field({ title, value, helper, placeholder, onChange }: { title: string; value: string; helper?: string; placeholder?: string; onChange: (value: string) => void }) { const id = useId(); return <div><FieldLabel htmlFor={id} title={title} helper={helper} /><Input id={id} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} /></div>; }
function Choice({ title, value, options, optionLabels = {}, helper, validationPath, onChange }: { title: string; value: string; options: string[]; optionLabels?: Record<string, string>; helper?: string; validationPath?: string; onChange: (value: string) => void }) { const id = useId(); return <div><FieldLabel htmlFor={id} title={title} helper={helper} /><select id={id} className={select} value={value} data-validation-path={validationPath} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{optionLabels[option] ?? option}</option>)}</select></div>; }
/*
  Every metric card explains itself through one collapsed disclosure. The old
  layout paired a hover-only ⓘ with an always-printed helper line, so the
  explanation was on screen before anyone pressed the icon.
*/
function Metric({ title, value, helper }: { title: string; value: string; helper?: string }) { return <div className="min-w-0 rounded-xl bg-slate-900 p-3" data-metric={title}><small className="text-slate-500">{title}</small><p className="break-words font-mono font-bold">{value}</p>{helper && <MetricDisclosure summary="ดูคำอธิบาย" openSummary="ซ่อนคำอธิบาย" label={title} className="mt-2">{helper}</MetricDisclosure>}</div>; }
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
  return <section className={box} data-testid="contract-summary"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold">เลือกสัญญาหรือทั้งพอร์ตที่ต้องการทดลอง</h2><p className="text-xs text-slate-400">เลือกทั้งพอร์ตหรือรายสัญญา ระบบจะดึงค่าจากหน้าข้อมูลสัญญาให้อัตโนมัติ</p></div><Button size="sm" variant="outline" onClick={onEdit}>แก้ไขข้อมูลสัญญา</Button></div>
    <div className="mb-4 max-w-md"><FieldLabel htmlFor={selectorId} title="สัญญา" helper="เปลี่ยนสัญญาแล้วจะรีเซ็ตเฉพาะค่าจำลองที่ขึ้นกับสัญญา" /><select id={selectorId} aria-label="เลือกสัญญาหรือทั้งพอร์ตที่ต้องการทดลอง" className={select} value={selectedLegId} onChange={(event) => onSelect(event.target.value)}><option value="portfolio">ทั้งพอร์ต</option>{workspace.legs.map((leg, index) => <option key={leg.id} value={leg.id}>สัญญาที่ {index + 1} · {leg.side === 'buy' ? 'Buy' : 'Sell'} {leg.kind === 'call' ? 'Call' : 'Put'} · ราคาใช้สิทธิ {leg.strike}</option>)}</select></div>
    <div className="space-y-3">{summaryLegs.map(({ leg, dte, legNumber, resolved }) => <article key={leg.id} className="grid grid-cols-2 gap-3 rounded-xl border border-slate-700 p-3 text-sm sm:grid-cols-3 lg:grid-cols-6"><span className="sr-only">สัญญาที่ {legNumber}</span><SummaryValue label="ประเภทสัญญา" value={leg.kind === 'call' ? 'Call' : 'Put'} /><SummaryValue label="ฝั่งซื้อ/ขาย" value={leg.side === 'buy' ? 'Buy' : 'Sell'} /><SummaryValue label="จำนวนสัญญา" value={leg.quantity.toString()} /><SummaryValue label="ราคาใช้สิทธิ (Strike)" value={leg.strike.toString()} /><SummaryValue label="วันหมดอายุ" value={leg.expiration || UNDATED_TEXT} /><SummaryValue label="ราคาสัญญาต่อหุ้น (Premium)" value={`$${leg.entryPremium.toFixed(2)}`} /><SummaryValue label="ความผันผวนที่ตลาดคาด (IV)" value={`${engineVolatilityToPercent(leg.impliedVolatility).toFixed(2)}%`} /><SummaryValue label="Delta ต่อหุ้น" value={resolved.delta === null ? 'ไม่มีข้อมูล' : `${formatResultMoney(resolved.delta, 'USD', null, true)}/หุ้น ต่อราคาหุ้นเปลี่ยน $1 USD · ${sourceLabel(resolved.deltaSource)}`} /><SummaryValue label="Theta/day ต่อหุ้น" value={resolved.theta === null ? 'ไม่มีข้อมูล' : `${formatResultMoney(resolved.theta, 'USD', null, true)}/หุ้น/วัน · ${sourceLabel(resolved.thetaSource)}`} /><SummaryValue label="จำนวนหุ้นต่อ 1 สัญญา" value={leg.multiplier.toString()} /><SummaryValue label="จำนวนวันที่เหลือก่อนหมดอายุ (DTE)" value={date ? `${dte} วัน` : UNDATED_TEXT} />{(leg.deltaSource === 'provider' || leg.thetaSource === 'provider') && <SummaryValue label="ข้อมูลราคา ณ เวลา" value={leg.deltaTimestamp ?? leg.thetaTimestamp ?? 'ไม่มีข้อมูล'} />}</article>)}</div></section>;
}
function sourceLabel(source: OptionLeg['deltaSource']) { return source === 'provider' ? 'ข้อมูลจริง' : source === 'manual' ? 'กรอกเอง' : 'ระบบประเมิน'; }

const contractStatusLabels: Record<NonNullable<OptionLeg['contractStatus']>, string> = {
  live: 'เรียลไทม์',
  delayed: 'ล่าช้า',
  cached: 'จากแคช',
  stale: 'เก่า',
};
/*
  The premium basis is read back from the leg's real `premiumSource`; it is never
  inferred from Buy/Sell, so a manually typed premium keeps saying so.
*/
const premiumBasisLabels: Record<NonNullable<OptionLeg['premiumSource']>, string> = {
  manual: 'กรอกเอง',
  mark: 'ราคากลาง (Mark)',
  bid: 'ราคาที่มีผู้เสนอซื้อ (Bid)',
  ask: 'ราคาที่มีผู้เสนอขาย (Ask)',
  last: 'ราคาล่าสุด (Last)',
};

/**
 * The market snapshot behind one imported contract, written for a reader who has
 * never seen an option chain. The provider identifiers stay available — they
 * just move into a disclosure instead of leading with a raw contract symbol.
 *
 * Nothing here is inferred: a field with no value says so, the timestamp is the
 * provider's own quote time (never presented as a creation date), and the
 * expiration is the contract's real expiration.
 */
function ContractMarketData({ leg }: { leg: OptionLeg }) {
  const stale = leg.contractStatus === 'stale';
  const manualEntry = leg.premiumSource === 'manual' || leg.premiumSource === undefined;
  return <div className={`mt-3 rounded-lg border p-3 text-xs ${stale ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-slate-700 bg-slate-950/40 text-slate-300'}`} data-testid="contract-market-data">
    <p className="font-semibold text-slate-100">ข้อมูลตลาดของสัญญา</p>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      <div><dt className="text-slate-500">วันหมดอายุสัญญา</dt><dd>{leg.expiration}</dd></div>
      <div><dt className="text-slate-500">ข้อมูลราคา ณ เวลา</dt><dd>{formatTimestamp(leg.contractAsOf)}</dd></div>
      <div><dt className="text-slate-500">สถานะข้อมูล</dt><dd>{leg.contractStatus ? contractStatusLabels[leg.contractStatus] : 'ไม่มีข้อมูล'}</dd></div>
      <div><dt className="text-slate-500">ราคาล่าสุด</dt><dd className="font-mono">{optionQuoteValue(leg.last)}</dd></div>
      <div><dt className="text-slate-500">ราคาที่มีผู้เสนอซื้อ</dt><dd className="font-mono">{optionQuoteValue(leg.bid)}</dd></div>
      <div><dt className="text-slate-500">ราคาที่มีผู้เสนอขาย</dt><dd className="font-mono">{optionQuoteValue(leg.ask)}</dd></div>
      <div><dt className="text-slate-500">ราคากลาง</dt><dd className="font-mono">{optionQuoteValue(leg.midpoint)}</dd></div>
      <div><dt className="text-slate-500">ราคาที่ใช้เริ่มคำนวณ</dt><dd>{leg.premiumSource ? premiumBasisLabels[leg.premiumSource] : 'กรอกเอง'}</dd></div>
    </dl>
    {manualEntry && <p className="mt-2">ราคาตลาดด้านบนใช้สำหรับอ้างอิง และไม่ได้ถูกนำมาแทนราคาที่คุณกรอก</p>}
    {stale && <p className="mt-2">ข้อมูลชุดนี้เก่าแล้ว ระบบจะถามยืนยันอีกครั้งก่อนคำนวณ</p>}
    <MetricDisclosure summary="รายละเอียดข้อมูลทางเทคนิค" icon="chevron" className="mt-3" triggerClassName="text-xs font-semibold text-[#D4FF00]">
      <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <div><dt className="text-slate-500">รหัสสัญญา</dt><dd className="font-mono break-all">{leg.contractSymbol ?? 'ไม่มีข้อมูล'}</dd></div>
        <div><dt className="text-slate-500">ผู้ให้บริการข้อมูล</dt><dd>{leg.contractProvider ?? 'ไม่มีข้อมูล'}</dd></div>
        <div><dt className="text-slate-500">ข้อมูล ณ เวลา</dt><dd>{leg.contractAsOf ?? 'ไม่มีข้อมูล'}</dd></div>
        <div><dt className="text-slate-500">สถานะข้อมูล</dt><dd>{leg.contractStatus ? contractStatusLabels[leg.contractStatus] : 'ไม่มีข้อมูล'}</dd></div>
        <div><dt className="text-slate-500">ที่มาของราคาสัญญา</dt><dd>{leg.premiumSource ? premiumBasisLabels[leg.premiumSource] : 'กรอกเอง'}</dd></div>
        <div><dt className="text-slate-500">วิธีกรอกข้อมูล</dt><dd>{leg.inputMode === 'provider' ? 'นำเข้าจากข้อมูลจริง' : 'กรอกเอง'}</dd></div>
      </dl>
    </MetricDisclosure>
  </div>;
}
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
      {fxQuote ? <div className="text-right text-xs text-slate-400"><p>1 USD = {Number(fxQuote.rate).toFixed(2)} THB <span className={`ml-1 rounded-full px-2 py-0.5 font-semibold uppercase ${fxQuote.stale ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`}>{status}</span></p><p>อัตรา ณ {formatTimestamp(fxQuote.asOf)} · {fxQuote.source}</p></div>
        : <p role="status" className="text-xs text-amber-300">{fxState === 'loading' ? 'กำลังโหลดอัตราแลกเปลี่ยน ยังเลือกบาทไม่ได้' : 'ยังไม่มีอัตราแลกเปลี่ยนที่ใช้ได้ จึงแสดงผลเป็นดอลลาร์เท่านั้น'}</p>}
    </div>
    <p className="mt-2 text-[11px] text-slate-500">ระบบคำนวณเป็นดอลลาร์เสมอ การเลือกบาทเป็นการแปลงหน่วยตอนแสดงผลเท่านั้น ตัวเลขผลลัพธ์ไม่เปลี่ยน</p>
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
  return <div className="min-w-0 rounded-xl bg-slate-900 p-3" data-metric={title}><small className="text-slate-500">{title}</small><ProfitLossValue amount={amount} denominator={denominator} currency={currency} usdThbRate={usdThbRate} prefix={title} />{helper && <MetricDisclosure summary="ดูคำอธิบาย" openSummary="ซ่อนคำอธิบาย" label={title} className="mt-2">{helper}</MetricDisclosure>}</div>;
}

function ExplainedProfitLossMetric({ title, amount, currency, usdThbRate, helper }: { title: string; amount: number; currency: ResultCurrency; usdThbRate: number | null; helper: string }) {
  const state = profitLossState(amount);
  return <div className="min-w-0 rounded-xl bg-slate-900 p-3" data-metric={title}>
    <small className="text-slate-400">{title}</small>
    <p className={`mt-1 break-words font-mono font-bold ${profitLossToneClass(state)}`}>{formatResultMoney(amount, currency, usdThbRate, true)}</p>
    <MetricDisclosure summary="ดูคำอธิบาย" openSummary="ซ่อนคำอธิบาย" label={title} className="mt-2">{helper}</MetricDisclosure>
  </div>;
}

/** Says which money the percentage is measured against — never the division itself. */
function profitLossPercentBasis(policy: ReturnType<typeof portfolioProfitLossBasis>['policy']): string {
  if (policy === 'absolute-net-debit') return 'เปอร์เซ็นต์วัดเทียบกับเงินสุทธิที่คุณจ่ายไปเพื่อเปิดสถานะนี้';
  if (policy === 'gross-premium-at-risk') return 'เปอร์เซ็นต์วัดเทียบกับเงินที่คุณเสี่ยงไว้กับสถานะฝั่งขายนี้';
  return 'สถานะนี้ยังไม่มีฐานเงินที่เสี่ยงมากกว่า 0 จึงคิดเป็นเปอร์เซ็นต์ไม่ได้';
}

const auditStatusLabels: Record<string, string> = { matched: 'ตรงกัน', mismatch: 'พบส่วนต่าง', unavailable: 'ข้อมูลไม่พอ' };

function ExplainedResultMetric({ title, value, helper, toneClass = 'text-slate-100', secondary }: { title: string; value: string; helper: string; toneClass?: string; secondary?: string }) {
  return <div className="min-w-0 rounded-xl bg-slate-900 p-3" data-metric={title}>
    <small className="text-slate-400">{title}</small>
    <p className={`mt-1 break-words font-mono font-bold ${toneClass}`}>{value}</p>
    {secondary && <p className="mt-1 text-xs text-slate-400">{secondary}</p>}
    <MetricDisclosure summary="ดูคำอธิบาย" openSummary="ซ่อนคำอธิบาย" label={title} className="mt-2">{helper}</MetricDisclosure>
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
    ? 'ตรวจสอบแล้ว ตัวเลขทุกส่วนสอดคล้องกัน'
    : audit.impactDecomposition.status === 'unavailable'
      ? 'ยังตรวจสอบที่มาของกำไร/ขาดทุนไม่ได้ เพราะข้อมูลบางส่วนยังไม่ครบ'
      : 'พบส่วนต่างเล็กน้อยจากการตรวจสอบ ดูได้ที่ “ผลอื่น ๆ”';
  return <section className={box} data-testid="what-if-results"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold">ผลลัพธ์การทดลอง</h2><p className="text-xs text-slate-400">กำไรหรือขาดทุนที่คาดว่าจะได้ จากสถานการณ์ที่คุณตั้งไว้</p></div><span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">สกุลเงินที่เลือก: {currency}</span></div>
    <ResultCurrencyControl currency={currency} fxQuote={fxQuote} fxState={fxState} onCurrencyChange={onCurrencyChange} />
    <p className={`mt-4 rounded-xl border p-4 text-sm ${state === 'profit' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : state === 'loss' ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-slate-600 bg-slate-800/60 text-slate-200'}`} role="status">
      {buildProfitLossSummary(valuation.profitLoss, basis.amount, currency, usdThbRate)}
    </p>

    <div data-testid="result-summary">
      <ResultGroup title="สรุปผลสำคัญ" testId="result-group-key-summary">
        <ExplainedResultMetric title="กำไร/ขาดทุนที่คาดจากสถานการณ์ (Projected P&L)" value={formatResultMoney(valuation.profitLoss, currency, usdThbRate, true)} toneClass={profitLossToneClass(state)} helper="กำไรหรือขาดทุนที่คาดว่าจะได้ หากราคาหุ้นและเวลาเป็นไปตามที่ทดลองไว้ รวมค่าธรรมเนียมแล้ว" />
        <ExplainedResultMetric title="กำไร/ขาดทุน (%)" value={formatSignedPercent(percentage)} toneClass={profitLossToneClass(state)} helper="กำไรหรือขาดทุนคิดเป็นกี่เปอร์เซ็นต์ของเงินที่คุณเสี่ยงไปตั้งแต่แรก" />
        <ExplainedResultMetric title="ราคาคุ้มทุนต่อหุ้น (Break-even)" value={breakEvenValue} helper="ราคาหุ้นในวันหมดอายุที่ทำให้คุณไม่กำไรและไม่ขาดทุน ต่ำกว่านี้เริ่มขาดทุน" />
      </ResultGroup>

      <ResultGroup title="มูลค่าสถานะ" testId="result-group-position-value">
        <ExplainedResultMetric title="มูลค่าปัจจุบัน (Current Value)" value={current ? formatResultMoney(current.theoreticalValue, currency, usdThbRate) : 'ไม่มีข้อมูล'} helper="มูลค่าของสถานะนี้ ณ ราคาหุ้นและวันที่ปัจจุบัน ค่าติดลบเกิดได้กับสถานะที่เป็นฝั่งขาย" />
        <ExplainedResultMetric title="มูลค่าหลังทดลอง (Simulated Value)" value={formatResultMoney(valuation.theoreticalValue, currency, usdThbRate)} helper="มูลค่าของสถานะนี้หากสถานการณ์เป็นไปตามที่ทดลองไว้ ยังไม่ได้หักต้นทุนที่จ่ายไปตอนเปิดสถานะ" />
        <ExplainedResultMetric title="เพิ่ม/ลดจากปัจจุบัน (Change from Current)" value={difference === null ? 'ไม่มีข้อมูล' : formatResultMoney(difference, currency, usdThbRate, true)} toneClass={difference === null ? 'text-slate-100' : profitLossToneClass(profitLossState(difference))} helper="มูลค่าสถานะเพิ่มขึ้นหรือลดลงเท่าไร เมื่อเทียบกับตอนนี้" />
      </ResultGroup>

      <ResultGroup title="ความเสี่ยงสูงสุด" testId="result-group-maximum-risk">
        <ExplainedResultMetric title="กำไรสูงสุด (Max Profit)" value={valuation.unlimitedProfit ? 'ไม่จำกัด' : formatResultMoney(valuation.maxProfit ?? Number.NaN, currency, usdThbRate, true)} toneClass="text-emerald-400" helper="กำไรมากที่สุดที่สถานะนี้เป็นไปได้ ถ้ากำไรเพิ่มได้ไม่สิ้นสุดจะแสดงว่าไม่จำกัด" />
        <ExplainedResultMetric title="ขาดทุนสูงสุด (Max Loss)" value={valuation.unlimitedLoss ? 'ไม่จำกัด' : formatResultMoney(valuation.maxLoss ?? Number.NaN, currency, usdThbRate, true)} toneClass="text-red-400" helper="เงินมากที่สุดที่คุณเสี่ยงจะเสียไปกับสถานะนี้ ถ้าขาดทุนเพิ่มได้ไม่สิ้นสุดจะแสดงว่าไม่จำกัด" />
      </ResultGroup>

      <ResultGroup title="ที่มาของกำไร/ขาดทุน" testId="result-group-estimate-details" summary="แยกให้เห็นว่ากำไรหรือขาดทุนมาจากราคาหุ้น จากเวลา และจากความผันผวน อย่างละเท่าไร">
        <ExplainedResultMetric title="ผลจากราคาหุ้น (Price Impact)" value={priceImpact === null ? 'ไม่มีข้อมูล' : formatResultMoney(priceImpact, currency, usdThbRate, true)} helper={PRICE_IMPACT_HELP} />
        <ExplainedResultMetric title="ผลจากเวลาที่ผ่านไป (Time Decay)" value={timeImpact === null ? 'ไม่มีข้อมูล' : formatResultMoney(timeImpact, currency, usdThbRate, true)} helper={TIME_IMPACT_HELP} />
        <ExplainedResultMetric title="ผลจาก IV (IV Impact)" value={ivImpact === null ? 'ไม่มีข้อมูล' : formatResultMoney(ivImpact, currency, usdThbRate, true)} helper="ส่วนที่เปลี่ยนไปเพราะตลาดคาดว่าราคาหุ้นจะเหวี่ยงมากขึ้นหรือน้อยลงกว่าเดิม" />
        <ExplainedResultMetric title="ค่าประมาณจาก Delta (ทั้งสถานะ)" value={audit.deltaEstimate === null ? 'ไม่มีข้อมูล' : `${formatResultMoney(audit.deltaEstimate, currency, usdThbRate, true)} ต่อราคาหุ้นเปลี่ยน $1 USD`} helper="ค่าเทียบเคียงจาก Delta ว่ามูลค่าน่าจะเปลี่ยนเท่าไรเมื่อราคาหุ้นขยับ 1 ดอลลาร์ เป็นตัวเลขไว้เทียบเท่านั้น ไม่ใช่กำไรที่ได้เพิ่ม" />
        {audit.impactDecomposition.residual !== null && audit.impactDecomposition.residual !== 0 && <ExplainedResultMetric title="ผลอื่น ๆ (Other Impact)" value={formatResultMoney(audit.impactDecomposition.residual, currency, usdThbRate, true)} helper="ส่วนต่างเล็กน้อยที่เหลือจากการแยกผลข้างต้น เกิดจากปัจจัยที่ส่งผลพร้อมกันและการปัดเศษ" />}
      </ResultGroup>
    </div>

    <p className={`mt-4 rounded-lg p-3 text-xs ${reconciled ? 'bg-emerald-500/10 text-emerald-200' : 'bg-amber-500/10 text-amber-200'}`} data-testid="reconciliation-status" role="status">{reconciliationMessage}</p>
    <MetricDisclosure summary="ระบบดูอย่างไร" icon="chevron" className="mt-3 rounded-xl border border-slate-700 bg-slate-950/40 p-3 text-xs text-slate-300" panelClassName="text-xs text-slate-300">
      <div className="mt-3 space-y-2 leading-relaxed">
        <p>ระบบเทียบมูลค่าสถานะหลังทดลองกับมูลค่าตอนนี้ แล้วหักต้นทุนที่จ่ายไปตอนเปิดสถานะ จึงได้กำไรหรือขาดทุนที่คาดไว้</p>
        <p>{profitLossPercentBasis(basis.policy)}</p>
        <p>จากนั้นแยกให้เห็นว่าส่วนไหนมาจากราคาหุ้น ส่วนไหนมาจากเวลาที่ผ่านไป และส่วนไหนมาจากความผันผวน รวมกันแล้วต้องเท่ากับมูลค่าที่เปลี่ยนไปทั้งหมด</p>
        <p>Delta เป็นตัวเลขไว้เทียบเท่านั้น ไม่ถูกนำไปบวกซ้ำในผลรวม</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>ตรวจมูลค่าที่เปลี่ยนไป: {auditStatusLabels[audit.valueChange.status]}</li>
          <li>ตรวจกำไร/ขาดทุน: {auditStatusLabels[audit.projectedProfitLoss.status]}</li>
          <li>ตรวจที่มาของกำไร/ขาดทุน: {auditStatusLabels[audit.impactDecomposition.status]}</li>
        </ul>
      </div>
    </MetricDisclosure>
    <p className="mt-4 text-xs text-slate-500">ผลลัพธ์เป็นค่าประมาณจากแบบจำลอง ไม่ใช่ราคาตลาดจริง และไม่ใช่คำแนะนำซื้อขาย</p></section>;
}
/*
  Display-only Thai wording for the engine's classification values. The raw
  classification still drives `tone` and is kept in the label, so a reader who
  wants to audit the score against the library sees the exact same term.
*/
const classificationLabels: Record<string, string> = {
  'Positive Scenario Edge': 'แบบจำลองพบความได้เปรียบเชิงสถิติ (Positive Scenario Edge)',
  'No Positive Edge': 'แบบจำลองไม่พบความได้เปรียบ (No Positive Edge)',
  'No Clear Edge': 'ยังไม่ชัดเจน (No Clear Edge)',
  Neutral: 'ใกล้เคียงกันทั้งสองฝั่ง (Neutral)',
  'Bullish Call Edge': 'ฝั่ง Call ได้เปรียบ (Bullish Call Edge)',
  'Bearish Put Edge': 'ฝั่ง Put ได้เปรียบ (Bearish Put Edge)',
  'Not directly comparable': 'เทียบกันตรง ๆ ไม่ได้ (Not directly comparable)',
  'Score Unavailable': 'ยังไม่มีคะแนน (Score Unavailable)',
};
function classificationLabel(classification: string): string { return classificationLabels[classification] ?? classification; }
const SCORE_CAVEAT = 'คะแนนนี้ไม่ใช่โอกาสชนะและไม่รับประกันผลลัพธ์';

function CallPutScenarioScoreCard({ score }: { score: CallPutScenarioScore | null }) {
  if (!score || score.status === 'unavailable') {
    return <section className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" data-testid="call-put-scenario-score">
      <h3 className="font-semibold text-slate-100">คะแนนความน่าสนใจของสถานการณ์ (Scenario Quality Score)</h3>
      <p className="mt-2 font-medium text-amber-200">{classificationLabel('Score Unavailable')}</p>
      <p className="mt-1 text-xs text-amber-100/80">{presentUnavailableReason(score?.reason, 'ผลที่บันทึกไว้ยังไม่มีคะแนน กรุณากดจำลองใหม่อีกครั้ง')}</p>
      <p className="mt-3 text-xs text-slate-400">{SCORE_CAVEAT} — เป็นการประเมินภายใต้สมมติฐานของแบบจำลอง ไม่ใช่คำแนะนำซื้อขายและไม่รับประกันผลลัพธ์</p>
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
      <div><h3 className="font-semibold text-slate-100">{score.mode === 'comparison' ? 'เปรียบเทียบฝั่ง Call/Put (Call/Put Comparison)' : 'คะแนนความน่าสนใจของสถานการณ์ (Scenario Quality Score)'}</h3><p className="mt-1 text-xs text-slate-400">{SCORE_CAVEAT}</p><p className="mt-1 text-xs text-slate-400">แต่ละฝั่งได้คะแนนของตัวเองจากชุดการจำลองเดียวกัน คะแนนสองฝั่งจึงไม่จำเป็นต้องรวมกันได้ 100</p></div>
      <div className="flex flex-wrap gap-2"><span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200">{driftModeHelp[score.pricingMode === 'risk-neutral' ? 'risk-neutral' : 'forecast'].split(' ')[0]}</span><span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300">ใช้ชุดการจำลองเดียวกันทั้งสองฝั่ง</span></div>
    </div>
    <p className={`mt-3 rounded-lg border p-3 text-sm font-semibold ${tone(summary)}`}>{classificationLabel(summary)}{score.mode === 'comparison' && !score.comparable ? ' · แสดงคะแนนแยกกัน ยังไม่ชี้ว่าฝั่งใดดีกว่า' : ''}</p>
    <div className={`mt-4 grid gap-3 ${score.strategies.length > 1 ? 'lg:grid-cols-2' : ''}`}>
      {score.strategies.map((strategy) => <article key={strategy.id} className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-100">{strategy.strategy}</p><p className="mt-1 text-xs text-slate-500">{strategySideLabels[strategy.side] ?? strategy.side} · {strategyStatusLabels[strategy.status] ?? strategy.status}</p></div><div className="text-right"><p className="text-3xl font-bold text-[#D4FF00]">{strategy.edgeScore === null ? 'ไม่มีข้อมูล' : strategy.edgeScore.toFixed(2)}</p><p className="text-[10px] text-slate-500">คะแนนความได้เปรียบ เต็ม 100</p></div></div>
        <p className={`mt-3 rounded-md border px-2 py-1 text-xs font-semibold ${tone(strategy.classification)}`}>{classificationLabel(strategy.classification)}</p>
        {strategy.status === 'available' && strategy.metrics && strategy.confidence && <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <div><dt className="text-slate-500">โอกาสได้กำไร (POP)</dt><dd>{formatResultNumber(strategy.metrics.probabilityOfProfit * 100)}%</dd></div>
            <div><dt className="text-slate-500">กำไร/ขาดทุนเฉลี่ยจากการจำลอง (Expected P&amp;L)</dt><dd>${formatResultNumber(strategy.metrics.expectedPnL)}</dd></div>
            <div><dt className="text-slate-500">ผลตอบแทนคาดหวังต่อเงินที่เสี่ยง (EVR)</dt><dd>{formatResultNumber(strategy.metrics.evr * 100)}%</dd></div>
            <div><dt className="text-slate-500">ผลตอบแทนค่ากลางต่อเงินที่เสี่ยง</dt><dd>{formatResultNumber(strategy.metrics.medianR * 100)}%</dd></div>
            <div><dt className="text-slate-500">ขาดทุนกรณีแย่สุดต่อเงินที่เสี่ยง</dt><dd>{formatResultNumber(strategy.metrics.es95R * 100)}%</dd></div>
            <div><dt className="text-slate-500">อัตราส่วนกำไรต่อขาดทุน</dt><dd>{strategy.metrics.profitFactor === null ? 'ไม่มีข้อมูล' : formatResultNumber(strategy.metrics.profitFactor)}</dd></div>
            <div><dt className="text-slate-500">ความทนเมื่อสถานการณ์เปลี่ยน</dt><dd>{formatResultNumber(strategy.metrics.robustness * 100)}%</dd></div>
            <div><dt className="text-slate-500">ขาดทุนสูงสุด / เงินที่เสี่ยง</dt><dd>${formatResultNumber(strategy.metrics.maxLoss)}</dd></div>
            <div><dt className="text-slate-500">ความน่าเชื่อถือของข้อมูล</dt><dd>{formatResultNumber(strategy.confidence.score)} / 100</dd></div>
          </dl>
          {!strategy.positiveEdge && (() => { const gate = presentEdgeGate(strategy.positiveEdgeReasons); return <div className="mt-3 rounded-md bg-red-500/10 p-2 text-xs text-red-200" data-testid="positive-edge-gate"><p className="font-semibold">{gate.title}</p><p className="mt-1">{gate.message}</p></div>; })()}
        </>}
        {strategy.reason && <p className="mt-3 text-xs text-amber-200">{presentUnavailableReason(strategy.reason)}</p>}
        <MetricDisclosure summary="รายละเอียดทางเทคนิคของคะแนนนี้" icon="chevron" className="mt-3 rounded-lg border border-slate-700 p-3 text-xs text-slate-300" panelClassName="text-xs text-slate-300"><div className="mt-2 space-y-2">
          <p>ค่าสัญญา ${formatResultNumber(strategy.assumptions.premium)} · ค่าธรรมเนียม ${formatResultNumber(strategy.assumptions.fees)} · จำนวนหุ้นต่อสัญญา {strategy.assumptions.multiplier.join(', ')} · จำนวนสัญญา {strategy.assumptions.quantity.join(', ')}</p>
          <p>ที่มาของราคาสัญญา {strategy.assumptions.premiumSources.join(', ')} · ผู้ให้บริการข้อมูล {strategy.assumptions.source ?? 'ไม่มีข้อมูล'} · ข้อมูล ณ {formatTimestamp(strategy.assumptions.asOf)}</p>
          {strategy.scoreComponents && <p>ที่มาของคะแนน — โอกาสได้กำไร {formatResultNumber(strategy.scoreComponents.pop)} · กำไรที่คาดหวัง {formatResultNumber(strategy.scoreComponents.ev)} · ผลค่ากลาง {formatResultNumber(strategy.scoreComponents.median)} · กรณีแย่ที่สุด {formatResultNumber(strategy.scoreComponents.tail)} · รูปแบบผลตอบแทน {formatResultNumber(strategy.scoreComponents.payoff)} · ความทนเมื่อสถานการณ์เปลี่ยน {formatResultNumber(strategy.scoreComponents.robustness)}</p>}
          {strategy.metrics && <p>ความคลาดเคลื่อนของผล — โอกาสได้กำไร ±{formatResultNumber(strategy.metrics.popStandardError * 100, 4)}% · กำไรที่คาดหวัง ±${formatResultNumber(strategy.metrics.expectedPnLStandardError, 4)} · ช่วงที่เป็นไปได้ 95% อยู่ระหว่าง ${formatResultNumber(strategy.metrics.expectedPnLConfidence95[0])} ถึง ${formatResultNumber(strategy.metrics.expectedPnLConfidence95[1])}</p>}
          {strategy.stressScenarios.length > 0 && <p>ผลตอบแทนต่อเงินที่เสี่ยง เมื่อลองเปลี่ยนสถานการณ์ — {strategy.stressScenarios.map((item) => `${stressScenarioLabels[item.id] ?? item.id}: ${formatResultNumber(item.evr * 100)}%`).join(' · ')}</p>}
          {strategy.confidence && <p>ความน่าเชื่อถือของข้อมูล เต็ม 100 — คุณภาพข้อมูลที่กรอก {formatResultNumber(strategy.confidence.inputQuality.score)} · ความนิ่งเมื่อสถานการณ์เปลี่ยน {formatResultNumber(strategy.confidence.scenarioStability.score)} · ความแม่นของผลจำลอง {formatResultNumber(strategy.confidence.statisticalPrecision.score)} · สภาพคล่องของสัญญา {formatResultNumber(strategy.confidence.liquidityQuality.score)}</p>}
        </div></MetricDisclosure>
      </article>)}
    </div>
    {score.mode === 'comparison' && <div className="mt-3 grid gap-2 rounded-lg border border-slate-700 p-3 text-xs sm:grid-cols-3"><p>เทียบกันได้: <strong>{score.comparable ? 'ได้' : 'ยังไม่ได้'}</strong></p><p>คะแนนต่างกัน: <strong>{score.scoreDifference === null ? 'ไม่มีข้อมูล' : formatResultNumber(score.scoreDifference)}</strong></p><p>ความน่าเชื่อถือของการเทียบ: <strong>{score.comparisonConfidence === null ? 'ไม่มีข้อมูล' : formatResultNumber(score.comparisonConfidence)}</strong></p></div>}
    <div className="mt-3 rounded-lg border border-slate-700 p-3 text-xs text-slate-300"><p className="font-semibold text-slate-100">โอกาสทิศทางราคาหุ้น (คิดแยกจากคะแนนกลยุทธ์)</p><p className="mt-1">โอกาสที่ราคาหุ้นจะสูงกว่าราคาตั้งต้น {formatResultNumber(score.marketDirectionProbability.probabilityAboveStartingSpot * 100)}% · โอกาสที่จะถึงหรือเกินราคาเป้าหมาย ${formatResultNumber(score.marketDirectionProbability.targetPrice)} คือ {formatResultNumber(score.marketDirectionProbability.probabilityAtOrAboveTarget * 100)}%</p><p className="mt-1 text-slate-500">ตัวเลขชุดนี้บอกทิศทางของหุ้นอย่างเดียว ไม่ได้ถูกนำไปคิดเป็นคะแนนความได้เปรียบ</p></div>
    <MetricDisclosure summary="ส่วนประกอบของคะแนนและสมมติฐาน (รายละเอียดทางเทคนิค)" icon="chevron" className="mt-4 rounded-lg border border-slate-700 p-3 text-xs text-slate-300" panelClassName="text-xs text-slate-300">
      <div className="mt-2 space-y-1 leading-relaxed">
        <p>คะแนนความได้เปรียบให้น้ำหนักกับโอกาสได้กำไรมากที่สุด รองลงมาคือกำไรที่คาดหวัง ผลค่ากลาง ความรุนแรงของกรณีแย่ที่สุด รูปแบบผลตอบแทน และความทนเมื่อสถานการณ์เปลี่ยน</p>
        <p>ตัวเลขที่ลงท้ายว่า “ต่อเงินที่เสี่ยง” ทุกตัว วัดเทียบกับขาดทุนสูงสุดของสถานะนี้</p>
        <p>รอบจำลองที่ขอ / ที่สร้างได้ / ที่ใช้ร่วมกันได้ / ที่ตัดทิ้ง: {score.pathSet.requestedPaths.toLocaleString()} / {score.pathSet.generatedPaths.toLocaleString()} / {score.pathSet.commonValidPaths.toLocaleString()} / {score.pathSet.droppedPaths.toLocaleString()}</p>
        <p>ค่าเริ่มสุ่ม {score.pathSet.seed} · ราคาตั้งต้น ${formatResultNumber(score.assumptions.startingSpot)} · ความผันผวน {formatResultNumber(score.assumptions.volatility * 100)}% · แนวโน้ม {formatResultNumber(score.assumptions.drift * 100)}% · อัตราดอกเบี้ย {formatResultNumber(score.assumptions.rate * 100)}% · เงินปันผล {formatResultNumber(score.assumptions.dividendYield * 100)}%</p>
        <p>{driftModeHelp[score.pricingMode === 'risk-neutral' ? 'risk-neutral' : 'forecast']}</p>
      </div>
    </MetricDisclosure>
    <p className="mt-3 text-xs text-slate-400">เป็นผลจากแบบจำลองภายใต้สมมติฐานที่แสดงไว้ ไม่ใช่คำแนะนำซื้อขายและไม่รับประกันผลลัพธ์</p>
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
    ...(workspace.underlyingPrice === null ? [] : [{ value: workspace.underlyingPrice, label: 'ราคาปัจจุบัน', color: '#f59e0b', description: `ราคาปัจจุบัน $${formatResultNumber(workspace.underlyingPrice)}` }]),
    ...workspace.legs.map((leg, index) => ({ value: leg.strike, label: `ราคาใช้สิทธิ ${index + 1}`, color: '#94a3b8', description: `ราคาใช้สิทธิของสัญญาที่ ${index + 1}: $${formatResultNumber(leg.strike)}` })),
    ...breakEvens.map((value, index) => ({ value, label: breakEvens.length === 1 ? 'จุดคุ้มทุน' : `จุดคุ้มทุน ${index + 1}`, color: '#a78bfa', description: `จุดคุ้มทุน $${formatResultNumber(value)}` })),
    ...(result.targetPrice === undefined ? [] : [{ value: result.targetPrice, label: 'ราคาเป้าหมาย', color: '#22d3ee', description: `ราคาเป้าหมาย $${formatResultNumber(result.targetPrice)}` }]),
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
      <p className="mt-2 text-sm leading-relaxed text-slate-200">จากการจำลอง {validPaths.toLocaleString()} รอบ จากทั้งหมด {result.paths.toLocaleString()} รอบ โดยเฉลี่ยแล้ว{buildProfitLossSummary(result.expectedProfitLoss, basis.amount, currency, usdThbRate)} ผลตรงกลางคือ{buildProfitLossSummary(result.medianProfitLoss, basis.amount, currency, usdThbRate)} ถ้าตกอยู่ในกลุ่ม 5% ที่แย่ที่สุด จะขาดทุนเฉลี่ยประมาณ {formatResultMoney(es95Pnl, currency, usdThbRate, true)} และโอกาสจบด้วยกำไรอยู่ที่ {formatProbability(result.probabilityOfProfit)}</p>
      {discardedPaths > 0 && <p className="mt-2 text-xs text-amber-300">มีการจำลอง {discardedPaths.toLocaleString()} รอบที่ให้ผลผิดปกติ ระบบจึงไม่นำมารวมในผลลัพธ์</p>}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric title="ขาดทุนสูงสุด (Max Loss)" value={maximumLoss === null ? 'ไม่จำกัด' : formatResultMoney(maximumLoss, currency, usdThbRate, true)} helper="จำนวนเงินมากที่สุดที่สถานะนี้จะขาดทุนได้ ไม่ใช่ผลจากรอบจำลองที่แย่ที่สุดเพียงรอบเดียว" />
        <Metric title="โอกาสได้กำไร (POP)" value={formatProbability(result.probabilityOfProfit)} helper={PROBABILITY_OF_PROFIT_HELP} />
        <ExplainedProfitLossMetric title="กำไร/ขาดทุนเฉลี่ยจากการจำลอง (Expected P&L)" amount={result.expectedProfitLoss} currency={currency} usdThbRate={usdThbRate} helper="กำไรหรือขาดทุนโดยเฉลี่ยจากทุกรอบที่จำลอง" />
        <ExplainedProfitLossMetric title="ค่ากลางกำไร/ขาดทุน (Median P&L)" amount={result.medianProfitLoss} currency={currency} usdThbRate={usdThbRate} helper="ผลที่อยู่ตรงกลางเมื่อเรียงทุกรอบจากแย่ไปดี ไม่ใช่ค่าเฉลี่ย" />
        <ExplainedProfitLossMetric title="ผลลัพธ์ในกลุ่มกรณีแย่ (P5)" amount={p5Pnl} currency={currency} usdThbRate={usdThbRate} helper="ประมาณ 5% ของการจำลองให้ผลแย่กว่าระดับนี้" />
        <ExplainedProfitLossMetric title={VALUE_AT_RISK_TITLE} amount={var95Pnl} currency={currency} usdThbRate={usdThbRate} helper={VALUE_AT_RISK_HELP} />
        <ExplainedProfitLossMetric title={EXPECTED_SHORTFALL_TITLE} amount={es95Pnl} currency={currency} usdThbRate={usdThbRate} helper={EXPECTED_SHORTFALL_HELP} />
      </div>
    </div>
    <CallPutScenarioScoreCard score={scenarioScore} />
    <ResultGroup title="สรุปผล" testId="monte-carlo-group-summary" summary="ภาพรวมกำไรหรือขาดทุน และสถานะของสัญญาในวันเป้าหมาย">
      <ProfitLossMetric title="กำไร/ขาดทุนเฉลี่ยจากการจำลอง (Expected P&L)" amount={result.expectedProfitLoss} denominator={basis.amount} currency={currency} usdThbRate={usdThbRate} helper="กำไรหรือขาดทุนโดยเฉลี่ยจากทุกรอบที่จำลอง หักต้นทุนและค่าธรรมเนียมแล้ว" />
      <Metric title="โอกาสได้กำไร (POP)" value={formatProbability(result.probabilityOfProfit)} helper={PROBABILITY_OF_PROFIT_HELP} />
      <ProfitLossMetric title="ค่ากลางกำไร/ขาดทุน (Median P&L)" amount={result.medianProfitLoss} denominator={basis.amount} currency={currency} usdThbRate={usdThbRate} helper="ผลที่อยู่ตรงกลางเมื่อเรียงทุกรอบจากแย่ไปดี ไม่ใช่ค่าเฉลี่ย" />
      <Metric title="โอกาสที่สัญญาจะมีมูลค่าในตัว (ITM)" value={formatProbability(result.probabilityItm)} helper="โอกาสที่ราคาหุ้นในวันเป้าหมายจะเลยราคาใช้สิทธิ การมีมูลค่าในตัวยังไม่ได้แปลว่ากำไร เพราะยังต้องหักค่าสัญญาที่จ่ายไป" />
    </ResultGroup>
    <ResultGroup title="ราคาเป้าหมาย" testId="monte-carlo-group-target" summary="เทียบสองแบบ: เคยไปถึงเป้าหมายระหว่างทาง กับไปถึงในวันเป้าหมายพอดี">
      <Metric title="โอกาสที่ราคาเคยแตะเป้าหมาย" value={formatProbability(result.probabilityReachingTarget)} helper={TOUCH_TARGET_HELP} />
      <Metric title="โอกาสที่ราคาปลายทางถึงเป้าหมาย" value={closeAboveLabel} helper={CLOSE_AT_TARGET_HELP} />
      <Metric title="โอกาสที่ราคาปลายทางไม่ถึงเป้าหมาย" value={closeBelowLabel} helper={CLOSE_BELOW_TARGET_HELP} />
    </ResultGroup>
    <ResultGroup title="ช่วงผลลัพธ์และความเสี่ยง" testId="monte-carlo-group-risk" summary="ทุกค่าเป็นกำไรหรือขาดทุนหลังหักต้นทุนและค่าธรรมเนียมแล้ว">
      <ExplainedProfitLossMetric title="ผลลัพธ์ในกลุ่มกรณีแย่ (P5)" amount={p5Pnl} currency={currency} usdThbRate={usdThbRate} helper="ประมาณ 5% ของการจำลองให้ผลแย่กว่าระดับนี้ ใช้ดูฝั่งที่ไม่เป็นใจ" />
      <ExplainedProfitLossMetric title="ผลลัพธ์ค่ากลาง (P50)" amount={p50Pnl} currency={currency} usdThbRate={usdThbRate} helper="ครึ่งหนึ่งของการจำลองให้ผลดีกว่านี้ อีกครึ่งหนึ่งแย่กว่านี้" />
      <ExplainedProfitLossMetric title="ผลลัพธ์ในกลุ่มกรณีดี (P95)" amount={p95Pnl} currency={currency} usdThbRate={usdThbRate} helper="มีเพียงประมาณ 5% ของการจำลองที่ให้ผลดีกว่าระดับนี้" />
      <ExplainedProfitLossMetric title={VALUE_AT_RISK_TITLE} amount={var95Pnl} currency={currency} usdThbRate={usdThbRate} helper={VALUE_AT_RISK_HELP} />
      <ExplainedProfitLossMetric title={EXPECTED_SHORTFALL_TITLE} amount={es95Pnl} currency={currency} usdThbRate={usdThbRate} helper={EXPECTED_SHORTFALL_HELP} />
    </ResultGroup>
    <section className="mt-4 rounded-xl border border-slate-700 bg-slate-950/30 p-3" data-testid="monte-carlo-group-charts">
      <h3 className="font-semibold text-slate-100">กราฟและสมมติฐาน</h3>
      <p className="mt-1 text-xs text-slate-400">กราฟแท่งใช้ผลจากทุกรอบที่จำลอง ส่วนเส้นราคาเป็นเพียงตัวอย่างให้เห็นภาพ ไม่ใช่การทำนายราคา</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <HistogramChart title={`การกระจายกำไร/ขาดทุน (${currency})`} ariaLabel={`กราฟการกระจายกำไรและขาดทุน จากการจำลอง ${validPaths.toLocaleString()} รอบ แกนนอนเป็นกำไร/ขาดทุน ${currency} แกนตั้งเป็นจำนวนรอบจำลอง`} data={pnl} xAxisLabel={`กำไร/ขาดทุน (${currency})`} referenceXs={[{ value: 0, label: 'จุดคุ้มทุน', color: '#94a3b8', description: 'ไม่กำไรไม่ขาดทุน' }]} />
        {terminal.length > 0 ? <HistogramChart title="การกระจายราคาหุ้นในวันเป้าหมาย (USD)" ariaLabel={`กราฟการกระจายราคาหุ้นในวันเป้าหมาย จากการจำลอง ${validPaths.toLocaleString()} รอบ แกนนอนเป็นราคาหุ้น USD แกนตั้งเป็นจำนวนรอบจำลอง`} data={terminal} xAxisLabel="ราคาหุ้นในวันเป้าหมาย (USD)" referenceXs={terminalReferences} /> : <div className="min-w-0 rounded-xl border border-slate-700 p-3 text-sm text-amber-300">ผลที่บันทึกไว้ยังไม่มีกราฟนี้ กรุณากดจำลองใหม่อีกครั้ง</div>}
        <div className="h-80 min-w-0 rounded-xl border border-slate-700 p-3 lg:col-span-2" role="group" aria-label={`ตัวอย่างเส้นทางราคา ${shownPaths.length} เส้น จากการจำลอง ${validPaths} รอบ ตั้งแต่ ${workspace.valuationDate} ถึง ${workspace.scenarios[0].valuationDate}`}>
          <h4 className="text-sm font-semibold">ตัวอย่างเส้นทางราคา (USD)</h4>
          <p className="mb-2 text-xs text-slate-400">แสดงตัวอย่าง {shownPaths.length.toLocaleString()} เส้น จากการจำลอง {validPaths.toLocaleString()} รอบ ทุกเส้นมีน้ำหนักเท่ากันและไม่ใช่เส้นคาดการณ์</p>
          <ResponsiveContainer width="100%" height="85%"><LineChart data={samples} margin={{ bottom: 16, left: 4, right: 12 }}><CartesianGrid stroke="#334155" /><XAxis dataKey="date" minTickGap={28} tickFormatter={(value) => new Date(`${value}T00:00:00Z`).toLocaleDateString('th-TH-u-ca-gregory', { day: 'numeric', month: 'short', timeZone: 'UTC' })} label={{ value: 'วันที่', position: 'insideBottom', offset: -10 }} /><YAxis label={{ value: 'ราคาหุ้น (USD)', angle: -90, position: 'insideLeft' }} /><Tooltip />{shownPaths.map((_, index) => <Line key={index} dataKey={`path${index}`} name={`ตัวอย่าง ${index + 1}`} dot={false} stroke={['#94a3b8', '#7dd3fc', '#c4b5fd', '#86efac'][index % 4]} strokeOpacity={0.55} strokeWidth={1.25} isAnimationActive={false} />)}<ReferenceLine y={workspace.underlyingPrice ?? undefined} stroke="#f59e0b" strokeDasharray="4 4" /></LineChart></ResponsiveContainer>
        </div>
      </div>
      <div data-testid="monte-carlo-assumptions"><MetricDisclosure summary="สมมติฐานที่ใช้ (รายละเอียดทางเทคนิค)" icon="chevron" className="mt-4 rounded-xl border border-slate-700 bg-slate-950/40 p-3 text-xs text-slate-300" panelClassName="text-xs text-slate-300">
        <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          <div><dt className="text-slate-500">แบบจำลองที่ใช้</dt><dd>Geometric Brownian Motion (GBM) · options-simulator-v1</dd></div>
          <div><dt className="text-slate-500">จำนวนรอบจำลอง / ค่าเริ่มสุ่ม</dt><dd>{result.paths.toLocaleString()} / {result.seed}</dd></div>
          <div><dt className="text-slate-500">ราคาหุ้นปัจจุบัน</dt><dd>{workspace.underlyingPrice === null ? 'ไม่มีข้อมูล' : `$${formatResultNumber(workspace.underlyingPrice)} USD`}</dd></div>
          <div><dt className="text-slate-500">วันเป้าหมาย / จำนวนวัน</dt><dd>{workspace.scenarios[0].valuationDate} / {workspace.monteCarlo.horizonDays} วัน</dd></div>
          <div><dt className="text-slate-500">ความผันผวน / แนวโน้ม</dt><dd>{formatResultNumber(workspace.monteCarlo.volatility * 100)}% / {formatResultNumber(workspace.monteCarlo.drift * 100)}%</dd></div>
          <div><dt className="text-slate-500">อัตราดอกเบี้ย / เงินปันผล</dt><dd>{formatResultNumber(workspace.monteCarlo.rate * 100)}% / {formatResultNumber(workspace.monteCarlo.dividendYield * 100)}%</dd></div>
          <div><dt className="text-slate-500">จำนวนสัญญา</dt><dd>{workspace.legs.map((leg, index) => `สัญญาที่ ${index + 1}: ${leg.quantity}`).join(' · ')}</dd></div>
          <div><dt className="text-slate-500">จำนวนหุ้นต่อ 1 สัญญา</dt><dd>{workspace.legs.map((leg, index) => `สัญญาที่ ${index + 1}: ${leg.multiplier}`).join(' · ')}</dd></div>
          <div><dt className="text-slate-500">ค่าธรรมเนียม</dt><dd>รวมใน P&amp;L แล้ว · ${formatResultMoney(totalFees, 'USD', null)}</dd></div>
        </dl>
        <p className="mt-3 text-slate-500">การจำลองเส้นทางราคาใช้แนวโน้ม ความผันผวน และเงินปันผลตามที่แสดงไว้ ส่วนอัตราดอกเบี้ยแสดงไว้เพื่อการตรวจสอบเท่านั้น</p>
      </MetricDisclosure></div>
    </section>
    <p className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">ผลลัพธ์เป็นความน่าจะเป็นจากสมมติฐาน ไม่ใช่การทำนายราคาที่แน่นอน</p></section>;
}
interface HistogramMarker { value: number; label: string; color: string; description: string }
function HistogramChart({ title, ariaLabel, data, xAxisLabel, referenceXs = [] }: { title: string; ariaLabel: string; data: Array<{ x: number; lower: number; upper: number; count: number }>; xAxisLabel: string; referenceXs?: HistogramMarker[] }) {
  return <div className="h-80 min-w-0 rounded-xl border border-slate-700 p-3" role="group" aria-label={ariaLabel}>
    <h4 className="text-sm font-semibold">{title}</h4>
    {referenceXs.length > 0 && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400" aria-label="เส้นอ้างอิงบนกราฟ">{referenceXs.map((reference, index) => <span key={`${reference.label}-${reference.value}-${index}`} title={reference.description} tabIndex={0}><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: reference.color }} />{reference.label}</span>)}</div>}
    <ResponsiveContainer width="100%" height="82%"><BarChart data={data} margin={{ bottom: 20, left: 4, right: 12, top: 12 }}><CartesianGrid stroke="#334155" /><XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(value) => formatResultNumber(Number(value), 0)} label={{ value: xAxisLabel, position: 'insideBottom', offset: -12 }} /><YAxis allowDecimals={false} label={{ value: 'จำนวนรอบจำลอง', angle: -90, position: 'insideLeft' }} /><Tooltip labelFormatter={(_, payload) => payload?.[0]?.payload ? `${formatResultNumber(payload[0].payload.lower)} – ${formatResultNumber(payload[0].payload.upper)}` : ''} formatter={(value) => [Number(value).toLocaleString(), 'จำนวนรอบจำลอง']} />{referenceXs.map((reference, index) => <ReferenceLine key={`${reference.label}-${reference.value}-${index}`} x={reference.value} stroke={reference.color} strokeDasharray="4 4" label={{ value: reference.label, fill: reference.color, fontSize: 9, position: 'insideTop' }} />)}<Bar dataKey="count" name="จำนวนรอบจำลอง" fill="#D4FF00" isAnimationActive={false} /></BarChart></ResponsiveContainer>
  </div>;
}
function Payoff({ heading, valuation, spot, currency, usdThbRate }: { heading: string; valuation: PortfolioValuation; spot: number | null; currency: ResultCurrency; usdThbRate: number | null }) {
  const payoff = valuation.payoff.map((point) => ({ ...point, profitLoss: convertUsdForDisplay(point.profitLoss, currency, usdThbRate) ?? point.profitLoss }));
  return <section className={box}><h1 className="mb-3 text-xl font-bold">{heading}</h1><div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500"><span><i className="mr-1 inline-block h-0.5 w-3 bg-amber-500" />ราคาหุ้นปัจจุบัน (USD)</span><span><i className="mr-1 inline-block h-0.5 w-3 bg-slate-400" />เส้นคุ้มทุน ไม่กำไรไม่ขาดทุน</span><span><i className="mr-1 inline-block h-0.5 w-3 bg-[#D4FF00]" />กำไร/ขาดทุน ณ วันหมดอายุ ({currency})</span></div><div className="h-72 min-w-0"><ResponsiveContainer><LineChart data={payoff}><CartesianGrid stroke="#334155" /><XAxis dataKey="price" /><YAxis /><Tooltip /><ReferenceLine y={0} stroke="#94a3b8" />{spot && <ReferenceLine x={spot} stroke="#f59e0b" />}{valuation.breakEvens.map((value) => <ReferenceLine key={value} x={value} stroke="#a78bfa" />)}<Line dataKey="profitLoss" dot={false} stroke="#D4FF00" isAnimationActive={false} /></LineChart></ResponsiveContainer></div></section>;
}
