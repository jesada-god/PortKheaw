import 'server-only';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { serverEnv } from '@/src/config/env/server';
import { MarketDataError } from '../errors';
import { canonicalRegularTradingDateAt } from '../current-session';
import { gatewayBarsCacheKey } from './cache';
import { isCompatibleSelection } from './capabilities';
import type { MarketDataGateway, ResolvedInstrument } from './contracts';
import type { MarketDataProviderV2 } from './provider';
import { PolygonMarketDataProvider } from './polygon-provider';
import { SymbolResolver } from './symbol-resolver';

function assertInstrument(instrument: ResolvedInstrument): void {
  if (!instrument.active) throw new MarketDataError('invalid-symbol', instrument.unsupportedReason ?? 'Instrument is inactive');
  if (!instrument.supported) throw new MarketDataError('unsupported', instrument.unsupportedReason ?? 'Instrument is unsupported');
}

export class DefaultMarketDataGateway implements MarketDataGateway {
  constructor(
    private readonly resolver: SymbolResolver,
    private readonly provider: MarketDataProviderV2 | null,
    private readonly cache = new SharedRequestCache(),
  ) {}

  resolveInstrument(symbol: string) { return this.resolver.resolve(symbol); }
  resolveInstruments(symbols: readonly string[]) { return this.resolver.resolveMany(symbols); }

  private configuredProvider(): MarketDataProviderV2 {
    if (!this.provider) throw new MarketDataError('provider-not-configured', 'Set POLYGON_API_KEY and MARKET_DATA_PROVIDER=polygon to load production market data');
    return this.provider;
  }

  async getQuote({ instrument }: { instrument: ResolvedInstrument }) {
    const provider = this.configuredProvider();
    assertInstrument(instrument);
    const regularTradingDate = canonicalRegularTradingDateAt(new Date()) ?? 'unknown-date';
    const resolution = await this.cache.resolve(
      `market-gateway:${provider.id}:quote:${instrument.canonicalSymbol}:${instrument.providerSymbol}:${regularTradingDate}`,
      () => provider.getQuote(instrument),
      { freshMs: 15_000, staleMs: 5 * 60_000, errorMs: 30_000 },
    );
    return resolution.state === 'fresh' ? resolution.value
      : { ...resolution.value, status: resolution.state === 'stale' ? 'stale' as const : 'cached' as const };
  }

  async getSession({ instrument }: { instrument: ResolvedInstrument }) {
    const provider = this.configuredProvider();
    assertInstrument(instrument);
    const resolution = await this.cache.resolve(
      `market-gateway:${provider.id}:session:${instrument.mic ?? instrument.exchange ?? 'unknown'}`,
      () => provider.getSession(instrument),
      { freshMs: 30_000, staleMs: 5 * 60_000, errorMs: 30_000 },
    );
    return resolution.state === 'stale' ? { ...resolution.value, stale: true } : resolution.value;
  }

  async getBars(input: Parameters<MarketDataGateway['getBars']>[0]) {
    const provider = this.configuredProvider();
    assertInstrument(input.instrument);
    if (!isCompatibleSelection(input.interval, input.range)) {
      throw new MarketDataError('unsupported', `${input.interval} and ${input.range} are not a compatible chart selection`);
    }
    const key = gatewayBarsCacheKey({ provider: provider.id, ...input });
    const intraday = !['1D', 'Week', 'Month'].includes(input.interval);
    const resolution = await this.cache.resolve(
      key,
      () => provider.getBars(input),
      intraday
        ? { freshMs: 30_000, staleMs: 15 * 60_000, errorMs: 30_000 }
        : { freshMs: 6 * 60 * 60_000, staleMs: 7 * 24 * 60 * 60_000, errorMs: 30_000 },
    );
    if (resolution.state === 'fresh') return resolution.value;
    return {
      ...resolution.value,
      dataStatus: resolution.state === 'stale' ? 'stale' as const : 'cached' as const,
      warnings: [
        ...resolution.value.warnings,
        resolution.state === 'stale' ? 'Serving stale cached bars after a provider failure' : 'Serving cached bars',
      ],
    };
  }
}

let configurationKey = '';
let gateway: DefaultMarketDataGateway | null = null;

export function marketDataGatewayConfigured(): boolean {
  return Boolean(serverEnv.POLYGON_API_KEY) && (!serverEnv.MARKET_DATA_PROVIDER || serverEnv.MARKET_DATA_PROVIDER.toLowerCase() === 'polygon');
}

export function getMarketDataGateway(): DefaultMarketDataGateway {
  const key = `${serverEnv.MARKET_DATA_PROVIDER ?? 'polygon'}\u0000${serverEnv.POLYGON_API_KEY ?? ''}`;
  if (!gateway || configurationKey !== key) {
    configurationKey = key;
    const provider = marketDataGatewayConfigured() && serverEnv.POLYGON_API_KEY
      ? new PolygonMarketDataProvider(serverEnv.POLYGON_API_KEY)
      : null;
    gateway = new DefaultMarketDataGateway(new SymbolResolver(), provider);
  }
  return gateway;
}
