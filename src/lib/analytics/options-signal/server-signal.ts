import 'server-only';

import { computeOptionsSupportResistance, type OptionsSrResult } from '@/src/lib/analytics/options-sr';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { assembleOptionsSignalInput } from './assemble';
import { calculateOptionsSignal } from './calculations';
import { loadOptionsSignalContext } from './service';
import { readOwnHistory, recordOptionsSignal } from './signal-history';
import { getOptionsSignalHistoryStore } from './signal-history-repository';
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

async function loadNearestChain(symbol: string): Promise<{ chain: OptionsChain; result: OptionsSrResult } | null> {
  try {
    const service = getOptionsMarketDataService();
    const expirations = await service.getExpirations(symbol);
    const today = new Date().toISOString().slice(0, 10);
    const nearest = [...new Set(expirations.data.expirations)]
      .filter((value) => value >= today)
      .sort()[0];
    if (!nearest) return null;

    const chainResult = await service.getChain(symbol, nearest);
    const chain = chainResult.data;
    return {
      chain,
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
  const [context, options, ownHistory] = await Promise.all([
    loadOptionsSignalContext(symbol),
    loadNearestChain(symbol),
    /*
     * Read BEFORE this computation, so today's reading never sits inside its own
     * percentile — and in parallel with the market data, because a percentile
     * lookup must never be the reason a card is slower to appear.
     */
    readOwnHistory(symbol, history),
  ]);

  const input = assembleOptionsSignalInput(context, {
    chain: options?.chain ?? null,
    optionsSr: options?.result ?? null,
    acceptedPrice: options?.chain.spot ?? null,
    // This symbol's own recorded readings are what make a raw IV or a raw
    // Put/Call comparable at all.
    ownHistory,
  });
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
