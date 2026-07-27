'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, RefreshCw } from 'lucide-react';
import { DataProvenance } from '@/src/components/market-data/DataProvenance';
import { Button } from '@/src/components/ui/Button';
import { Select } from '@/src/components/ui/Select';
import { useAppActive } from '@/src/hooks/useAppActive';
import { DESKTOP_QUERY, useMediaQuery } from '@/src/hooks/useMediaQuery';
import { calculateAtmIv, calculateExpectedMove, calculateOiConcentration } from '@/src/lib/market-data/options/analytics';
import type { OptionContract, OptionsChain, OptionsExpirations } from '@/src/lib/market-data/options/contracts';
import { MarketTracer } from '@/src/lib/market-data/realtime';
import { parseStrikeLines, type StrikeLine } from '@/src/lib/analytics/chart-layers/strike-lines';
import type { MarketDataLabel } from '@/src/lib/stock-detail/market-source';
import {
  activityMetrics,
  buildStrikeRows,
  computeVirtualWindow,
  formatMoney,
  formatNumber,
  formatPercent,
  greekMetrics,
  hasAnyGreek,
  isAtmStrike,
  isOutsideExpectedMove,
  moneyness,
  priceMetrics,
  UNAVAILABLE,
  type Moneyness,
  type OptionMetric,
  type StrikeRow,
} from '@/src/lib/stock-detail/options-chain-view';
import {
  DEFAULT_EXPIRATIONS_COOLDOWN_MS,
  OPTIONS_CHAIN_RATE_LIMIT_COOLDOWN_MS,
  optionsChainCoordinator,
  optionsExpirationsCoordinator,
} from '@/src/lib/stock-detail/options-source';
import { cn } from '@/src/utils/cn';

const optionsTracer = new MarketTracer();

/**
 * Fallback height of the scroll viewport, in px, used for the very first window
 * before the scroller has been measured. The real height is read from the DOM.
 */
const VIEWPORT_HEIGHT = 512;
/**
 * Height assumed for a row that has not been measured yet. Rows are NEVER forced
 * to this height — it only seeds the virtual window, and every mounted row
 * reports its true height back through a ResizeObserver. Pinning rows to a
 * constant was the original overlap defect.
 */
const ROW_ESTIMATE_DESKTOP = 198;
const ROW_ESTIMATE_MOBILE = 464;
const OVERSCAN = 3;

/** Desktop keeps the classic Call | Strike | Put ledger; the strike column is deliberately narrow. */
const GRID_TEMPLATE = 'md:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)]';

const MONEYNESS_BADGE: Record<Moneyness, string> = {
  ITM: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200',
  ATM: 'border-[#D4FF00]/50 bg-[#D4FF00]/10 text-[#D4FF00]',
  OTM: 'border-slate-700 bg-slate-800/50 text-slate-400',
};

/** One label-over-value cell. Stacking keeps 4 columns readable down to a 320px screen. */
function MetricCell({ metric }: { metric: OptionMetric }) {
  return (
    <div className="min-w-0" title={metric.title}>
      <dt className="truncate text-[10px] uppercase leading-tight tracking-wide text-slate-500">{metric.label}</dt>
      <dd className="truncate font-mono text-[11px] leading-tight tabular-nums text-slate-100">{metric.value}</dd>
    </div>
  );
}

function MetricGrid({ metrics, label }: { metrics: OptionMetric[]; label: string }) {
  return (
    <dl aria-label={label} className="grid grid-cols-4 gap-x-2 gap-y-1">
      {metrics.map((metric) => <MetricCell key={metric.key} metric={metric} />)}
    </dl>
  );
}

/**
 * One side of a strike.
 *
 * The layout is a plain vertical stack — status + contract, prices, activity,
 * Greeks, actions — so nothing is absolutely positioned and no element can land
 * on top of another. The contract symbol truncates with the full value kept in
 * `title` and in the DOM; it is never abbreviated away.
 */
