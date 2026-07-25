import 'server-only';
import { normalizePercentage } from './resolver';
import type { MetricProvenance } from './types';

const TREASURY_FEED_BASE =
  'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml';
const DAMODARAN_HOME =
  'https://pages.stern.nyu.edu/~adamodar/New_Home_Page/home.htm';
const REQUEST_TIMEOUT_MS = 10_000;
const SUCCESS_CACHE_MS = 60 * 60_000;
const ERROR_COOLDOWN_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type Fetcher = typeof fetch;
type MarketMetric = 'riskFreeRate' | 'equityRiskPremium';

export interface IndependentMarketInput {
  value: number;
  asOf: string;
  provenance: MetricProvenance;
}

export class IndependentMarketSourceError extends Error {
  constructor(
    readonly code:
      | 'rate-limited'
      | 'timeout'
      | 'http-error'
      | 'invalid-provider-response',
    readonly source: 'us-treasury' | 'nyu-damodaran',
    readonly status: number | null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`${source}:${code}`);
    this.name = 'IndependentMarketSourceError';
  }
}

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function isoDate(value: string): string | null {
  const trimmed = value.trim();
  const dateOnly = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateOnly) return dateOnly[1];
  // Parse labelled English dates at UTC noon so the server timezone cannot
  // shift the published date backward or forward.
  const timestamp = Date.parse(`${trimmed} 12:00:00 UTC`);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString().slice(0, 10)
    : null;
}

