'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, ArrowLeft, Bell, Share2, Star } from 'lucide-react';
import { addWatchlistItemAction, removeWatchlistItemAction } from '@/app/watchlist/actions';
import { Tabs } from '@/src/components/ui/Tabs';
import { useToast } from '@/src/components/ui/Toast';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { useAppVisible } from '@/src/hooks/useAppVisible';
import { useMarketSource } from './useMarketSource';
import { selectionKeyOf, type AcceptedPriceCandidate, type MarketSelection, type MarketSessionKind } from '@/src/lib/stock-detail/market-source';
import { KeyStatisticsSection } from '@/src/components/analytics/key-statistics/KeyStatisticsSection';
import { AnalystTargetSection } from '@/src/components/analytics/analyst-target/AnalystTargetSection';
import { MarketSignalSection } from '@/src/components/analytics/market-signal/MarketSignalSection';
import type { MarketSignalResult } from '@/src/lib/analytics/market-signal/types';
import type { FxQuote } from '@/src/lib/market-data/fx/types';
import { formatMarketCapitalization } from '@/src/lib/stock-detail/profile-presentation';
import type { CompanyProfileLanguage } from '@/src/lib/stock-detail/profile-presentation';
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
import { resolvePriceCurrency, resolvePriceHeaderData } from './price-header';
import { requestCompanyProfile } from './profile-retry';
import { StockPriceHeader, type TransientPriceSink } from './StockPriceHeader';

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

const tabs = ['Overview', 'Chart', 'Financials', 'News', 'Analysis'];

