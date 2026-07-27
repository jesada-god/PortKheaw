export type {
  AggregateValue,
  ConnectionStatus,
  LiveCandle,
  MarketDataLabel,
  MarketDataMode,
  MarketPriceSource,
  MarketSessionKind,
  MarketSource,
  MarketSourceTransport,
  MarketUpdate,
  MarketUpdateListener,
  PollingCadence,
  SnapshotValue,
  TransportFreshness,
  TransportOutcome,
  WebSocketMarketSource,
} from './types';
export { buildLabel, buildRealtimeLabel, modeFromFreshness, unavailableLabel } from './labels';
export { WebSocketMarketSourceImpl, type WebSocketMarketSourceOptions } from './websocket-source';
export { CoordinatedMarketSource, createMarketSource, type CoordinatedMarketSourceOptions } from './coordinator';
export {
  acquireMarketConnection,
  GRACE_MS,
  __resetMarketConnectionsForTest,
  __activeMarketConnectionsForTest,
  type AcquireMarketConnectionParams,
  type MarketConnectionHandle,
  type ManagedMarketSource,
} from './market-connection-manager';
export {
  browserSocketFactory,
  type RealtimeSocket,
  type RealtimeSocketFactory,
} from './realtime-socket';
export { mergeCandle, newestBar } from './candle-merge';
export {
  validateLiveCandle,
  isTradeablePrice,
  DEFAULT_FUTURE_TOLERANCE_SECONDS,
  type CandleRejectionReason,
  type CandleValidation,
  type CandleValidationPolicy,
} from './candle-validation';
export { PollingMarketSource, type PollingMarketSourceOptions } from './polling-source';
export { createBrowserMarketTransport } from './browser-transport';
export {
  resolveAcceptedPrice,
  resolveAcceptedPriceDomains,
  historyFallbackModeFromStatus,
  type AcceptedPriceCandidate,
  type AcceptedPriceDomains,
} from './accepted-price';
export {
  buildAcceptedResource,
  candidateFromUpdate,
  freshnessFromMode,
  labelFromAccepted,
  AGGREGATE_FALLBACK_LABEL,
  HISTORY_FALLBACK_LABEL,
} from './accepted-quote';
export {
  resolveMarketSourceConfig,
  selectionKeyOf,
  isIntradayLiveSelection,
  isLiveIntradayInterval,
  isHistoryOnlyInterval,
  LIVE_INTRADAY_INTERVALS,
  HISTORY_ONLY_INTERVALS,
  type MarketSelection,
  type MarketSourceConfig,
  type MarketSourceMode,
  type IntervalProvenance,
} from './config';
