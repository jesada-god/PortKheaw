import 'server-only';
import { serverEnv } from '@/src/config/env/server';
import { MarketDataError, mapProviderFailure } from '@/src/lib/market-data/errors';
import { safeNumber } from '../../fundamentals/normalize';
import type {
  AnalystEstimate,
  PeerObservation,
  ValuationDiagnostic,
  WaccMarketInputs,
} from '../types';
import { normalizePercentage } from '../resolver';

const BASE_URL = 'https://financialmodelingprep.com/stable';
const TIMEOUT_MS = 10_000;
const MAX_PEER_CANDIDATES = 16;
const MAX_NETWORK_CONCURRENCY = 4;
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

interface PeerLoadResult {
  observation: PeerObservation | null;
  cacheStates: CacheState[];
  rejectionReasons: string[];
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
  cash: number | null;
  totalDebt: number | null;
  balanceSheetAsOf: string | null;
  sector: string | null;
  industry: string | null;
  asOf: string;
  cacheStatus: CacheState;
  peerCandidates: string[];
  peerRejections: Array<{ symbol: string; reason: string }>;
  endpointErrors: Record<string, string>;
  diagnostics: ValuationDiagnostic[];
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
  const estimatedRevenue = firstNumber(row, ['revenueAvg', 'estimatedRevenueAvg', 'estimatedRevenue']);
  const estimatedEps = firstNumber(row, ['epsAvg', 'estimatedEpsAvg', 'estimatedEPS', 'estimatedEps']);
  return {
    periodEnd,
    // Stable FMP currently uses revenueAvg/epsAvg. The explicit aliases keep the
    // adapter compatible with the documented estimatedRevenue/estimatedEPS names.
    estimatedRevenue,
    estimatedEps,
    revenueAnalystCount: firstNumber(row, ['numAnalystsRevenue', 'numberAnalystsEstimatedRevenue']),
    epsAnalystCount: firstNumber(row, ['numAnalystsEps', 'numberAnalystEstimatedEps']),
    provider: 'financial-modeling-prep',
    asOf: fetchedAt,
    currency: 'USD',
    revenueProvenance: estimatedRevenue === null ? null : {
      provider: 'financial-modeling-prep',
      sourceType: 'structured-provider',
      field: 'revenueAvg',
      fiscalPeriod: periodEnd,
      asOf: fetchedAt,
      sourceUrl: `${BASE_URL}/analyst-estimates`,
      evidence: [],
      evidenceQuality: 'high',
    },
    epsProvenance: estimatedEps === null ? null : {
      provider: 'financial-modeling-prep',
      sourceType: 'structured-provider',
      field: 'epsAvg',
      fiscalPeriod: periodEnd,
      asOf: fetchedAt,
      sourceUrl: `${BASE_URL}/analyst-estimates`,
      evidence: [],
      evidenceQuality: 'high',
    },
  };
}

function nearestFutureEstimate(estimates: AnalystEstimate[], today: string): AnalystEstimate | null {
  return estimates
    .filter((estimate) => {
      const revenueAvailable = estimate.estimatedRevenue !== null
        && estimate.estimatedRevenue > 0
        && (estimate.revenueAnalystCount === null || estimate.revenueAnalystCount > 0);
      const epsAvailable = estimate.estimatedEps !== null
        && Number.isFinite(estimate.estimatedEps)
        && (estimate.epsAnalystCount === null || estimate.epsAnalystCount > 0);
      return estimate.periodEnd > today && (revenueAvailable || epsAvailable);
    })
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .at(0) ?? null;
}

export class FinancialModelingPrepValuationProvider {
  readonly id = 'financial-modeling-prep' as const;
  private readonly cache = new Map<string, CachedPayload>();
  private readonly inflight = new Map<string, Promise<LoadedPayload>>();
  private activeNetworkRequests = 0;
  private readonly networkQueue: Array<() => void> = [];

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

