import { z } from 'zod';
import { datasetFreshness, type DatasetFreshnessState, type ValuationDataset } from './freshness';
import type {
  AnalystEstimate,
  MetricProvenance,
  PeerObservation,
  ValuationInput,
  ValuationDiagnostic,
  WaccMarketInputs,
} from './types';

export const VALUATION_LKG_SCHEMA_VERSION = 1;

export type ValuationInputLkgScope = 'company' | 'market' | 'peers';
export type ValuationInputLkgMetric =
  | 'beta'
  | 'risk-free-rate'
  | 'equity-risk-premium'
  | 'forward-eps'
  | 'forward-revenue'
  | 'peer-forward-pe'
  | 'peer-forward-ev-sales';
export type ValuationInputLkgOrigin = 'provider' | 'derived' | 'gemini-grounded';

export interface ValuationInputLkgEntry {
  scope: ValuationInputLkgScope;
  ownerKey: string;
  metric: ValuationInputLkgMetric;
  period: string;
  data: unknown;
  source: string;
  origin: ValuationInputLkgOrigin;
  asOf: string;
  fetchedAt: string;
  validatedAt: string;
  freshness: 'fresh' | 'stale';
  schemaVersion: number;
  provenance: MetricProvenance | null;
}

export interface ValuationInputLkgRepository {
  list(ownerKey: string): Promise<ValuationInputLkgEntry[]>;
  upsert(entry: ValuationInputLkgEntry): Promise<void>;
}

export interface CachedValuationScalar {
  value: number;
  state: 'fresh' | 'stale';
  entry: ValuationInputLkgEntry;
}

export interface CachedForwardMetric extends CachedValuationScalar {
  period: string;
  analystCount: number | null;
  currency: string;
}

export interface CachedPeerSet {
  metric: 'forward-pe' | 'forward-ev-sales';
  candidates: string[];
  accepted: string[];
  rejected: NonNullable<ValuationInput['peerAudit']>['rejected'];
  observations: PeerObservation[];
  state: 'fresh' | 'stale';
  entry: ValuationInputLkgEntry;
}

export interface ValuationInputLkgSnapshot {
  symbol: string;
  company: {
    beta: CachedValuationScalar | null;
    forwardEps: CachedForwardMetric[];
    forwardRevenue: CachedForwardMetric[];
  };
  market: {
    riskFreeRate: CachedValuationScalar | null;
    equityRiskPremium: CachedValuationScalar | null;
  };
  peers: CachedPeerSet[];
}

