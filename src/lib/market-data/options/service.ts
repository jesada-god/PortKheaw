import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { MarketDataError } from '../errors';
import type { MarketDataProvider, OptionsChain, OptionsExpirations, ProviderResult } from '../types';
import type { NormalizedOptionContracts } from './contracts';
import { optionsChainSchema, optionsExpirationsSchema } from './contracts';
import type { OptionsContractsProvider } from '../providers/alpha-vantage/options';

const OPTIONS_CACHE_POLICY = {
  freshMs: 60_000,
  staleMs: 15 * 60_000,
  errorMs: 30_000,
} as const;

function cacheStatus<T extends OptionsChain | OptionsExpirations>(
  value: T,
  state: 'fresh' | 'cache' | 'stale',
): T {
  if (state === 'fresh') return value;
  const status = state === 'stale' ? 'stale' : 'cached';
  if ('calls' in value) {
    return {
      ...value,
      status,
      calls: value.calls.map((contract) => ({ ...contract, status })),
      puts: value.puts.map((contract) => ({ ...contract, status })),
      warnings: [...value.warnings, state === 'stale' ? 'Serving stale options data after a provider failure' : 'Serving server-cached options data'],
    } as T;
  }
  return {
    ...value,
    status,
    warnings: [...value.warnings, state === 'stale' ? 'Serving stale expiration data after a provider failure' : 'Serving server-cached expiration data'],
  } as T;
}

function freshness(status: OptionsChain['status'], asOf: string) {
  return {
    status: status === 'live' ? 'realtime' as const : status,
    asOf,
    maxAgeSeconds: OPTIONS_CACHE_POLICY.freshMs / 1_000,
    staleWhileRevalidateSeconds: OPTIONS_CACHE_POLICY.staleMs / 1_000,
  };
}

function underlyingStatus(status: string): NonNullable<OptionsChain['underlyingStatus']> {
  if (status === 'realtime') return 'live';
  if (status === 'cached') return 'cached';
  if (status === 'stale') return 'stale';
  if (status === 'unavailable' || status === 'unknown') return 'unavailable';
  return 'delayed';
}

export class OptionsMarketDataService {
  private readonly providers: readonly OptionsContractsProvider[];
  private readonly providerBlockedUntil = new Map<string, number>();
  private readonly fullSnapshots = new Map<string, { snapshot: NormalizedOptionContracts; state: 'fresh' | 'cache' | 'stale'; freshUntil: number }>();

  constructor(
    provider: OptionsContractsProvider | readonly OptionsContractsProvider[],
    private readonly quoteProvider: Pick<MarketDataProvider, 'getQuote'>,
    private readonly cache = new SharedRequestCache(),
    private readonly now: () => number = Date.now,
  ) {
    this.providers = Array.isArray(provider) ? provider : [provider];
  }

  private async getSnapshot(symbol: string, expiration?: string): Promise<{ snapshot: NormalizedOptionContracts; state: 'fresh' | 'cache' | 'stale' }> {
    if (!this.providers.length) throw new MarketDataError('provider-not-configured', 'Options provider is not configured');
    const failures: MarketDataError[] = [];
    for (const provider of this.providers) {
      const blockedUntil = this.providerBlockedUntil.get(provider.id) ?? 0;
      if (this.now() < blockedUntil) {
        failures.push(new MarketDataError('rate-limited', `${provider.id} is in Retry-After cooldown`, Math.max(1, Math.ceil((blockedUntil - this.now()) / 1_000))));
        continue;
      }
      try {
        const resolution = await this.cache.resolve(
          `options:${provider.id}:${symbol}:${expiration ?? 'all'}`,
          () => provider.getOptionsContracts(symbol, expiration),
          OPTIONS_CACHE_POLICY,
        );
        return { snapshot: resolution.value, state: resolution.state };
      } catch (cause) {
        let failure = cause instanceof MarketDataError
          ? cause
          : new MarketDataError('provider-unavailable', 'Options provider failed');
        if (failure.code === 'rate-limited') {
          const retryAfterSeconds = failure.retryAfterSeconds ?? 60;
          this.providerBlockedUntil.set(provider.id, this.now() + retryAfterSeconds * 1_000);
          if (failure.retryAfterSeconds === undefined) {
            failure = new MarketDataError('rate-limited', failure.message, retryAfterSeconds);
          }
        }
        failures.push(failure);
      }
    }
    throw failures[0] ?? new MarketDataError('provider-unavailable', 'Options data is unavailable');
  }

