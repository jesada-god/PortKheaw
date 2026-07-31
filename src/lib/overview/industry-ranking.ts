import type { IndustryGroup, IndustryMember, OverviewPrice } from './types';

export interface IndustryBreadth {
  advancing: number;
  declining: number;
  unchanged: number;
  validCount: number;
  upDownRatio: number | null;
  aboveEma20Percent: number | null;
  updatedAt: string | null;
}

export const MIN_INDUSTRY_SYMBOLS = 5;

export interface IndustryQuoteCandidate {
  price: OverviewPrice;
  sector: string | null;
  industry: string | null;
  industryNameTh?: string | null;
  industrySlug?: string | null;
  valid: boolean;
  volume?: number | null;
  marketCap?: number | null;
  groupTotalCount?: number | null;
}

const THAI_INDUSTRIES: Record<string, string> = {
  'Aerospace & Defense': 'อากาศยานและการป้องกันประเทศ',
  'Auto Manufacturers': 'ผู้ผลิตรถยนต์',
  'Banks - Diversified': 'ธนาคารพาณิชย์ขนาดใหญ่',
  Biotechnology: 'เทคโนโลยีชีวภาพ',
  'Communication Equipment': 'อุปกรณ์สื่อสาร',
  'Computer Hardware': 'ฮาร์ดแวร์คอมพิวเตอร์',
  'Consumer Electronics': 'อิเล็กทรอนิกส์สำหรับผู้บริโภค',
  'Credit Services': 'บริการสินเชื่อ',
  'Drug Manufacturers - General': 'ผู้ผลิตยา',
  'Internet Content & Information': 'สื่อและข้อมูลออนไลน์',
  'Oil & Gas Integrated': 'น้ำมันและก๊าซครบวงจร',
  Restaurants: 'ร้านอาหาร',
  Semiconductors: 'เซมิคอนดักเตอร์',
  'Semiconductor Equipment & Materials': 'อุปกรณ์และวัสดุเซมิคอนดักเตอร์',
  'Software - Application': 'ซอฟต์แวร์ประยุกต์',
  'Software - Infrastructure': 'ซอฟต์แวร์โครงสร้างพื้นฐาน',
  'Specialty Retail': 'ค้าปลีกเฉพาะทาง',
  'Utilities - Regulated Electric': 'สาธารณูปโภคไฟฟ้า',
};

function validPercent(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function canonicalCohort(
  candidates: readonly IndustryQuoteCandidate[],
): IndustryQuoteCandidate[] {
  const cohorts = new Map<string, IndustryQuoteCandidate[]>();
  for (const candidate of candidates) {
    if (
      !candidate.valid
      || !validPercent(candidate.price.changePercent)
      || !candidate.price.tradingDate
    ) continue;
    const key = `${candidate.price.tradingDate}:${candidate.price.session}`;
    cohorts.set(key, [...(cohorts.get(key) ?? []), candidate]);
  }
  return [...cohorts.values()].sort((left, right) =>
    right.length - left.length
    || (right[0]?.price.tradingDate ?? '').localeCompare(left[0]?.price.tradingDate ?? '')
  )[0] ?? [];
}

export function industrySlug(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export function thaiIndustryName(name: string): string | null {
  return THAI_INDUSTRIES[name] ?? null;
}

export function calculateMarketBreadth(
  candidates: readonly IndustryQuoteCandidate[],
): IndustryBreadth | null {
  const usable = candidates.filter((candidate) =>
    candidate.valid && validPercent(candidate.price.changePercent));
  if (!usable.length) return null;
  const advancing = usable.filter((item) => item.price.changePercent! > 0).length;
  const declining = usable.filter((item) => item.price.changePercent! < 0).length;
  const unchanged = usable.length - advancing - declining;
  const timestamps = usable.map((item) => item.price.asOf)
    .filter((value): value is string => Boolean(value)).sort();
  return {
    advancing,
    declining,
    unchanged,
    validCount: usable.length,
    upDownRatio: declining > 0 ? advancing / declining : null,
    aboveEma20Percent: null,
    updatedAt: timestamps.at(-1) ?? null,
  };
}

export function buildIndustryRanking(
  candidates: readonly IndustryQuoteCandidate[],
  minimumSymbols = MIN_INDUSTRY_SYMBOLS,
): IndustryGroup[] {
  const groups = new Map<string, IndustryQuoteCandidate[]>();
  for (const candidate of candidates) {
    const industry = candidate.industry?.trim();
    if (!industry) continue;
    groups.set(industry, [...(groups.get(industry) ?? []), candidate]);
  }

  const result: IndustryGroup[] = [];
  for (const [name, allMembers] of groups) {
    // Never blend different trading dates or regular/extended domains. The
    // largest canonical cohort wins and every other quote is excluded.
    const usable = canonicalCohort(allMembers);
    if (usable.length < minimumSymbols) continue;
    const changes = usable.map((candidate) => candidate.price.changePercent!);
    const returnPercent = changes.reduce((sum, change) => sum + change, 0)
      / usable.length;
    const advancing = usable.filter((item) => item.price.changePercent! > 0).length;
    const declining = usable.filter((item) => item.price.changePercent! < 0).length;
    const unchanged = usable.length - advancing - declining;
    const timestamps = usable.map((item) => item.price.asOf)
      .filter((value): value is string => Boolean(value)).sort();
    const members: IndustryMember[] = usable.map((candidate) => ({
      price: candidate.price,
      volume: candidate.volume ?? null,
      marketCap: candidate.marketCap ?? null,
      contributionPercent: candidate.price.changePercent! / usable.length,
    }));
    result.push({
      slug: usable.find((item) => item.industrySlug)?.industrySlug ?? industrySlug(name),
      name,
      nameTh: usable.find((item) => item.industryNameTh)?.industryNameTh
        ?? thaiIndustryName(name),
      sector: usable.find((item) => item.sector)?.sector ?? null,
      returnPercent,
      averageChange: returnPercent,
      medianChange: median(changes),
      upDownRatio: declining > 0 ? advancing / declining : null,
      weighting: 'equal',
      advancing,
      declining,
      unchanged,
      validCount: usable.length,
      totalCount: Math.max(
        allMembers.length,
        ...usable.map((item) => item.groupTotalCount ?? 0),
      ),
      breadthPercent: advancing / usable.length * 100,
      updatedAt: timestamps.at(-1) ?? null,
      sparkline: [],
      members,
    });
  }
  return result;
}

export type IndustryRankingOrder = 'gainers' | 'losers' | 'all';

export function rankIndustries(
  groups: readonly IndustryGroup[],
  order: IndustryRankingOrder,
  limit = 8,
): IndustryGroup[] {
  return [...groups].sort((left, right) => {
    const returns = order === 'losers'
      ? left.returnPercent - right.returnPercent
      : right.returnPercent - left.returnPercent;
    if (returns) return returns;
    const breadth = order === 'losers'
      ? left.breadthPercent - right.breadthPercent
      : right.breadthPercent - left.breadthPercent;
    if (breadth) return breadth;
    const count = right.validCount - left.validCount;
    if (count) return count;
    return left.name.localeCompare(right.name);
  }).slice(0, limit);
}
