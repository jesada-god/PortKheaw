'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ArrowLeft, Bell, Share2, Star } from 'lucide-react';
import { addWatchlistItemAction, removeWatchlistItemAction } from '@/app/watchlist/actions';
import { BrandLockup } from '@/src/components/brand/BrandLockup';
import { Tabs } from '@/src/components/ui/Tabs';
import { DetailPopover } from '@/src/components/ui/DetailPopover';
import { useToast } from '@/src/components/ui/Toast';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { useAppVisible } from '@/src/hooks/useAppVisible';
import { useExchangeClock } from '@/src/hooks/useExchangeClock';
import {
  applySymbolHalt,
  resolveCurrentMarketSession,
  sessionPhaseOf,
} from '@/src/lib/market-data/current-session';
import { resolveCanonicalMarketSnapshot } from '@/src/lib/market-data/market-snapshot';
import { useMarketSource, type CanonicalLiveUpdateSink } from './useMarketSource';
import {
  freshnessFromMode,
  selectionKeyOf,
  type AcceptedPriceCandidate,
  type MarketSelection,
  type MarketSessionKind,
} from '@/src/lib/stock-detail/market-source';
import { KeyStatisticsSection } from '@/src/components/analytics/key-statistics/KeyStatisticsSection';
import { AnalystTargetSection } from '@/src/components/analytics/analyst-target/AnalystTargetSection';
import { MarketSignalSection } from '@/src/components/analytics/market-signal/MarketSignalSection';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import type { FxQuote } from '@/src/lib/market-data/fx/types';
import {
  formatMarketCapitalization,
  resolveAssetPresentationPolicy,
} from '@/src/lib/stock-detail/profile-presentation';
import type { CompanyProfileLanguage } from '@/src/lib/stock-detail/profile-presentation';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import { resolveCompanyIdentity } from '@/src/lib/stock-detail/identity';
import type {
  InitialHistoryResponse,
  StockDetailQuoteResource,
  StockDetailResource,
} from '@/src/lib/stock-detail/types';
import type {
  CompanyProfile,
  MarketDataApiError,
  MarketOverview,
} from '@/src/lib/market-data/types';
import { CompanyProfileCard } from './CompanyProfileCard';
import {
  buildStockPriceHeaderModel,
  preserveLastKnownExtendedQuote,
  resolvePriceCurrency,
  type PriceHeaderExtendedQuote,
} from './price-header';
import { requestCompanyProfile } from './profile-retry';
import { StockPriceHeader, type TransientPriceSink } from './StockPriceHeader';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { PlanThisStockCta } from '@/src/components/stock/PlanThisStockCta';
import {
  isContinuousAssetType,
  resolveContinuousMarketSession,
  resolveContinuousMarketSnapshot,
} from '@/src/lib/stock-detail/continuous-client';

const ChartPanel = dynamic(
  () => import('./ChartPanel').then((module) => module.ChartPanel),
  {
    ssr: false,
    loading: () => <div className="h-[340px] animate-pulse rounded-xl bg-slate-800/50" />,
  },
);
const NewsFeed = dynamic(
  () => import('@/src/components/news/NewsFeed').then((module) => module.NewsFeed),
  {
    ssr: false,
    loading: () => <div className="h-72 animate-pulse rounded-xl bg-slate-800/50" />,
  },
);
const OptionsChainPanel = dynamic(
  () => import('./OptionsChainPanel').then((module) => module.OptionsChainPanel),
  {
    ssr: false,
    loading: () => <div className="h-72 animate-pulse rounded-xl bg-slate-800/50" />,
  },
);
const OptionsSignalSection = dynamic(
  () => import('@/src/components/analytics/options-signal/OptionsSignalSection')
    .then((module) => module.OptionsSignalSection),
  {
    ssr: false,
    loading: () => <div className="h-96 animate-pulse rounded-2xl bg-slate-800/50" />,
  },
);

/**
 * The tab strip an instrument actually has content for.
 *
 * Financials is analyst targets, key statistics and a fundamentals-driven market
 * signal; Analysis is the US-listed options chain and its analytics. Neither
 * exists for a spot crypto pair, so both used to open on a permanently empty
 * panel. The presentation policy — not this component — decides that.
 */