const nonEmpty = z.string().trim().min(1);
const timestamp = nonEmpty.refine((value) => Number.isFinite(Date.parse(value)));
const positiveFinite = z.number().finite().positive();
const evidenceSchema = z.object({
  url: z.url(),
  publisher: nonEmpty,
  publishedAt: nonEmpty,
  evidence: nonEmpty,
  quality: z.enum(['primary', 'reputable', 'secondary']),
});
const provenanceSchema = z.object({
  provider: nonEmpty,
  sourceType: z.enum(['structured-provider', 'gemini-grounded', 'derived']),
  field: nonEmpty,
  fiscalPeriod: nonEmpty,
  asOf: timestamp,
  sourceUrl: z.url().optional(),
  evidence: z.array(evidenceSchema),
  evidenceQuality: z.enum(['high', 'medium']),
  methodology: nonEmpty.optional(),
  benchmark: nonEmpty.optional(),
  sampleSize: z.number().int().positive().optional(),
  frequency: z.enum(['daily', 'weekly', 'monthly']).optional(),
  start: nonEmpty.optional(),
  end: nonEmpty.optional(),
});
const baseEntrySchema = z.object({
  scope: z.enum(['company', 'market', 'peers']),
  ownerKey: nonEmpty,
  metric: z.enum([
    'beta',
    'risk-free-rate',
    'equity-risk-premium',
    'forward-eps',
    'forward-revenue',
    'peer-forward-pe',
    'peer-forward-ev-sales',
  ]),
  period: nonEmpty,
  source: nonEmpty,
  origin: z.enum(['provider', 'derived', 'gemini-grounded']),
  asOf: timestamp,
  fetchedAt: timestamp,
  validatedAt: timestamp,
  freshness: z.enum(['fresh', 'stale']),
  schemaVersion: z.literal(VALUATION_LKG_SCHEMA_VERSION),
  provenance: provenanceSchema.nullable(),
});
const scalarDataSchema = z.object({ value: positiveFinite });
const forwardDataSchema = z.object({
  value: positiveFinite,
  analystCount: z.number().int().nonnegative().nullable(),
  currency: z.literal('USD'),
});
const rejectionSchema = z.object({
  symbol: nonEmpty,
  reason: nonEmpty,
  metric: z.enum(['forward-pe', 'forward-ev-sales']).nullable().optional(),
  period: nonEmpty.nullable().optional(),
  source: nonEmpty.nullable().optional(),
  asOf: nonEmpty.nullable().optional(),
});
const peerObservationSchema = z.object({
  symbol: nonEmpty,
  company: z.string().nullable().optional(),
  businessContext: z.string().nullable().optional(),
  sector: z.string().nullable(),
  industry: z.string().nullable(),
  price: positiveFinite.nullable(),
  priceAsOf: nonEmpty.nullable(),
  enterpriseValue: positiveFinite.nullable(),
  enterpriseValueAsOf: nonEmpty.nullable(),
  forwardEps: positiveFinite.nullable(),
  forwardRevenue: positiveFinite.nullable(),
  estimatePeriod: nonEmpty.nullable(),
  estimateAsOf: nonEmpty.nullable(),
  provider: nonEmpty,
  estimateProvenance: provenanceSchema.nullable().optional(),
  candidateProvenance: provenanceSchema.nullable().optional(),
  candidateSource: z.enum([
    'provider-peers',
    'industry',
    'sector',
    'gemini-grounded',
  ]).optional(),
  currency: z.literal('USD').nullable().optional(),
});
const peerSetDataSchema = z.object({
  metric: z.enum(['forward-pe', 'forward-ev-sales']),
  candidates: z.array(nonEmpty),
  accepted: z.array(nonEmpty).min(4),
  rejected: z.array(rejectionSchema),
  observations: z.array(peerObservationSchema).min(4),
});

function freshnessDataset(metric: ValuationInputLkgMetric): ValuationDataset {
  if (metric === 'beta') return 'beta';
  if (metric === 'risk-free-rate') return 'riskFreeRate';
  if (metric === 'equity-risk-premium') return 'equityRiskPremium';
  if (metric === 'forward-eps' || metric === 'forward-revenue') return 'forwardEstimates';
  return 'peerEstimates';
}

function validateEntry(entry: ValuationInputLkgEntry): ValuationInputLkgEntry {
  const base = baseEntrySchema.safeParse(entry);
  if (!base.success) throw new Error('Invalid valuation LKG entry');
  const dataResult = entry.metric === 'forward-eps' || entry.metric === 'forward-revenue'
    ? forwardDataSchema.safeParse(entry.data)
    : entry.metric === 'peer-forward-pe' || entry.metric === 'peer-forward-ev-sales'
      ? peerSetDataSchema.safeParse(entry.data)
      : scalarDataSchema.safeParse(entry.data);
  const scopeValid = entry.metric === 'risk-free-rate' || entry.metric === 'equity-risk-premium'
    ? entry.scope === 'market' && entry.ownerKey === 'US'
    : entry.metric === 'peer-forward-pe' || entry.metric === 'peer-forward-ev-sales'
      ? entry.scope === 'peers'
      : entry.scope === 'company';
  if (!dataResult.success || !scopeValid) throw new Error('Invalid valuation LKG entry');
  return entry;
}

function usableState(
  entry: ValuationInputLkgEntry,
  now: number,
): Extract<DatasetFreshnessState, 'fresh' | 'stale'> | null {
  if (entry.schemaVersion !== VALUATION_LKG_SCHEMA_VERSION) return null;
  const state = datasetFreshness(freshnessDataset(entry.metric), entry.asOf, now);
  return state === 'fresh' || state === 'stale' ? state : null;
}

function newest<T extends { entry: ValuationInputLkgEntry }>(values: T[]): T | null {
  return values.toSorted((left, right) =>
    left.entry.asOf.localeCompare(right.entry.asOf)).at(-1) ?? null;
}

