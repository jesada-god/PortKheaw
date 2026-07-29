'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chartRequestKey, planChartRequest, shouldApplyResponse } from './chart-request';
import { matchesLiveSelection, mergeLiveCandleIntoBars, shouldPollChart } from './live-candle-bridge';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { useAppActive } from '@/src/hooks/useAppActive';
import {
  normalizedCandleResultSchema,
  type CandleInterval,
  type CandleRange as HistoricalRange,
  type CandleSession as MarketSessionMode,
} from '@/src/lib/market-data/candles/contracts';
import { historyBarPriceRole, historyFallbackModeFromStatus, type AcceptedPriceCandidate, type LiveCandle, type MarketDataLabel } from '@/src/lib/stock-detail/market-source';
import { resolveChartProvenance } from './chart-live-provenance';
import type { CanonicalLiveUpdateSink } from './useMarketSource';
import { resolvePriceAdjustment } from '@/src/lib/analytics/price-adjustment';
import { presentChartWarnings } from './chart-data-warnings';
import type { ChartPreferences } from '@/src/lib/analytics/timeframe';
import type { ToolbarToggleKey } from './chart/technical/ChartToolbar';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';

const TechnicalAnalysisChart = dynamic(
  () => import('./chart/technical/TechnicalAnalysisChart').then((module) => module.TechnicalAnalysisChart),
  { ssr: false, loading: () => <Skeleton className="h-[540px] w-full rounded-xl" /> },
);

type Envelope = {
  data: unknown;
  error?: { code?: string; message?: string; retryAfterSeconds?: number; reason?: string; retryable?: boolean };
  meta?: { timestamp?: unknown };
};
type ChartResult = ReturnType<typeof normalizedCandleResultSchema.parse>;
type ChartCacheEntry = { data: ChartResult; updatedAt: string };
type KeyedChartResult = ChartCacheEntry & { requestKey: string };

interface Props {
  symbol: string;
  active: boolean;
  interval: CandleInterval;
  range: HistoricalRange;
  session: MarketSessionMode;
  adjusted: boolean;
  currentPrice?: number | null;
  /** Provenance of the accepted price for the decision panel (never REAL-TIME). */
  marketLabel?: MarketDataLabel | null;
  liveCandle?: LiveCandle | null;
  liveUpdateSinkRef?: { current: CanonicalLiveUpdateSink | null };
  liveActive?: boolean;
  onLiveRefresh?: () => void;
  liveRefreshDisabled?: boolean;
  /** Report the newest completed displayed bar up as a history-fallback price candidate. */
  onHistoryFallbackChange?: (fallback: AcceptedPriceCandidate | null) => void;
  preferences: ChartPreferences;
  onSelectInterval: (interval: CandleInterval) => void;
  onSelectRange: (range: HistoricalRange) => void;
  onToggleFavoriteInterval: (interval: CandleInterval) => void;
  onToggleFavoriteRange: (range: HistoricalRange) => void;
  onChartType: (type: ChartPreferences['chartType']) => void;
  onToggle: (key: ToolbarToggleKey) => void;
}

function limitationMessage(code: string | undefined): string {
  if (code === 'provider-not-configured') return 'ยังไม่ได้ตั้งค่าแหล่งข้อมูลแท่งเทียนย้อนหลัง';
  if (code === 'forbidden' || code === 'provider-unauthorized') return 'แหล่งข้อมูลย้อนหลังไม่อนุญาตให้เรียกข้อมูลนี้';
  if (code === 'rate-limited') return 'แหล่งข้อมูลย้อนหลังกำลังจำกัดอัตราการเรียก กรุณารอสักครู่';
  if (code === 'unsupported') return 'หลักทรัพย์นี้ หรือคู่แท่งเทียน/ช่วงข้อมูลที่เลือก ไม่รองรับ';
  if (code === 'invalid-symbol') return 'หลักทรัพย์นี้ถูกถอนออกจากตลาด หรือไม่สามารถระบุได้อย่างปลอดภัย';
  if (code === 'not-found' || code === 'insufficient-data') return 'ไม่มีข้อมูล OHLCV จริงสำหรับหลักทรัพย์และช่วงที่เลือก';
  return 'ข้อมูลแท่งเทียนใช้งานไม่ได้ชั่วคราว';
}