function tabsFor(policy: { showFinancials: boolean; showOptionsAnalysis: boolean }): string[] {
  return [
    'Overview',
    'Chart',
    ...(policy.showFinancials ? ['Financials'] : []),
    'News',
    ...(policy.showOptionsAnalysis ? ['Analysis'] : []),
  ];
}

interface StockDetailClientProps {
  symbol: string;
  quoteResource: StockDetailQuoteResource;
  profileResource: StockDetailResource<CompanyProfile>;
  overviewResource: StockDetailResource<MarketOverview>;
  instrumentName: string | null;
  instrumentCurrency: string | null;
  instrumentExchange: string | null;
  instrumentLogoUrl: string | null;
  /** Instrument-master asset type, used only to name the profile card. */
  instrumentAssetType: string | null;
  initialHistory: InitialHistoryResponse;
  fxQuote: FxQuote | null;
  evaluatedAt: string;
  /**
   * Pre/after-hours print resolved on the SERVER from the existing Yahoo chart
   * pipeline, so the extended row costs the browser no request and no polling.
   * Used only when the live/REST quote pipeline has no accepted extended print
   * of its own, and never allowed to replace the regular price.
   */
  extendedQuote: PriceHeaderExtendedQuote | null;
  providerConfigured: boolean;
  initialWatched: boolean;
  technicalIndicatorsEnabled: boolean;
  advancedChartTypesEnabled: boolean;
  extendedIndicatorsEnabled: boolean;
  supportResistanceEnabled: boolean;
  keyStatisticsEnabled: boolean;
  analystConsensusEnabled: boolean;
  marketSignal?: MarketSignalResult | null;
}

function MetricCard({
  label,
  value,
  tooltip,
  footnote,
}: {
  label: string;
  value: string | null;
  tooltip?: string;
  /**
   * Secondary provenance for a metric that does NOT share the live quote's
   * timestamp — see the market-capitalisation card below.
   */
  footnote?: string | null;
}) {
  return (
    <div data-metric={label} className="min-h-20 rounded-xl border border-slate-800 bg-[#151B28] p-3">
      {/*
        A div, not a <p>: the shared ⓘ affordance opens a <div role="dialog">
        panel, which a paragraph may not contain — the browser would close the
        <p> early and split the label row.
      */}
      <div className="flex items-center gap-1 text-[10px] text-slate-500">
        <span>{label}</span>
        {tooltip && (
          /*
            Was a hover-only `title` span: it explained nothing on touch, where
            there is no hover, and nothing to a keyboard user either. The shared
            popover is a real button — tap, click and Enter/Space all open it,
            and a second press, Escape or a press outside closes it.
          */
          <DetailPopover
            triggerLabel={`คำอธิบาย: ${label}`}
            title={label}
            align="start"
            testId={`metric-hint-${label}`}
          >
            <p className="mt-2 text-xs leading-relaxed text-slate-300">{tooltip}</p>
          </DetailPopover>
        )}
      </div>
      <p className="mt-2 break-words font-mono text-sm text-white">
        {value ?? 'ไม่พบข้อมูล'}
      </p>
      {footnote && (
        <p className="mt-1 break-words text-[10px] leading-4 text-slate-500">{footnote}</p>
      )}
    </div>
  );
}

function numberValue(value: number | null | undefined): string | null {
  return value == null || !Number.isFinite(value) ? null : value.toLocaleString('en-US');
}

