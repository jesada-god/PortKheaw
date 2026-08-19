import 'server-only';

import { computeOptionsSupportResistance, type OptionsSrResult } from '@/src/lib/analytics/options-sr';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { calculateAtmIv } from '@/src/lib/market-data/options/analytics';
import { assembleOptionsSignalInput, atmStraddleExpectedMove, chainDte } from './assemble';
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

/**
 * The three numbers a horizon chain contributes. Nothing else survives the fetch.
 *
 * It was two — the straddle and its DTE — until the implied volatility followed
 * the expected move onto the same expiration. It comes off the chain that is
 * already in hand at that moment, so it is the one number here that costs
 * nothing at all: no second request, no third, no new cache.
 */
interface HorizonChainReading {
  /** ATM straddle price: the expected move to THIS expiration. */
  move: number | null;
  dte: number | null;
  /** Robust median near-ATM implied volatility, as a decimal. */
  iv: number | null;
  /**
   * When this chain was captured — kept because the reading is cached for
   * fifteen minutes and the card prints a fetch time under the IV. Stamping it
   * with the front chain's timestamp would advertise a freshness the number does
   * not have.
   */
  asOf: string | null;
}

/**
 * The expected move, cached per symbol, ON ITS OWN.
 *
 * Reading it at the recommended 45-day horizon rather than off the front chain
 * is what stopped "this level is further than the option can reach" firing on 24
 * of 30 tickers — but it cost a SECOND full options snapshot on every card, on
 * top of the front chain the card actually displays. The shared options cache
 * holds a chain fresh for 60 seconds, so every card opened more than a minute
 * apart paid that second fetch again.
 *
 * Three numbers survive that fetch: the ATM straddle price, the DTE it was read
 * at, and the ATM implied volatility of the same chain. They are what is cached
 * here, keyed by symbol, so the fetch happens once per window instead of once
 * per reader.
 *
 * FIFTEEN MINUTES, not hours. A 45-day straddle is genuinely slow — it reprices
 * with the underlying, not with the tick — and it is used here as a coarse
 * yardstick ("is this level one expected move away, or four"), not as a quote.
 * But it is still a price, and a price cached for an afternoon would be a
 * different statement from the one the card implies. Fifteen minutes is inside
 * the engine's own `staleMixHours` and well inside the resolution of the
 * comparison it feeds.
 */
const HORIZON_CHAIN_CACHE_POLICY = {
  freshMs: 15 * 60_000,
  staleMs: 2 * 60 * 60_000,
  errorMs: 60_000,
} as const;

const horizonChainCache = new SharedRequestCache();

async function loadNearestChain(
  symbol: string,
): Promise<{ chain: OptionsChain; result: OptionsSrResult; horizon: HorizonChainReading | null } | null> {
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
     * recommends, read for the two numbers that have to be quoted on a horizon.
     *
     * Liquidity and positioning stay on the front chain, and that is not a
     * compromise: they are facts ABOUT the book a reader is looking at. The
     * expected move and the implied volatility are not facts about a book, they
     * are COMPARISONS — the move against confirmed daily support and resistance,
     * the volatility against realized volatility and against the 30-60 day
     * contract this card recommends — and a comparison is worth nothing unless
     * both of its sides are on one horizon. Reading the move at the front
     * expiration made "further than this option can reach" fire on 24 of 30
     * tickers; at the recommended horizon, 3.
     */
    const horizonDays = OPTIONS_SIGNAL_CONFIG.expectedMove.horizonDays;
    const horizonExpiration = future.length
      ? future.reduce((best, value) => (
        Math.abs(daysBetween(today, value) - horizonDays) < Math.abs(daysBetween(today, best) - horizonDays) ? value : best
      ), future[0])
      : null;

    const chainResult = await service.getChain(symbol, nearest);
    const chain = chainResult.data;
    /*
     * Failing to resolve it costs the two comparisons, never the card: the
     * risk/reward factor already reports its distances in ATR and in percent
     * without an expected move, and the pricing factor falls back to the front
     * chain's own implied volatility. `null` here means "use the front chain",
     * which is what the assembler falls back to — and the DTE it publishes then
     * says so on the card rather than leaving the horizon unstated.
     *
     * Keyed on the EXPIRATION as well as the symbol, so the day the horizon
     * rolls to the next monthly the cache does not serve yesterday's contract
     * under today's DTE.
     */
    const horizon = horizonExpiration === null || horizonExpiration === nearest
      ? null
      : await horizonChainCache.resolve<HorizonChainReading>(
        `options-horizon-chain:${symbol.toUpperCase()}:${horizonExpiration}`,
        async () => {
          const horizonChain = (await service.getChain(symbol, horizonExpiration)).data;
          const atm = calculateAtmIv(horizonChain);
          return {
            move: atmStraddleExpectedMove(horizonChain),
            dte: chainDte(horizonChain),
            iv: atm.status === 'available' ? atm.iv : null,
            asOf: horizonChain.asOf,
          };
        },
        HORIZON_CHAIN_CACHE_POLICY,
      ).then((resolution) => resolution.value).catch(() => null);

    return {
      chain,
      horizon,
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
    expectedMove: options?.horizon ? { move: options.horizon.move, dte: options.horizon.dte } : null,
    /*
     * The same chain, the same fetch, the same fifteen-minute window. Read here
     * rather than off the front expiration because the pricing verdict is a
     * COMPARISON — against realized volatility, and against the 30-60 day
     * contract the setup section recommends — and a two-day contract carrying an
     * earnings report whole is not on either of those horizons.
     */
    horizonIv: options?.horizon
      ? { iv: options.horizon.iv, dte: options.horizon.dte, asOf: options.horizon.asOf }
      : null,
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
