export type CompanyProfileLanguage = 'th' | 'en';

/**
 * What the profile card is describing.
 *
 * An ETF has no employees to hire and no company to profile — it is a fund, and
 * calling its card "ข้อมูลบริษัท" is simply the wrong noun. Only the *labels*
 * split on this; every field, provider and request stays identical.
 */
export type CompanyProfileKind = 'company' | 'fund';

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

/**
 * The instrument's own asset type decides the noun. Anything that is not
 * explicitly an ETF — including a symbol nothing is known about — keeps the
 * existing company wording, because guessing is how a stock ends up labelled a
 * fund.
 */
export function companyProfileKind(assetType: string | null | undefined): CompanyProfileKind {
  return assetType?.trim().toLowerCase() === 'etf' ? 'fund' : 'company';
}

export type CompanyProfileLabels = Record<
  keyof typeof companyProfileLabels['th'],
  string
>;

export function resolveCompanyProfileLabels(
  language: CompanyProfileLanguage,
  kind: CompanyProfileKind,
): CompanyProfileLabels {
  return kind === 'fund'
    ? { ...companyProfileLabels[language], ...FUND_LABELS[language] }
    : companyProfileLabels[language];
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
