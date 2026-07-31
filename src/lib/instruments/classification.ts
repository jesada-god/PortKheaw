export const INSTRUMENT_CLASSIFICATION_SCHEMA_VERSION = 1 as const;
export const SIC_TAXONOMY_VERSION = 'portkheaw-sic-th-v1' as const;

export type ClassificationVerdict =
  | 'verified'
  | 'excluded-asset'
  | 'excluded-entity'
  | 'duplicate-company'
  | 'unknown';

export interface InstrumentClassification {
  symbol: string;
  companyIdentity: string | null;
  companyName: string;
  exchange: string | null;
  assetType: string;
  currency: string;
  cik: string | null;
  sicCode: string | null;
  sicDescription: string | null;
  sectorKey: string | null;
  sectorNameEn: string | null;
  sectorNameTh: string | null;
  industryKey: string | null;
  industryNameEn: string | null;
  industryNameTh: string | null;
  stableSlug: string | null;
  websiteDomain: string | null;
  logoUrl: string | null;
  metadataSource: string;
  taxonomyVersion: string;
  updatedAt: string;
  verdict: ClassificationVerdict;
  confidence: 'high' | 'none';
  rankingEligible: boolean;
}

export interface InstrumentClassificationDataset {
  schemaVersion: typeof INSTRUMENT_CLASSIFICATION_SCHEMA_VERSION;
  taxonomyVersion: typeof SIC_TAXONOMY_VERSION;
  generatedAt: string;
  source: {
    tickerExchangeUrl: string;
    submissionsArchiveUrl: string;
    tickerExchangeLastModified: string | null;
    submissionsLastModified: string | null;
    submissionsSha256: string;
  };
  coverage: {
    instrumentCount: number;
    stockCount: number;
    etfCount: number;
    secTickerMatches: number;
    verifiedClassifications: number;
    unknownStocks: number;
    excludedStocks: number;
    duplicateCompanySymbols: number;
  };
  instruments: InstrumentClassification[];
}

interface TaxonomyNode {
  sectorKey: string;
  sectorNameEn: string;
  sectorNameTh: string;
  industryKey: string;
  industryNameEn: string;
  industryNameTh: string;
}

type SicRule = TaxonomyNode & {
  min: number;
  max: number;
};

const rule = (
  min: number,
  max: number,
  sectorKey: string,
  sectorNameEn: string,
  sectorNameTh: string,
  industryKey: string,
  industryNameEn: string,
  industryNameTh: string,
): SicRule => ({
  min,
  max,
  sectorKey,
  sectorNameEn,
  sectorNameTh,
  industryKey,
  industryNameEn,
  industryNameTh,
});

/**
 * Static, reviewable grouping of the SEC's four-digit SIC values.
 *
 * The order is intentional: narrow rules must precede their broad parent range.
 * Unknown values stay unknown; no company is classified from its name.
 */
