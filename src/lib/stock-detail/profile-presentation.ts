export type CompanyProfileLanguage = 'th' | 'en';

/**
 * What the profile card is describing.
 *
 * An ETF has no employees to hire and no company to profile — it is a fund, and
 * calling its card "ข้อมูลบริษัท" is simply the wrong noun. Only the *labels*
 * split on this; every field, provider and request stays identical.
 */
export type CompanyProfileKind = 'company' | 'fund' | 'crypto' | 'commodity';

const THAI_MONTHS: Record<string, string> = {
  January: 'มกราคม',
  February: 'กุมภาพันธ์',
  March: 'มีนาคม',
  April: 'เมษายน',
  May: 'พฤษภาคม',
  June: 'มิถุนายน',
  July: 'กรกฎาคม',
  August: 'สิงหาคม',
  September: 'กันยายน',
  October: 'ตุลาคม',
  November: 'พฤศจิกายน',
  December: 'ธันวาคม',
};

const THAI_COUNTRIES: Record<string, string> = {
  US: 'สหรัฐอเมริกา',
  USA: 'สหรัฐอเมริกา',
  'United States': 'สหรัฐอเมริกา',
  'United States of America': 'สหรัฐอเมริกา',
  TH: 'ไทย',
  Thailand: 'ไทย',
  CA: 'แคนาดา',
  Canada: 'แคนาดา',
  CN: 'จีน',
  China: 'จีน',
  JP: 'ญี่ปุ่น',
  Japan: 'ญี่ปุ่น',
  SG: 'สิงคโปร์',
  Singapore: 'สิงคโปร์',
  GB: 'สหราชอาณาจักร',
  'United Kingdom': 'สหราชอาณาจักร',
};

export const companyProfileLabels = {
  th: {
    title: 'ข้อมูลบริษัท',
    country: 'ประเทศ',
    employees: 'จำนวนพนักงาน',
    currency: 'สกุลเงิน',
    fiscalYearEnd: 'สิ้นสุดปีบัญชี',
    website: 'เยี่ยมชมเว็บไซต์บริษัท',
    unavailable: 'ไม่พร้อมใช้งาน',
    missingDescription: 'ยังไม่มีรายละเอียดบริษัทสำหรับแปล',
    unknownProvider: 'ไม่ทราบผู้ให้บริการ',
    fallbackSource: 'แหล่งข้อมูลสำรอง',
    loading: 'กำลังโหลด…',
    retryWait: 'รอตามระยะเวลาที่กำหนดแล้วลองอีกครั้ง',
    retryProfile: 'ลองโหลดข้อมูลบริษัทอีกครั้ง',
    loadingTranslation: 'กำลังโหลดคำแปล…',
    translationFailed: 'ไม่สามารถโหลดคำแปลได้ กำลังแสดงข้อความภาษาอังกฤษต้นฉบับ',
    retryTranslation: 'ลองแปลอีกครั้ง',
  },
  en: {
    title: 'Company Profile',
    country: 'Country',
    employees: 'Employees',
    currency: 'Currency',
    fiscalYearEnd: 'Fiscal year end',
    website: 'Visit company website',
    unavailable: 'Unavailable',
    missingDescription: 'ยังไม่มีรายละเอียดบริษัทสำหรับแปล',
    unknownProvider: 'Unknown provider',
    fallbackSource: 'Fallback source',
    loading: 'Loading…',
    retryWait: 'Wait for the retry period, then try again',
    retryProfile: 'Retry company profile',
    loadingTranslation: 'Loading translation…',
    translationFailed: 'Translation is unavailable. Showing the original English text.',
    retryTranslation: 'Retry translation',
  },
} as const;

/**
 * Fund wording, as an overlay on the labels above rather than a second table —
 * so a label added to `companyProfileLabels` can never be missing here.
 */
const FUND_LABELS = {
  th: {
    title: 'ข้อมูลกองทุน',
    missingDescription: 'ยังไม่มีรายละเอียดกองทุนสำหรับแปล',
    retryProfile: 'ลองโหลดข้อมูลกองทุนอีกครั้ง',
  },
  en: {
    title: 'Fund Profile',
    missingDescription: 'ยังไม่มีรายละเอียดกองทุนสำหรับแปล',
    retryProfile: 'Retry fund profile',
  },
} as const;

