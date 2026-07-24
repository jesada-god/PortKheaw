import type { MarketUpdate } from '@/src/lib/stock-detail/market-source';

/**
 * Keeps high-frequency Alpaca trade ticks outside React's render loop.
 *
 * The first priced live event is committed so provenance/badges become visible.
 * After that, only snapshots and official bars update React state; individual
 * trades go to the imperative header sink and quotes/statuses update only their
 * dedicated metadata path.
 */
export function realtimeUpdatePolicy(
  update: Pick<MarketUpdate, 'eventKind' | 'label' | 'price'>,
  hasCommittedLivePrice: boolean,
): { transientPrice: boolean; commitMarketState: boolean } {
  if (update.label.realtime !== true) {
    return { transientPrice: false, commitMarketState: true };
  }

  const transientPrice = update.eventKind === 'trade'
    && update.price !== null
    && Number.isFinite(update.price);
  const firstPricedLiveEvent = !hasCommittedLivePrice
    && update.price !== null
    && Number.isFinite(update.price);
  const commitMarketState = firstPricedLiveEvent
    || update.eventKind === 'snapshot'
    || update.eventKind === 'bar'
    // Older/injected sources may not yet provide an event kind.
    || update.eventKind === undefined;

  return { transientPrice, commitMarketState };
}
