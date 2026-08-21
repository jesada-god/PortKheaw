import 'server-only';

import { MARKET_SIGNAL_HISTORY } from '@/src/config/signal';
import {
  signalActionableEnabled,
  signalGateEnabled,
  signalHistoryEnabled,
  signalZonesEnabled,
} from '@/src/config/signal-flags';
import { loadEarningsSchedule } from '@/src/lib/analytics/earnings/service';
import { getCandleMarketDataService } from '@/src/lib/market-data/candles';
import type { DataFreshness } from '@/src/lib/market-data/types';
import { calculateMarketSignal } from './calculations';
import { snapshotOf, summariseHistory } from './history';
import { readSignalHistory, writeSignalSnapshot } from './history-repository';
import type { MarketSignalCandle, MarketSignalEarningsContext, MarketSignalResult } from './types';

const unavailableFreshness: DataFreshness = {
  status: 'unavailable',
  asOf: null,
  maxAgeSeconds: null,
};

/**
 * Days to the next scheduled report, or nothing at all.
 *
 * Every failure mode here — no provider key, no scheduled report, a rate limit,
 * an outage — resolves to `null`, which makes the engine skip its earnings rules
 * entirely rather than assume the print is far away. The call is made ONLY when
 * the gate is on, so a deployment with the flag off issues exactly the provider
 * requests it issued before P1.
 */
async function loadEarningsContext(symbol: string): Promise<MarketSignalEarningsContext | undefined> {
  if (!signalGateEnabled()) return undefined;
  try {
    const schedule = await loadEarningsSchedule(symbol);
    return { daysToNextReport: schedule.status === 'available' ? schedule.daysToEarnings : null };
  } catch {
    return { daysToNextReport: null };
  }
}

/**
 * Record today's reading and hand back the strip, or change nothing at all.
 *
 * Reads the stored days, then writes today's, then folds today in locally
 * rather than reading it back. Today has to be IN the strip — it is the newest
 * thing the card has said, and a strip ending yesterday would show every label
 * change one day late for anyone who looked before the close — but a second
 * round trip to fetch a row we just wrote would buy nothing.
 *
 * `recent_flip` is appended to the flags here rather than produced by the
 * engine, because the engine is a pure function of the candles in front of it
 * and has no memory. It is the only member of `MarketSignalFlag` that arrives
 * this way, and the type says so.
 */
async function withHistory(result: MarketSignalResult): Promise<MarketSignalResult> {
  if (!signalHistoryEnabled()) return result;
  if (result.status !== 'available') return result;
  try {
    return await attachHistory(result);
  } catch {
    /*
     * Its own boundary, not the caller's.
     *
     * `loadMarketSignal`'s outer catch answers "the provider failed" with an
     * insufficient-data card, which is the right answer to that question and
     * the wrong answer to this one: a strip that could not load must cost the
     * strip, not the reading. Without this, a throw anywhere below would blank
     * a card that had already been computed correctly.
     */
    return result;
  }
}

async function attachHistory(result: MarketSignalResult): Promise<MarketSignalResult> {
  const entries = await readSignalHistory(result.symbol, MARKET_SIGNAL_HISTORY.stripDays);

  const features = {
    gate: signalGateEnabled(),
    zones: signalZonesEnabled(),
    actionable: signalActionableEnabled(),
  };
  const snapshot = snapshotOf(result, features);
  if (snapshot) await writeSignalSnapshot(snapshot);

  const history = summariseHistory(
    snapshot ? [...entries.filter((entry) => entry.asOf !== snapshot.asOf), {
      asOf: snapshot.asOf,
      state: snapshot.state,
      rawState: snapshot.rawState,
      bias: snapshot.bias,
      zone: snapshot.zone,
      score: snapshot.score,
      evidenceAgreement: snapshot.evidenceAgreement,
      flags: snapshot.flags,
    }] : entries,
    {
      windowDays: MARKET_SIGNAL_HISTORY.stripDays,
      recentFlipDays: MARKET_SIGNAL_HISTORY.recentFlipDays,
    },
  );
  if (!history) return result;

  return {
    ...result,
    flags: history.recentFlip && !result.flags.includes('recent_flip')
      ? [...result.flags, 'recent_flip']
      : result.flags,
    history,
  };
}

export async function loadMarketSignal(
  symbol: string,
  options: { now?: () => Date } = {},
): Promise<MarketSignalResult> {
  const calculatedAt = (options.now ?? (() => new Date()))().toISOString();
  const features = { gate: signalGateEnabled(), zones: signalZonesEnabled(), actionable: signalActionableEnabled() };
  try {
    // One canonical 1D dataset supplies the signal. The candle service owns its
    // 6h/7d cache and in-flight dedupe, so opening tabs/dialogs or receiving a
    // WebSocket tick never triggers another provider request or recalculation.
    const result = await getCandleMarketDataService().getCandles({
      symbol,
      interval: '1D',
      range: '5y',
      adjusted: true,
      session: 'regular',
    });
    const candles: MarketSignalCandle[] = result.data.candles.map((candle) => ({
      date: new Date(candle.timestamp * 1_000).toISOString().slice(0, 10),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: Math.round(candle.volume),
      finalized: candle.partial !== true,
    }));
    return await withHistory(calculateMarketSignal(candles, {
      symbol,
      source: result.provider ?? result.data.provider,
      freshness: result.freshness,
      calculatedAt,
      features,
      earnings: await loadEarningsContext(symbol),
    }));
  } catch {
    return calculateMarketSignal([], {
      symbol,
      source: null,
      freshness: unavailableFreshness,
      calculatedAt,
      features,
    });
  }
}
