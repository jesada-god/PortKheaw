'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  CompanyProfile,
  DataFreshness,
  MarketDataApiError,
} from '@/src/lib/market-data/types';
import { companyProfileErrorPresentation } from '@/src/lib/stock-detail/error-presentation';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import {
  awaitsThaiDescription,
  displayCountry,
  displayFiscalYearEnd,
  isCompanyProfileTranslationLoading,
  resolveAssetPresentationPolicy,
  resolveCompanyProfileLabels,
  resolvedDescription,
  shouldRequestCompanyProfileTranslation,
  type CompanyProfileLanguage,
} from '@/src/lib/stock-detail/profile-presentation';
import { companyProfileTranslationClient } from './company-profile-translation-client';

interface TranslationResult {
  key: string;
  attempt: number;
  text: string | null;
  error: string | null;
}

function Field({
  label,
  value,
  missingLabel,
}: {
  label: string;
  value: string | null;
  missingLabel: string;
}) {
  return (
    <div data-profile-field={label} className="min-w-0">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 break-words text-sm text-white">{value ?? missingLabel}</p>
    </div>
  );
}

const PROFILE_STATUS_LABELS: Record<CompanyProfileLanguage, Record<DataFreshness['status'], string>> = {
  th: {
    realtime: 'ข้อมูลสด',
    delayed: 'ข้อมูลล่าช้า',
    'end-of-day': 'ข้อมูลสิ้นวัน',
    cached: 'ข้อมูลแคช',
    stale: 'ข้อมูลเก่า',
    unknown: 'ไม่ทราบความสดของข้อมูล',
    unavailable: 'ไม่พร้อมใช้งาน',
  },
  en: {
    realtime: 'Live',
    delayed: 'Delayed',
    'end-of-day': 'End of day',
    cached: 'Cached',
    stale: 'Stale',
    unknown: 'Unknown freshness',
    unavailable: 'Unavailable',
  },
};

