import { describe, expect, it } from 'vitest';
import {
  awaitsThaiDescription,
  companyProfileKind,
  displayCountry,
  displayFiscalYearEnd,
  formatMarketCapitalization,
  isCompanyProfileTranslationLoading,
  resolveCompanyProfileLabels,
  resolvedDescription,
  shouldRequestCompanyProfileTranslation,
} from './profile-presentation';
import { companyProfileTranslationRequestSchema } from './api-schemas';

describe('Company Profile presentation', () => {
  it('keeps the original English source when translation fails', () => {
    expect(resolvedDescription({
      language: 'th',
      sourceText: 'Rocket Lab provides launch services.',
      translatedText: null,
      translationFailed: true,
    })).toEqual({
      text: 'Rocket Lab provides launch services.',
      fellBackToEnglish: true,
    });
  });

  it('does not translate symbols, currency, or source numeric values', () => {
    expect(formatMarketCapitalization(42_000_000_000, 'USD')).toBe('$42.0B');
    expect(displayCountry('USA', 'en')).toBe('USA');
    expect(displayFiscalYearEnd('December', 'en')).toBe('December');
    expect(companyProfileTranslationRequestSchema.safeParse({
      symbol: 'RKLB',
      sourceText: 'Rocket Lab provides launch services.',
      targetLanguage: 'th',
      companyName: 'Rocket Lab USA, Inc.',
      currency: 'USD',
    }).success).toBe(false);
  });

  it('localizes only display values for Thai', () => {
    expect(displayCountry('USA', 'th')).toContain('สหรัฐ');
    expect(displayFiscalYearEnd('December', 'th')).toBe('ธันวาคม');
  });

  it('requests translation only for Thai when English source text exists', () => {
    expect(shouldRequestCompanyProfileTranslation('th', 'Rocket Lab provides launch services.')).toBe(true);
    expect(shouldRequestCompanyProfileTranslation('en', 'Rocket Lab provides launch services.')).toBe(false);
    expect(shouldRequestCompanyProfileTranslation('th', null)).toBe(false);
    expect(shouldRequestCompanyProfileTranslation('th', '   ')).toBe(false);
  });

  it('leaves loading and falls back after the active translation attempt fails', () => {
    expect(isCompanyProfileTranslationLoading({
      language: 'th',
      sourceText: 'Rocket Lab provides launch services.',
      attempt: 1,
      settledAttempt: 1,
      translatedText: null,
      error: 'Translation request timed out',
    })).toBe(false);
    expect(resolvedDescription({
      language: 'th',
      sourceText: 'Rocket Lab provides launch services.',
      translatedText: null,
      translationFailed: true,
    })).toEqual({
      text: 'Rocket Lab provides launch services.',
      fellBackToEnglish: true,
    });
  });
});

describe('instrument kind wording', () => {
  it('names an ETF card a fund and everything else a company', () => {
    expect(resolveCompanyProfileLabels('th', companyProfileKind('ETF')).title).toBe('ข้อมูลกองทุน');
    expect(resolveCompanyProfileLabels('th', companyProfileKind('etf')).title).toBe('ข้อมูลกองทุน');
    expect(resolveCompanyProfileLabels('th', companyProfileKind('Stock')).title).toBe('ข้อมูลบริษัท');
    expect(resolveCompanyProfileLabels('th', companyProfileKind('crypto')).title).toBe('ข้อมูลสินทรัพย์ดิจิทัล');
  });

  it('never guesses: an unknown asset type keeps the existing company wording', () => {
    for (const assetType of [null, undefined, '', '   ', 'Mutual Fund']) {
      expect(companyProfileKind(assetType)).toBe('company');
      expect(resolveCompanyProfileLabels('th', companyProfileKind(assetType)).title)
        .toBe('ข้อมูลบริษัท');
    }
  });

  it('renames only the labels that carry the wrong noun', () => {
    const fund = resolveCompanyProfileLabels('th', 'fund');
    const company = resolveCompanyProfileLabels('th', 'company');
    expect(fund.retryProfile).toBe('ลองโหลดข้อมูลกองทุนอีกครั้ง');
    expect(fund.country).toBe(company.country);
    expect(fund.currency).toBe(company.currency);
    expect(fund.fiscalYearEnd).toBe(company.fiscalYearEnd);
    expect(resolveCompanyProfileLabels('en', 'fund').title).toBe('Fund Profile');
  });
});

describe('Thai description handover', () => {
  const sourceText = 'Rocket Lab provides launch services.';

  it('waits rather than showing the English source a Thai reader will not keep', () => {
    expect(awaitsThaiDescription({
      language: 'th', sourceText, translationSettled: false,
    })).toBe(true);
  });

  it('stops waiting as soon as an attempt settles, however it settled', () => {
    expect(awaitsThaiDescription({
      language: 'th', sourceText, translationSettled: true,
    })).toBe(false);
    // The settled-but-failed case is what keeps the original text reachable.
    expect(resolvedDescription({
      language: 'th', sourceText, translatedText: null, translationFailed: true,
    }).text).toBe(sourceText);
  });

  it('never withholds text from an English reader or an empty description', () => {
    expect(awaitsThaiDescription({
      language: 'en', sourceText, translationSettled: false,
    })).toBe(false);
    expect(awaitsThaiDescription({
      language: 'th', sourceText: null, translationSettled: false,
    })).toBe(false);
    expect(awaitsThaiDescription({
      language: 'th', sourceText: '   ', translationSettled: false,
    })).toBe(false);
  });
});
