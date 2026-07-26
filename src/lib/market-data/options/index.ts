import 'server-only';
import { serverEnv } from '@/src/config/env/server';
import { MarketDataError } from '../errors';
import { AlphaVantageProvider } from '../providers/alpha-vantage/provider';
import { AlphaVantageOptionsProvider, type OptionsContractsProvider } from '../providers/alpha-vantage/options';
import { AlpacaOptionsProvider } from '../providers/alpaca/options';
import { OptionsMarketDataService } from './service';

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
    service = new OptionsMarketDataService(providers, new AlphaVantageProvider(current.alphaVantage));
  }
  return service;
}
