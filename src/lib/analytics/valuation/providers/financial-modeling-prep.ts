import 'server-only';
import { serverEnv } from '@/src/config/env/server';
import { MarketDataError, mapProviderFailure } from '@/src/lib/market-data/errors';
import { safeNumber } from '../../fundamentals/normalize';
import type {
  AnalystEstimate,
  PeerObservation,
  WaccMarketInputs,
} from '../types';

const BASE_URL = 'https://financialmodelingprep.com/stable';
const TIMEOUT_MS = 10_000;
const MAX_PEER_CANDIDATES = 10;
const FRESH_MS = {
  quote: 5 * 60_000,
  profile: 7 * 86_400_000,
  financial: 24 * 60 * 60_000,
} as const;
const STALE_MULTIPLIER = 7;

type Fetcher = typeof fetch;
type RawRow = Record<string, unknown>;
type CacheState = 'hit' | 'miss' | 'stale';

interface CachedPayload {
  payload: unknown;
  fetchedAt: number;
}

interface LoadedPayload {
  payload: unknown;
  fetchedAt: number;
  cache: CacheState;
}

export interface FmpValuationDataset {
  provider: 'financial-modeling-prep';
  marketPrice: number | null;
  marketPriceAsOf: string | null;
  currency: string | null;
  estimates: AnalystEstimate[];
  peers: PeerObservation[];
  waccMarketInputs: WaccMarketInputs;
  marketCapitalization: number | null;
  sharesOutstanding: number | null;
  sharesOutstandingAsOf: string | null;
  sector: string | null;
  industry: string | null;
  asOf: string;
  cacheStatus: CacheState;
}