export function MarketCandleChartPanel(props: Props) {
  const {
    symbol, active, interval, range, session, adjusted, currentPrice, marketLabel, liveCandle,
    liveUpdateSinkRef, liveActive, onLiveRefresh, liveRefreshDisabled, onHistoryFallbackChange,
    preferences, onSelectInterval, onSelectRange, onToggleFavoriteInterval, onToggleFavoriteRange,
    onChartType, onToggle,
  } = props;
  const appActive = useAppActive();
  // When the current selection is the exact bucket the shared market source
  // streams, the chart consumes that single accepted candle instead of running a
  // duplicate history poll. The Yahoo history still loads exactly once below.
  const coveredByLiveSource = Boolean(liveActive) && matchesLiveSelection(interval, session);
  const [resultState, setResultState] = useState<KeyedChartResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string; diagnostics?: string; retryable?: boolean } | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(0);
  const cache = useRef(new Map<string, ChartCacheEntry>());
  const inflight = useRef(new Map<string, Promise<void>>());
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const requestKey = chartRequestKey({ symbol, interval, range, adjusted, session });
  // A selection update renders before its effect can clear the previous result.
  // Keying the data prevents that one stale render from mounting the chart with
  // a new interval/symbol and issuing a throwaway levels request.
  const result = resultState?.requestKey === requestKey ? resultState.data : null;

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const request = useCallback(async (force = false) => {
    if (!active || !appActive) return;
    if (!navigator.onLine) { setError({ code: 'offline', message: 'You are offline, so no provider request was made.', retryable: true }); return; }
    const plan = planChartRequest({
      force,
      hasCache: cache.current.has(requestKey),
      hasInflight: inflight.current.has(requestKey),
      now: Date.now(),
      cooldownUntil,
    });
    if (plan === 'serve-cache') {
      setResultState({ requestKey, ...cache.current.get(requestKey)! });
      setError(null);
      return;
    }
    if (plan === 'join-inflight') return inflight.current.get(requestKey);
    if (plan === 'wait-cooldown') return;
    const requestGeneration = ++generation.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);
    const operation = (async () => {
      try {
        const query = new URLSearchParams({ symbol, interval, range, adjusted: String(adjusted), session });
        // Historical primary: the server-side Yahoo Finance Chart JSON pipeline
        // (`/api/market/candles`). It is already normalized, validated, aggregated
        // and cached server-side, and it is the SAME pipeline the shared market
        // source and the S/R level engine read — so the chart, the header fallback
        // and the pivot basis can never disagree about what a bar was.
        const response = await fetch(`/api/market/candles?${query.toString()}`, { signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
        const payload = await response.json() as Envelope;
        if (!response.ok) {
          const retry = Number(response.headers.get('Retry-After') ?? payload.error?.retryAfterSeconds ?? 0);
          if (retry > 0) setCooldownUntil(Date.now() + retry * 1_000);
          throw Object.assign(new Error(limitationMessage(payload.error?.code)), {
            code: payload.error?.code,
            retryable: payload.error?.retryable,
            diagnostics: process.env.NODE_ENV === 'development' ? payload.error?.reason ?? payload.error?.message : undefined,
          });
        }
        const parsed = normalizedCandleResultSchema.safeParse(payload.data);
        if (!parsed.success) throw Object.assign(new Error('ข้อมูลแท่งเทียนย้อนหลังไม่ผ่านการตรวจสอบ'), { code: 'invalid-provider-response' });
        const responseTimestamp = typeof payload.meta?.timestamp === 'string'
          ? new Date(payload.meta.timestamp)
          : null;
        if (!responseTimestamp || Number.isNaN(responseTimestamp.valueOf())) {
          throw Object.assign(new Error('ข้อมูลเวลาอัปเดตย้อนหลังไม่ผ่านการตรวจสอบ'), { code: 'invalid-provider-response' });
        }
        if (!shouldApplyResponse(generation.current, requestGeneration, controller.signal.aborted)) return;
        const entry = { data: parsed.data, updatedAt: responseTimestamp.toISOString() };
        cache.current.set(requestKey, entry);
        setResultState({ requestKey, ...entry });
        setCooldownUntil(0);
      } catch (cause) {
        if (!shouldApplyResponse(generation.current, requestGeneration, controller.signal.aborted)) return;
        setResultState(null);
        setError({ code: (cause as { code?: string }).code, message: cause instanceof Error ? cause.message : 'Market candles are unavailable.', diagnostics: (cause as { diagnostics?: string }).diagnostics, retryable: (cause as { retryable?: boolean }).retryable });
      } finally {
        if (generation.current === requestGeneration) setLoading(false);
      }
    })().finally(() => inflight.current.delete(requestKey));
    inflight.current.set(requestKey, operation);
    return operation;
  }, [active, adjusted, appActive, cooldownUntil, interval, range, requestKey, session, symbol]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setResultState(null);
      setError(null);
      if (active && appActive) void request();
    });
    return () => { cancelled = true; generation.current += 1; abort.current?.abort(); };
  }, [active, appActive, request, requestKey]);
  useEffect(() => {
    // The shared market source is the single polling loop for the live bucket:
    // when it covers this selection the chart never runs its own recurring poll.
    if (!shouldPollChart({
      active,
      appActive,
      hasResult: Boolean(result),
      dataStatus: result?.dataStatus ?? '',
      coveredByLiveSource,
    })) return;
    const timer = window.setInterval(() => { void request(true); }, 60_000);
    return () => window.clearInterval(timer);
  }, [active, appActive, coveredByLiveSource, request, result]);
  useEffect(() => () => abort.current?.abort(), []);

  const prices = useMemo(() => result?.candles.map((bar) => ({
    date: new Date(bar.timestamp * 1_000).toISOString(),
    open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
    partial: bar.partial,
  })) ?? [], [result]);
  // Fold the shared source's accepted active candle into the loaded history:
  // same bucket updates in place, a newer bucket appends once, stale is ignored.
  const displayPrices = useMemo(
    () => (coveredByLiveSource ? mergeLiveCandleIntoBars(prices, liveCandle ?? null, interval) : prices),
    [coveredByLiveSource, interval, liveCandle, prices],
  );
  const historyAsOf = result?.actualEnd ? new Date(result.actualEnd * 1_000).toISOString() : undefined;
  const provenance = result ? resolveChartProvenance({
    historyStatus: result.dataStatus,
    historyProvider: result.provider,
    historyAsOf,
    coveredByLiveSource,
    hasLiveCandle: Boolean(liveCandle),
    marketLabel,
  }) : null;
  const successfulUpdateAt = provenance?.realtime
    ? marketLabel?.receivedAt ?? null
    : resultState?.requestKey === requestKey ? resultState.updatedAt : null;
  // The newest completed (non-partial) bar the chart currently displays, reported
  // up as a history-fallback price candidate — the exact bar shown, never a
  // fabricated one. It is the header's history candidate for Daily/Week/Month (or
  // any snapshot-403 selection); the shared resolver accepts it only when its
  // verified exchange timestamp is newer, or as the trust-ranked fallback when a
  // higher-ranked source is absent. Reported as null while there is no result so a
  // stale bar from a superseded selection can never linger.
  const historyFallback = useMemo<AcceptedPriceCandidate | null>(() => {
    if (!result) return null;
    let newestCompleted: (typeof displayPrices)[number] | null = null;
    for (const priced of displayPrices) {
      if (priced.partial === true) continue; // exclude the still-forming bucket
      newestCompleted = priced; // displayPrices is ascending by time
    }
    if (!newestCompleted || !Number.isFinite(newestCompleted.close)) return null;
    // The bar's own semantic domain. A bucket from the `extended` session selection
    // must not reach the header as a regular price, so an unclassifiable bar is
    // reported as no candidate at all rather than as a regular one.
    const priceRole = historyBarPriceRole(newestCompleted.date);
    if (!priceRole) return null;
    return {
      price: newestCompleted.close,
      source: 'history-fallback',
      exchangeTimestamp: newestCompleted.date,
      mode: historyFallbackModeFromStatus(result.dataStatus),
      provider: result.provider,
      priceRole,
    };
  }, [result, displayPrices]);
  useEffect(() => { onHistoryFallbackChange?.(historyFallback); }, [historyFallback, onHistoryFallbackChange]);

  // Truthful raw/adjusted provenance: `adjusted` is what we asked the provider
  // for, `result.adjusted` is what it actually served. A series is only ever
  // labelled adjusted when the provider confirmed it.
  const priceAdjustment = resolvePriceAdjustment({
    interval,
    requested: adjusted,
    providerAdjusted: Boolean(result?.adjusted),
    source: result?.provider ?? 'provider',
  });

  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1_000));
  // When the shared source owns this bucket, Refresh triggers exactly one
  // shared request that updates the header and current candle together — it never
  // reloads the full chart history (that only happens on a range/interval change).
  const onRefresh = coveredByLiveSource && onLiveRefresh ? onLiveRefresh : () => void request(true);
  const refreshDisabled = coveredByLiveSource
    ? Boolean(liveRefreshDisabled) || !appActive
    : loading || cooldown > 0 || !appActive || error?.retryable === false;
  const refreshLabel = !coveredByLiveSource && cooldown ? `รีเฟรชได้ใน ${cooldown}s` : 'รีเฟรช';
  const warningNotices = presentChartWarnings(result?.warnings ?? []);
  return <div className="space-y-3" data-testid="market-candle-chart-panel">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={refreshDisabled} onClick={onRefresh} className="min-h-11 rounded-lg border border-slate-700 px-3 text-xs text-slate-300 disabled:opacity-40">{refreshLabel}</button>
      {successfulUpdateAt && (
        <p className="ml-auto text-xs text-slate-500" data-testid="chart-last-updated">
          อัปเดตล่าสุด: {formatBangkokDateTime(successfulUpdateAt)}
        </p>
      )}
    </div>
    {warningNotices.length > 0 && <div className="flex flex-wrap gap-1.5" aria-label="สถานะข้อมูลย้อนหลัง">
      {warningNotices.map((notice) => <span key={notice.kind} title={notice.message} className="rounded-full border border-slate-700 bg-slate-900/70 px-2 py-1 text-[11px] text-slate-400">ⓘ {notice.message}</span>)}
    </div>}
    {loading && !result && <Skeleton className="h-[420px] w-full rounded-xl" />}
    {error && !loading && <div role="alert" className="flex min-h-[300px] flex-col items-center justify-center rounded-xl border border-amber-500/20 p-4 text-center text-sm text-amber-200"><p>{error.message}</p><p className="mt-1 text-xs text-slate-500">No candle is mocked, interpolated, forward-filled, or replaced by another provider.</p>{process.env.NODE_ENV === 'development' && error.diagnostics && <details className="mt-2 max-w-xl text-left text-xs text-slate-500"><summary>Development diagnostics</summary><p className="mt-1 break-words">{error.diagnostics}</p></details>}{error.retryable !== false && <button type="button" disabled={cooldown > 0} onClick={() => void request(true)} className="mt-3 min-h-11 rounded-lg border border-slate-700 px-3 disabled:opacity-40">{cooldown ? `ลองใหม่ใน ${cooldown}s` : 'ลองใหม่'}</button>}</div>}
    {result && displayPrices.length === 1 && <div role="status" className="rounded-xl border border-amber-500/20 p-5 text-sm text-amber-200">ช่วงนี้มีข้อมูลจริงเพียง 1 แท่ง อาจเป็นหลักทรัพย์เพิ่งเข้าตลาดหรือช่วงที่เลือกสั้นเกินไป กรุณาเลือก range ที่ยาวขึ้น</div>}
    {result && displayPrices.length >= 2 && <TechnicalAnalysisChart
      symbol={result.symbol}
      interval={interval}
      range={range}
      prices={displayPrices}
      datasetKey={requestKey}
      currentPrice={currentPrice}
      priceProvenance={provenance ? `${provenance.provider ?? 'provider'} · ${provenance.status}` : null}
      priceAdjustment={priceAdjustment}
      currency={result.currency === 'USD' || result.currency == null ? '$' : `${result.currency} `}
      pricePrecision={result.pricePrecision ?? 2}
      preferences={preferences}
      onSelectInterval={onSelectInterval}
      onSelectRange={onSelectRange}
      onToggleFavoriteInterval={onToggleFavoriteInterval}
      onToggleFavoriteRange={onToggleFavoriteRange}
      onChartType={onChartType}
      onToggle={onToggle}
      liveUpdateSinkRef={liveUpdateSinkRef}
    />}
    {result && displayPrices.length === 0 && <p className="rounded-xl border border-amber-500/20 p-4 text-sm text-amber-200">ไม่มีแท่งเทียนที่ผ่านการตรวจสอบสำหรับช่วงที่เลือก</p>}
  </div>;
}

export const IntradayChartPanel = MarketCandleChartPanel;