export function StockDetailClient({
  symbol,
  quoteResource: initialQuoteResource,
  profileResource: initialProfileResource,
  overviewResource,
  instrumentName,
  instrumentCurrency,
  instrumentExchange,
  instrumentLogoUrl,
  instrumentAssetType,
  initialHistory,
  fxQuote,
  evaluatedAt,
  extendedQuote: serverExtendedQuote,
  providerConfigured,
  initialWatched,
  technicalIndicatorsEnabled,
  advancedChartTypesEnabled,
  extendedIndicatorsEnabled,
  supportResistanceEnabled,
  keyStatisticsEnabled,
  analystConsensusEnabled,
  marketSignal = null,
}: StockDetailClientProps) {
  const router = useRouter();
  const { addToast } = useToast();
  const [tab, setTab] = useState('Overview');
  const [watched, setWatched] = useState(initialWatched);
  const [pending, startTransition] = useTransition();
  const [profileResource, setProfileResource] = useState(initialProfileResource);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileRetryAt, setProfileRetryAt] = useState(() => {
    const seconds = initialProfileResource.retryAfterSeconds
      ?? initialProfileResource.error?.retryAfterSeconds
      ?? 0;
    return seconds > 0 ? Date.parse(evaluatedAt) + seconds * 1_000 : 0;
  });
  // Thai is the reader's language for the card's own wording. The DESCRIPTION
  // still falls back to English when there is no Thai version of it, which the
  // card resolves separately.
  const [profileLanguage, setProfileLanguage] = useState<CompanyProfileLanguage>('th');
  const presentation = resolveAssetPresentationPolicy(instrumentAssetType);
  const tabs = tabsFor(presentation);
  const [lastKnownExtended, setLastKnownExtended] = useState<{
    symbol: string;
    quote: PriceHeaderExtendedQuote | null;
  }>(() => ({ symbol, quote: serverExtendedQuote }));
  const isOnline = useOnlineStatus();
  // The live market socket follows tab VISIBILITY, not window focus: focusing the
  // DevTools/console, a split-screen app, a second monitor or the OS taskbar must
  // never tear the connection down (that produced the spurious 1005 close). A
  // genuinely backgrounded/minimised tab still releases the socket via visibility.
  const tabVisible = useAppVisible();
  // The chart reports its live-relevant selection (interval/session/adjusted) so
  // the single shared market source follows it: the header price and the chart's
  // active candle then derive from one accepted event. Default is the header's
  // 5m/regular current-price proxy used before the chart drives a selection.
  const [chartSelection, setChartSelection] = useState<MarketSelection>({
    interval: '5m', session: 'regular', adjusted: false,
  });
  const handleSelectionChange = useCallback((next: MarketSelection) => {
    setChartSelection((previous) => (
      selectionKeyOf(previous) === selectionKeyOf(next) ? previous : next
    ));
  }, []);
  // The chart reports its newest completed displayed bar as the header's
  // history-fallback price (last-resort priority). It flows back into the shared
  // market source so the header, chart price line and S/R currentPrice all read
  // one accepted value and timestamp.
  const [chartHistoryFallback, setChartHistoryFallback] = useState<AcceptedPriceCandidate | null>(null);
  // Shared ref between the market source and StockPriceHeader. Trade ticks write
  // directly to the price text node; snapshots/bars still flow through React.
  const transientPriceSinkRef = useRef<TransientPriceSink | null>(null);
  const liveUpdateSinkRef = useRef<CanonicalLiveUpdateSink | null>(null);

  useEffect(() => {
    if (profileRetryAt <= 0) return;
    const timeout = window.setTimeout(
      () => setProfileRetryAt(0),
      Math.max(0, profileRetryAt - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [profileRetryAt]);

  const profile = profileResource.data;
  const overview = overviewResource.data;
  const continuousMarket = isContinuousAssetType(instrumentAssetType);
  const market = overview?.markets.find((item) => (
    item.primaryExchanges.some((exchange) => (
      profile?.exchange?.toLowerCase().includes(exchange.toLowerCase())
      || instrumentExchange?.toLowerCase().includes(exchange.toLowerCase())
    ))
  )) ?? overview?.markets[0] ?? null;
  // SINGLE SOURCE OF TRUTH for the current session. It reads a server-anchored
  // ticking instant plus the market-status report WITH its freshness, and never
  // any quote/candle/extended timestamp. A cached provider "open" from a previous
  // trading date is discarded inside the resolver, which then falls back to the
  // exchange calendar in America/New_York.
  const exchangeNow = useExchangeClock(evaluatedAt);
  const resolvedSession = continuousMarket
    ? resolveContinuousMarketSession(exchangeNow)
    : resolveCurrentMarketSession({
        now: exchangeNow,
        marketStatus: market
          ? {
              status: market.currentStatus,
              asOf: overviewResource.freshness.asOf,
              source: overviewResource.provider,
              stale: overviewResource.freshness.status === 'stale',
              maxAgeSeconds: overviewResource.freshness.maxAgeSeconds,
            }
          : null,
      });
  // The transport-agnostic market source refreshes the header/price in place via
  // entitlement-aware REST polling (12s in a live session, slower when closed),
  // pausing when hidden/offline. It never claims real-time data.
  const marketSession: MarketSessionKind = continuousMarket || ['PREMARKET', 'REGULAR', 'AFTER_HOURS', 'EARLY_CLOSE']
    .includes(resolvedSession.session)
    ? 'regular'
    : 'closed';
  const {
    quoteResource,
    quoteLoading,
    quoteRetryAt,
    liveCandle,
    priceState,
    dataLabel,
    liveSession,
    halted,
    haltReason,
    connectionState,
    refresh: refreshQuote,
  } = useMarketSource({
    symbol,
    initialQuote: initialQuoteResource,
    session: marketSession,
    selection: chartSelection,
    historyFallback: chartHistoryFallback,
    initialReceivedAt: evaluatedAt,
    active: tabVisible,
    online: isOnline,
    // Polygon REST bootstraps history; Finnhub owns the live trade stream and
    // the Railway Gateway owns canonical candle construction.
    // When the Gateway URL is absent, the coordinator safely falls back to REST.
    enabled: true,
    allowWebSocket: !continuousMarket,
    marketKind: continuousMarket ? 'continuous' : 'us-equity',
    transientPriceSinkRef,
    liveUpdateSinkRef,
  });

  const quote = quoteResource.data;
  const identity = resolveCompanyIdentity({
    symbol,
    profile,
    instrument: {
      name: instrumentName,
      exchange: instrumentExchange,
    },
    quoteMetadata: {
      symbol: quote?.symbol ?? symbol,
    },
  });
  const exchange = identity.exchange;
  const sourceCurrency = resolvePriceCurrency({
    profileCurrency: profile?.currency,
    quoteCurrency: quote?.currency,
    instrumentCurrency,
    exchange,
  }).currency;
  // A symbol halt replaces the REGULAR label only; it never turns an open market
  // into a closed one, and it never invents a session outside regular hours.
  const currentSession = applySymbolHalt(resolvedSession.session, halted);
  const liveExtendedQuote: PriceHeaderExtendedQuote | null = (
    priceState.extendedPrice !== null
    && priceState.extendedSession !== null
    && priceState.extendedTimestamp !== null
  ) ? {
      session: priceState.extendedSession === 'PRE' ? 'premarket' : 'after-hours',
      price: priceState.extendedPrice,
      asOf: priceState.extendedTimestamp,
      tradingDate: priceState.extendedTradingDate,
      freshness: freshnessFromMode(
        priceState.extendedMode ?? 'DELAYED',
        priceState.extendedTimestamp,
      ),
      provider: priceState.extendedProvider,
    }
    : null;
  const incomingExtendedQuote = preserveLastKnownExtendedQuote(
    serverExtendedQuote,
    liveExtendedQuote,
  );
  const persistedExtendedQuote = preserveLastKnownExtendedQuote(
    lastKnownExtended.symbol === symbol ? lastKnownExtended.quote : null,
    incomingExtendedQuote,
  );
  /**
   * THE canonical market price snapshot — the single source of truth this header
   * renders from. A symbol halt is applied first so the phase it resolves against
   * is the one the header actually shows.
   */
  const marketSnapshot = continuousMarket
    ? resolveContinuousMarketSnapshot({ symbol, quote: quoteResource, evaluatedAt: exchangeNow })
    : resolveCanonicalMarketSnapshot({
        symbol,
        session: {
          ...resolvedSession,
          session: currentSession,
          phase: sessionPhaseOf(currentSession),
        },
        sessionSourceLabel: resolvedSession.provider.accepted
          ? `${resolvedSession.source} (${resolvedSession.provider.source ?? 'ไม่ทราบผู้ให้บริการ'})`
          : `${resolvedSession.source} · provider ${resolvedSession.provider.rejection ?? 'missing'}`,
        quote: quoteResource,
        // The server-rendered quote's `regularClose` was verified against the canonical
        // trading date server-side, so it backs the live pipeline's own close.
        initialQuote: initialQuoteResource,
        extended: persistedExtendedQuote,
        now: exchangeNow,
      });
  // Canonical/regular snapshots often omit extended fields. Capture each real
  // pre/post print independently so omission, reconnect and rerender cannot be
  // mistaken for an instruction to clear the last-known valid quote. The pure
  // merge returns the existing object for an equivalent quote, so this guarded
  // derived-state update settles after at most one render.
  const nextLastKnownExtended = preserveLastKnownExtendedQuote(
    persistedExtendedQuote,
    incomingExtendedQuote,
  );
  if (lastKnownExtended.symbol !== symbol || nextLastKnownExtended !== lastKnownExtended.quote) {
    setLastKnownExtended({ symbol, quote: nextLastKnownExtended });
  }
  const priceHeaderModel = buildStockPriceHeaderModel({
    snapshot: marketSnapshot,
    evaluatedAt: exchangeNow,
    fallbackLabel: quoteResource.fallbackLabel,
  });
  /**
   * The price the analytics panels mark against (S/R distance, options underlying).
   *
   * Read from the canonical snapshot so it can never disagree with the header:
   * inside REGULAR that is the live regular price, and once the market is closed it
   * is the official close, with a real extended print preferred during PRE/POST
   * because that IS the most recent traded price for a marking purpose.
   */
  const analyticalSpotPrice = marketSnapshot.session === 'REGULAR'
    ? marketSnapshot.mainPrice
    : marketSnapshot.extendedPrice ?? marketSnapshot.mainPrice;

  const toggleWatch = () => {
    if (!isOnline) {
      addToast({ title: 'แก้ไขรายการติดตามไม่ได้ขณะออฟไลน์', type: 'error' });
      return;
    }
    startTransition(async () => {
      const result = watched
        ? await removeWatchlistItemAction(symbol)
        : await addWatchlistItemAction(symbol);
      if (result.ok) {
        setWatched(!watched);
        addToast({
          title: watched ? 'นำออกจากรายการติดตามแล้ว' : 'เพิ่มในรายการติดตามแล้ว',
          type: 'success',
        });
      } else {
        addToast({ title: result.message, type: 'error' });
      }
    });
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: symbol, url });
      else await navigator.clipboard.writeText(url);
      addToast({ title: 'แชร์ลิงก์แล้ว', type: 'success' });
    } catch {
      // The user cancelled the share sheet.
    }
  };

  const retryProfile = async () => {
    const now = Date.now();
    if (profileLoading || now < profileRetryAt) return;
    setProfileLoading(true);
    try {
      const next = await requestCompanyProfile(symbol);
      setProfileResource(next);
      const retryAfterSeconds = next.retryAfterSeconds
        ?? next.error?.retryAfterSeconds
        ?? 0;
      if (retryAfterSeconds > 0) {
        setProfileRetryAt(Date.now() + retryAfterSeconds * 1_000);
      } else {
        setProfileRetryAt(0);
      }
      if (next.error) {
        console.warn('[stock-detail:profile-retry]', { code: next.error.code });
      }
    } catch (cause) {
      const error: MarketDataApiError = {
        code: 'upstream-unavailable',
        message: cause instanceof Error ? cause.message : 'Company profile is unavailable',
        retryable: true,
      };
      setProfileResource((current) => ({
        ...current,
        reason: `${error.code}: ${error.message}`,
        error,
      }));
      console.warn('[stock-detail:profile-retry]', { code: error.code });
    } finally {
      setProfileLoading(false);
    }
  };

  return (
    /*
     * No bottom padding of its own. The shell already reserves the dock's whole
     * footprint through `--dock-clearance`, and this page used to add `pb-20` on
     * top of it — 80px of empty page above the capsule that no other route had,
     * which is what made the dock look like it sat somewhere different here.
     */
    <div>
      <header className="sticky top-0 z-40 flex min-h-16 items-center justify-between border-b border-slate-800 bg-[#0A0E17]/95 px-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          {/*
            This page owns its header rather than using the shared one, so the
            brand used to reach it through the desktop sidebar. With the sidebar
            replaced by the dock, nothing carried it here and PortKheaw vanished
            from the one route people spend the longest on. The lockup takes the
            sidebar's old place from lg only: the handset header already packs a
            back control, the instrument logo, the symbol and three actions into
            320px, and it has never shown the brand.
          */}
          <BrandLockup className="brand-lockup--from-lg" />
          <span aria-hidden="true" className="hidden h-7 w-px flex-none bg-slate-800 lg:block" />
          <button
            aria-label="กลับ"
            onClick={() => {
              const sameOriginReferrer = document.referrer.startsWith(window.location.origin);
              if (sameOriginReferrer && window.history.length > 1) router.back();
              else router.push('/search');
            }}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-slate-400"
          >
            <ArrowLeft size={20} />
          </button>
          <InstrumentLogo
            symbol={symbol}
            companyName={identity.name}
            logoUrl={instrumentLogoUrl ?? profileResource.data?.logoUrl ?? null}
            size={44}
            mobileSize={40}
            appearance="plain"
            priority
          />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-white">{symbol}</h1>
            <p className="truncate text-xs text-slate-500">
              {identity.name}{exchange ? ` · ${exchange}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0">
          <button
            disabled={pending || !isOnline}
            aria-label={watched ? `นำ ${symbol} ออกจากรายการติดตาม` : `เพิ่ม ${symbol} ในรายการติดตาม`}
            onClick={toggleWatch}
            className={watched
              ? 'flex min-h-11 min-w-11 items-center justify-center text-[#D4FF00]'
              : 'flex min-h-11 min-w-11 items-center justify-center text-slate-400'}
          >
            <Star size={20} fill={watched ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => addToast({ title: 'Alert: Coming Soon', type: 'info' })}
            aria-label="Alert Coming Soon"
            className="flex min-h-11 min-w-11 items-center justify-center text-slate-400"
          >
            <Bell size={20} />
          </button>
          <button
            onClick={() => void share()}
            aria-label="แชร์"
            className="flex min-h-11 min-w-11 items-center justify-center text-slate-400"
          >
            <Share2 size={20} />
          </button>
        </div>
      </header>

      <main className="space-y-6 p-4 md:p-8">
        <StockPriceHeader
          symbol={symbol}
          exchange={exchange}
          sourceCurrency={sourceCurrency}
          model={priceHeaderModel}
          providerConfigured={providerConfigured}
          quoteError={quoteResource.error}
          quoteLoading={quoteLoading}
          quoteRetryAt={quoteRetryAt}
          onRetryQuote={refreshQuote}
          fxQuote={fxQuote}
          evaluatedAt={exchangeNow}
          realtime={dataLabel?.realtime ?? false}
          feed={dataLabel?.feed ?? null}
          symbolHalted={halted}
          haltReason={haltReason}
          connectionState={connectionState}
          transientPriceSinkRef={transientPriceSinkRef}
        />

        {/*
          One line, under the price and above the tabs: the reader has just seen
          what the stock is doing, and this is where "so what would my plan be"
          belongs. It carries the symbol only — see PlanThisStockCta.
        */}
        <PlanThisStockCta symbol={symbol} />

        <div className="sticky top-16 z-30 -mx-4 border-y border-slate-800 bg-[#0A0E17]/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0">
          <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />
        </div>

        <section className="min-h-[360px]">
          {tab === 'Overview' && (
            <Overview
              symbol={symbol}
              quoteResource={quoteResource}
              profileResource={profileResource}
              marketCapitalizationCurrency={sourceCurrency}
              profileLoading={profileLoading}
              profileRetryAt={profileRetryAt}
              onRetryProfile={() => void retryProfile()}
              profileLanguage={profileLanguage}
              onProfileLanguageChange={setProfileLanguage}
              instrumentAssetType={instrumentAssetType}
              continuousMarket={continuousMarket}
            />
          )}
          {tab === 'Chart' && (
            <ChartPanel
              symbol={symbol}
              active={tab === 'Chart'}
              initialHistory={initialHistory}
              // Analytics follows the session-selected spot from the same
              // atomic source state: regular in REGULAR/CLOSED and the separate
              // extended domain in PRE/AFTER when a verified print exists.
              currentPrice={analyticalSpotPrice}
              marketLabel={dataLabel}
              liveCandle={liveCandle}
              liveUpdateSinkRef={liveUpdateSinkRef}
              liveActive
              onLiveRefresh={refreshQuote}
              liveRefreshDisabled={quoteLoading}
              onSelectionChange={handleSelectionChange}
              onHistoryFallbackChange={setChartHistoryFallback}
              continuousMarket={continuousMarket}
              technicalIndicatorsEnabled={technicalIndicatorsEnabled}
              advancedChartTypesEnabled={advancedChartTypesEnabled}
              extendedIndicatorsEnabled={extendedIndicatorsEnabled}
              supportResistanceEnabled={supportResistanceEnabled}
            />
          )}
          {tab === 'News' && <NewsFeed symbol={symbol} />}
          {tab === 'Financials' && (
            <div className="space-y-4">
              <AnalystTargetSection symbol={symbol} enabled={analystConsensusEnabled} />
              <MarketSignalSection result={marketSignal} />
              {keyStatisticsEnabled && <KeyStatisticsSection symbol={symbol} />}
            </div>
          )}
          {tab === 'Analysis' && (
            <div className="space-y-4">
              <OptionsSignalSection
                symbol={symbol}
                active={tab === 'Analysis'}
              />
              <OptionsChainPanel
                symbol={symbol}
                acceptedPrice={analyticalSpotPrice}
                underlyingLabel={dataLabel}
              />
              <div className="rounded-2xl border border-amber-500/20 bg-[#151B28] p-5 text-center">
                <Activity className="mx-auto mb-3 text-amber-300" />
                <h2 className="font-bold text-white">AI analysis · Coming Soon</h2>
                <p className="mt-2 text-sm text-slate-400">ส่วน Options ด้านบนเป็น analytics ตามสูตรจากข้อมูลตลาดจริง ไม่ใช่คำสั่งหรือการรับประกันผลลัพธ์</p>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Overview({
  symbol,
  quoteResource,
  profileResource,
  marketCapitalizationCurrency,
  profileLoading,
  profileRetryAt,
  onRetryProfile,
  profileLanguage,
  onProfileLanguageChange,
  instrumentAssetType,
  continuousMarket,
}: {
  symbol: string;
  quoteResource: StockDetailQuoteResource;
  profileResource: StockDetailResource<CompanyProfile>;
  marketCapitalizationCurrency: string | null;
  profileLoading: boolean;
  profileRetryAt: number;
  onRetryProfile: () => void;
  profileLanguage: CompanyProfileLanguage;
  onProfileLanguageChange: (language: CompanyProfileLanguage) => void;
  instrumentAssetType: string | null;
  continuousMarket: boolean;
}) {
  const quote = quoteResource.data;
  const profile = profileResource.data;
  const policy = resolveAssetPresentationPolicy(instrumentAssetType);
  const priceMetrics = [
    {
      label: 'ราคาเปิด',
      value: numberValue(quote?.open),
      tooltip: continuousMarket
        ? 'ราคาแรกของวัน (Open) ตามวันสากล UTC ของสินทรัพย์ที่ซื้อขายตลอด 24 ชั่วโมง'
        : 'ราคาแรกที่ซื้อขายเมื่อเปิดตลาดของวันนี้ (Open)',
    },
    {
      label: 'สูงสุดวันนี้',
      value: numberValue(quote?.high),
      tooltip: 'ราคาสูงสุดที่ซื้อขายกันในวันนี้ (High)',
    },
    {
      label: 'ต่ำสุดวันนี้',
      value: numberValue(quote?.low),
      tooltip: 'ราคาต่ำสุดที่ซื้อขายกันในวันนี้ (Low)',
    },
    {
      label: 'ราคาปิดก่อนหน้า',
      value: numberValue(quote?.previousClose) ?? '—',
      tooltip: 'ราคาปิดของวันซื้อขายก่อนหน้า (Prev Close) ใช้เป็นฐานเปรียบเทียบว่าราคาวันนี้เพิ่มขึ้นหรือลดลงเท่าไร',
    },
  ];
  /*
   * Market capitalisation is a FUNDAMENTAL, loaded from the company-profile
   * provider on its own (day-long) cache — not from the quote pipeline. Sitting
   * unannotated beside a live volume it read as being just as current, so it
   * carries its own source and as-of. It is withheld entirely for an instrument
   * whose profile describes something other than the traded asset (see
   * `resolveAssetPresentationPolicy`).
   */
  const marketCapitalizationValue = formatMarketCapitalization(
    profile?.marketCapitalization ?? null,
    marketCapitalizationCurrency,
  );
  const profileAsOf = profileResource.freshness.cachedAt ?? profileResource.freshness.asOf;
  const profileMetrics = [
    {
      label: 'ปริมาณซื้อขาย',
      value: numberValue(quote?.volume),
      tooltip: 'จำนวนหุ้น/หน่วยที่ซื้อขายกันในวันนี้ (Volume)',
    },
    ...(policy.showMarketCapitalization ? [{
      label: 'มูลค่าตลาด',
      value: marketCapitalizationValue,
      tooltip: 'มูลค่าตลาดรวมของบริษัท (Market Cap) = ราคาหุ้น × จำนวนหุ้นทั้งหมด เป็นข้อมูลพื้นฐาน ไม่ได้อัปเดตแบบเรียลไทม์พร้อมราคา',
      footnote: marketCapitalizationValue && profileAsOf
        // Provider names are deliberately absent: the footnote exists to say the
        // number is a fundamental with its own as-of, not to credit a vendor.
        // `profileResource.provider` is untouched and still flows to the card.
        ? `ข้อมูลพื้นฐาน · ${formatMarketDataAsOf(profileAsOf)}`
        : null,
    }] : []),
    ...(policy.showSectorAndIndustry ? [
      { label: 'กลุ่มธุรกิจ', value: profile?.sector ?? null, tooltip: 'หมวดธุรกิจหลักของบริษัท (Sector)' },
      { label: 'อุตสาหกรรม', value: profile?.industry ?? null, tooltip: 'อุตสาหกรรมย่อยของบริษัท (Industry)' },
    ] : []),
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {priceMetrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
      </div>
      <div className={`grid gap-3 ${profileMetrics.length > 2 ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2'}`}>
        {profileMetrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
      </div>
      {policy.kind === 'fund' && (
        <p className="text-xs leading-6 text-slate-500">
          กองทุน ETF ถือสินทรัพย์หลายรายการแทนการเป็นบริษัทเดียว
          ข้อมูลบริษัทผู้ออกกองทุน เช่น กลุ่มธุรกิจ จำนวนพนักงาน หรือมูลค่าตลาดของผู้ออก
          จึงไม่ได้อธิบายสิ่งที่กองทุนนี้ลงทุน และ PortKheaw ยังไม่มีข้อมูลขนาดกองทุน (สินทรัพย์สุทธิ)
          จากแหล่งข้อมูลที่เชื่อถือได้ จึงไม่แสดงตัวเลขเหล่านั้น
        </p>
      )}
      <CompanyProfileCard
        symbol={symbol}
        profile={profile}
        freshness={profileResource.freshness}
        provider={profileResource.provider}
        fallbackUsed={profileResource.fallbackUsed}
        error={profileResource.error}
        loading={profileLoading}
        retryAt={profileRetryAt}
        onRetry={onRetryProfile}
        language={profileLanguage}
        onLanguageChange={onProfileLanguageChange}
        assetType={instrumentAssetType}
      />
    </div>
  );
}

function ComingSoon({ title }: { title: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center rounded-2xl border border-slate-800 bg-[#151B28] p-6 text-center">
      <div>
        <p className="font-bold text-white">{title}</p>
        <p className="mt-2 text-sm text-slate-500">
          Coming Soon · ไม่มีการแสดงข้อมูลจำลอง
        </p>
      </div>
    </div>
  );
}
