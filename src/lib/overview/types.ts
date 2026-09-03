import type { MarketEventsCardView } from '@/src/lib/market-events/card-view';
import type { PortfolioSummary } from '@/src/lib/portfolio/types';
import type { DataFreshness } from '@/src/lib/market-data/types';

export type OverviewSection =
  | 'portfolio'
  | 'market'
  | 'industries'
  | 'watchlist'
  | 'breadth'
  | 'news';

export interface InstrumentMetadata {
  symbol: string;
  companyIdentity?: string | null;
  companyName: string;
  exchange: string | null;
  assetType: string;
  currency: string;
  sector: string | null;
  industry: string | null;
  industryNameTh?: string | null;
  industrySlug?: string | null;
  industryMemberCount?: number | null;
  rankingEligible?: boolean;
  websiteDomain: string | null;
  logoUrl: string | null;
  metadataSource: string;
  updatedAt: string | null;
}

export type OverviewPriceStatus = 'live' | 'delayed' | 'saved' | 'closed' | 'unavailable';

export interface OverviewPrice {
  symbol: string;
  instrument: InstrumentMetadata;
  price: number | null;
  currency: string;
  change: number | null;
  changePercent: number | null;
  session: 'PRE' | 'REGULAR' | 'POST' | 'CLOSED' | 'CONTINUOUS';
  sessionLabel: string;
  status: OverviewPriceStatus;
  asOf: string | null;
  source?: string | null;
  unavailableReason?: string | null;
  tradingDate: string | null;
  extended: {
    label: 'ก่อนตลาดเปิด' | 'หลังตลาด';
    price: number;
    change: number | null;
    changePercent: number | null;
    asOf: string;
  } | null;
  freshness: DataFreshness | null;
  sparkline: number[];
}

export interface MarketIndexCard extends OverviewPrice {
  name: string;
  /**
   * What the card is actually quoting, so a proxy is never read as the thing
   * itself. 'ETF อ้างอิง' is a fund standing in for an index, 'สินทรัพย์จริง' is
   * the asset traded directly, and 'สัญญาล่วงหน้า' is a futures contract — the
   * reference price for a commodity, which is neither of the other two.
   */
  proxyLabel: 'ETF อ้างอิง' | 'สินทรัพย์จริง' | 'สัญญาล่วงหน้า';
  /**
   * The line under the name, composed once on the server.
   *
   * An index proxy names its ticker because the ticker is the thing being
   * quoted and a reader may well be looking for "SPY". A commodity contract's
   * code — `GC-F`, `CL-F` — is an exchange identifier that means nothing to the
   * person this card is for, and printing it cost the name the width it needed
   * on a handset, so a contract states what it is and leaves the code out.
   */
  subtitle: string;
}

export interface IndustryMember {
  price: OverviewPrice;
  volume: number | null;
  marketCap: number | null;
  contributionPercent: number;
}

export interface IndustryGroup {
  slug: string;
  name: string;
  nameTh: string | null;
  sector: string | null;
  returnPercent: number;
  averageChange: number;
  medianChange: number;
  upDownRatio: number | null;
  weighting: 'equal';
  advancing: number;
  declining: number;
  unchanged: number;
  validCount: number;
  totalCount: number;
  breadthPercent: number;
  updatedAt: string | null;
  sparkline: number[];
  members: IndustryMember[];
}

export interface MarketBreadth {
  advancing: number;
  declining: number;
  unchanged: number;
  validCount: number;
  universeCount: number;
  returnedCount: number;
  failedCount: number;
  staleCount: number;
  upDownRatio: number | null;
  breadthPercent: number;
  coveragePercent: number;
  aboveEma20Percent: number | null;
  updatedAt: string | null;
  evaluatedAt: string;
  durationMs: number;
  tradingDate: string;
  session: 'regular';
  source: 'alpaca-multi-snapshot';
  feed: 'delayed_sip';
  status: 'ready' | 'partial' | 'stale';
  universeDescription: string;
}

export interface ServiceStatus {
  level: 'ready' | 'delayed' | 'partial' | 'connecting';
  label: string;
  checkedAt: string;
  affected: Array<{ section: OverviewSection; label: string }>;
}

export interface PortfolioOverview {
  authenticated: boolean;
  portfolioCount: number;
  totalPortfolioCount: number;
  portfolioName: string | null;
  summary: PortfolioSummary | null;
  baseCurrency: 'USD' | 'THB';
  targetValueUsd: number | null;
  targetDate: string | null;
  valuedAt: string | null;
  /**
   * The exchange-local date of the render instant, in America/New_York.
   *
   * Carried so the card can tell "the close that finished today" from "the close
   * of some earlier day" without reading a clock in the browser — which would
   * answer in the reader's zone and disagree with the server HTML it hydrates
   * over. Null only when there is no summary to caption.
   */
  todayExchangeDate: string | null;
  coverage: {
    pricedAssets: number;
    totalAssets: number;
    verifiedValueUsd: number | null;
  } | null;
  portfolios: Array<{
    id: string;
    name: string;
    archived: boolean;
    summary: PortfolioSummary;
    baseCurrency: 'USD' | 'THB';
    targetValueUsd: number | null;
    targetDate: string | null;
    valuedAt: string | null;
    coverage: {
      pricedAssets: number;
      totalAssets: number;
      verifiedValueUsd: number | null;
    };
  }>;
}

export type IndustryTimeframe = '1D' | '1W' | '1M' | '3M' | '1Y';