export function emptyValuationInputLkgSnapshot(symbol: string): ValuationInputLkgSnapshot {
  return {
    symbol: symbol.trim().toUpperCase(),
    company: { beta: null, forwardEps: [], forwardRevenue: [] },
    market: { riskFreeRate: null, equityRiskPremium: null },
    peers: [],
  };
}

export class ValuationInputLkgService {
  private readonly inflight = new Map<string, Promise<ValuationInputLkgSnapshot>>();
  private readonly listInflight = new Map<string, Promise<ValuationInputLkgEntry[]>>();
  private readonly writeInflight = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: ValuationInputLkgRepository | null,
    private readonly now: () => number = Date.now,
  ) {}

  async read(rawSymbol: string): Promise<ValuationInputLkgSnapshot> {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!this.repository) return emptyValuationInputLkgSnapshot(symbol);
    const active = this.inflight.get(symbol);
    if (active) return active;
    const operation = this.readFromRepository(symbol)
      .finally(() => this.inflight.delete(symbol));
    this.inflight.set(symbol, operation);
    return operation;
  }

  async write(entry: ValuationInputLkgEntry): Promise<void> {
    if (!this.repository) return;
    const validated = validateEntry(entry);
    const key = [
      validated.scope,
      validated.ownerKey,
      validated.metric,
      validated.period,
    ].join(':');
    const previous = this.writeInflight.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.repository!.upsert(validated))
      .finally(() => {
        if (this.writeInflight.get(key) === operation) this.writeInflight.delete(key);
      });
    this.writeInflight.set(key, operation);
    return operation;
  }

  async writeMany(entries: ValuationInputLkgEntry[]): Promise<void> {
    await Promise.all(entries.map((entry) => this.write(entry)));
  }

  private async readFromRepository(symbol: string): Promise<ValuationInputLkgSnapshot> {
    const [companyEntries, marketEntries] = await Promise.all([
      this.listOwner(symbol),
      this.listOwner('US'),
    ]);
    const snapshot = emptyValuationInputLkgSnapshot(symbol);
    const scalarCandidates = new Map<ValuationInputLkgMetric, CachedValuationScalar[]>();

    for (const untrusted of [...companyEntries, ...marketEntries]) {
      let entry: ValuationInputLkgEntry;
      try {
        entry = validateEntry(untrusted);
      } catch {
        continue;
      }
      const state = usableState(entry, this.now());
      if (!state) continue;
      const data = entry.data as { value: number; analystCount?: number | null; currency?: string };
      if (entry.metric === 'forward-eps' || entry.metric === 'forward-revenue') {
        const item: CachedForwardMetric = {
          value: data.value,
          analystCount: data.analystCount ?? null,
          currency: data.currency ?? 'USD',
          period: entry.period,
          state,
          entry,
        };
        if (entry.metric === 'forward-eps') snapshot.company.forwardEps.push(item);
        else snapshot.company.forwardRevenue.push(item);
        continue;
      }
      if (entry.metric === 'peer-forward-pe' || entry.metric === 'peer-forward-ev-sales') {
        const data = entry.data as Omit<CachedPeerSet, 'state' | 'entry'>;
        snapshot.peers.push({ ...data, state, entry });
        continue;
      }
      const values = scalarCandidates.get(entry.metric) ?? [];
      values.push({ value: data.value, state, entry });
      scalarCandidates.set(entry.metric, values);
    }

    snapshot.company.beta = newest(scalarCandidates.get('beta') ?? []);
    snapshot.market.riskFreeRate = newest(
      scalarCandidates.get('risk-free-rate') ?? [],
    );
    snapshot.market.equityRiskPremium = newest(
      scalarCandidates.get('equity-risk-premium') ?? [],
    );
    snapshot.company.forwardEps.sort((left, right) => left.period.localeCompare(right.period));
    snapshot.company.forwardRevenue.sort((left, right) =>
      left.period.localeCompare(right.period));
    snapshot.peers.sort((left, right) => left.entry.asOf.localeCompare(right.entry.asOf));
    return snapshot;
  }

  private listOwner(ownerKey: string): Promise<ValuationInputLkgEntry[]> {
    const active = this.listInflight.get(ownerKey);
    if (active) return active;
    const operation = this.repository!.list(ownerKey)
      .finally(() => this.listInflight.delete(ownerKey));
    this.listInflight.set(ownerKey, operation);
    return operation;
  }
}

