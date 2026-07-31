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
  session: 'PRE' | 'REGULAR' | 'POST' | 'CLOSED';
  sessionLabel: string;
  status: OverviewPriceStatus;
  asOf: string | null;
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
  proxyLabel: 'ETF อ้างอิง';
}

export interface IndustryMember {
  price: OverviewPrice;
  volume: number | null;
  marketCap: number | null;
}

export interface IndustryGroup {
  slug: string;
  name: string;
  nameTh: string | null;
  sector: string | null;
  returnPercent: number;
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
  upDownRatio: number | null;
  aboveEma20Percent: number | null;
  updatedAt: string | null;
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
  summary: PortfolioSummary | null;
  baseCurrency: 'USD' | 'THB';
  targetValueUsd: number | null;
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
  limitations: string[];
}