  async getExpirations(symbol: string): Promise<ProviderResult<OptionsExpirations>> {
    const resolution = await this.getSnapshot(symbol);
    this.fullSnapshots.set(symbol.toUpperCase(), {
      snapshot: resolution.snapshot,
      state: resolution.state,
      freshUntil: this.now() + OPTIONS_CACHE_POLICY.freshMs,
    });
    const data = cacheStatus(optionsExpirationsSchema.parse({
      underlyingSymbol: resolution.snapshot.underlyingSymbol || symbol,
      expirations: resolution.snapshot.expirations,
      provider: resolution.snapshot.provider,
      asOf: resolution.snapshot.asOf,
      timestampKind: resolution.snapshot.timestampKind,
      status: resolution.snapshot.status,
      delayedMinutes: resolution.snapshot.delayedMinutes,
      warnings: resolution.snapshot.warnings,
    }), resolution.state);
    return { data, provider: data.provider, freshness: freshness(data.status, data.asOf) };
  }

  async getChain(symbol: string, expiration: string): Promise<ProviderResult<OptionsChain>> {
    const full = this.fullSnapshots.get(symbol.toUpperCase());
    const reusable = full && this.now() < full.freshUntil
      && full.snapshot.contracts.some((contract) => contract.expiration === expiration);
    // REALTIME_OPTIONS without an expiration already returned every validated
    // contract. Reusing that fresh snapshot avoids a second upstream provider
    // call while preserving the public flow (one expirations route, then one
    // selected-chain route) and truthfully marks the chain as cached.
    const resolution = reusable
      ? { snapshot: full.snapshot, state: full.state === 'stale' ? 'stale' as const : 'cache' as const }
      : await this.getSnapshot(symbol, expiration);
    const snapshot: NormalizedOptionContracts = resolution.snapshot;
    const contracts = snapshot.contracts.filter((contract) => contract.expiration === expiration);
    if (!contracts.length) {
      throw new MarketDataError('not-found', `No options chain was returned for ${symbol} on ${expiration}`);
    }
    const quote = await this.quoteProvider.getQuote(symbol);
    const spot = quote.data.price;
    if (!Number.isFinite(spot) || spot <= 0) {
      throw new MarketDataError('insufficient-data', 'A validated underlying spot price is required for the options chain');
    }
    const warnings = [...snapshot.warnings];
    if (quote.freshness.status !== 'realtime') {
      warnings.push('Underlying spot is not realtime; underlying and options freshness are reported separately');
    }
    const withMoneyness = contracts.map((contract) => ({
      ...contract,
      inTheMoney: contract.type === 'call' ? spot > contract.strike : spot < contract.strike,
      status: contract.status,
    }));
    const data = cacheStatus(optionsChainSchema.parse({
      underlyingSymbol: symbol,
      spot,
      expiration,
      expirations: snapshot.expirations,
      calls: withMoneyness.filter((contract) => contract.type === 'call'),
      puts: withMoneyness.filter((contract) => contract.type === 'put'),
      provider: snapshot.provider,
      asOf: snapshot.asOf,
      timestampKind: snapshot.timestampKind,
      status: snapshot.status,
      delayedMinutes: snapshot.delayedMinutes,
      completeness: snapshot.completeness,
      warnings,
      underlyingProvider: quote.provider,
      underlyingAsOf: quote.freshness.asOf,
      underlyingStatus: underlyingStatus(quote.freshness.status),
    }), resolution.state);
    return { data, provider: data.provider, freshness: freshness(data.status, data.asOf) };
  }
}