function rows(payload: unknown): RawRow[] {
  return Array.isArray(payload)
    ? payload.filter((row): row is RawRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoFromTimestamp(value: unknown): string | null {
  const numeric = safeNumber(value);
  if (numeric === null || numeric <= 0) return null;
  const milliseconds = numeric >= 1e12 ? numeric : numeric * 1_000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function percentage(value: unknown): number | null {
  const numeric = safeNumber(value);
  return numeric === null ? null : numeric / 100;
}

function firstNumber(row: RawRow | undefined, fields: string[]): number | null {
  if (!row) return null;
  for (const field of fields) {
    const value = safeNumber(row[field]);
    if (value !== null) return value;
  }
  return null;
}

function firstDate(row: RawRow | undefined, fields: string[]): string | null {
  if (!row) return null;
  for (const field of fields) {
    const value = text(row[field]);
    if (value && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  return null;
}

function newestByDate(input: RawRow[]): RawRow | undefined {
  return [...input].sort((left, right) =>
    (firstDate(right, ['date']) ?? '').localeCompare(firstDate(left, ['date']) ?? '')).at(0);
}

function normalizedEstimate(row: RawRow, fetchedAt: string): AnalystEstimate | null {
  const periodEnd = firstDate(row, ['date', 'periodEnd']);
  if (!periodEnd) return null;
  return {
    periodEnd,
    // Stable FMP currently uses revenueAvg/epsAvg. The explicit aliases keep the
    // adapter compatible with the documented estimatedRevenue/estimatedEPS names.
    estimatedRevenue: firstNumber(row, ['revenueAvg', 'estimatedRevenueAvg', 'estimatedRevenue']),
    estimatedEps: firstNumber(row, ['epsAvg', 'estimatedEpsAvg', 'estimatedEPS', 'estimatedEps']),
    revenueAnalystCount: firstNumber(row, ['numAnalystsRevenue', 'numberAnalystsEstimatedRevenue']),
    epsAnalystCount: firstNumber(row, ['numAnalystsEps', 'numberAnalystEstimatedEps']),
    provider: 'financial-modeling-prep',
    asOf: fetchedAt,
  };
}

function nearestFutureEstimate(estimates: AnalystEstimate[], today: string): AnalystEstimate | null {
  return estimates
    .filter((estimate) =>
      estimate.periodEnd > today
      && (estimate.revenueAnalystCount === null || estimate.revenueAnalystCount > 0)
      && (estimate.epsAnalystCount === null || estimate.epsAnalystCount > 0))
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .at(0) ?? null;
}

function sameIndustryOrSector(
  target: { sector: string | null; industry: string | null },
  peer: { sector: string | null; industry: string | null },
): boolean {
  const normalize = (value: string | null) => value?.trim().toLowerCase() ?? '';
  const targetIndustry = normalize(target.industry);
  const targetSector = normalize(target.sector);
  const peerIndustry = normalize(peer.industry);
  const peerSector = normalize(peer.sector);
  return Boolean(
    (targetIndustry && peerIndustry && targetIndustry === peerIndustry)
    || (targetSector && peerSector && targetSector === peerSector),
  );
}

export class FinancialModelingPrepValuationProvider {
  readonly id = 'financial-modeling-prep' as const;
  private readonly cache = new Map<string, CachedPayload>();
  private readonly inflight = new Map<string, Promise<LoadedPayload>>();

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private retryAfter(response: Response): number | undefined {
    const raw = response.headers.get('retry-after');
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, Math.ceil((date - this.now()) / 1_000)) : undefined;
  }

  private async network(path: string, params: Record<string, string>): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const url = new URL(`${BASE_URL}/${path}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: { Accept: 'application/json', apikey: this.apiKey },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        });
      } catch (cause) {
        const error = mapProviderFailure({ cause });
        if (attempt < 2 && error.retryable) {
          await this.sleep(250 * (2 ** attempt));
          continue;
        }
        throw error;
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        throw mapProviderFailure({ status: response.status, cause });
      }
      const retryAfter = this.retryAfter(response);
      const objectError = payload && typeof payload === 'object' && !Array.isArray(payload);
      if (!response.ok || objectError) {
        const error = mapProviderFailure({
          status: response.status,
          payload,
          retryAfterSeconds: retryAfter,
        });
        if (attempt < 2 && error.retryable) {
          await this.sleep((retryAfter ?? attempt + 1) * 1_000);
          continue;
        }
        throw error;
      }
      if (!Array.isArray(payload)) {
        throw new MarketDataError(
          'invalid-provider-response',
          `FMP ${path} returned a non-array payload`,
        );
      }
      return payload;
    }
    throw new MarketDataError('upstream-unavailable', `FMP ${path} retry budget exhausted`);
  }

  private load(path: string, params: Record<string, string>, ttlMs: number): Promise<LoadedPayload> {
    const ordered = Object.entries(params).toSorted(([left], [right]) => left.localeCompare(right));
    const key = `${path}?${ordered.map(([name, value]) => `${name}=${value}`).join('&')}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const cached = this.cache.get(key);
      const age = cached ? this.now() - cached.fetchedAt : Number.POSITIVE_INFINITY;
      if (cached && age <= ttlMs) {
        return { ...cached, cache: 'hit' as const };
      }
      try {
        const payload = await this.network(path, params);
        const fetchedAt = this.now();
        this.cache.set(key, { payload, fetchedAt });
        return { payload, fetchedAt, cache: 'miss' as const };
      } catch (cause) {
        if (cached && age <= ttlMs * STALE_MULTIPLIER) {
          return { ...cached, cache: 'stale' as const };
        }
        throw cause;
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, operation);
    return operation;
  }

  private async peerObservation(
    symbol: string,
    target: { sector: string | null; industry: string | null },
    today: string,
  ): Promise<{ observation: PeerObservation | null; cacheStates: CacheState[] }> {
    const [profileResult, quoteResult, enterpriseResult, estimatesResult] = await Promise.all([
      this.load('profile', { symbol }, FRESH_MS.profile),
      this.load('quote', { symbol }, FRESH_MS.quote),
      this.load('enterprise-values', { symbol, period: 'annual', limit: '1' }, FRESH_MS.financial),
      this.load('analyst-estimates', { symbol, period: 'annual', page: '0', limit: '10' }, FRESH_MS.financial),
    ]);
    const profile = rows(profileResult.payload).at(0);
    const peerIdentity = {
      sector: text(profile?.sector),
      industry: text(profile?.industry),
    };
    if (!profile || !sameIndustryOrSector(target, peerIdentity)) {
      return {
        observation: null,
        cacheStates: [profileResult.cache, quoteResult.cache, enterpriseResult.cache, estimatesResult.cache],
      };
    }
    const quote = rows(quoteResult.payload).at(0);
    const enterprise = newestByDate(rows(enterpriseResult.payload));
    const estimate = nearestFutureEstimate(
      rows(estimatesResult.payload)
        .map((row) => normalizedEstimate(row, new Date(estimatesResult.fetchedAt).toISOString()))
        .filter((item): item is AnalystEstimate => item !== null),
      today,
    );
    return {
      observation: {
        symbol,
        ...peerIdentity,
        price: firstNumber(quote, ['price']),
        priceAsOf: isoFromTimestamp(quote?.timestamp) ?? new Date(quoteResult.fetchedAt).toISOString(),
        enterpriseValue: firstNumber(enterprise, ['enterpriseValue']),
        enterpriseValueAsOf: firstDate(enterprise, ['date']),
        forwardEps: estimate?.estimatedEps ?? null,
        forwardRevenue: estimate?.estimatedRevenue ?? null,
        estimatePeriod: estimate?.periodEnd ?? null,
        estimateAsOf: estimate?.asOf ?? null,
        provider: this.id,
      },
      cacheStates: [profileResult.cache, quoteResult.cache, enterpriseResult.cache, estimatesResult.cache],
    };
  }

  async getValuationDataset(rawSymbol: string): Promise<FmpValuationDataset> {
    const symbol = rawSymbol.trim().toUpperCase();
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const [
      estimatesResult,
      peersResult,
      profileResult,
      quoteResult,
      enterpriseResult,
      treasuryResult,
      premiumResult,
    ] =
      await Promise.all([
        this.load('analyst-estimates', { symbol, period: 'annual', page: '0', limit: '10' }, FRESH_MS.financial),
        this.load('stock-peers', { symbol }, FRESH_MS.financial),
        this.load('profile', { symbol }, FRESH_MS.profile),
        this.load('quote', { symbol }, FRESH_MS.quote),
        this.load('enterprise-values', { symbol, period: 'annual', limit: '1' }, FRESH_MS.financial),
        this.load('treasury-rates', {}, FRESH_MS.financial),
        this.load('market-risk-premium', {}, FRESH_MS.financial),
      ]);
    const profile = rows(profileResult.payload).at(0);
    const quote = rows(quoteResult.payload).at(0);
    const target = {
      sector: text(profile?.sector),
      industry: text(profile?.industry),
    };
    const estimatesAsOf = new Date(estimatesResult.fetchedAt).toISOString();
    const estimates = rows(estimatesResult.payload)
      .map((row) => normalizedEstimate(row, estimatesAsOf))
      .filter((estimate): estimate is AnalystEstimate => estimate !== null)
      .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
    const peerSymbols = [...new Set(rows(peersResult.payload)
      .map((row) => text(row.symbol)?.toUpperCase() ?? null)
      .filter((peer): peer is string => Boolean(peer) && peer !== symbol))]
      .slice(0, MAX_PEER_CANDIDATES);
    // Bounded one-shot fan-out from the provider's real peer set. There is no
    // browser loop, timer, recursive pagination, or hard-coded peer universe.
    const settledPeers = await Promise.allSettled(
      peerSymbols.map((peer) => this.peerObservation(peer, target, today)),
    );
    const peerResults = settledPeers
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<FinancialModelingPrepValuationProvider['peerObservation']>>> =>
        result.status === 'fulfilled')
      .map((result) => result.value);
    const peers = peerResults
      .map((result) => result.observation)
      .filter((peer): peer is PeerObservation => peer !== null);
    const latestTreasury = newestByDate(rows(treasuryResult.payload));
    const usPremium = rows(premiumResult.payload).find((row) =>
      text(row.country)?.toLowerCase() === 'united states');
    const enterprise = newestByDate(rows(enterpriseResult.payload));
    const cacheStates = [
      estimatesResult.cache,
      peersResult.cache,
      profileResult.cache,
      quoteResult.cache,
      enterpriseResult.cache,
      treasuryResult.cache,
      premiumResult.cache,
      ...peerResults.flatMap((result) => result.cacheStates),
    ];
    const fetchedAt = Math.max(
      estimatesResult.fetchedAt,
      peersResult.fetchedAt,
      profileResult.fetchedAt,
      quoteResult.fetchedAt,
      enterpriseResult.fetchedAt,
      treasuryResult.fetchedAt,
      premiumResult.fetchedAt,
    );
    return {
      provider: this.id,
      marketPrice: firstNumber(quote, ['price']),
      marketPriceAsOf: isoFromTimestamp(quote?.timestamp)
        ?? new Date(quoteResult.fetchedAt).toISOString(),
      currency: text(profile?.currency)?.toUpperCase() ?? null,
      estimates,
      peers,
      waccMarketInputs: {
        beta: firstNumber(profile, ['beta']),
        betaAsOf: new Date(profileResult.fetchedAt).toISOString(),
        riskFreeRate: percentage(latestTreasury?.year10),
        riskFreeAsOf: firstDate(latestTreasury, ['date']),
        equityRiskPremium: percentage(usPremium?.totalEquityRiskPremium),
        equityRiskPremiumAsOf: new Date(premiumResult.fetchedAt).toISOString(),
        provider: this.id,
      },
      marketCapitalization: firstNumber(profile, ['marketCap'])
        ?? firstNumber(enterprise, ['marketCapitalization']),
      sharesOutstanding: firstNumber(enterprise, ['numberOfShares']),
      sharesOutstandingAsOf: firstDate(enterprise, ['date']),
      ...target,
      asOf: new Date(fetchedAt).toISOString(),
      cacheStatus: cacheStates.includes('stale')
        ? 'stale'
        : cacheStates.every((state) => state === 'hit') ? 'hit' : 'miss',
    };
  }
}

let instance: FinancialModelingPrepValuationProvider | null = null;
let instanceKey: string | undefined;

export function getFmpValuationProvider(): FinancialModelingPrepValuationProvider | null {
  const apiKey = serverEnv.FMP_API_KEY;
  if (!apiKey) return null;
  if (!instance || instanceKey !== apiKey) {
    instanceKey = apiKey;
    instance = new FinancialModelingPrepValuationProvider(apiKey);
  }
  return instance;
}
