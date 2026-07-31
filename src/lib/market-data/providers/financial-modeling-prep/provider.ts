import 'server-only';
import { ZodError } from 'zod';
import { MarketDataError, mapProviderFailure } from '../../errors';
import {
  companyProfileSchema,
  type CompanyProfile,
  type ProviderResult,
} from '../../types';
import { financialModelingPrepProfileResponseSchema } from './schemas';

const BASE_URL = 'https://financialmodelingprep.com/stable/profile';
const TIMEOUT_MS = 8_000;
const PROFILE_MAX_AGE_SECONDS = 24 * 60 * 60;

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  return Number.isFinite(date)
    ? Math.max(1, Math.ceil((date - Date.now()) / 1_000))
    : undefined;
}

function nullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function nullableInteger(value: string | number | null | undefined): number | null {
  const parsed = nullableNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function nullableWebsite(value: string | null | undefined): string | null {
  const text = nullableText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export class FinancialModelingPrepProfileProvider {
  readonly id = 'financial-modeling-prep';

  constructor(private readonly apiKey: string) {}

  async getCompanyProfile(symbol: string): Promise<ProviderResult<CompanyProfile>> {
    const url = new URL(BASE_URL);
    url.searchParams.set('symbol', symbol);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          apikey: this.apiKey,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'force-cache',
        next: { revalidate: PROFILE_MAX_AGE_SECONDS },
      });
    } catch (cause) {
      throw mapProviderFailure({ cause });
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json') && !contentType.includes('+json')) {
      throw mapProviderFailure({
        status: response.status,
        cause: new Error('Company profile provider returned a non-JSON response'),
        retryAfterSeconds: retryAfterSeconds(response),
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw mapProviderFailure({ status: response.status, cause });
    }

    if (!response.ok) {
      throw mapProviderFailure({
        status: response.status,
        payload,
        retryAfterSeconds: retryAfterSeconds(response),
      });
    }

    try {
      const rows = financialModelingPrepProfileResponseSchema.parse(payload);
      const raw = rows.find((row) => row.symbol?.trim().toUpperCase() === symbol)
        ?? rows[0];
      const name = nullableText(raw.companyName);
      if (!name) {
        throw new MarketDataError(
          'invalid-provider-response',
          'Secondary company profile response did not contain a company name',
        );
      }
      if (raw.symbol && raw.symbol.trim().toUpperCase() !== symbol) {
        throw new MarketDataError(
          'invalid-provider-response',
          'Secondary company profile response did not match the requested symbol',
        );
      }

      return {
        provider: this.id,
        data: companyProfileSchema.parse({
          symbol,
          name,
          description: nullableText(raw.description),
          country: nullableText(raw.country),
          employees: nullableInteger(raw.fullTimeEmployees),
          currency: nullableText(raw.currency),
          fiscalYearEnd: nullableText(raw.fiscalYearEnd),
          sector: nullableText(raw.sector),
          industry: nullableText(raw.industry),
          marketCapitalization: nullableNumber(raw.marketCap),
          website: nullableWebsite(raw.website),
          logoUrl: nullableWebsite(raw.image),
          exchange: nullableText(raw.exchange) ?? nullableText(raw.exchangeShortName),
          latestQuarter: null,
        }),
        freshness: {
          status: 'cached',
          asOf: null,
          maxAgeSeconds: PROFILE_MAX_AGE_SECONDS,
        },
      };
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) {
        throw new MarketDataError(
          'invalid-provider-response',
          'Secondary company profile response did not match its contract',
        );
      }
      throw cause;
    }
  }
}
