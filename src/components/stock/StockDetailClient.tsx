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
import type { EarningsSchedule } from '@/src/lib/analytics/earnings/types';
import { buildStockSummary } from '@/src/lib/stock-detail/summary';
import { StockSummaryCard } from './StockSummaryCard';
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
  isCommodityAssetType,
  isContinuousAssetType,
  resolveCommodityMarketSession,
  resolveContinuousMarketSession,
  resolveContinuousMarketSnapshot,
} from '@/src/lib/stock-detail/continuous-client';

const ChartPanel = dynamic(
  () => import('./ChartPanel').then((module) => module.ChartPanel),
  {
    ssr: false,
    loading: () => <div className="h-[340px] animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-elevated)]" />,
  },
);
const NewsTab = dynamic(
  () => import('@/src/components/news/NewsTab').then((module) => module.NewsTab),
  {
    ssr: false,
    loading: () => <div className="h-72 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-elevated)]" />,
  },
);
const OptionsChainPanel = dynamic(
  () => import('./OptionsChainPanel').then((module) => module.OptionsChainPanel),
  {
    ssr: false,
    loading: () => <div className="h-72 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-elevated)]" />,
  },
);
const OptionsSignalSection = dynamic(
  () => import('@/src/components/analytics/options-signal/OptionsSignalSection')
    .then((module) => module.OptionsSignalSection),
  {
    ssr: false,
    loading: () => <div className="h-96 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-elevated)]" />,
  },
);