function xmlValue(entry: string, field: string): string | null {
  const match = entry.match(
    new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${field}\\b[^>]*>([^<]+)<\\/`, 'i'),
  );
  return match?.[1]?.trim() ?? null;
}

export function parseTreasuryTenYearYield(xml: string): IndependentMarketInput {
  const observations = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)]
    .flatMap((match) => {
      const date = isoDate(xmlValue(match[0], 'NEW_DATE') ?? '');
      const value = normalizePercentage(
        xmlValue(match[0], 'BC_10YEAR'),
        'percent',
        { maximum: 0.25 },
      );
      return date && positive(value) ? [{ date, value }] : [];
    })
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const latest = observations.at(-1);
  if (!latest) {
    throw new IndependentMarketSourceError(
      'invalid-provider-response',
      'us-treasury',
      200,
    );
  }
  return {
    value: latest.value,
    asOf: latest.date,
    provenance: {
      provider: 'us-treasury-daily-par-yield-curve',
      sourceType: 'structured-provider',
      field: 'riskFreeRate',
      fiscalPeriod: '10Y',
      asOf: latest.date,
      sourceUrl: TREASURY_FEED_BASE,
      evidence: [{
        url: TREASURY_FEED_BASE,
        publisher: 'U.S. Department of the Treasury',
        publishedAt: latest.date,
        evidence: 'Official daily 10-year Treasury par yield curve observation.',
        quality: 'primary',
      }],
      evidenceQuality: 'high',
      methodology: 'Official 10-year par yield normalized from percent to decimal.',
    },
  };
}

function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseDamodaranUsImpliedErp(html: string): IndependentMarketInput {
  const text = visibleText(html);
  const match = text.match(
    /Implied\s+ERP\s+on\s+([^=]{3,40}?)\s*=\s*([0-9]+)(?:\s*\.\s*([0-9]+))?\s*%\s*\(\s*Trailing\s+12\s+month,\s*with\s+adjusted\s+payout\s*\)/i,
  );
  const asOf = isoDate(match?.[1]?.trim() ?? '');
  const publishedPercent = match
    ? `${match[2]}${match[3] ? `.${match[3]}` : ''}`
    : null;
  const value = normalizePercentage(
    publishedPercent,
    'percent',
    { maximum: 0.25 },
  );
  if (!asOf || !positive(value)) {
    throw new IndependentMarketSourceError(
      'invalid-provider-response',
      'nyu-damodaran',
      200,
    );
  }
  return {
    value,
    asOf,
    provenance: {
      provider: 'nyu-damodaran-implied-erp',
      sourceType: 'structured-provider',
      field: 'equityRiskPremium',
      fiscalPeriod: 'United States',
      asOf,
      sourceUrl: DAMODARAN_HOME,
      evidence: [{
        url: DAMODARAN_HOME,
        publisher: 'NYU Stern / Aswath Damodaran',
        publishedAt: asOf,
        evidence: 'Published U.S. implied ERP using trailing 12-month adjusted payout.',
        quality: 'primary',
      }],
      evidenceQuality: 'high',
      methodology: 'Published U.S. implied ERP normalized from percent to decimal.',
    },
  };
}

function retryAfterSeconds(response: Response, now: number): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.ceil((date - now) / 1_000))
    : null;
}

export class IndependentMarketInputsResolver {
  private readonly cache = new Map<
    MarketMetric,
    { value: IndependentMarketInput; expiresAt: number }
  >();
  private readonly inflight = new Map<MarketMetric, Promise<IndependentMarketInput>>();
  private readonly blockedUntil = new Map<MarketMetric, number>();
  private readonly failures = new Map<
    MarketMetric,
    { error: IndependentMarketSourceError; expiresAt: number }
  >();

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  resolveRiskFreeRate(): Promise<IndependentMarketInput> {
    const year = new Date(this.now()).getUTCFullYear();
    const url = new URL(TREASURY_FEED_BASE);
    url.searchParams.set('data', 'daily_treasury_yield_curve');
    url.searchParams.set('field_tdr_date_value', String(year));
    return this.resolve(
      'riskFreeRate',
      'us-treasury',
      url,
      parseTreasuryTenYearYield,
    );
  }

  resolveEquityRiskPremium(): Promise<IndependentMarketInput> {
    return this.resolve(
      'equityRiskPremium',
      'nyu-damodaran',
      new URL(DAMODARAN_HOME),
      parseDamodaranUsImpliedErp,
    );
  }

  private resolve(
    metric: MarketMetric,
    source: IndependentMarketSourceError['source'],
    url: URL,
    parse: (body: string) => IndependentMarketInput,
  ): Promise<IndependentMarketInput> {
    const cached = this.cache.get(metric);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    const failure = this.failures.get(metric);
    if (failure && failure.expiresAt > this.now()) {
      return Promise.reject(failure.error);
    }
    const pending = this.inflight.get(metric);
    if (pending) return pending;
    const blockedUntil = this.blockedUntil.get(metric) ?? 0;
    if (blockedUntil > this.now()) {
      return Promise.reject(new IndependentMarketSourceError(
        'rate-limited',
        source,
        429,
        Math.ceil((blockedUntil - this.now()) / 1_000),
      ));
    }
    const operation = this.load(metric, source, url, parse)
      .finally(() => this.inflight.delete(metric));
    this.inflight.set(metric, operation);
    return operation;
  }

  private async load(
    metric: MarketMetric,
    source: IndependentMarketSourceError['source'],
    url: URL,
    parse: (body: string) => IndependentMarketInput,
  ): Promise<IndependentMarketInput> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        cache: 'no-store',
        headers: {
          accept: source === 'us-treasury'
            ? 'application/xml,text/xml;q=0.9'
            : 'text/html;q=0.9',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfter = retryAfterSeconds(response, this.now());
        if (response.status === 429) {
          this.blockedUntil.set(
            metric,
            this.now() + (retryAfter ?? ERROR_COOLDOWN_MS / 1_000) * 1_000,
          );
        }
        throw new IndependentMarketSourceError(
          response.status === 429 ? 'rate-limited' : 'http-error',
          source,
          response.status,
          retryAfter,
        );
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new IndependentMarketSourceError(
          'invalid-provider-response',
          source,
          response.status,
        );
      }
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES) {
        throw new IndependentMarketSourceError(
          'invalid-provider-response',
          source,
          response.status,
        );
      }
      const value = parse(body);
      this.failures.delete(metric);
      this.cache.set(metric, { value, expiresAt: this.now() + SUCCESS_CACHE_MS });
      return value;
    } catch (cause) {
      if (cause instanceof IndependentMarketSourceError) {
        if (cause.code !== 'rate-limited') {
          this.failures.set(metric, {
            error: cause,
            expiresAt: this.now() + ERROR_COOLDOWN_MS,
          });
        }
        throw cause;
      }
      if (cause instanceof Error && cause.name === 'AbortError') {
        const error = new IndependentMarketSourceError('timeout', source, null);
        this.failures.set(metric, {
          error,
          expiresAt: this.now() + ERROR_COOLDOWN_MS,
        });
        throw error;
      }
      const error = new IndependentMarketSourceError('http-error', source, null);
      this.failures.set(metric, {
        error,
        expiresAt: this.now() + ERROR_COOLDOWN_MS,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

let resolver: IndependentMarketInputsResolver | undefined;

export function getIndependentMarketInputsResolver(): IndependentMarketInputsResolver {
  resolver ??= new IndependentMarketInputsResolver();
  return resolver;
}
