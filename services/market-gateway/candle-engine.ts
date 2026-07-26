import {
  LiveBucketStore,
  type NormalizedBar,
  type NormalizedTrade,
  type RealtimeCandle,
} from '@/src/lib/market-data/realtime';

export interface CandleEngineResult {
  accepted: boolean;
  bars: NormalizedBar[];
  droppedDuplicate: boolean;
  droppedOutOfOrder: boolean;
}

export interface CandleEngineStats {
  accepted: number;
  droppedDuplicate: number;
  droppedOutOfOrder: number;
}

interface SymbolEngineState {
  store: LiveBucketStore;
  seen: Set<string>;
  seenOrder: string[];
  stats: CandleEngineStats;
}

const MAX_SEEN_PER_SYMBOL = 20_000;

/**
 * Gateway-owned canonical 1m candle engine. It is the only place that adds trade
 * volume; reconnect duplicates are rejected before both price fan-out and OHLCV.
 */
export class MarketCandleEngine {
  private readonly symbols = new Map<string, SymbolEngineState>();

  ingest(trade: NormalizedTrade): CandleEngineResult {
    const state = this.stateFor(trade.symbol);
    const id = trade.tradeId ?? `${trade.symbol}:${trade.timestampMs}:${trade.price}:${trade.size}:${trade.conditions?.join(',') ?? ''}`;
    if (state.seen.has(id)) {
      state.stats.droppedDuplicate += 1;
      return { accepted: false, bars: [], droppedDuplicate: true, droppedOutOfOrder: false };
    }
    this.remember(state, id);
    const previous = state.store.activeCandle('1m');
    const applied = state.store.applyTrade(trade);
    if (!applied.applied) {
      state.stats.droppedOutOfOrder += 1;
      return { accepted: false, bars: [], droppedDuplicate: false, droppedOutOfOrder: true };
    }
    const current = state.store.activeCandle('1m');
    const bars: NormalizedBar[] = [];
    if (applied.finalizedPrevious && previous) bars.push(this.toBar(trade, previous, true));
    if (current) bars.push(this.toBar(trade, current, false));
    state.stats.accepted += 1;
    return { accepted: true, bars, droppedDuplicate: false, droppedOutOfOrder: false };
  }

  statsFor(symbol: string): CandleEngineStats {
    const state = this.symbols.get(symbol.toUpperCase());
    return state ? { ...state.stats } : { accepted: 0, droppedDuplicate: 0, droppedOutOfOrder: 0 };
  }

  private toBar(trade: NormalizedTrade, candle: RealtimeCandle, finalized: boolean): NormalizedBar {
    return {
      kind: 'bar',
      symbol: trade.symbol,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      timestampMs: candle.time * 1_000,
      updated: !finalized,
      finalized,
      provider: trade.provider ?? 'finnhub',
      source: 'finnhub-trades',
      timeframe: '1m',
      session: trade.session,
      updatedAtMs: trade.timestampMs,
      gatewayReceivedAtMs: trade.gatewayReceivedAtMs,
    };
  }

  private stateFor(symbol: string): SymbolEngineState {
    const key = symbol.toUpperCase();
    let state = this.symbols.get(key);
    if (!state) {
      state = {
        store: new LiveBucketStore(), seen: new Set(), seenOrder: [],
        stats: { accepted: 0, droppedDuplicate: 0, droppedOutOfOrder: 0 },
      };
      this.symbols.set(key, state);
    }
    return state;
  }

  private remember(state: SymbolEngineState, id: string): void {
    state.seen.add(id);
    state.seenOrder.push(id);
    if (state.seenOrder.length <= MAX_SEEN_PER_SYMBOL) return;
    const oldest = state.seenOrder.shift();
    if (oldest) state.seen.delete(oldest);
  }
}
