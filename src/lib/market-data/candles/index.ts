import 'server-only';
import { YahooCandleProvider } from '../providers/yahoo/candles';
import { CandleMarketDataService } from './service';

let service: CandleMarketDataService | undefined;

export function getCandleMarketDataService(): CandleMarketDataService {
  // Stock-detail charts intentionally use one deterministic Yahoo Chart JSON
  // pipeline. A failed Yahoo request surfaces as unavailable; it is never mixed
  // with or silently replaced by another provider's candle series.
  service ??= new CandleMarketDataService([new YahooCandleProvider()]);
  return service;
}

export type {
  CandleDataStatus,
  CandleInterval,
  CandleRange,
  CandleRequest,
  CandleSession,
  NormalizedCandle,
  NormalizedCandleResult,
  NormalizedMarketDataProvider,
  ProviderCapabilities,
  TimeframeCapability,
} from './contracts';
