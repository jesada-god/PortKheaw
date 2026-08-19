import 'server-only';

import { computeOptionsSupportResistance, type OptionsSrResult } from '@/src/lib/analytics/options-sr';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { assembleOptionsSignalInput } from './assemble';
import { calculateOptionsSignal } from './calculations';
import { OPTIONS_SIGNAL_CONFIG } from './config';
import { loadOptionsSignalContext } from './service';
import { readOwnHistory, recordOptionsSignal } from './signal-history';
import { getOptionsSignalHistoryHealth, getOptionsSignalHistoryStore } from './signal-history-repository';
import type { OptionsSignalResult } from './types';

/**
 * Compute the Options Signal on the server.
 *
 * It used to be assembled in the browser, which meant every candle-derived
 * input — macro, trend, momentum, the confirmed levels, the earnings date — was
 * serialized into the page for anyone to read. Those inputs ARE the breakdown,
 * so the only way to sell the gauge separately from the breakdown is to compute
 * both here and serve whichever the reader's plan includes.
 *
 * Nothing about the calculation changed: the same pure engine reads the same
 * assembled input. The only substitution is the underlying price, which is now
 * the options provider's own spot for the resolved chain rather than the
 * browser's accepted price — both are real observed prices, and this one is the
 * price the chain itself was quoted against.
 */

export interface ServerOptionsSignal {
  result: OptionsSignalResult;
  /** The expiration the options-derived factors were read from, when one resolved. */
  expiration: string | null;
}

/** Calendar days between two `YYYY-MM-DD` dates. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

async function loadNearestChain(
  symbol: string,
): Promise<{ chain: OptionsChain; result: OptionsSrResult; expectedMoveChain: OptionsChain | null } | null> {
  try {
    const service = getOptionsMarketDataService();
    const expirations = await service.getExpirations(symbol);
    const today = new Date().toISOString().slice(0, 10);
    const future = [...new Set(expirations.data.expirations)]
      .filter((value) => value >= today)
      .sort();
    const nearest = future[0];
    if (!nearest) return null;

    /*
     * A SECOND expiration, near the horizon the card's own SETUP section
     * recommends, read only for the expected move.
     *
     * Every other options factor stays on the front chain: that is the book a
     * reader is looking at, and its liquidity, positioning and implied
     * volatility are facts about it. The expected move is different — it is the
     * yardstick the confirmed daily support and resistance are held against, and
     * a 0-DTE straddle is simply the wrong ruler for a swing level. Reading it
     * at the front expiration made the "further than this option can reach"
     * warning fire on 24 of 30 tickers; at the recommended horizon, 3.
     */
    const horizon = OPTIONS_SIGNAL_CONFIG.expectedMove.horizonDays;
    const expectedMoveExpiration = future.length
      ? future.reduce((best, value) => (
        Math.abs(daysBetween(today, value) - horizon) < Math.abs(daysBetween(today, best) - horizon) ? value : best
      ), future[0])
      : null;

    const chainResult = await service.getChain(symbol, nearest);
    const chain = chainResult.data;
    /*
     * Failing to resolve it costs the expected-move comparison, never the card:
     * the risk/reward factor already reports its distances in ATR and in percent
     * without one.
     */
    const expectedMoveChain = expectedMoveExpiration === null || expectedMoveExpiration === nearest
      ? null
      : (await service.getChain(symbol, expectedMoveExpiration).catch(() => null))?.data ?? null;

    return {
      chain,
      expectedMoveChain,
      result: computeOptionsSupportResistance({
        symbol: chain.underlyingSymbol,
        expiration: chain.expiration,
        acceptedPrice: chain.spot,
        calls: chain.calls,
        puts: chain.puts,
        provider: chain.provider,
        asOf: chain.asOf,
        status: chain.status,
      }),
    };
  } catch {
    // A missing chain reduces the signal's coverage; the engine reports the
    // affected factors as UNAVAILABLE rather than scoring them as zero.
    return null;
  }
}

export async function computeServerOptionsSignal(symbol: string): Promise<ServerOptionsSignal> {
  const history = getOptionsSignalHistoryStore();
  const [context, options, ownHistory, historyHealth] = await Promise.all([
    loadOptionsSignalContext(symbol),
    loadNearestChain(symbol),
    /*
     * Read BEFORE this computation, so today's reading never sits inside its own
     * percentile — and in parallel with the market data, because a percentile
     * lookup must never be the reason a card is slower to appear.
     */
    readOwnHistory(symbol, history),
    /*
     * Probed once per process, so this resolves instantly after the first
     * request. Without it an unreachable store is indistinguishable from a new
     * symbol, and the card would count down to a day that never arrives.
     */
    getOptionsSignalHistoryHealth(),
  ]);

  const input = assembleOptionsSignalInput(context, {
    chain: options?.chain ?? null,
    optionsSr: options?.result ?? null,
    acceptedPrice: options?.chain.spot ?? null,
    expectedMoveChain: options?.expectedMoveChain ?? null,
    // This symbol's own recorded readings are what make a raw IV or a raw
    // Put/Call comparable at all.
    ownHistory,
  });
  input.historyDegraded = !historyHealth.ok;
  const result = calculateOptionsSignal(input);
  /*
   * Fire-and-forget, and deliberately not awaited: the row is a disclosure
   * record, and a card that waited on a write to a table it does not read would
   * be slower for no benefit to the reader in front of it. `recordOptionsSignal`
   * never rejects, so there is nothing here for an unhandled rejection to catch.
   */
  void recordOptionsSignal(input, result, history);

  return { result, expiration: options?.chain.expiration ?? null };
}
