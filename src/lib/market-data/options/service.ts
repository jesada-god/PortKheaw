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
  constructor(
    private readonly provider: OptionsContractsProvider,
    private readonly quoteProvider: Pick<MarketDataProvider, 'getQuote'>,
    private readonly cache = new SharedRequestCache(),
  ) {}

  async getExpirations(symbol: string): Promise<ProviderResult<OptionsExpirations>> {
    const resolution = await this.cache.resolve(
      `options:${this.provider.id}:${symbol}:all`,
      () => this.provider.getOptionsContracts(symbol),
      OPTIONS_CACHE_POLICY,
    );
    const data = cacheStatus(optionsExpirationsSchema.parse({
      underlyingSymbol: resolution.value.underlyingSymbol || symbol,
      expirations: resolution.value.expirations,
      provider: resolution.value.provider,
      asOf: resolution.value.asOf,
      timestampKind: resolution.value.timestampKind,
      status: resolution.value.status,
      delayedMinutes: resolution.value.delayedMinutes,
      warnings: resolution.value.warnings,
    }), resolution.state);
    return { data, provider: data.provider, freshness: freshness(data.status, data.asOf) };
  }

  async getChain(symbol: string, expiration: string): Promise<ProviderResult<OptionsChain>> {
    const resolution = await this.cache.resolve(
      `options:${this.provider.id}:${symbol}:${expiration}`,
      () => this.provider.getOptionsContracts(symbol, expiration),
      OPTIONS_CACHE_POLICY,
    );
    const snapshot: NormalizedOptionContracts = resolution.value;
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