function cacheProvenance(
  entry: ValuationInputLkgEntry,
  field: string,
): MetricProvenance {
  return entry.provenance ?? {
    provider: entry.source,
    sourceType: entry.origin === 'provider' ? 'structured-provider' : entry.origin,
    field,
    fiscalPeriod: entry.period,
    asOf: entry.asOf,
    evidence: [],
    evidenceQuality: 'high',
  };
}

export function hasCompleteFreshValuationLkg(snapshot: ValuationInputLkgSnapshot): boolean {
  return snapshot.company.beta?.state === 'fresh'
    && snapshot.market.riskFreeRate?.state === 'fresh'
    && snapshot.market.equityRiskPremium?.state === 'fresh';
}

export function mergeCachedForwardEstimates(
  current: AnalystEstimate[],
  snapshot: ValuationInputLkgSnapshot,
  state: 'fresh' | 'stale',
): AnalystEstimate[] {
  const merged = new Map(current.map((estimate) => [estimate.periodEnd, { ...estimate }]));
  const apply = (
    item: CachedForwardMetric,
    metric: 'eps' | 'revenue',
  ) => {
    if (item.state !== state) return;
    const existing = merged.get(item.period) ?? {
      periodEnd: item.period,
      estimatedRevenue: null,
      estimatedEps: null,
      revenueAnalystCount: null,
      epsAnalystCount: null,
      provider: item.entry.source,
      asOf: item.entry.asOf,
      currency: 'USD',
      revenueProvenance: null,
      epsProvenance: null,
    };
    const currentValue = metric === 'eps'
      ? existing.estimatedEps : existing.estimatedRevenue;
    if (state === 'stale' && currentValue !== null && currentValue > 0) return;
    const provenance = cacheProvenance(
      item.entry,
      metric === 'eps' ? 'forwardEps' : 'forwardRevenue',
    );
    merged.set(item.period, {
      ...existing,
      estimatedEps: metric === 'eps' ? item.value : existing.estimatedEps,
      estimatedRevenue: metric === 'revenue' ? item.value : existing.estimatedRevenue,
      epsAnalystCount: metric === 'eps' ? item.analystCount : existing.epsAnalystCount,
      revenueAnalystCount: metric === 'revenue'
        ? item.analystCount : existing.revenueAnalystCount,
      epsProvenance: metric === 'eps' ? provenance : existing.epsProvenance,
      revenueProvenance: metric === 'revenue'
        ? provenance : existing.revenueProvenance,
      provider: item.entry.source,
      asOf: item.entry.asOf,
      currency: 'USD',
    });
  };
  snapshot.company.forwardEps.forEach((item) => apply(item, 'eps'));
  snapshot.company.forwardRevenue.forEach((item) => apply(item, 'revenue'));
  return [...merged.values()].toSorted((left, right) =>
    left.periodEnd.localeCompare(right.periodEnd));
}

export function mergeCachedPeers(
  current: PeerObservation[],
  snapshot: ValuationInputLkgSnapshot,
): {
  peers: PeerObservation[];
  candidates: string[];
  rejected: NonNullable<ValuationInput['peerAudit']>['rejected'];
  stale: boolean;
} {
  const selected = snapshot.peers
    .filter((set) => set.accepted.length >= 4)
    .toSorted((left, right) => {
      if (left.state !== right.state) return left.state === 'fresh' ? 1 : -1;
      return left.entry.asOf.localeCompare(right.entry.asOf);
    })
    .at(-1);
  if (!selected) return { peers: current, candidates: [], rejected: [], stale: false };
  const bySymbol = new Map(current.map((peer) => [peer.symbol.toUpperCase(), peer]));
  for (const peer of selected.observations) {
    bySymbol.set(peer.symbol.toUpperCase(), peer);
  }
  return {
    peers: [...bySymbol.values()],
    candidates: selected.candidates,
    rejected: selected.rejected,
    stale: selected.state === 'stale',
  };
}