const COMMODITY_LABELS = {
  th: {
    title: 'ข้อมูลสัญญาสินค้าโภคภัณฑ์',
    missingDescription: 'ยังไม่มีรายละเอียดสัญญาสำหรับแปล',
    retryProfile: 'ลองโหลดข้อมูลสัญญาอีกครั้ง',
  },
  en: {
    title: 'Commodity Contract Profile',
    missingDescription: 'No contract description is available to translate.',
    retryProfile: 'Retry contract profile',
  },
} as const;

const CRYPTO_LABELS = {
  th: {
    title: 'ข้อมูลสินทรัพย์ดิจิทัล',
    missingDescription: 'ยังไม่มีรายละเอียดสินทรัพย์ดิจิทัลสำหรับแปล',
    retryProfile: 'ลองโหลดข้อมูลสินทรัพย์อีกครั้ง',
  },
  en: {
    title: 'Crypto Asset Profile',
    missingDescription: 'No crypto asset description is available to translate.',
    retryProfile: 'Retry asset profile',
  },
} as const;

/**
 * The instrument's own asset type decides the noun. Anything that is not
 * explicitly an ETF — including a symbol nothing is known about — keeps the
 * existing company wording, because guessing is how a stock ends up labelled a
 * fund.
 */
export function companyProfileKind(assetType: string | null | undefined): CompanyProfileKind {
  const normalized = assetType?.trim().toLowerCase();
  if (normalized === 'etf') return 'fund';
  if (normalized === 'crypto') return 'crypto';
  if (normalized === 'commodity') return 'commodity';
  return 'company';
}

/**
 * Which profile facts Stock Detail may show for an instrument, decided once from
 * the instrument master's own asset type.
 *
 * The company-profile providers answer for the LEGAL ENTITY behind a symbol. For
 * a common stock that entity is the business the reader came to look at. For an
 * ETF it is the issuer: SPY's "sector" is State Street's (Financial Services),
 * its "employees" are State Street's, its fiscal year is State Street's, and its
 * market capitalisation describes the issuer, not the fund. Rendering any of
 * those beside a fund's price states something false about the fund, so this
 * withholds them. A fund's own size is net assets/AUM — a metric this profile
 * contract does not carry — so the field is hidden rather than filled with the
 * issuer's number under a new name.
 *
 * A 24/7 digital asset has no filings, no headcount and no sector at all.
 *
 * Built on {@link companyProfileKind} so there is exactly one classification.
 */
export interface AssetPresentationPolicy {
  kind: CompanyProfileKind;
  showEmployees: boolean;
  showFiscalYearEnd: boolean;
  showCountry: boolean;
  /** Issuer classification is not a fund's exposure, and a currency has none. */
  showSectorAndIndustry: boolean;
  /** Corporate market capitalisation. Never reused as a fund's size. */
  showMarketCapitalization: boolean;
  /** Analyst targets, key statistics and market signal are equity fundamentals. */
  showFinancials: boolean;
  /** US-listed options analytics. Nothing lists options on a spot crypto pair. */
  showOptionsAnalysis: boolean;
}

export function resolveAssetPresentationPolicy(
  assetType: string | null | undefined,
): AssetPresentationPolicy {
  const kind = companyProfileKind(assetType);
  /*
   * A futures contract has no legal entity behind it at all: no filings, no
   * headcount, no sector, no market capitalisation, and no equity options chain.
   * Everything an equity page is built to show is withheld, for the same reason
   * it is withheld from a currency pair — the number would be about something
   * other than the thing on screen.
   */
  if (kind === 'commodity') {
    return {
      kind,
      showEmployees: false,
      showFiscalYearEnd: false,
      showCountry: false,
      showSectorAndIndustry: false,
      showMarketCapitalization: false,
      showFinancials: false,
      showOptionsAnalysis: false,
    };
  }
  if (kind === 'crypto') {
    return {
      kind,
      showEmployees: false,
      showFiscalYearEnd: false,
      showCountry: false,
      showSectorAndIndustry: false,
      showMarketCapitalization: false,
      showFinancials: false,
      showOptionsAnalysis: false,
    };
  }
  if (kind === 'fund') {
    return {
      kind,
      showEmployees: false,
      showFiscalYearEnd: false,
      showCountry: true,
      showSectorAndIndustry: false,
      showMarketCapitalization: false,
      showFinancials: true,
      showOptionsAnalysis: true,
    };
  }
  return {
    kind,
    showEmployees: true,
    showFiscalYearEnd: true,
    showCountry: true,
    showSectorAndIndustry: true,
    showMarketCapitalization: true,
    showFinancials: true,
    showOptionsAnalysis: true,
  };
}