function ContractBlock({ contract, side, spot, className, onOpen, onStrike }: {
  contract: OptionContract | null;
  side: 'call' | 'put';
  spot: number;
  className?: string;
  onOpen: (contract: OptionContract) => void;
  onStrike: (contract: OptionContract) => void;
}) {
  const sideLabel = side === 'call' ? 'CALL' : 'PUT';
  if (!contract) {
    return (
      <div
        data-testid={`option-cell-${side}-empty`}
        className={cn(
          'flex min-h-14 items-center justify-center border-t border-slate-800/70 px-3 py-3 text-slate-600',
          'md:min-h-0 md:border-t-0',
          className,
        )}
      >
        <span aria-hidden="true" className="font-mono">{UNAVAILABLE}</span>
        <span className="sr-only">{`ผู้ให้บริการไม่มีสัญญา ${sideLabel} ที่ราคาใช้สิทธินี้`}</span>
      </div>
    );
  }

  const state = moneyness(contract, spot);
  return (
    <div
      data-testid={`option-cell-${side}`}
      className={cn('flex min-w-0 flex-col gap-2 border-t border-slate-800/70 px-3 py-2.5 md:border-t-0', className)}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        {/* Badges never shrink; the contract symbol is the element that truncates. */}
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-semibold leading-tight',
            side === 'call' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300',
          )}>
            {sideLabel}
          </span>
          <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium leading-tight', MONEYNESS_BADGE[state])}>
            {state}
          </span>
        </span>
        <span
          title={contract.contractSymbol}
          data-testid="option-contract-symbol"
          className="min-w-0 truncate font-mono text-[10px] leading-tight text-slate-500"
        >
          {contract.contractSymbol}
        </span>
      </div>

      <MetricGrid label={`ราคา ${sideLabel}`} metrics={priceMetrics(contract)} />
      <MetricGrid label={`สภาพคล่อง ${sideLabel}`} metrics={activityMetrics(contract, spot)} />

      <dl aria-label={`Greeks ${sideLabel}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-slate-800/60 pt-1.5">
        {greekMetrics(contract).map((metric) => (
          <div key={metric.key} className="flex items-baseline gap-1 text-[10px]" title={metric.title}>
            <dt className="text-slate-500">{metric.label}</dt>
            <dd className="font-mono tabular-nums text-slate-300">{metric.value}</dd>
          </div>
        ))}
      </dl>

      {/*
        Actions live in their own row at the end of the stack — never overlaid on
        the text above. Touch targets are ≥44px on mobile and relax to 36px once
        a pointer is likely.
      */}
      <div className="mt-auto flex flex-wrap gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => onStrike(contract)}
          aria-label={`เพิ่มเส้น strike ${contract.strike} ของ ${sideLabel} ลงกราฟ`}
          className="min-h-11 flex-1 rounded-md border border-slate-700 px-2 text-[11px] text-sky-300 hover:border-sky-500/60 hover:bg-sky-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 md:min-h-9 md:flex-none"
        >
          Strike line
        </button>
        <button
          type="button"
          onClick={() => onOpen(contract)}
          aria-label={`เปิด Simulator สำหรับสัญญา ${contract.contractSymbol}`}
          className="min-h-11 flex-1 rounded-md border border-[#D4FF00]/40 px-2 text-[11px] text-[#D4FF00] hover:bg-[#D4FF00]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4FF00] md:min-h-9 md:flex-none"
        >
          Simulator
        </button>
      </div>
    </div>
  );
}

/**
 * One strike.
 *
 * A single DOM tree serves both presentations, so the two can never drift:
 *  - **< md** it is a card — strike headline on top, then CALL and PUT as
 *    separate stacked sections;
 *  - **≥ md** the same three children become the Call | Strike | Put columns
 *    (`order-*` puts the strike back in the middle) of an auto-height grid row.
 */
function StrikeRowView({ row, spot, outsideExpectedMove, onOpen, onStrike }: {
  row: StrikeRow;
  spot: number;
  outsideExpectedMove: boolean;
  onOpen: (contract: OptionContract) => void;
  onStrike: (contract: OptionContract) => void;
}) {
  const atm = isAtmStrike(row.strike, spot);
  return (
    <article
      data-testid="options-strike-row"
      aria-label={`Strike ${row.strike}`}
      className={cn(
        'grid grid-cols-1 overflow-hidden rounded-xl border bg-slate-900/30',
        'md:rounded-none md:border-x-0 md:border-b md:border-t-0 md:bg-transparent',
        GRID_TEMPLATE,
        atm ? 'border-[#D4FF00]/40 md:bg-[#D4FF00]/[0.04]' : 'border-slate-800',
      )}
    >
      <div className={cn(
        'flex items-center justify-between gap-2 bg-slate-950/50 px-3 py-2 md:order-2 md:flex-col md:items-center md:justify-center md:gap-1 md:border-x md:border-slate-800 md:px-1.5 md:py-3',
        atm && 'md:bg-transparent',
      )}>
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-base font-bold tabular-nums text-white md:text-sm">{formatMoney(row.strike)}</span>
          {atm && <span className="rounded border border-[#D4FF00]/50 px-1 text-[10px] font-semibold text-[#D4FF00] md:hidden">ATM</span>}
        </span>
        {outsideExpectedMove && (
          <span
            title="ราคาใช้สิทธินี้อยู่นอกกรอบ Expected Move"
            className="shrink-0 text-right text-[10px] leading-tight text-amber-300 md:text-center"
          >
            นอกกรอบ<span className="md:hidden"> Expected Move</span>
          </span>
        )}
      </div>
      <ContractBlock contract={row.call} side="call" spot={spot} className="md:order-1" onOpen={onOpen} onStrike={onStrike} />
      <ContractBlock contract={row.put} side="put" spot={spot} className="md:order-3" onOpen={onOpen} onStrike={onStrike} />
    </article>
  );
}

/**
 * Windowed options ledger with genuine auto-height rows.
 *
 * Every mounted row reports its measured height back, so the virtual window is
 * computed from real heights rather than a constant. One scroll container owns
 * both axes: the page itself never scrolls sideways.
 */
function VirtualOptionsTable({ rows, spot, expectedMove, onOpen, onStrike }: {
  rows: StrikeRow[];
  spot: number;
  expectedMove?: { lower: number | null; upper: number | null };
  onOpen: (contract: OptionContract) => void;
  onStrike: (contract: OptionContract) => void;
}) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowElements = useRef(new Map<number, HTMLElement>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(VIEWPORT_HEIGHT);
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map());

  const record = useCallback((index: number, element: HTMLElement) => {
    const height = element.getBoundingClientRect().height;
    if (!Number.isFinite(height) || height <= 0) return;
    setHeights((current) => {
      const known = current.get(index);
      if (known !== undefined && Math.abs(known - height) < 0.5) return current;
      const next = new Map(current);
      next.set(index, height);
      return next;
    });
  }, []);

  const registerRow = useCallback((index: number) => (element: HTMLElement | null) => {
    const previous = rowElements.current.get(index);
    if (previous && previous !== element) observerRef.current?.unobserve(previous);
    if (!element) { rowElements.current.delete(index); return; }
    rowElements.current.set(index, element);
    observerRef.current?.observe(element);
    record(index, element);
  }, [record]);

  // Refs are attached before effects run, so the observer both picks up rows that
  // mounted before it existed and keeps following later reflows (font swap,
  // breakpoint change, a wrapped contract symbol).
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        for (const [index, element] of rowElements.current) {
          if (element === entry.target) record(index, element);
        }
      }
    });
    observerRef.current = observer;
    for (const element of rowElements.current.values()) observer.observe(element);
    return () => { observer.disconnect(); observerRef.current = null; };
  }, [record]);

  useLayoutEffect(() => {
    for (const [index, element] of rowElements.current) record(index, element);
  });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const sync = () => setViewportHeight((current) => {
      const measured = element.clientHeight;
      return Number.isFinite(measured) && measured > 0 && Math.abs(measured - current) >= 1 ? measured : current;
    });
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const estimate = desktop ? ROW_ESTIMATE_DESKTOP : ROW_ESTIMATE_MOBILE;
  const virtual = computeVirtualWindow({
    count: rows.length,
    scrollTop,
    viewportHeight,
    overscan: OVERSCAN,
    estimate,
    heights,
  });
  const onScroll = (event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop);

  return (
    // The column header sits ABOVE the vertical scroller, not inside it, so it
    // stays visible for free and the windowed offsets start at exactly 0. The
    // horizontal scroller wraps both, so header and rows can never misalign.
    <div className="overflow-hidden rounded-xl border border-slate-800">
      <div className="overflow-x-auto">
        <div className="md:min-w-[40rem]">
          <div className={cn(
            'hidden border-b border-slate-800 bg-[#101725] px-3 py-2 text-xs font-semibold text-slate-300 md:grid',
            GRID_TEMPLATE,
          )}>
            <span>Call</span>
            <span className="text-center">Strike</span>
            <span>Put</span>
          </div>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            aria-label="Virtualized options chain"
            data-testid="options-chain-scroller"
            className="max-h-[75svh] overflow-y-auto overscroll-contain pb-3 md:max-h-[32rem] md:pb-0"
          >
            <div style={{ height: virtual.padTop }} aria-hidden="true" />
            {rows.slice(virtual.start, virtual.end).map((row, offset) => {
              const index = virtual.start + offset;
              return (
                // The gap between mobile cards is padding INSIDE the measured
                // element, so measured heights and scroll offsets stay in step.
                <div key={row.strike} ref={registerRow(index)} className="px-3 pt-3 md:px-0 md:pt-0">
                  <StrikeRowView
                    row={row}
                    spot={spot}
                    outsideExpectedMove={isOutsideExpectedMove(row.strike, expectedMove)}
                    onOpen={onOpen}
                    onStrike={onStrike}
                  />
                </div>
              );
            })}
            <div style={{ height: virtual.padBottom }} aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * An entitlement refusal is a permanent, account-level fact and must never be
 * phrased as a transient hiccup — the user would keep retrying something that
 * cannot succeed. It stays free of plan/API detail: production copy states the
 * limitation, not the vendor's pricing tier.
 */
const ENTITLEMENT_LABEL = 'ผู้ให้บริการปัจจุบันไม่รองรับข้อมูลออปชันสำหรับบัญชีนี้';

function errorLabel(code: string | undefined): string {
  if (code === 'forbidden' || code === 'entitlement-required') return ENTITLEMENT_LABEL;
  if (code === 'rate-limited') return 'ข้อมูลออปชันถูกจำกัดชั่วคราว กรุณาลองใหม่ภายหลัง';
  if (code === 'provider-not-configured') return 'ยังไม่ได้ตั้งค่าผู้ให้บริการ Options';
  if (code === 'unsupported') return ENTITLEMENT_LABEL;
  return 'ข้อมูลออปชันยังไม่พร้อมใช้งาน';
}

export function optionsPanelErrorLabel(code: string | undefined, cooldownSeconds: number): string {
  if (code === 'rate-limited') {
    return cooldownSeconds > 0
      ? `ข้อมูลออปชันถูกจำกัดชั่วคราว · ลองใหม่ใน ${cooldownSeconds} วินาที`
      : 'ข้อมูลออปชันถูกจำกัดชั่วคราว · ลองใหม่อีกครั้ง';
  }
  if (code === 'not-found') return 'ไม่พบสัญญาออปชัน';
  return errorLabel(code);
}

export function optionsPanelRetrySeconds(
  code: string | undefined,
  retryAfterSeconds: number | null | undefined,
  fallbackCooldownMs: number,
): number {
  if (retryAfterSeconds !== null && retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    return retryAfterSeconds;
  }
  return code === 'rate-limited' ? Math.ceil(fallbackCooldownMs / 1_000) : 0;
}

/** A headline metric card: value first, method and sample size underneath. */
function SummaryCard({ title, value, detail, children }: {
  title: string;
  value: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-slate-800 bg-slate-900/30 p-3">
      <h3 className="text-xs text-slate-500">{title}</h3>
      <p className="mt-1 break-words font-mono text-lg font-bold leading-tight tabular-nums text-white sm:text-xl">{value}</p>
      <p className="mt-1 text-[10px] leading-snug text-slate-400">{detail}</p>
      {children}
    </article>
  );
}

export function OptionsChainPanel({ symbol, acceptedPrice, underlyingLabel }: {
  symbol: string;
  acceptedPrice: number | null;
  underlyingLabel: MarketDataLabel | null;
}) {
  const router = useRouter();
  const appActive = useAppActive();
  const [expirations, setExpirations] = useState<OptionsExpirations | null>(null);
  const [expiration, setExpiration] = useState('');
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [strikeRange, setStrikeRange] = useState(20);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(0);
  const [saveData] = useState(() => typeof navigator !== 'undefined' && Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData));
  const [userStarted, setUserStarted] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const requestExpirations = useCallback(async () => {
    if (!navigator.onLine) { setError({ code: 'offline', message: 'ออฟไลน์อยู่ จึงไม่เรียกผู้ให้บริการ' }); return; }
    const requestGeneration = ++generation.current;
    setLoading(true); setError(null);
    try {
      const outcome = await optionsExpirationsCoordinator.load(symbol);
      if (!outcome.ok) {
        const retry = optionsPanelRetrySeconds(
          outcome.classification?.reason,
          outcome.retryAfterSeconds,
          DEFAULT_EXPIRATIONS_COOLDOWN_MS,
        );
        if (retry > 0) { const deadline = Date.now() + retry * 1_000; setNow(Date.now()); setCooldownUntil(deadline); }
        throw Object.assign(new Error(errorLabel(outcome.classification?.reason)), { code: outcome.classification?.reason });
      }
      if (generation.current !== requestGeneration) return;
      if (!outcome.data) throw Object.assign(new Error('Expiration response validation failed'), { code: 'invalid-response' });
      setExpirations(outcome.data);
      setExpiration((current) => outcome.expirations.includes(current) ? current : '');
      if (!outcome.expirations.length) setError({ code: 'not-found', message: 'ไม่พบวันหมดอายุจริงจากผู้ให้บริการ' });
    } catch (cause) {
      if (generation.current !== requestGeneration) return;
      setExpirations(null); setChain(null);
      setError({ code: (cause as { code?: string }).code, message: cause instanceof Error ? cause.message : 'Options expirations unavailable' });
    } finally { if (generation.current === requestGeneration) setLoading(false); }
  }, [symbol]);

  const requestChain = useCallback(async (targetExpiration: string, force = false) => {
    if (!targetExpiration || !navigator.onLine || (!force && Date.now() < cooldownUntil)) return;
    const requestGeneration = ++generation.current;
    setLoading(true); setError(null); setChain(null);
    try {
      if (force && !optionsChainCoordinator.reset(symbol, targetExpiration)) return;
      const outcome = await optionsChainCoordinator.load(symbol, targetExpiration, acceptedPrice);
      if (!outcome.ok || !outcome.chain) {
        const retry = optionsPanelRetrySeconds(
          outcome.classification?.reason,
          outcome.retryAfterSeconds,
          OPTIONS_CHAIN_RATE_LIMIT_COOLDOWN_MS,
        );
        if (retry > 0) { const deadline = Date.now() + retry * 1_000; setNow(Date.now()); setCooldownUntil(deadline); }
        throw Object.assign(new Error(errorLabel(outcome.classification?.reason)), { code: outcome.classification?.reason });
      }
      if (generation.current !== requestGeneration) return;
      setChain(outcome.chain); setCooldownUntil(0); setNow(Date.now());
    } catch (cause) {
      if (generation.current !== requestGeneration) return;
      setError({ code: (cause as { code?: string }).code, message: cause instanceof Error ? cause.message : 'Options chain unavailable' });
    } finally { if (generation.current === requestGeneration) setLoading(false); }
  }, [acceptedPrice, cooldownUntil, symbol]);

  useEffect(() => {
    if (!appActive || (saveData && !userStarted) || expirations || error) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void requestExpirations(); });
    return () => { cancelled = true; };
  }, [appActive, error, expirations, requestExpirations, saveData, userStarted]);
  useEffect(() => {
    if (!appActive || !expiration || chain?.expiration === expiration || error) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void requestChain(expiration); });
    return () => { cancelled = true; };
  }, [appActive, chain?.expiration, error, expiration, now, requestChain]);

  const spot = acceptedPrice !== null && Number.isFinite(acceptedPrice) && acceptedPrice > 0
    ? acceptedPrice
    : null;
  const canonicalChain = useMemo(() => {
    if (!chain || spot === null) return null;
    const underlyingStatus: NonNullable<OptionsChain['underlyingStatus']> = underlyingLabel?.mode === 'REAL-TIME' ? 'live'
      : underlyingLabel?.mode === 'CACHED' ? 'cached'
        : underlyingLabel?.mode === 'STALE' ? 'stale'
          : underlyingLabel?.mode === 'UNAVAILABLE' ? 'unavailable'
            : 'delayed';
    return {
      ...chain,
      spot,
      underlyingProvider: underlyingLabel?.provider ?? chain.underlyingProvider ?? null,
      underlyingAsOf: underlyingLabel?.exchangeTimestamp ?? chain.underlyingAsOf ?? null,
      underlyingStatus,
    };
  }, [chain, spot, underlyingLabel]);
  useEffect(() => {
    if (spot === null || !underlyingLabel) return;
    const exchangeTimestampMs = underlyingLabel.exchangeTimestamp
      ? Date.parse(underlyingLabel.exchangeTimestamp)
      : Number.NaN;
    optionsTracer.trace({
      stage: 'options_underlying_updated', symbol, price: spot,
      exchangeTimestampMs: Number.isFinite(exchangeTimestampMs) ? exchangeTimestampMs : undefined,
    });
  }, [spot, symbol, underlyingLabel]);
  const rows = useMemo(
    () => canonicalChain ? buildStrikeRows(canonicalChain, strikeRange) : [],
    [canonicalChain, strikeRange],
  );
  const analytics = useMemo(() => canonicalChain ? {
    atm: calculateAtmIv(canonicalChain),
    expectedMove: calculateExpectedMove(canonicalChain),
    oi: calculateOiConcentration(canonicalChain),
  } : null, [canonicalChain]);
  /** Alpaca-shaped chains carry no IV/Greeks at all; say so once instead of on all 40 rows. */
  const greeksMissing = useMemo(
    () => rows.length > 0 && !rows.some((row) => (row.call && hasAnyGreek(row.call)) || (row.put && hasAnyGreek(row.put))),
    [rows],
  );
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1_000));
  const displayedError = error ? optionsPanelErrorLabel(error.code, cooldown) : null;

  const addChartLine = (line: StrikeLine) => {
    const key = `nexora:strike-lines:${symbol.toUpperCase()}:v1`;
    const current = parseStrikeLines(window.localStorage.getItem(key));
    window.localStorage.setItem(key, JSON.stringify([...current.filter((item) => item.id !== line.id), line]));
  };
  const addStrike = (contract: OptionContract) => {
    addChartLine({ id: `option:${contract.contractSymbol}`, price: contract.strike, label: `${contract.type === 'call' ? 'Call' : 'Put'} ${contract.expiration}`, optionType: contract.type, expiration: contract.expiration, visible: true });
  };
  const addExpectedMove = () => {
    if (!chain || !analytics || analytics.expectedMove.lower === null || analytics.expectedMove.upper === null) return;
    addChartLine({ id: `expected-move:${chain.expiration}:lower`, price: analytics.expectedMove.lower, label: `Expected Move lower ${chain.expiration}`, optionType: 'put', expiration: chain.expiration, visible: true });
    addChartLine({ id: `expected-move:${chain.expiration}:upper`, price: analytics.expectedMove.upper, label: `Expected Move upper ${chain.expiration}`, optionType: 'call', expiration: chain.expiration, visible: true });
  };
  const openSimulator = (contract: OptionContract) => {
    const query = new URLSearchParams({ symbol, expiration: contract.expiration, contract: contract.contractSymbol });
    if (spot !== null && underlyingLabel) {
      query.set('underlyingPrice', String(spot));
      query.set('underlyingMode', underlyingLabel.mode);
      if (underlyingLabel.provider) query.set('underlyingProvider', underlyingLabel.provider);
      if (underlyingLabel.exchangeTimestamp) query.set('underlyingAsOf', underlyingLabel.exchangeTimestamp);
    }
    router.push(`/tools/monte-carlo?${query.toString()}`);
  };

  if (saveData && !userStarted) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
        <Activity className="text-sky-300" />
        <h2 className="mt-2 font-bold text-white">Options Chain</h2>
        <p className="mt-2 text-sm text-slate-400">Data Saver เปิดอยู่ ระบบจึงรอให้คุณเริ่มโหลดข้อมูล Options โดยตรง</p>
        <Button className="mt-3 min-h-11" onClick={() => { setUserStarted(true); setError(null); }}>โหลด Options Chain</Button>
      </section>
    );
  }

  return (
    <section className="space-y-4 overflow-hidden rounded-2xl border border-slate-800 bg-[#151B28] p-4 md:p-6" data-testid="options-chain-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-bold text-white">Options Chain · {symbol}</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">ข้อมูลสัญญาจริงแบบอ่านอย่างเดียว พร้อม ATM IV, Expected Move และ OI concentration</p>
        </div>
        <Button
          variant="outline"
          className="min-h-11 shrink-0 md:min-h-10"
          disabled={loading || cooldown > 0 || !appActive}
          onClick={() => chain ? void requestChain(expiration, true) : void requestExpirations()}
        >
          <RefreshCw size={14} />{cooldown ? ` ${cooldown}s` : ' Refresh'}
        </Button>
      </div>

      <DataProvenance status={chain?.status ?? expirations?.status ?? (error ? 'unavailable' : 'delayed')} provider={chain?.provider ?? expirations?.provider} asOf={chain?.asOf ?? expirations?.asOf} timestampKind={chain?.timestampKind ?? expirations?.timestampKind} delayedMinutes={chain?.delayedMinutes ?? expirations?.delayedMinutes} reason={displayedError} />
      <p className="break-words text-xs leading-relaxed text-slate-400" data-testid="options-underlying-provenance">
        Underlying: {spot === null ? 'Unavailable' : formatMoney(spot)}
        {spot !== null ? ` · ${underlyingLabel?.provider ?? 'unknown source'} · ${underlyingLabel?.mode ?? 'UNAVAILABLE'} · ${underlyingLabel?.exchangeTimestamp ?? 'unknown time'}` : ''}
      </p>

      {error && (
        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200">
          <p className="leading-relaxed">{displayedError}</p>
          <p className="mt-1 text-xs text-slate-400">ไม่มีการสร้างหรือเติม Options data ทดแทน</p>
          <Button className="mt-3 min-h-11" variant="outline" disabled={loading || cooldown > 0} onClick={() => { setUserStarted(true); setError(null); }}>ลองใหม่</Button>
        </div>
      )}
      {loading && !chain && <div className="flex h-48 items-center justify-center rounded-xl bg-slate-800/60 px-4 text-center text-sm text-slate-300 sm:h-64" aria-label="กำลังโหลดข้อมูลออปชัน…">กำลังโหลดข้อมูลออปชัน…</div>}

      {expirations && expirations.expirations.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="min-w-0 text-xs text-slate-400">
            Expiration
            <Select className="mt-1" aria-label="วันหมดอายุออปชัน" value={expiration} onChange={(event) => { setError(null); setExpiration(event.target.value); }}>
              <option value="" disabled>เลือกวันหมดอายุ</option>
              {expirations.expirations.map((value) => <option key={value} value={value}>{value}</option>)}
            </Select>
          </label>
          <label className="min-w-0 text-xs text-slate-400">
            Strike range
            <Select className="mt-1" aria-label="ช่วง strike รอบราคาปัจจุบัน" value={strikeRange} onChange={(event) => setStrikeRange(Number(event.target.value))}>
              {[5, 10, 20, 50].map((value) => <option key={value} value={value}>±{value}% around spot</option>)}
            </Select>
          </label>
        </div>
      )}

      {chain && analytics && <>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          <SummaryCard
            title="ATM IV"
            value={analytics.atm.iv === null ? UNAVAILABLE : formatPercent(analytics.atm.iv)}
            detail={`robust median · ${analytics.atm.sampledContracts.length} contracts · DTE ${analytics.atm.dte} · confidence ${formatNumber(analytics.atm.confidence)}%`}
          />
          <SummaryCard
            title="Expected Move"
            value={analytics.expectedMove.move === null ? UNAVAILABLE : `±${formatMoney(analytics.expectedMove.move)} (${formatPercent(analytics.expectedMove.movePercent)})`}
            detail={analytics.expectedMove.lower === null
              ? 'ผู้ให้บริการไม่มี IV ที่ใช้คำนวณกรอบได้'
              : `${formatMoney(analytics.expectedMove.lower)} – ${formatMoney(analytics.expectedMove.upper)}`}
          >
            {analytics.expectedMove.move !== null && (
              <button
                type="button"
                onClick={addExpectedMove}
                className="mt-2 min-h-11 rounded-md border border-sky-500/30 px-2 text-xs text-sky-300 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 md:min-h-9"
              >
                เพิ่มกรอบลงกราฟ
              </button>
            )}
          </SummaryCard>
          <SummaryCard
            title="Spot / Expiration"
            value={formatMoney(spot)}
            detail={`${chain.expiration} · completeness ${formatPercent(chain.completeness, 0)}`}
          />
        </div>
        <p className="rounded-lg bg-sky-500/5 p-3 text-xs leading-relaxed text-sky-200">Expected Move เป็นกรอบความผันผวนเชิงสถิติ ราคาอาจอยู่นอกกรอบได้ และกรอบนี้ไม่ใช่การรับประกัน</p>

        {rows.length > 0
          // Keyed by the selection: a new expiration or strike range is a new
          // list, so it remounts at the top with fresh measurements instead of
          // leaving the reader parked among unrelated strikes.
          ? <VirtualOptionsTable key={`${chain.expiration}:${strikeRange}`} rows={rows} spot={spot!} expectedMove={analytics.expectedMove} onOpen={openSimulator} onStrike={addStrike} />
          : <p className="rounded-lg border border-amber-500/20 p-3 text-sm text-amber-200">ไม่มีสัญญาจริงในช่วง strike ที่เลือก</p>}
        {greeksMissing && (
          <p className="text-[11px] leading-relaxed text-slate-500" data-testid="options-greeks-missing">
            ผู้ให้บริการไม่ได้ส่งค่า IV/Greeks สำหรับสัญญาชุดนี้ ช่องที่ไม่มีข้อมูลจึงแสดงเป็น “{UNAVAILABLE}” และระบบไม่คำนวณแทน
          </p>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          {([['Call OI Concentration', analytics.oi.calls], ['Put OI Concentration', analytics.oi.puts]] as const).map(([title, levels]) => (
            <article key={title} className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/30 p-3">
              <h3 className="text-sm font-semibold text-white">{title}</h3>
              <ul className="mt-2 space-y-2">
                {levels.length ? levels.map((level) => (
                  <li key={level.contractSymbol} className="rounded-lg bg-slate-950/50 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold tabular-nums text-white">{formatMoney(level.strike)}</span>
                      <button
                        type="button"
                        onClick={() => addChartLine({ id: `oi:${level.contractSymbol}`, price: level.strike, label: `${level.type === 'call' ? 'Call' : 'Put'} OI ${chain.expiration}`, optionType: level.type, expiration: chain.expiration, visible: true })}
                        aria-label={`เพิ่มระดับ OI ${level.strike} ลงกราฟ`}
                        className="min-h-11 shrink-0 rounded-md border border-slate-700 px-3 text-[11px] text-sky-300 hover:border-sky-500/60 hover:bg-sky-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 md:min-h-9"
                      >
                        เพิ่มลงกราฟ
                      </button>
                    </div>
                    <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
                      <MetricCell metric={{ key: 'oi', label: 'OI', value: formatNumber(level.openInterest, 0), title: 'Open Interest · สัญญาคงค้าง' }} />
                      <MetricCell metric={{ key: 'volume', label: 'Vol', value: formatNumber(level.volume, 0), title: 'Volume · จำนวนสัญญาที่ซื้อขายวันนี้' }} />
                      <MetricCell metric={{ key: 'distance', label: 'Dist', value: formatMoney(level.distance), title: 'ระยะห่างจากราคาปัจจุบัน' }} />
                      <MetricCell metric={{ key: 'score', label: 'Score', value: formatNumber(level.score), title: 'คะแนนความกระจุกตัวเชิงสถิติ' }} />
                    </dl>
                  </li>
                )) : <li className="text-xs text-slate-500">{UNAVAILABLE} ไม่มีข้อมูล Open Interest จากผู้ให้บริการ</li>}
              </ul>
              <p className="mt-2 text-[10px] leading-snug text-slate-500">ระดับความกระจุกตัวเชิงสถิติ ไม่ใช่กำแพงราคาและไม่รับประกันการตอบสนองของราคา</p>
            </article>
          ))}
        </div>

        <details className="rounded-xl border border-slate-800 p-3 text-xs leading-relaxed text-slate-400">
          <summary className="cursor-pointer text-slate-200">Methodology / warnings</summary>
          <p className="mt-2 break-words">{analytics.oi.methodology}</p>
          <p className="mt-1 break-words">ATM samples: {analytics.atm.sampledContracts.map((item) => `${item.type} ${item.strike}`).join(', ') || 'none'}</p>
          <ul className="mt-2 list-disc pl-5">
            {[...new Set([...chain.warnings, ...analytics.atm.warnings, ...analytics.oi.warnings])].map((warning) => <li key={warning} className="break-words">{warning}</li>)}
          </ul>
        </details>
      </>}
    </section>
  );
}
