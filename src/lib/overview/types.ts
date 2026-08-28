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
   * Earnings, expiries and alert proximity, already ordered and truncated to
   * what the Home card shows. Built on the server from state the page loaded
   * anyway; no section retry touches it, so it is not a retriable section.
   */
  upcoming?: import('@/src/lib/upcoming/types').UpcomingFeed;
  limitations: string[];
}