/**
 * The tab strip an instrument actually has content for.
 *
 * Financials holds analyst targets, key statistics and the technical signal;
 * Analysis is the US-listed options chain and its analytics. Neither exists for
 * a spot crypto pair, so both used to open on a permanently empty panel. A
 * futures contract keeps Financials for the signal alone — see
 * `resolveAssetPresentationPolicy`, which is what decides all of this. This
 * component only reads the answer.
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
  /** Next scheduled report, from the shared earnings calendar service. */
  earnings?: EarningsSchedule | null;
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
    /*
     * A cell in a band, not a card in a grid.
     *
     * Eight of these used to arrive on the Overview tab as eight bordered,
     * filled boxes — open/high/low/prev-close, then volume/market-cap/sector/
     * industry — which is a lot of container for eight short facts about ONE
     * instrument. They are facets of a single object, so they now read as one
     * band separated by hairlines. The element order is deliberately unchanged
     * (label element, value <p>, optional footnote <p>): the stock-detail smoke
     * script addresses the value positionally through `[data-metric]`.
     */
    <div data-metric={label} className="data-strip__cell">
      {/*
        A div, not a <p>: the shared ⓘ affordance opens a <div role="dialog">
        panel, which a paragraph may not contain — the browser would close the
        <p> early and split the label row.
      */}
      <div className="figure-label flex items-center gap-1">
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
            <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{tooltip}</p>
          </DetailPopover>
        )}
      </div>
      <p className="figure-data mt-1.5 break-words text-[var(--text)]">
        {value ?? 'ไม่พบข้อมูล'}
      </p>
      {footnote && (
        <p className="mt-1 break-words text-[10px] leading-4 text-[var(--text-muted)]">{footnote}</p>
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
  earnings = null,
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
  /*
   * A futures market is neither of the two the page knew about. It is not the US
   * equity session — treating it as one would report gold closed while COMEX is
   * trading and invent a pre-market it does not have — and it is not 24/7, so it
   * cannot borrow the crypto path either. It shares the crypto path's *plumbing*
   * (no equity reconciliation, no WebSocket feed) and keeps its own schedule.
   */
  const commodityMarket = isCommodityAssetType(instrumentAssetType);
  const nonEquityMarket = continuousMarket || commodityMarket;
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
  const resolvedSession = commodityMarket
    ? resolveCommodityMarketSession(exchangeNow)
    : continuousMarket
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
    // The live trade stream is a US-equity feed. A commodity contract is not on
    // it, so the page polls REST exactly as the crypto page does.
    allowWebSocket: !nonEquityMarket,
    marketKind: nonEquityMarket ? 'continuous' : 'us-equity',
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
  const marketSnapshot = nonEquityMarket
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

  /*
   * The compact summary, built from the canonical values this page already
   * resolved: the accepted marking price, the market-signal engine's own
   * nearest support/resistance, and the earnings calendar's report date. Rows
   * whose destination tab does not exist for this instrument are dropped —
   * a crypto pair has no Financials tab to send anybody to.
   */
  const summaryItems = buildStockSummary({
    price: analyticalSpotPrice,
    currency: sourceCurrency,
    marketSignal,
    earnings,
  }).filter((item) => tabs.includes(item.target));

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
      <header className="sticky top-0 z-40 flex min-h-16 items-center justify-between border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_95%,transparent)] px-3 backdrop-blur-md">
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
          <span aria-hidden="true" className="hidden h-7 w-px flex-none bg-[var(--border)] lg:block" />
          <button
            aria-label="กลับ"
            onClick={() => {
              const sameOriginReferrer = document.referrer.startsWith(window.location.origin);
              if (sameOriginReferrer && window.history.length > 1) router.back();
              else router.push('/search');
            }}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
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
            <h1 className="truncate text-lg font-bold tracking-tight text-[var(--text)]">{symbol}</h1>
            <p className="truncate text-xs text-[var(--text-muted)]">
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
              ? 'flex min-h-11 min-w-11 items-center justify-center text-[var(--accent)]'
              : 'flex min-h-11 min-w-11 items-center justify-center text-[var(--text-muted)]'}
          >
            <Star size={20} fill={watched ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => addToast({ title: 'แจ้งเตือนราคา — กำลังจะมา', type: 'info' })}
            aria-label="แจ้งเตือนราคา (ยังไม่เปิดใช้งาน)"
            className="flex min-h-11 min-w-11 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <Bell size={20} />
          </button>
          <button
            onClick={() => void share()}
            aria-label="แชร์"
            className="flex min-h-11 min-w-11 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <Share2 size={20} />
          </button>
        </div>
      </header>

      <main className="page-stack px-[var(--page-gutter)] py-4 md:py-8">
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

        <div className="stack-lead">
          <StockSummaryCard items={summaryItems} onOpenSection={setTab} />
        </div>

        <div className="bleed-mobile sticky top-16 z-30 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_95%,transparent)] px-[var(--page-gutter)] pt-3 backdrop-blur md:static md:border-0 md:bg-transparent md:px-0">
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
              marketKind={commodityMarket ? 'commodity' : continuousMarket ? 'continuous' : 'us-equity'}
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
              marketKind={commodityMarket ? 'commodity' : continuousMarket ? 'continuous' : 'us-equity'}
              /*
                The chart's Options layer, from the SAME policy that decides the
                Analysis tab. It was previously gated on nothing but "is this a
                non-empty symbol", so a contract that has no listed options at
                all still offered the toggle, the expiry picker and a panel that
                could only ever resolve to "unavailable".
              */
              optionsAvailable={presentation.showOptionsAnalysis}
              technicalIndicatorsEnabled={technicalIndicatorsEnabled}
              advancedChartTypesEnabled={advancedChartTypesEnabled}
              extendedIndicatorsEnabled={extendedIndicatorsEnabled}
              supportResistanceEnabled={supportResistanceEnabled}
            />
          )}
          {tab === 'News' && <NewsTab symbol={symbol} />}
          {tab === 'Financials' && (
            /*
              Three independent panels, each behind the flag that decides whether
              it describes THIS instrument — not one flag over all three. The
              signal is the only one a futures contract keeps, because it is the
              only one computed from the contract's own prices; the targets and
              the statistics are about an issuer, and a contract has none.
            */
            <div className="space-y-4">
              {presentation.showAnalystTargets && (
                <AnalystTargetSection symbol={symbol} enabled={analystConsensusEnabled} />
              )}
              <MarketSignalSection
                result={marketSignal}
                capability={presentation.technicalOutlookCapability}
                /*
                 * The page's accepted marking price, the same one the header
                 * shows. The signal is computed from the last FINALIZED close,
                 * which on an open market is a different number — the zone bar
                 * draws both and labels which is which rather than letting a
                 * reader assume they are the same.
                 */
                livePrice={analyticalSpotPrice}
              />
              {presentation.showKeyStatistics && keyStatisticsEnabled && (
                <KeyStatisticsSection symbol={symbol} />
              )}
              {/*
                Last in Financials, after the targets and the statistics: the
                reader has just read what other people expect of this stock, and
                this is where stating their own belongs. It carries the symbol
                only, and it shows itself only for instruments the planner will
                actually take — see PlanThisStockCta.
              */}
              <PlanThisStockCta symbol={symbol} assetType={instrumentAssetType} currency={sourceCurrency} />
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
              <div className="flex items-start gap-3 rounded-[var(--radius-panel)] border border-[var(--warning-line)] bg-[var(--warning-soft)] p-4">
                <Activity aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-[var(--warning)]" />
                <div className="min-w-0">
                <h2 className="text-sm font-bold text-[var(--text)]">การวิเคราะห์ด้วย AI — กำลังจะมา</h2>
                <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">ส่วน Options ด้านบนเป็น analytics ตามสูตรจากข้อมูลตลาดจริง ไม่ใช่คำสั่งหรือการรับประกันผลลัพธ์</p>
                </div>
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
  marketKind,
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
  /** Which trading day "ราคาเปิด" and "สูงสุดวันนี้" are counted over. */
  marketKind: 'us-equity' | 'continuous' | 'commodity';
}) {
  const quote = quoteResource.data;
  const profile = profileResource.data;
  const policy = resolveAssetPresentationPolicy(instrumentAssetType);
  const priceMetrics = [
    {
      label: 'ราคาเปิด',
      value: numberValue(quote?.open),
      /*
        Which day this is the first price OF. A Globex day is not a calendar
        day and not a US equity session: it starts the evening before, at 17:00
        Chicago, so saying "เมื่อเปิดตลาดของวันนี้" over a futures contract
        would name the wrong opening.
      */
      tooltip: marketKind === 'continuous'
        ? 'ราคาแรกของวัน (Open) ตามวันสากล UTC ของสินทรัพย์ที่ซื้อขายตลอด 24 ชั่วโมง'
        : marketKind === 'commodity'
        ? 'ราคาแรกของรอบซื้อขาย (Open) ของสัญญาล่วงหน้า ซึ่งเริ่มตั้งแต่เย็นวันก่อนหน้าตามเวลาตลาด ไม่ใช่ตามวันปฏิทิน'
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
      {/*
        ONE band, not two.

        Today's trading range and the fundamentals were two strips with page
        rhythm between them, and on a handset — where each is two columns of two
        — that read as two separate objects with a gap ruled across the middle:
        four facts about the instrument, a break, four more. They are facets of
        the same instrument, so they are one hairline rectangle now, and the
        divider under `ต่ำสุดวันนี้`/`ราคาปิดก่อนหน้า` is the same cell-drawn
        hairline as every other row instead of empty margin.

        The order is the read order and is unchanged: price metrics, then
        profile metrics. A band that comes up short in its last row simply ends
        — the divider is drawn by cells, never by the grid — so the counts a
        withholding `resolveAssetPresentationPolicy` produces (5, 6 or 8 cells)
        need no column arithmetic. `--4` keeps the desktop band four across as
        before; the base two columns give the requested 2 × 4 on mobile.
      */}
      <div className="data-strip data-strip--4">
        {[...priceMetrics, ...profileMetrics].map((metric) => (
          <MetricCard key={metric.label} {...metric} />
        ))}
      </div>
      {policy.kind === 'fund' && (
        <p className="text-xs leading-6 text-[var(--text-muted)]">
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
    <div className="panel flex min-h-64 items-center justify-center p-6 text-center">
      <div>
        <p className="font-bold text-[var(--text)]">{title}</p>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          กำลังจะมา · ไม่มีการแสดงข้อมูลจำลอง
        </p>
      </div>
    </div>
  );
}