export function CompanyProfileCard({
  symbol,
  profile,
  freshness,
  provider,
  fallbackUsed = false,
  error,
  loading,
  retryAt,
  onRetry,
  language: controlledLanguage,
  onLanguageChange,
  assetType = null,
}: {
  symbol: string;
  profile: CompanyProfile | null;
  freshness: DataFreshness;
  provider: string | null;
  fallbackUsed?: boolean;
  error: MarketDataApiError | null;
  loading: boolean;
  retryAt: number;
  onRetry: () => void;
  language?: CompanyProfileLanguage;
  onLanguageChange?: (language: CompanyProfileLanguage) => void;
  /**
   * The instrument master's own asset type, already resolved for this page.
   * Decides company-vs-fund wording only — never a request, never a field.
   */
  assetType?: string | null;
}) {
  const sourceText = profile?.description?.trim() || null;
  // Thai is the reader's language. It used to default to English whenever there
  // was no description, which put the whole card into English over a fact about
  // one paragraph.
  const [localLanguage, setLocalLanguage] = useState<CompanyProfileLanguage>('th');
  const language = controlledLanguage ?? localLanguage;
  const setLanguage = onLanguageChange ?? setLocalLanguage;
  const [attempt, setAttempt] = useState(0);
  const [translation, setTranslation] = useState<TranslationResult | null>(null);
  const translationKey = `${symbol}:${sourceText ?? ''}`;
  const activeLanguage = sourceText ? language : 'en';

  useEffect(() => {
    if (!shouldRequestCompanyProfileTranslation(activeLanguage, sourceText)) return;
    const controller = new AbortController();
    let current = true;
    void companyProfileTranslationClient.request({
      symbol,
      sourceText,
      targetLanguage: 'th',
    }, controller.signal).then(
      (text) => {
        if (current) setTranslation({ key: translationKey, attempt, text, error: null });
      },
      (cause) => {
        if (current && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setTranslation({
            key: translationKey,
            attempt,
            text: null,
            error: cause instanceof Error ? cause.message : 'Translation is unavailable',
          });
        }
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [activeLanguage, attempt, sourceText, symbol, translationKey]);

  const activeTranslation = translation?.key === translationKey ? translation : null;
  const loadingTranslation = isCompanyProfileTranslationLoading({
    language: activeLanguage,
    sourceText,
    attempt,
    settledAttempt: activeTranslation?.attempt ?? null,
    translatedText: activeTranslation?.text ?? null,
    error: activeTranslation?.error ?? null,
  });
  const description = resolvedDescription({
    language: activeLanguage,
    sourceText,
    translatedText: activeTranslation?.text ?? null,
    translationFailed: Boolean(activeTranslation?.error),
  });
  /*
   * A Thai reader who has never had an answer for this text yet sees the
   * placeholder, not the English source — that swap was the visible flicker.
   * Once an attempt has settled (success or failure) the normal resolution
   * applies, so a failed translation still shows the original paragraph.
   */
  const awaitingTranslation = awaitsThaiDescription({
    language: activeLanguage,
    sourceText,
    translationSettled: Boolean(activeTranslation),
  });
  /*
   * The card's own wording follows the READER's language, not the description's.
   * They used to be the same value, so an instrument with no description to
   * translate — every crypto asset, and any symbol whose provider returned no
   * paragraph — forced the whole card into English: a Thai reader met
   * "Crypto Asset Profile". Only the description still falls back to English,
   * because that is the only text there is no Thai version of.
   */
  const policy = resolveAssetPresentationPolicy(assetType);
  const labels = resolveCompanyProfileLabels(language, policy.kind);
  const errorPresentation = companyProfileErrorPresentation(error, language);
  const status = PROFILE_STATUS_LABELS[language][freshness.status];
  const website = profile?.website ?? null;
  const profileCoolingDown = retryAt > 0;
  const profileTimestamp = freshness.cachedAt ?? freshness.asOf;
  const fields = useMemo(() => [
    ...(policy.showCountry ? [{
      label: labels.country,
      value: displayCountry(profile?.country ?? null, language),
    }] : []),
    ...(policy.showEmployees ? [{
      label: labels.employees,
      value: profile?.employees == null ? null : profile.employees.toLocaleString('en-US'),
    }] : []),
    { label: labels.currency, value: profile?.currency ?? null },
    ...(policy.showFiscalYearEnd ? [{
      label: labels.fiscalYearEnd,
      value: displayFiscalYearEnd(profile?.fiscalYearEnd ?? null, language),
    }] : []),
  ], [labels, language, policy, profile]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-bold text-white">{labels.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
            {/* Freshness + as-of only. The provider stays in the resource (and in
                the DOM as a debugging attribute) but is not written out for the
                reader — see the market-capitalisation footnote for the same rule. */}
            <span className="break-words" data-profile-provider={provider ?? undefined}>
              {status}
              {profileTimestamp
                ? ` · ${formatMarketDataAsOf(profileTimestamp, {
                    dateOnly: !freshness.cachedAt && profileTimestamp === freshness.asOf,
                  })}`
                : ''}
            </span>
            {fallbackUsed && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-300">
                {labels.fallbackSource}
              </span>
            )}
          </div>
        </div>
        {/*
          The toggle switches the DESCRIPTION's language, so it appears only when
          there is a description. It used to render permanently disabled beside a
          card that had already been forced into English, which read as a broken
          control rather than as "there is nothing here to translate".
        */}
        {sourceText && (
          <div className="flex shrink-0 rounded-lg border border-slate-700 p-1" aria-label="Company Profile language">
            <button
              type="button"
              aria-pressed={activeLanguage === 'th'}
              onClick={() => setLanguage('th')}
              className={`min-h-9 rounded-md px-3 text-xs ${activeLanguage === 'th' ? 'bg-[#D4FF00] text-black' : 'text-slate-300'}`}
            >
              ไทย
            </button>
            <button
              type="button"
              aria-pressed={activeLanguage === 'en'}
              onClick={() => setLanguage('en')}
              className={`min-h-9 rounded-md px-3 text-xs ${activeLanguage === 'en' ? 'bg-[#D4FF00] text-black' : 'text-slate-300'}`}
            >
              English
            </button>
          </div>
        )}
      </div>

      {errorPresentation && (
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="font-semibold text-amber-200">{errorPresentation.title}</p>
          <p className="mt-1 text-sm text-slate-300">{errorPresentation.detail}</p>
          {error?.retryable && (
            <button
              type="button"
              disabled={loading || profileCoolingDown}
              onClick={onRetry}
              className="mt-3 min-h-10 rounded-lg border border-amber-400/30 px-3 text-xs text-amber-200 disabled:opacity-50"
            >
              {loading
                ? labels.loading
                : profileCoolingDown
                  ? labels.retryWait
                  : labels.retryProfile}
            </button>
          )}
        </div>
      )}

      <div className="mt-4 min-h-24">
        {awaitingTranslation ? (
          <div
            role="status"
            aria-label={labels.loadingTranslation}
            className="space-y-2.5 py-1"
          >
            {['w-full', 'w-11/12', 'w-4/5'].map((width) => (
              <span
                key={width}
                aria-hidden="true"
                className={`block h-3.5 rounded bg-slate-800/70 motion-safe:animate-pulse ${width}`}
              />
            ))}
          </div>
        ) : (
          <p className="whitespace-pre-line text-sm leading-7 text-slate-300">
            {description.text ?? labels.missingDescription}
          </p>
        )}
        {loadingTranslation && <p className="mt-2 text-xs text-slate-500">{labels.loadingTranslation}</p>}
        {description.fellBackToEnglish && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-300">
            <span>{labels.translationFailed}</span>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              className="min-h-9 rounded-lg border border-amber-400/30 px-3"
            >
              {labels.retryTranslation}
            </button>
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-4 border-t border-slate-800 pt-4 sm:grid-cols-2">
        {fields.map((field) => (
          <Field
            key={field.label}
            label={field.label}
            value={field.value}
            missingLabel={labels.unavailable}
          />
        ))}
      </div>

      {website && (
        <a
          href={website}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex min-h-11 items-center rounded-lg px-1 text-sm text-[#D4FF00]"
        >
          {labels.website} ↗
        </a>
      )}
    </section>
  );
}