  private async withNetworkPermit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeNetworkRequests >= MAX_NETWORK_CONCURRENCY) {
      await new Promise<void>((resolve) => this.networkQueue.push(resolve));
    }
    this.activeNetworkRequests += 1;
    try {
      return await operation();
    } finally {
      this.activeNetworkRequests -= 1;
      this.networkQueue.shift()?.();
    }
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
        const payload = await this.withNetworkPermit(() => this.network(path, params));
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
    candidateSource: NonNullable<PeerObservation['candidateSource']>,
    quote: RawRow | undefined,
    quoteResult: LoadedPayload | null,
    branch: 'eps' | 'revenue' | null,
  ): Promise<PeerLoadResult> {
    const [enterpriseSettled, estimatesSettled] = await Promise.allSettled([
      branch === 'eps'
        ? Promise.resolve<LoadedPayload | null>(null)
        : this.load('enterprise-values', { symbol, period: 'annual', limit: '1' }, FRESH_MS.financial),
      this.load('analyst-estimates', { symbol, period: 'annual', page: '0', limit: '10' }, FRESH_MS.financial),
    ]);
    const enterpriseResult = enterpriseSettled.status === 'fulfilled' ? enterpriseSettled.value : null;
    const estimatesResult = estimatesSettled.status === 'fulfilled' ? estimatesSettled.value : null;
    const cacheStates = [quoteResult, enterpriseResult, estimatesResult]
      .filter((result): result is LoadedPayload => result !== null)
      .map((result) => result.cache);
    const peerIdentity = {
      sector: target.sector,
      industry: target.industry,
    };
    const enterprise = newestByDate(rows(enterpriseResult?.payload));
    const estimate = nearestFutureEstimate(
      rows(estimatesResult?.payload)
        .map((row) => normalizedEstimate(
          row,
          new Date(estimatesResult?.fetchedAt ?? this.now()).toISOString(),
        ))
        .filter((item): item is AnalystEstimate => item !== null),
      today,
    );
    const price = firstNumber(quote, ['price']);
    const enterpriseValue = firstNumber(enterprise, ['enterpriseValue']);
    const relevant = Boolean(
      target.industry && peerIdentity.industry
      && target.industry.toLowerCase() === peerIdentity.industry.toLowerCase(),
    ) || Boolean(
      target.sector && peerIdentity.sector
      && target.sector.toLowerCase() === peerIdentity.sector.toLowerCase(),
    );
    const currency = 'USD';
    const rejectionReasons = [
      ...(!relevant ? ['business-relevance-mismatch'] : []),
      ...(currency !== 'USD' ? ['currency-mismatch'] : []),
      ...(!price ? ['missing-quote'] : []),
      ...(branch !== 'eps' && !enterpriseValue ? ['missing-EV'] : []),
      ...(!estimate || (estimate.estimatedEps === null && estimate.estimatedRevenue === null)
        ? ['missing-estimate'] : []),
    ];
    return {
      observation: {
        symbol,
        ...peerIdentity,
        price,
        priceAsOf: quoteResult
          ? isoFromTimestamp(quote?.timestamp) ?? new Date(quoteResult.fetchedAt).toISOString()
          : null,
        enterpriseValue,
        enterpriseValueAsOf: firstDate(enterprise, ['date']),
        forwardEps: estimate?.estimatedEps ?? null,
        forwardRevenue: estimate?.estimatedRevenue ?? null,
        estimatePeriod: estimate?.periodEnd ?? null,
        estimateAsOf: estimate?.asOf ?? null,
        provider: this.id,
        estimateProvenance: estimate?.estimatedEps !== null && estimate?.estimatedEps !== undefined
          ? estimate.epsProvenance ?? null
          : estimate?.revenueProvenance ?? null,
        candidateSource,
        currency,
      },
      cacheStates,
      rejectionReasons,
    };
  }

  private safeError(cause: unknown): string {
    return cause instanceof MarketDataError ? cause.code : 'provider-unavailable';
  }

  private rankedScreenerSymbols(
    payload: unknown,
    target: { sector: string | null; industry: string | null; marketCap: number | null },
    kind: 'industry' | 'sector',
  ): string[] {
    const normalizedTarget = text(target[kind])?.toLowerCase();
    if (!normalizedTarget) return [];
    return rows(payload)
      .filter((row) => text(row[kind])?.toLowerCase() === normalizedTarget)
      .map((row) => ({
        symbol: text(row.symbol)?.toUpperCase() ?? null,
        marketCap: firstNumber(row, ['marketCap', 'marketCapitalization']),
      }))
      .filter((item): item is { symbol: string; marketCap: number | null } => Boolean(item.symbol))
      .toSorted((left, right) => {
        if (!target.marketCap || target.marketCap <= 0) return left.symbol.localeCompare(right.symbol);
        const distance = (value: number | null) => value && value > 0
          ? Math.abs(Math.log(value / target.marketCap!)) : Number.POSITIVE_INFINITY;
        return distance(left.marketCap) - distance(right.marketCap);
      })
      .map((item) => item.symbol);
  }

  async getValuationDataset(rawSymbol: string): Promise<FmpValuationDataset> {
    const symbol = rawSymbol.trim().toUpperCase();
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const endpointNames = [
      'analyst-estimates',
      'stock-peers',
      'profile',
      'quote',
      'enterprise-values',
      'shares-float',
      'treasury-rates',
      'market-risk-premium',
    ] as const;
    const settled = await Promise.allSettled([
        this.load('analyst-estimates', { symbol, period: 'annual', page: '0', limit: '10' }, FRESH_MS.financial),
        this.load('stock-peers', { symbol }, FRESH_MS.financial),
        this.load('profile', { symbol }, FRESH_MS.profile),
        this.load('quote', { symbol }, FRESH_MS.quote),
        this.load('enterprise-values', { symbol, period: 'annual', limit: '1' }, FRESH_MS.financial),
        this.load('shares-float', { symbol }, FRESH_MS.financial),
        this.load('treasury-rates', {}, FRESH_MS.financial),
        this.load('market-risk-premium', {}, FRESH_MS.financial),
      ]);
    const endpointErrors: Record<string, string> = {};
    const results = settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      endpointErrors[endpointNames[index]] = this.safeError(result.reason);
      return null;
    });
    const [
      estimatesResult,
      peersResult,
      profileResult,
      quoteResult,
      enterpriseResult,
      sharesResult,
      treasuryResult,
      premiumResult,
    ] = results;
    const profile = rows(profileResult?.payload).at(0);
    const quote = rows(quoteResult?.payload).at(0);
    const enterprise = newestByDate(rows(enterpriseResult?.payload));
    const shares = newestByDate(rows(sharesResult?.payload)) ?? rows(sharesResult?.payload).at(0);
    const target = {
      sector: text(profile?.sector),
      industry: text(profile?.industry),
      marketCap: firstNumber(profile, ['marketCap'])
        ?? firstNumber(enterprise, ['marketCapitalization']),
    };
    const estimatesAsOf = new Date(estimatesResult?.fetchedAt ?? this.now()).toISOString();
    const estimates = rows(estimatesResult?.payload)
      .map((row) => normalizedEstimate(row, estimatesAsOf))
      .filter((estimate): estimate is AnalystEstimate => estimate !== null)
      .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
    const targetEstimate = nearestFutureEstimate(estimates, today);
    const peerBranch = targetEstimate?.estimatedEps !== null
      && targetEstimate?.estimatedEps !== undefined
      && targetEstimate.estimatedEps > 0
      ? 'eps' as const
      : targetEstimate?.estimatedRevenue !== null
        && targetEstimate?.estimatedRevenue !== undefined
        && targetEstimate.estimatedRevenue > 0
        ? 'revenue' as const : null;
    const providerSymbols = [...new Set(rows(peersResult?.payload)
      .flatMap((row) => {
        const nested = Array.isArray(row.peersList)
          ? row.peersList.map((peer) => text(peer))
          : Array.isArray(row.peers) ? row.peers.map((peer) => text(peer)) : [];
        return [text(row.symbol), ...nested]
          .map((peer) => peer?.toUpperCase() ?? null);
      })
      .filter((peer): peer is string => Boolean(peer) && peer !== symbol))];
    const candidateSource = new Map<string, NonNullable<PeerObservation['candidateSource']>>();
    // Keep room for industry/sector coverage instead of allowing a long but
    // unusable provider list to crowd out all fallback candidates.
    for (const peer of providerSymbols.slice(0, 8)) {
      candidateSource.set(peer, 'provider-peers');
    }

    if (candidateSource.size < 12 && target.industry) {
      try {
        const industryResult = await this.load('company-screener', {
          industry: target.industry,
          country: 'US',
          isActivelyTrading: 'true',
          limit: '50',
        }, FRESH_MS.profile);
        for (const peer of this.rankedScreenerSymbols(industryResult.payload, target, 'industry')) {
          if (peer !== symbol && candidateSource.size < 12) {
            if (!candidateSource.has(peer)) candidateSource.set(peer, 'industry');
          }
        }
      } catch (cause) {
        endpointErrors['company-screener:industry'] = this.safeError(cause);
      }
    }

    const settledPeers = new Map<string, PromiseSettledResult<PeerLoadResult>>();
    const observeNewCandidates = async () => {
      const pending = [...candidateSource.keys()]
        .filter((peer) => !settledPeers.has(peer));
      if (!pending.length) return;
      let batchQuoteResult: LoadedPayload | null = null;
      try {
        batchQuoteResult = await this.load(
          'batch-quote',
          { symbols: pending.join(',') },
          FRESH_MS.quote,
        );
      } catch (cause) {
        endpointErrors['batch-quote'] = this.safeError(cause);
      }
      const quotesBySymbol = new Map(rows(batchQuoteResult?.payload)
        .flatMap((row) => {
          const rowSymbol = text(row.symbol)?.toUpperCase();
          return rowSymbol ? [[rowSymbol, row] as const] : [];
        }));
      const results = await Promise.allSettled(
        pending.map((peer) => this.peerObservation(
          peer,
          target,
          today,
          candidateSource.get(peer) ?? 'provider-peers',
          quotesBySymbol.get(peer),
          batchQuoteResult,
          peerBranch,
        )),
      );
      pending.forEach((peer, index) => settledPeers.set(peer, results[index]));
    };
    await observeNewCandidates();
    const potentialValidPeerCount = () => [...settledPeers.values()]
      .filter((result): result is PromiseFulfilledResult<PeerLoadResult> =>
        result.status === 'fulfilled' && result.value.observation !== null)
      .filter((result) => {
        const peer = result.value.observation!;
        return (
          firstNumber({ value: peer.price }, ['value']) !== null
          && firstNumber({ value: peer.forwardEps }, ['value']) !== null
          && peer.price! > 0
          && peer.forwardEps! > 0
        ) || (
          firstNumber({ value: peer.enterpriseValue }, ['value']) !== null
          && firstNumber({ value: peer.forwardRevenue }, ['value']) !== null
          && peer.enterpriseValue! > 0
          && peer.forwardRevenue! > 0
        );
      }).length;

    if (
      potentialValidPeerCount() < 4
      && candidateSource.size < MAX_PEER_CANDIDATES
      && target.sector
    ) {
      try {
        const sectorResult = await this.load('company-screener', {
          sector: target.sector,
          country: 'US',
          isActivelyTrading: 'true',
          limit: '50',
        }, FRESH_MS.profile);
        for (const peer of this.rankedScreenerSymbols(sectorResult.payload, target, 'sector')) {
          if (peer !== symbol && candidateSource.size < MAX_PEER_CANDIDATES) {
            if (!candidateSource.has(peer)) candidateSource.set(peer, 'sector');
          }
        }
      } catch (cause) {
        endpointErrors['company-screener:sector'] = this.safeError(cause);
      }
      await observeNewCandidates();
    }
    const peerSymbols = [...candidateSource.keys()].slice(0, MAX_PEER_CANDIDATES);
    // Bounded fan-out from provider-derived candidates only. There is no
    // browser loop, recursive pagination, or hard-coded peer universe.
    const orderedPeerResults = peerSymbols
      .map((peer) => settledPeers.get(peer))
      .filter((result): result is PromiseSettledResult<PeerLoadResult> => Boolean(result));
    const peerResults = orderedPeerResults
      .filter((result): result is PromiseFulfilledResult<PeerLoadResult> =>
        result.status === 'fulfilled')
      .map((result) => result.value);
    const peers = peerResults
      .map((result) => result.observation)
      .filter((peer): peer is PeerObservation => peer !== null);
    const peerRejections = orderedPeerResults.flatMap((result, index) => {
      const candidate = peerSymbols[index] ?? 'unknown';
      if (result.status === 'rejected') {
        return [{ symbol: candidate, reason: this.safeError(result.reason) }];
      }
      return result.value.rejectionReasons
        .map((reason) => ({ symbol: candidate, reason }));
    });
    const latestTreasury = newestByDate(rows(treasuryResult?.payload));
    const usPremium = rows(premiumResult?.payload).find((row) =>
      text(row.country)?.toLowerCase() === 'united states');
    const cacheStates = [
      ...results.filter((result): result is LoadedPayload => result !== null)
        .map((result) => result.cache),
      ...peerResults.flatMap((result) => result.cacheStates),
    ];
    const fetchedTimes = results
      .filter((result): result is LoadedPayload => result !== null)
      .map((result) => result.fetchedAt);
    const fetchedAt = fetchedTimes.length ? Math.max(...fetchedTimes) : this.now();
    const datasetAsOf = new Date(fetchedAt).toISOString();
    const sharesOutstanding = firstNumber(shares, ['outstandingShares', 'sharesOutstanding'])
      ?? firstNumber(enterprise, ['numberOfShares']);
    const sharesOutstandingAsOf = firstDate(shares, ['date'])
      ?? firstDate(enterprise, ['date']);
    const marketCapitalization = firstNumber(profile, ['marketCap'])
      ?? firstNumber(enterprise, ['marketCapitalization']);
    const cash = firstNumber(enterprise, [
      'cashAndCashEquivalents',
      'cashAndShortTermInvestments',
      'cash',
      'minusCashAndCashEquivalents',
    ]);
    const totalDebt = firstNumber(enterprise, ['totalDebt', 'addTotalDebt']);
    const balanceSheetAsOf = firstDate(enterprise, ['date']);
    const beta = firstNumber(profile, ['beta']);
    const riskFreeRate = normalizePercentage(
      latestTreasury?.year10,
      'percent',
      { maximum: 0.25 },
    );
    const equityRiskPremium = normalizePercentage(
      usPremium?.totalEquityRiskPremium,
      'percent',
      { maximum: 0.25 },
    );
    const diagnostic = (
      field: string,
      value: number | string | null,
      period: string | null,
      asOf: string,
      endpoint: typeof endpointNames[number],
    ): ValuationDiagnostic => ({
      field,
      value,
      period,
      provider: this.id,
      asOf,
      status: value === null
        ? 'missing'
        : results[endpointNames.indexOf(endpoint)]?.cache === 'stale' ? 'stale' : 'available',
      provenance: 'provider',
      reason: value === null
        ? endpointErrors[endpoint] ?? 'provider-field-missing'
        : results[endpointNames.indexOf(endpoint)]?.cache === 'stale' ? 'stale-provider-cache' : null,
    });
    const diagnostics: ValuationDiagnostic[] = [
      diagnostic('beta', beta, 'latest profile', profileResult
        ? new Date(profileResult.fetchedAt).toISOString() : datasetAsOf, 'profile'),
      diagnostic('riskFreeRate', riskFreeRate, '10Y Treasury',
        firstDate(latestTreasury, ['date']) ?? datasetAsOf, 'treasury-rates'),
      diagnostic('equityRiskPremium', equityRiskPremium, 'United States',
        premiumResult ? new Date(premiumResult.fetchedAt).toISOString() : datasetAsOf,
        'market-risk-premium'),
      diagnostic('marketCapitalization', marketCapitalization, 'latest profile',
        profileResult ? new Date(profileResult.fetchedAt).toISOString() : datasetAsOf, 'profile'),
      diagnostic('sharesOutstanding', sharesOutstanding, sharesOutstandingAsOf,
        sharesResult ? new Date(sharesResult.fetchedAt).toISOString() : datasetAsOf,
        sharesResult ? 'shares-float' : 'enterprise-values'),
      diagnostic('cash', cash, balanceSheetAsOf, datasetAsOf, 'enterprise-values'),
      diagnostic('totalDebt', totalDebt, balanceSheetAsOf, datasetAsOf, 'enterprise-values'),
      diagnostic('peerObservations', peers.length, 'forward annual', datasetAsOf, 'stock-peers'),
      ...estimates.flatMap((estimate) => [
        diagnostic('forwardRevenue', estimate.estimatedRevenue, estimate.periodEnd,
          estimate.asOf, 'analyst-estimates'),
        diagnostic('forwardEps', estimate.estimatedEps, estimate.periodEnd,
          estimate.asOf, 'analyst-estimates'),
      ]),
    ];
    return {
      provider: this.id,
      marketPrice: firstNumber(quote, ['price']),
      marketPriceAsOf: quoteResult
        ? isoFromTimestamp(quote?.timestamp)
          ?? new Date(quoteResult.fetchedAt).toISOString()
        : null,
      currency: text(profile?.currency)?.toUpperCase() ?? null,
      estimates,
      peers,
      waccMarketInputs: {
        beta,
        betaAsOf: profileResult ? new Date(profileResult.fetchedAt).toISOString() : null,
        betaProvenance: beta === null ? null : {
          provider: this.id,
          sourceType: 'structured-provider',
          field: 'beta',
          fiscalPeriod: 'latest profile',
          asOf: profileResult ? new Date(profileResult.fetchedAt).toISOString() : datasetAsOf,
          sourceUrl: `${BASE_URL}/profile`,
          evidence: [],
          evidenceQuality: 'high',
        },
        riskFreeRate,
        riskFreeAsOf: firstDate(latestTreasury, ['date']),
        riskFreeRateProvenance: riskFreeRate === null ? null : {
          provider: this.id,
          sourceType: 'structured-provider',
          field: 'riskFreeRate',
          fiscalPeriod: '10Y Treasury',
          asOf: firstDate(latestTreasury, ['date']) ?? datasetAsOf,
          sourceUrl: `${BASE_URL}/treasury-rates`,
          evidence: [],
          evidenceQuality: 'high',
        },
        equityRiskPremium,
        equityRiskPremiumAsOf: premiumResult
          ? new Date(premiumResult.fetchedAt).toISOString() : null,
        equityRiskPremiumProvenance: equityRiskPremium === null ? null : {
          provider: this.id,
          sourceType: 'structured-provider',
          field: 'equityRiskPremium',
          fiscalPeriod: 'United States',
          asOf: premiumResult ? new Date(premiumResult.fetchedAt).toISOString() : datasetAsOf,
          sourceUrl: `${BASE_URL}/market-risk-premium`,
          evidence: [],
          evidenceQuality: 'high',
        },
        provider: this.id,
      },
      marketCapitalization,
      sharesOutstanding,
      sharesOutstandingAsOf,
      cash,
      totalDebt,
      balanceSheetAsOf,
      sector: target.sector,
      industry: target.industry,
      asOf: datasetAsOf,
      cacheStatus: cacheStates.includes('stale')
        ? 'stale'
        : cacheStates.length > 0 && cacheStates.every((state) => state === 'hit') ? 'hit' : 'miss',
      peerCandidates: peerSymbols,
      peerRejections,
      endpointErrors,
      diagnostics,
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