/**
 * Reader-facing names for the provider ids the profile pipeline reports.
 *
 * The card showed the raw id ("Cached · continuous-market"), which is a routing
 * detail, not a source a reader can evaluate. The provenance itself is kept —
 * transparency about where a number came from is the point — but it is stated in
 * the name the source actually goes by, with the raw id still carried in the
 * element's tooltip for support and debugging.
 */
const PROFILE_SOURCE_NAMES: Record<string, string> = {
  'continuous-market': 'Yahoo Finance',
  'yahoo-finance-chart': 'Yahoo Finance',
  'financial-modeling-prep': 'Financial Modeling Prep',
  'alpha-vantage': 'Alpha Vantage',
  finnhub: 'Finnhub',
  polygon: 'Polygon.io',
  'market-data-gateway': 'PortKheaw Market Gateway',
};

export function profileSourceLabel(provider: string | null | undefined): string | null {
  const raw = provider?.trim();
  if (!raw) return null;
  return raw
    .split(/[+>]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => PROFILE_SOURCE_NAMES[part] ?? part)
    .join(' · ');
}

export type CompanyProfileLabels = Record<
  keyof typeof companyProfileLabels['th'],
  string
>;

export function resolveCompanyProfileLabels(
  language: CompanyProfileLanguage,
  kind: CompanyProfileKind,
): CompanyProfileLabels {
  if (kind === 'fund') return { ...companyProfileLabels[language], ...FUND_LABELS[language] };
  if (kind === 'crypto') return { ...companyProfileLabels[language], ...CRYPTO_LABELS[language] };
  if (kind === 'commodity') return { ...companyProfileLabels[language], ...COMMODITY_LABELS[language] };
  return companyProfileLabels[language];
}

/**
 * Whether the Thai reader is still waiting for the Thai description.
 *
 * The card used to render `sourceText` in this window, which meant the English
 * paragraph was painted first and replaced by Thai a moment later — a flicker
 * that reads as a half-loaded page. A placeholder is shown instead, and the
 * English text is only ever reached once an attempt has actually settled (so a
 * failed translation still falls back to the original rather than vanishing).
 */
export function awaitsThaiDescription(input: {
  language: CompanyProfileLanguage;
  sourceText: string | null;
  /** Whether a translation attempt for THIS source text has already settled. */
  translationSettled: boolean;
}): boolean {
  return input.language === 'th'
    && Boolean(input.sourceText?.trim())
    && !input.translationSettled;
}

export function shouldRequestCompanyProfileTranslation(
  language: CompanyProfileLanguage,
  sourceText: string | null,
): sourceText is string {
  return language === 'th' && Boolean(sourceText?.trim());
}

export function displayCountry(source: string | null, language: CompanyProfileLanguage): string | null {
  if (!source || language === 'en') return source;
  return THAI_COUNTRIES[source] ?? source;
}

export function displayFiscalYearEnd(source: string | null, language: CompanyProfileLanguage): string | null {
  if (!source || language === 'en') return source;
  return THAI_MONTHS[source] ?? source;
}

export function formatMarketCapitalization(value: number | null, currency: string | null): string | null {
  if (value === null || !Number.isFinite(value) || !currency) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      notation: 'compact',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return null;
  }
}

export function resolvedDescription(input: {
  language: CompanyProfileLanguage;
  sourceText: string | null;
  translatedText: string | null;
  translationFailed: boolean;
}): { text: string | null; fellBackToEnglish: boolean } {
  if (input.language === 'en') {
    return { text: input.sourceText, fellBackToEnglish: false };
  }
  if (input.translatedText) {
    return { text: input.translatedText, fellBackToEnglish: false };
  }
  return {
    text: input.sourceText,
    fellBackToEnglish: input.translationFailed && Boolean(input.sourceText),
  };
}

export function isCompanyProfileTranslationLoading(input: {
  language: CompanyProfileLanguage;
  sourceText: string | null;
  attempt: number;
  settledAttempt: number | null;
  translatedText: string | null;
  error: string | null;
}): boolean {
  return input.language === 'th'
    && Boolean(input.sourceText)
    && (
      input.settledAttempt !== input.attempt
      || (!input.translatedText && !input.error)
    );
}