export function applyCachedWaccInputs(
  current: WaccMarketInputs,
  snapshot: ValuationInputLkgSnapshot,
  phase: 'read-first' | 'stale-fallback',
): WaccMarketInputs {
  const allow = (value: CachedValuationScalar | null) =>
    value && (phase === 'read-first'
      ? value.state === 'fresh'
      : value.state === 'stale')
      ? value
      : null;
  const betaCandidate = allow(snapshot.company.beta);
  const riskFreeCandidate = allow(snapshot.market.riskFreeRate);
  const erpCandidate = allow(snapshot.market.equityRiskPremium);
  const beta = phase === 'stale-fallback' && current.beta
    ? null : betaCandidate;
  const riskFree = phase === 'stale-fallback' && current.riskFreeRate
    ? null : riskFreeCandidate;
  const erp = phase === 'stale-fallback' && current.equityRiskPremium
    ? null : erpCandidate;
  return {
    ...current,
    beta: beta ? beta.value : current.beta,
    betaAsOf: beta ? beta.entry.asOf : current.betaAsOf,
    betaProvenance: beta ? cacheProvenance(beta.entry, 'beta') : current.betaProvenance,
    riskFreeRate: riskFree ? riskFree.value : current.riskFreeRate,
    riskFreeAsOf: riskFree ? riskFree.entry.asOf : current.riskFreeAsOf,
    riskFreeRateProvenance: riskFree
      ? cacheProvenance(riskFree.entry, 'riskFreeRate')
      : current.riskFreeRateProvenance,
    equityRiskPremium: erp ? erp.value : current.equityRiskPremium,
    equityRiskPremiumAsOf: erp ? erp.entry.asOf : current.equityRiskPremiumAsOf,
    equityRiskPremiumProvenance: erp
      ? cacheProvenance(erp.entry, 'equityRiskPremium')
      : current.equityRiskPremiumProvenance,
    provider: [current.provider, beta?.entry.source, riskFree?.entry.source, erp?.entry.source]
      .filter(Boolean)
      .join('+'),
  };
}

function entryFreshness(
  metric: ValuationInputLkgMetric,
  asOf: string,
  now: number,
): 'fresh' | 'stale' | null {
  const state = datasetFreshness(freshnessDataset(metric), asOf, now);
  return state === 'fresh' || state === 'stale' ? state : null;
}

function originFromProvenance(
  provenance: MetricProvenance | null | undefined,
): ValuationInputLkgOrigin {
  if (provenance?.sourceType === 'derived') return 'derived';
  if (provenance?.sourceType === 'gemini-grounded') return 'gemini-grounded';
  return 'provider';
}

function scalarLkgEntry(
  symbol: string,
  metric: 'beta' | 'risk-free-rate' | 'equity-risk-premium',
  value: number | null,
  asOf: string | null,
  provenance: MetricProvenance | null | undefined,
  fallbackSource: string,
  calculatedAt: string,
): ValuationInputLkgEntry | null {
  if (value === null || !Number.isFinite(value) || value <= 0 || !asOf) return null;
  const freshness = entryFreshness(metric, asOf, Date.parse(calculatedAt));
  if (!freshness) return null;
  const market = metric !== 'beta';
  return {
    scope: market ? 'market' : 'company',
    ownerKey: market ? 'US' : symbol,
    metric,
    period: provenance?.fiscalPeriod ?? 'latest',
    data: { value },
    source: provenance?.provider ?? fallbackSource,
    origin: originFromProvenance(provenance),
    asOf,
    fetchedAt: calculatedAt,
    validatedAt: calculatedAt,
    freshness,
    schemaVersion: VALUATION_LKG_SCHEMA_VERSION,
    provenance: provenance ?? null,
  };
}

