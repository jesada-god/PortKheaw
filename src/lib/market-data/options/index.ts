import 'server-only';
import { serverEnv } from '@/src/config/env/server';
import { MarketDataError } from '../errors';
import { getCandleMarketDataService } from '../candles';
import { getMarketDataProvider } from '../index';
import { AlphaVantageOptionsProvider, type OptionsContractsProvider } from '../providers/alpha-vantage/options';
import { AlpacaOptionsProvider } from '../providers/alpaca/options';
import { OptionsMarketDataService } from './service';
import type { ProviderResult, Quote } from '../types';

/**
 * Options provider precedence is capability-aware, not historical.
 *
 * Alpaca is primary because a live capability probe proved it is the only
 * configured provider whose plan actually returns real options data (real open
 * interest, strikes and expirations). Alpha Vantage is kept strictly as a
 * fallback: its REALTIME_OPTIONS endpoint currently answers with an explicitly
 * artificial sample payload behind a premium gate, so it can only contribute if
 * the account is upgraded — at which point it would also supply IV and Greeks.
 * The service's capability cache skips refused providers, so an un-upgraded
 * Alpha Vantage costs at most one request per capability window.
 */

export interface OptionsProviderCredentials {
  alphaVantage: string | undefined;
  alpacaKeyId: string | undefined;
  alpacaSecretKey: string | undefined;
  alpacaBaseUrl: string | undefined;
  /**
   * Entitled options market-data feed. A live probe showed `opra` answers 403
   * ("OPRA agreement is not signed") on this account while `indicative` answers
   * 200, so the default is the feed that actually works.
   */
  alpacaDataFeed: string | undefined;
}

let credentials: OptionsProviderCredentials | undefined;
let service: OptionsMarketDataService | undefined;

function currentCredentials(): OptionsProviderCredentials {
  return {
    alphaVantage: serverEnv.ALPHA_VANTAGE_API_KEY,
    alpacaKeyId: serverEnv.ALPACA_API_KEY_ID,
    alpacaSecretKey: serverEnv.ALPACA_API_SECRET_KEY,
    alpacaBaseUrl: serverEnv.ALPACA_TRADING_BASE_URL,
    alpacaDataFeed: serverEnv.ALPACA_OPTIONS_FEED,
  };
}

function sameCredentials(left: OptionsProviderCredentials | undefined, right: OptionsProviderCredentials): boolean {
  return left !== undefined
    && left.alphaVantage === right.alphaVantage
    && left.alpacaKeyId === right.alpacaKeyId
    && left.alpacaSecretKey === right.alpacaSecretKey
    && left.alpacaBaseUrl === right.alpacaBaseUrl
    && left.alpacaDataFeed === right.alpacaDataFeed;
}

/** Ordered options providers for the given credentials. Exported for capability probes/tests. */
export function buildOptionsProviders(current: OptionsProviderCredentials): OptionsContractsProvider[] {
  const providers: OptionsContractsProvider[] = [];
  if (current.alpacaKeyId && current.alpacaSecretKey) {
    providers.push(new AlpacaOptionsProvider({
      keyId: current.alpacaKeyId,
      secretKey: current.alpacaSecretKey,
      ...(current.alpacaBaseUrl ? { baseUrl: current.alpacaBaseUrl } : {}),
      ...(current.alpacaDataFeed ? { dataFeed: current.alpacaDataFeed } : {}),
    }));
  }
  if (current.alphaVantage) providers.push(new AlphaVantageOptionsProvider(current.alphaVantage));
  return providers;
}

export function getOptionsMarketDataService(): OptionsMarketDataService {
  const current = currentCredentials();
  // The underlying spot still comes from the Alpha Vantage quote provider, so an
  // options chain cannot be priced without it even when Alpaca supplies contracts.
  if (!current.alphaVantage) {
    throw new MarketDataError('provider-not-configured', 'Options provider is not configured');
  }
  const providers = buildOptionsProviders(current);
  if (!providers.length) {
    throw new MarketDataError('provider-not-configured', 'No options provider credentials are configured');
  }
  if (!service || !sameCredentials(credentials, current)) {
    credentials = current;
    /*
      The underlying spot comes from the SHARED, cached market-data provider —
      the same `quote:<symbol>` entry the rest of the app already populates —
      not from a bare Alpha Vantage client.

      A raw client here made one uncached upstream quote per chain request. That
      burned the daily Alpha Vantage allowance (starving the earnings calendar
      too) and, once the allowance was gone, every chain failed on the spot
      lookup — discarding a complete Alpaca chain that had answered HTTP 200 and
      erasing Put/Call and IV. The cached provider single-flights that quote and
      keeps a last-good value through a provider failure.
    */
    service = new OptionsMarketDataService(
      providers,
      getMarketDataProvider(),
      undefined,
      undefined,
      undefined,
      underlyingFromDailyClose,
    );
  }
  return service;
}

/**
 * Secondary underlying price: the last CONFIRMED daily close from the same
 * candle pipeline the chart already uses.
 *
 * Open interest settles end-of-day, so a chain priced against a confirmed close
 * is coherent with its own vintage. This runs only after the quote provider has
 * already failed, and returns null — never a guess — when no real close exists.
 */
async function underlyingFromDailyClose(symbol: string): Promise<ProviderResult<Quote> | null> {
  try {
    const result = await getCandleMarketDataService().getCandles({
      symbol, interval: '1D', range: '1m', adjusted: true, session: 'regular',
    });
    const finalized = result.data.candles.filter((candle) => candle.partial !== true);
    const latest = finalized.at(-1);
    if (!latest || !Number.isFinite(latest.close) || latest.close <= 0) return null;
    const asOf = new Date(latest.timestamp * 1_000).toISOString();
    const previousClose = finalized.at(-2)?.close ?? null;
    return {
      data: {
        symbol: symbol.toUpperCase(),
        price: latest.close,
        change: previousClose === null ? null : latest.close - previousClose,
        changePercent: previousClose ? ((latest.close - previousClose) / previousClose) * 100 : null,
        previousClose,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        volume: latest.volume,
        latestTradingDay: asOf.slice(0, 10),
        asOf,
        provider: result.provider ?? result.data.provider,
      } as Quote,
      provider: result.provider ?? result.data.provider,
      freshness: { status: 'end-of-day', asOf, maxAgeSeconds: null },
    };
  } catch {
    return null;
  }
}
