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
  rejectionReason: 'duplicate' | 'out-of-order' | null;
}

export interface CandleEngineStats {
  receivedTrades: number;
  acceptedTrades: number;
  duplicateDropped: number;
  outOfOrderDropped: number;
  staleDropped: number;
  invalidDropped: number;
}

export type ExternalTradeRejectionReason = 'stale' | 'invalid';

const EMPTY_STATS: CandleEngineStats = {
  receivedTrades: 0,
  acceptedTrades: 0,
  duplicateDropped: 0,
  outOfOrderDropped: 0,
  staleDropped: 0,
  invalidDropped: 0,
};

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
    state.stats.receivedTrades += 1;
    const id = trade.tradeId ?? `${trade.symbol}:${trade.timestampMs}:${trade.price}:${trade.size}:${trade.conditions?.join(',') ?? ''}`;
    if (state.seen.has(id)) {
      state.stats.duplicateDropped += 1;
      return { accepted: false, bars: [], droppedDuplicate: true, droppedOutOfOrder: false, rejectionReason: 'duplicate' };
    }
    this.remember(state, id);
    const previous = state.store.activeCandle('1m');
    const applied = state.store.applyTrade(trade);
    if (!applied.applied) {
      state.stats.outOfOrderDropped += 1;
      return { accepted: false, bars: [], droppedDuplicate: false, droppedOutOfOrder: true, rejectionReason: 'out-of-order' };
    }
    const current = state.store.activeCandle('1m');
    const bars: NormalizedBar[] = [];
    if (applied.finalizedPrevious && previous) bars.push(this.toBar(trade, previous, true));
    if (current) bars.push(this.toBar(trade, current, false));
    state.stats.acceptedTrades += 1;
    return { accepted: true, bars, droppedDuplicate: false, droppedOutOfOrder: false, rejectionReason: null };
  }

  recordRejected(symbol: string, reason: ExternalTradeRejectionReason): CandleEngineStats {
    const state = this.stateFor(symbol);
    state.stats.receivedTrades += 1;
    if (reason === 'stale') state.stats.staleDropped += 1;
    else state.stats.invalidDropped += 1;
    return { ...state.stats };
  }

  statsFor(symbol: string): CandleEngineStats {
    const state = this.symbols.get(symbol.toUpperCase());
    return state ? { ...state.stats } : { ...EMPTY_STATS };
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
        stats: { ...EMPTY_STATS },
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