const SIC_RULES: readonly SicRule[] = [
  rule(2836, 2836, 'health-care', 'Health Care', 'สุขภาพ', 'biotechnology', 'Biotechnology', 'เทคโนโลยีชีวภาพ'),
  rule(2830, 2835, 'health-care', 'Health Care', 'สุขภาพ', 'pharmaceuticals', 'Pharmaceuticals', 'เวชภัณฑ์และยา'),
  rule(3840, 3859, 'health-care', 'Health Care', 'สุขภาพ', 'medical-devices', 'Medical Devices', 'อุปกรณ์การแพทย์'),
  rule(8000, 8099, 'health-care', 'Health Care', 'สุขภาพ', 'health-care-services', 'Health Care Services', 'บริการสุขภาพ'),
  rule(3674, 3674, 'information-technology', 'Information Technology', 'เทคโนโลยีสารสนเทศ', 'semiconductors', 'Semiconductors', 'เซมิคอนดักเตอร์'),
  rule(3570, 3579, 'information-technology', 'Information Technology', 'เทคโนโลยีสารสนเทศ', 'computer-hardware', 'Computer Hardware', 'ฮาร์ดแวร์คอมพิวเตอร์'),
  rule(7370, 7379, 'information-technology', 'Information Technology', 'เทคโนโลยีสารสนเทศ', 'software-and-it-services', 'Software & IT Services', 'ซอฟต์แวร์และบริการไอที'),
  rule(3660, 3669, 'information-technology', 'Information Technology', 'เทคโนโลยีสารสนเทศ', 'communication-equipment', 'Communication Equipment', 'อุปกรณ์สื่อสาร'),
  rule(3600, 3699, 'information-technology', 'Information Technology', 'เทคโนโลยีสารสนเทศ', 'electronic-equipment', 'Electronic Equipment', 'อุปกรณ์อิเล็กทรอนิกส์'),
  rule(3720, 3769, 'industrials', 'Industrials', 'อุตสาหกรรม', 'aerospace-and-defense', 'Aerospace & Defense', 'อากาศยานและการป้องกันประเทศ'),
  rule(3710, 3719, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'automobiles', 'Automobiles', 'รถยนต์'),
  rule(3500, 3599, 'industrials', 'Industrials', 'อุตสาหกรรม', 'industrial-machinery', 'Industrial Machinery', 'เครื่องจักรอุตสาหกรรม'),
  rule(3700, 3799, 'industrials', 'Industrials', 'อุตสาหกรรม', 'transportation-equipment', 'Transportation Equipment', 'อุปกรณ์ขนส่ง'),
  rule(3800, 3899, 'industrials', 'Industrials', 'อุตสาหกรรม', 'instruments-and-controls', 'Instruments & Controls', 'เครื่องมือวัดและระบบควบคุม'),
  rule(1500, 1799, 'industrials', 'Industrials', 'อุตสาหกรรม', 'construction', 'Construction', 'ก่อสร้าง'),
  rule(3400, 3499, 'industrials', 'Industrials', 'อุตสาหกรรม', 'fabricated-metals', 'Fabricated Metals', 'ผลิตภัณฑ์โลหะ'),
  rule(4000, 4799, 'industrials', 'Industrials', 'อุตสาหกรรม', 'transportation', 'Transportation', 'ขนส่ง'),
  rule(8700, 8799, 'industrials', 'Industrials', 'อุตสาหกรรม', 'professional-services', 'Professional Services', 'บริการวิชาชีพ'),
  rule(1000, 1299, 'materials', 'Materials', 'วัสดุ', 'metals-and-mining', 'Metals & Mining', 'โลหะและเหมืองแร่'),
  rule(1300, 1399, 'energy', 'Energy', 'พลังงาน', 'oil-and-gas', 'Oil & Gas', 'น้ำมันและก๊าซ'),
  rule(1400, 1499, 'materials', 'Materials', 'วัสดุ', 'non-metallic-mining', 'Non-metallic Mining', 'เหมืองแร่อโลหะ'),
  rule(2800, 2829, 'materials', 'Materials', 'วัสดุ', 'chemicals', 'Chemicals', 'เคมีภัณฑ์'),
  rule(2840, 2899, 'materials', 'Materials', 'วัสดุ', 'chemicals', 'Chemicals', 'เคมีภัณฑ์'),
  rule(2900, 2999, 'energy', 'Energy', 'พลังงาน', 'energy-refining', 'Energy Refining', 'การกลั่นพลังงาน'),
  rule(3000, 3399, 'materials', 'Materials', 'วัสดุ', 'materials-and-packaging', 'Materials & Packaging', 'วัสดุและบรรจุภัณฑ์'),
  rule(2400, 2799, 'materials', 'Materials', 'วัสดุ', 'forest-products-and-packaging', 'Forest Products & Packaging', 'ผลิตภัณฑ์ป่าไม้และบรรจุภัณฑ์'),
  rule(2000, 2099, 'consumer-staples', 'Consumer Staples', 'สินค้าอุปโภคบริโภคจำเป็น', 'food-and-beverage', 'Food & Beverage', 'อาหารและเครื่องดื่ม'),
  rule(2100, 2199, 'consumer-staples', 'Consumer Staples', 'สินค้าอุปโภคบริโภคจำเป็น', 'tobacco', 'Tobacco', 'ยาสูบ'),
  rule(2200, 2399, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'apparel-and-textiles', 'Apparel & Textiles', 'เสื้อผ้าและสิ่งทอ'),
  rule(100, 999, 'consumer-staples', 'Consumer Staples', 'สินค้าอุปโภคบริโภคจำเป็น', 'agriculture', 'Agriculture', 'เกษตรกรรม'),
  rule(4800, 4899, 'communication-services', 'Communication Services', 'บริการสื่อสาร', 'telecommunications', 'Telecommunications', 'โทรคมนาคม'),
  rule(4900, 4999, 'utilities', 'Utilities', 'สาธารณูปโภค', 'utilities', 'Utilities', 'สาธารณูปโภค'),
  rule(5000, 5199, 'industrials', 'Industrials', 'อุตสาหกรรม', 'wholesale-distribution', 'Wholesale Distribution', 'ค้าส่งและจัดจำหน่าย'),
  rule(5810, 5819, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'restaurants', 'Restaurants', 'ร้านอาหาร'),
  rule(5200, 5999, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'retail', 'Retail', 'ค้าปลีก'),
  rule(6000, 6099, 'financials', 'Financials', 'การเงิน', 'banks', 'Banks', 'ธนาคาร'),
  rule(6100, 6199, 'financials', 'Financials', 'การเงิน', 'credit-services', 'Credit Services', 'บริการสินเชื่อ'),
  rule(6200, 6299, 'financials', 'Financials', 'การเงิน', 'capital-markets', 'Capital Markets', 'ตลาดทุน'),
  rule(6300, 6499, 'financials', 'Financials', 'การเงิน', 'insurance', 'Insurance', 'ประกันภัย'),
  rule(6500, 6599, 'real-estate', 'Real Estate', 'อสังหาริมทรัพย์', 'real-estate', 'Real Estate', 'อสังหาริมทรัพย์'),
  rule(6770, 6770, 'financials', 'Financials', 'การเงิน', 'blank-check-companies', 'Blank Check Companies', 'บริษัทเช็คเปล่า'),
  rule(6798, 6798, 'real-estate', 'Real Estate', 'อสังหาริมทรัพย์', 'real-estate-investment-trusts', 'Real Estate Investment Trusts', 'ทรัสต์เพื่อการลงทุนในอสังหาริมทรัพย์'),
  rule(6700, 6799, 'financials', 'Financials', 'การเงิน', 'diversified-financials', 'Diversified Financials', 'บริการการเงินหลากหลาย'),
  rule(7000, 7099, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'hotels-and-leisure', 'Hotels & Leisure', 'โรงแรมและสันทนาการ'),
  rule(7200, 7299, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'consumer-services', 'Consumer Services', 'บริการผู้บริโภค'),
  rule(7300, 7369, 'industrials', 'Industrials', 'อุตสาหกรรม', 'business-services', 'Business Services', 'บริการธุรกิจ'),
  rule(7380, 7399, 'industrials', 'Industrials', 'อุตสาหกรรม', 'business-services', 'Business Services', 'บริการธุรกิจ'),
  rule(7500, 7699, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'consumer-services', 'Consumer Services', 'บริการผู้บริโภค'),
  rule(7800, 7999, 'communication-services', 'Communication Services', 'บริการสื่อสาร', 'media-and-entertainment', 'Media & Entertainment', 'สื่อและความบันเทิง'),
  rule(8100, 8199, 'industrials', 'Industrials', 'อุตสาหกรรม', 'professional-services', 'Professional Services', 'บริการวิชาชีพ'),
  rule(8200, 8299, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'education-services', 'Education Services', 'บริการการศึกษา'),
  rule(8300, 8699, 'industrials', 'Industrials', 'อุตสาหกรรม', 'social-and-member-services', 'Social & Member Services', 'บริการสังคมและสมาชิก'),
  rule(3900, 3999, 'consumer-discretionary', 'Consumer Discretionary', 'สินค้าและบริการตามกำลังซื้อ', 'consumer-products', 'Consumer Products', 'สินค้าเพื่อผู้บริโภค'),
];

export function classifySic(sicCode: string | null | undefined): TaxonomyNode | null {
  if (!sicCode || !/^\d{4}$/.test(sicCode)) return null;
  const numeric = Number(sicCode);
  const match = SIC_RULES.find(({ min, max }) => numeric >= min && numeric <= max);
  if (!match) return null;
  return {
    sectorKey: match.sectorKey,
    sectorNameEn: match.sectorNameEn,
    sectorNameTh: match.sectorNameTh,
    industryKey: match.industryKey,
    industryNameEn: match.industryNameEn,
    industryNameTh: match.industryNameTh,
  };
}

export function stableIndustrySlug(industryKey: string): string {
  return industryKey;
}

const EXCLUDED_SECURITY_NAME = /\b(?:warrants?|units?|rights?|preferred|preference|notes?\s+due|debentures?|bonds?)\b/i;

export function isExcludedSecurityName(name: string): boolean {
  return EXCLUDED_SECURITY_NAME.test(name);
}