interface StockDetailClientProps {
  symbol: string;
  quoteResource: StockDetailQuoteResource;
  profileResource: StockDetailResource<CompanyProfile>;
  overviewResource: StockDetailResource<MarketOverview>;
  instrumentName: string | null;
  instrumentCurrency: string | null;
  instrumentExchange: string | null;
  initialHistory: InitialHistoryResponse;
  fxQuote: FxQuote | null;
  evaluatedAt: string;
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
}: {
  label: string;
  value: string | null;
  tooltip?: string;
}) {
  return (
    <div className="min-h-20 rounded-xl border border-slate-800 bg-[#151B28] p-3">
      <p className="flex items-center gap-1 text-[10px] uppercase text-slate-500">
        {label}
        {tooltip && (
          <span
            tabIndex={0}
            title={tooltip}
            aria-label={`${label}: ${tooltip}`}
            className="cursor-help text-xs normal-case text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
          >ⓘ</span>
        )}
      </p>
      <p className="mt-2 break-words font-mono text-sm text-white">
        {value ?? 'ไม่พบข้อมูล'}
      </p>
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
  initialHistory,
  fxQuote,
  evaluatedAt,
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
  const [profileLanguage, setProfileLanguage] = useState<CompanyProfileLanguage>(
    initialProfileResource.data?.description ? 'th' : 'en',
  );
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
  const market = overview?.markets.find((item) => (
    item.primaryExchanges.some((exchange) => (
      profile?.exchange?.toLowerCase().includes(exchange.toLowerCase())
      || instrumentExchange?.toLowerCase().includes(exchange.toLowerCase())
    ))
  )) ?? overview?.markets[0] ?? null;
  // The transport-agnostic market source refreshes the header/price in place via
  // entitlement-aware REST polling (12s in a live session, slower when closed),
  // pausing when hidden/offline. It never claims real-time data.
  const marketSession: MarketSessionKind = market
    && ['pre-market', 'open', 'after-hours', 'early-close'].includes(market.currentStatus)
    ? 'regular'
    : 'closed';
  const {
    quoteResource,
    quoteLoading,
    quoteRetryAt,
    liveCandle,
    dataLabel,
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
    // Polygon REST bootstraps history; Alpaca IEX owns the live trade/bar stream.
    // When the Gateway URL is absent, the coordinator safely falls back to REST.
    enabled: true,
    allowWebSocket: true,
    transientPriceSinkRef,
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
  const priceHeaderData = resolvePriceHeaderData({
    current: quoteResource,
    initial: initialQuoteResource,
    marketStatus: market?.currentStatus ?? null,
    evaluatedAt,
  });

  const toggleWatch = () => {
    if (!isOnline) {
      addToast({ title: 'แก้ไข Watchlist ไม่ได้ขณะออฟไลน์', type: 'error' });
      return;
    }
    startTransition(async () => {
      const result = watched
        ? await removeWatchlistItemAction(symbol)
        : await addWatchlistItemAction(symbol);
      if (result.ok) {
        setWatched(!watched);
        addToast({
          title: watched ? 'นำออกจาก Watchlist แล้ว' : 'เพิ่มใน Watchlist แล้ว',
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
    <div className="pb-20">
      <header className="sticky top-0 z-40 flex min-h-16 items-center justify-between border-b border-slate-800 bg-[#0A0E17]/95 px-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
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
            aria-label="Watchlist"
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
          quote={priceHeaderData.quote}
          freshness={priceHeaderData.freshness}
          market={market}
          provider={priceHeaderData.provider}
          providerConfigured={providerConfigured}
          quoteError={quoteResource.error}
          fallbackLabel={priceHeaderData.fallbackLabel}
          quoteLoading={quoteLoading}
          quoteRetryAt={quoteRetryAt}
          onRetryQuote={refreshQuote}
          fxQuote={fxQuote}
          evaluatedAt={evaluatedAt}
          extendedQuote={priceHeaderData.extendedQuote}
          realtime={dataLabel?.realtime ?? false}
          feed={dataLabel?.feed ?? null}
          symbolHalted={halted}
          haltReason={haltReason}
          connectionState={connectionState}
          transientPriceSinkRef={transientPriceSinkRef}
        />

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
            />
          )}
          {tab === 'Chart' && (
            <ChartPanel
              symbol={symbol}
              active={tab === 'Chart'}
              initialHistory={initialHistory}
              // Header price, chart current candle and S/R distance all derive
              // from the same accepted market event: `currentPrice` and
              // `liveCandle` come from one `useMarketSource` subscription.
              currentPrice={quote?.price ?? null}
              marketLabel={dataLabel}
              liveCandle={liveCandle}
              liveActive
              onLiveRefresh={refreshQuote}
              liveRefreshDisabled={quoteLoading}
              onSelectionChange={handleSelectionChange}
              onHistoryFallbackChange={setChartHistoryFallback}
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
              {marketSignal && <MarketSignalSection result={marketSignal} />}
              {keyStatisticsEnabled && <KeyStatisticsSection symbol={symbol} />}
            </div>
          )}
          {tab === 'Analysis' && (
            <div className="space-y-4">
              <OptionsChainPanel symbol={symbol} />
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
}) {
  const quote = quoteResource.data;
  const profile = profileResource.data;
  const priceMetrics = [
    { label: 'Open', value: numberValue(quote?.open) },
    { label: 'High', value: numberValue(quote?.high) },
    { label: 'Low', value: numberValue(quote?.low) },
    {
      label: 'Prev Close',
      value: numberValue(quote?.previousClose) ?? '—',
      tooltip: 'ราคาปิดของวันซื้อขายก่อนหน้า ใช้เป็นฐานเปรียบเทียบว่าราคาวันนี้เพิ่มขึ้นหรือลดลงเท่าไร',
    },
  ];
  const profileMetrics = [
    { label: 'Volume', value: numberValue(quote?.volume) },
    {
      label: 'Market cap',
      value: formatMarketCapitalization(
        profile?.marketCapitalization ?? null,
        marketCapitalizationCurrency,
      ),
    },
    { label: 'Sector', value: profile?.sector ?? null },
    { label: 'Industry', value: profile?.industry ?? null },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {priceMetrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {profileMetrics.map((metric) => <MetricCard key={metric.label} {...metric} />)}
      </div>
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