export function buildResolvedValuationLkgEntries(input: {
  symbol: string;
  waccMarketInputs: WaccMarketInputs;
  estimates: AnalystEstimate[];
  peers: PeerObservation[];
  peerAudit: ValuationInput['peerAudit'];
  calculatedAt: string;
}): ValuationInputLkgEntry[] {
  const symbol = input.symbol.trim().toUpperCase();
  const entries = [
    scalarLkgEntry(
      symbol,
      'beta',
      input.waccMarketInputs.beta,
      input.waccMarketInputs.betaAsOf,
      input.waccMarketInputs.betaProvenance,
      input.waccMarketInputs.provider,
      input.calculatedAt,
    ),
    scalarLkgEntry(
      symbol,
      'risk-free-rate',
      input.waccMarketInputs.riskFreeRate,
      input.waccMarketInputs.riskFreeAsOf,
      input.waccMarketInputs.riskFreeRateProvenance,
      input.waccMarketInputs.provider,
      input.calculatedAt,
    ),
    scalarLkgEntry(
      symbol,
      'equity-risk-premium',
      input.waccMarketInputs.equityRiskPremium,
      input.waccMarketInputs.equityRiskPremiumAsOf,
      input.waccMarketInputs.equityRiskPremiumProvenance,
      input.waccMarketInputs.provider,
      input.calculatedAt,
    ),
  ].filter((entry): entry is ValuationInputLkgEntry => Boolean(entry));

  for (const estimate of input.estimates) {
    for (const metric of ['forward-eps', 'forward-revenue'] as const) {
      const eps = metric === 'forward-eps';
      const value = eps ? estimate.estimatedEps : estimate.estimatedRevenue;
      if (value === null || !Number.isFinite(value) || value <= 0) continue;
      const provenance = eps ? estimate.epsProvenance : estimate.revenueProvenance;
      const freshness = entryFreshness(metric, estimate.asOf, Date.parse(input.calculatedAt));
      if (!freshness || (estimate.currency ?? 'USD') !== 'USD') continue;
      entries.push({
        scope: 'company',
        ownerKey: symbol,
        metric,
        period: estimate.periodEnd,
        data: {
          value,
          analystCount: eps ? estimate.epsAnalystCount : estimate.revenueAnalystCount,
          currency: 'USD',
        },
        source: provenance?.provider ?? estimate.provider,
        origin: originFromProvenance(provenance),
        asOf: estimate.asOf,
        fetchedAt: input.calculatedAt,
        validatedAt: input.calculatedAt,
        freshness,
        schemaVersion: VALUATION_LKG_SCHEMA_VERSION,
        provenance: provenance ?? null,
      });
    }
  }

  const accepted = input.peerAudit?.accepted ?? [];
  for (const metric of ['forward-pe', 'forward-ev-sales'] as const) {
    const byPeriod = new Map<string, typeof accepted>();
    for (const item of accepted.filter((acceptedItem) => acceptedItem.metric === metric)) {
      const items = byPeriod.get(item.period) ?? [];
      items.push(item);
      byPeriod.set(item.period, items);
    }
    for (const [period, acceptedForPeriod] of byPeriod) {
      const acceptedSymbols = new Set(acceptedForPeriod.map((item) => item.symbol));
      const observations = input.peers.filter((peer) =>
        acceptedSymbols.has(peer.symbol) && peer.estimatePeriod === period);
      if (observations.length < 4) continue;
      const asOf = acceptedForPeriod.map((item) => item.asOf).toSorted().at(-1)!;
      const lkgMetric = metric === 'forward-pe'
        ? 'peer-forward-pe' as const : 'peer-forward-ev-sales' as const;
      const freshness = entryFreshness(lkgMetric, asOf, Date.parse(input.calculatedAt));
      if (!freshness) continue;
      const source = acceptedForPeriod.at(0)?.source ?? observations[0]!.provider;
      entries.push({
        scope: 'peers',
        ownerKey: symbol,
        metric: lkgMetric,
        period,
        data: {
          metric,
          candidates: input.peerAudit?.candidates ?? observations.map((peer) => peer.symbol),
          accepted: [...acceptedSymbols],
          rejected: input.peerAudit?.rejected ?? [],
          observations,
        },
        source,
        origin: observations.some((peer) =>
          peer.candidateSource === 'gemini-grounded'
          || peer.estimateProvenance?.sourceType === 'gemini-grounded')
          ? 'gemini-grounded' : 'provider',
        asOf,
        fetchedAt: input.calculatedAt,
        validatedAt: input.calculatedAt,
        freshness,
        schemaVersion: VALUATION_LKG_SCHEMA_VERSION,
        provenance: null,
      });
    }
  }
  return entries;
}