export interface IndustryChartPoint {
  timestamp: number;
  industryReturn: number;
  benchmarkReturn: number | null;
  memberCount: number;
}

export interface IndustryChartResult {
  timeframe: IndustryTimeframe;
  status: 'available' | 'unavailable';
  points: IndustryChartPoint[];
  benchmarkSymbol: 'SPY';
  benchmarkLabel: 'S&P 500 (SPY ETF อ้างอิง)';
  coverage: {
    usable: number;
    requested: number;
    thresholdPercent: number;
  };
  stale: boolean;
  asOf: string | null;
  reason: string | null;
}

export interface OverviewDashboardData {
  generatedAt: string;
  serviceStatus: ServiceStatus;
  portfolio: PortfolioOverview;
  usdThbRate: string | null;
  indices: MarketIndexCard[];
  industries: IndustryGroup[];
  watchlist: OverviewPrice[];
  /**
   * What the preview card needs to explain which five rows it is showing:
   * every list the reader owns, the one it drew from, and whether there is more
   * behind the link. Null while `WATCHLIST_V2` is off — the card then renders
   * exactly as it did before.
   */
  watchlistPreview?: {
    lists: { id: string; name: string; createdAt: string; itemCount: number }[];
    selectedId: string;
    hasMore: boolean;
  } | null;
  breadth: MarketBreadth | null;
  industryData: {
    state: 'ready' | 'refreshing' | 'unavailable';
    classificationUpdatedAt: string;
    quotesUpdatedAt: string | null;
    candidateCount: number;
    completedCount: number;
    deadlineReached: boolean;
  };
  newsContext: {
    portfolioSymbols: string[];
    watchlistSymbols: string[];
    industryNames: string[];
  };
  /**
   * The macro calendar card's finished view, or null when `MARKET_EVENTS_CARD`
   * is off. Built on the server so the calendar file and the Intl formatters
   * stay out of the client bundle, and so "today" is decided once — see
   * `src/lib/market-events/card-view.ts`.
   */
  marketEvents: MarketEventsCardView | null;
  /**
   * Whether the overview uses the V2 reading order.
   *
   * Carried in the PAYLOAD rather than read from `process.env` in the client:
   * a client component reading an env var reads the value baked in at build
   * time, which is a different question from what this deployment is set to.
   */
  overviewV2: boolean;
  /**
   * Earnings, expiries and alert proximity, already ordered and truncated to
   * what the Home card shows. Built on the server from state the page loaded
   * anyway; no section retry touches it, so it is not a retriable section.
   */
  upcoming?: import('@/src/lib/upcoming/types').UpcomingFeed;
  /**
   * ===========================================================================
   * THE PHASE 2 FIELDS
   * ===========================================================================
   * Every one is optional and absent by default, because every one is behind a
   * flag that is off. Absent must render as "this section is not part of the
   * page" — never as a section that failed — which is the same contract
   * `marketStatus` above already has.
   */
  /**
   * The six-instrument reading, the three-way word and the regime with its
   * reasons. Absent when `PHASE2_MARKET_SNAPSHOT` is off or the snapshot has
   * not warmed yet.
   */
  marketToday?: import('@/src/lib/market-overview/types').OvMarketSnapshot | null;
  /**
   * "สิ่งที่เปลี่ยนไป", already detected, capped and deduped on the server.
   *
   * An EMPTY ARRAY and an absent field are different: empty means the reader
   * has the section and nothing happened today, absent means they do not have
   * it. The section renders its one-line quiet state for the first and nothing
   * at all for the second.
   */
  changes?: import('@/src/lib/market-overview/what-changed').OvChangeEvent[] | null;
  /**
   * Watchlist rows with the trend column and the expanded details.
   *
   * Null when `WATCHLIST_V2` is off, when the reader has no list, or when the
   * capped view could not be loaded inside its deadline — in all three the
   * overview falls back to the quote-only rows in `watchlist` above.
   */
  watchlistRows?: import('@/src/lib/watchlist/rows').WatchlistRow[] | null;
  /** The merged macro + upcoming list. Absent when `PHASE2_EVENTS` is off. */
  events?: import('./events-feed').OverviewEventsView | null;
  /**
   * How many alert rules each symbol has.
   *
   * ABSENT MEANS UNREADABLE, and the row must then draw no alert element at all
   * — not a zero, not a dash. `overview_alert_rules` IS applied
   * (`202608300001`), so what arrives today is an empty object rather than the
   * absence this comment used to describe: the read works and every reader has
   * zero rules, because nothing in the product creates one yet.
   */
  alertCountBySymbol?: Record<string, number> | null;
  /**
   * Which news tab opens first. Absent leaves the feed on its own default.
   *
   * Carried in the payload rather than read from `process.env` in the client,
   * for the reason `overviewV2` gives: a client component reading an env var
   * reads what was baked in at build time.
   */
  newsDefaultScope?: import('@/src/lib/news/scope').NewsScope;
  /**
   * The Market Status card's reading, or absent when `MARKET_STATUS_CARD` is off.
   *
   * Optional because the flag defaults to OFF and absent must mean "the card is
   * not part of this page" — not "the card failed". The overview renders nothing
   * for it when this is undefined, which is the shipped state.
   */
  marketStatus?: {
    evaluation: import('@/src/lib/market-status/rules').MarketStatusEvaluation;
    /** Completed trading date the readings are from, or null while the market is open. */
    sessionDate: string | null;
  };
  limitations: string[];
}
