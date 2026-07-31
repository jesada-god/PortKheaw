import type {
  IndustryGroup,
  MarketIndexCard,
  MarketBreadth,
  OverviewDashboardData,
  OverviewPrice,
  OverviewSection,
} from './types';

export type RetriableOverviewSection =
  Extract<OverviewSection, 'market' | 'industries' | 'watchlist' | 'breadth'>;

export type OverviewSectionValue =
  | MarketIndexCard[]
  | IndustryGroup[]
  | OverviewPrice[]
  | MarketBreadth
  | null;

export interface OverviewSectionRelated {
  breadth?: MarketBreadth | null;
  industryData?: OverviewDashboardData['industryData'];
}

export function applyOverviewSectionUpdate(
  current: OverviewDashboardData,
  section: RetriableOverviewSection,
  value: OverviewSectionValue,
  generatedAt: string,
  related: OverviewSectionRelated | null = null,
): OverviewDashboardData {
  if (section === 'market') {
    return { ...current, generatedAt, indices: value as MarketIndexCard[] };
  }
  if (section === 'industries') {
    const breadth = related && 'breadth' in related
      ? related.breadth ?? null
      : current.breadth;
    const industryData = related?.industryData ?? {
      ...current.industryData,
      state: 'ready' as const,
      quotesUpdatedAt: generatedAt,
    };
    const affected = current.serviceStatus.affected.filter(({ section: affectedSection }) =>
      affectedSection !== 'industries'
      && (breadth === null || affectedSection !== 'breadth'));
    return {
      ...current,
      generatedAt,
      industries: value as IndustryGroup[],
      breadth,
      industryData,
      serviceStatus: {
        ...current.serviceStatus,
        checkedAt: generatedAt,
        affected,
        level: affected.length ? 'partial' : 'ready',
        label: affected.length
          ? 'ผู้ให้บริการข้อมูลบางส่วนขัดข้อง'
          : 'ข้อมูลตลาดพร้อมใช้งาน',
      },
      newsContext: {
        ...current.newsContext,
        industryNames: (value as IndustryGroup[])
          .slice()
          .sort((left, right) => right.returnPercent - left.returnPercent)
          .slice(0, 8)
          .map((industry) => industry.name),
      },
    };
  }
  if (section === 'watchlist') {
    return { ...current, generatedAt, watchlist: value as OverviewPrice[] };
  }
  return { ...current, generatedAt, breadth: value as MarketBreadth | null };
}