export function excludeUnchangedLkgEntries(
  entries: ValuationInputLkgEntry[],
  snapshot: ValuationInputLkgSnapshot,
): ValuationInputLkgEntry[] {
  const existing = [
    snapshot.company.beta?.entry,
    snapshot.market.riskFreeRate?.entry,
    snapshot.market.equityRiskPremium?.entry,
    ...snapshot.company.forwardEps.map((item) => item.entry),
    ...snapshot.company.forwardRevenue.map((item) => item.entry),
    ...snapshot.peers.map((item) => item.entry),
  ].filter((entry): entry is ValuationInputLkgEntry => Boolean(entry));
  const keyed = new Map(existing.map((entry) => [
    `${entry.scope}:${entry.ownerKey}:${entry.metric}:${entry.period}`,
    entry,
  ]));
  return entries.filter((entry) => {
    const previous = keyed.get(
      `${entry.scope}:${entry.ownerKey}:${entry.metric}:${entry.period}`,
    );
    return !previous
      || previous.asOf !== entry.asOf
      || previous.source !== entry.source
      || JSON.stringify(previous.data) !== JSON.stringify(entry.data);
  });
}

export function valuationInputLkgDiagnostics(
  snapshot: ValuationInputLkgSnapshot,
): ValuationDiagnostic[] {
  const diagnostic = (
    field: string,
    value: number,
    period: string,
    item: CachedValuationScalar,
  ): ValuationDiagnostic => ({
    field: `cache:${field}`,
    value,
    period,
    provider: item.entry.source,
    asOf: item.entry.asOf,
    status: item.state === 'stale' ? 'stale' : 'available',
    provenance: item.entry.origin === 'gemini-grounded'
      ? 'gemini-grounded'
      : item.entry.origin,
    sourceType: item.entry.provenance?.sourceType,
    sourceUrl: item.entry.provenance?.sourceUrl,
    evidence: item.entry.provenance?.evidence,
    sourceState: item.state === 'stale' ? 'provider-stale' : 'provider-cached',
    reason: item.state === 'stale'
      ? 'persistent-lkg-stale-within-policy'
      : 'persistent-lkg-fresh',
  });
  const diagnostics: ValuationDiagnostic[] = [];
  if (snapshot.company.beta) {
    diagnostics.push(diagnostic(
      'beta',
      snapshot.company.beta.value,
      snapshot.company.beta.entry.period,
      snapshot.company.beta,
    ));
  }
  if (snapshot.market.riskFreeRate) {
    diagnostics.push(diagnostic(
      'riskFreeRate',
      snapshot.market.riskFreeRate.value,
      snapshot.market.riskFreeRate.entry.period,
      snapshot.market.riskFreeRate,
    ));
  }
  if (snapshot.market.equityRiskPremium) {
    diagnostics.push(diagnostic(
      'equityRiskPremium',
      snapshot.market.equityRiskPremium.value,
      snapshot.market.equityRiskPremium.entry.period,
      snapshot.market.equityRiskPremium,
    ));
  }
  diagnostics.push(
    ...snapshot.company.forwardEps.map((item) =>
      diagnostic('forwardEps', item.value, item.period, item)),
    ...snapshot.company.forwardRevenue.map((item) =>
      diagnostic('forwardRevenue', item.value, item.period, item)),
    ...snapshot.peers.map((set): ValuationDiagnostic => ({
      field: `cache:peers:${set.metric}`,
      value: set.accepted.length,
      period: set.entry.period,
      provider: set.entry.source,
      asOf: set.entry.asOf,
      status: set.state === 'stale' ? 'stale' : 'available',
      provenance: set.entry.origin === 'gemini-grounded'
        ? 'gemini-grounded'
        : set.entry.origin,
      sourceState: set.state === 'stale' ? 'provider-stale' : 'provider-cached',
      reason: set.state === 'stale'
        ? 'persistent-lkg-stale-within-policy'
        : 'persistent-lkg-fresh',
    })),
  );
  return diagnostics;
}
