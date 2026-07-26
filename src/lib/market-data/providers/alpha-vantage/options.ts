import 'server-only';
import { z, ZodError } from 'zod';
import { MarketDataError } from '../../errors';
import { ProviderHttpClient } from '../../provider-http';
import type { NormalizedOptionContracts } from '../../options/contracts';
import { normalizeOptionContracts } from '../../options/normalize';

const BASE_URL = 'https://www.alphavantage.co/query';
const scalar = z.union([z.string(), z.number()]).nullable().optional();
const alphaVantageOptionRowSchema = z.object({
  contractID: z.string(),
  symbol: z.string(),
  expiration: z.string(),
  strike: scalar,
  type: z.enum(['call', 'put']),
  last: scalar,
  mark: scalar,
  bid: scalar,
  ask: scalar,
  volume: scalar,
  open_interest: scalar,
  date: z.string().optional(),
  implied_volatility: scalar,
  delta: scalar,
  gamma: scalar,
  theta: scalar,
  vega: scalar,
  rho: scalar,
});
const alphaVantageOptionsResponseSchema = z.object({
  endpoint: z.string().optional(),
  data: z.array(alphaVantageOptionRowSchema),
});

export interface OptionsContractsProvider {
  readonly id: string;
  getOptionsContracts(symbol: string, expiration?: string): Promise<NormalizedOptionContracts>;
  /**
   * Optional market-data enrichment for ONE expiration, keyed by exact contract
   * symbol. A provider whose catalogue already carries quotes and Greeks omits
   * this; a catalogue-only provider implements it so bid/ask/volume/IV/Greeks
   * can be merged on. Enrichment must never fail the chain — an implementation
   * reports its problems through `warnings` and returns whatever it did get.
   */
  getMarketSnapshots?(symbol: string, expiration: string): Promise<OptionsMarketSnapshotBundle>;
}

/** Provider-agnostic view of an options market-data snapshot batch. */
export interface OptionsMarketSnapshotBundle {
  snapshots: ReadonlyMap<string, {
    bid: number | null;
    ask: number | null;
    last: number | null;
    volume: number | null;
    impliedVolatility: number | null;
    delta: number | null;
    gamma: number | null;
    theta: number | null;
    vega: number | null;
    rho: number | null;
    observedAt: string | null;
  }>;
  provider: string;
  feed: string;
  asOf: string;
  warnings: string[];
}

export class AlphaVantageOptionsProvider implements OptionsContractsProvider {
  readonly id = 'alpha-vantage';

  constructor(
    private readonly apiKey: string,
    private readonly http = new ProviderHttpClient(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getOptionsContracts(symbol: string, expiration?: string): Promise<NormalizedOptionContracts> {
    const url = new URL(BASE_URL);
    url.searchParams.set('function', 'REALTIME_OPTIONS');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('require_greeks', 'true');
    if (expiration) url.searchParams.set('expiration', expiration);
    url.searchParams.set('apikey', this.apiKey);

    const payload = await this.http.json({
      provider: this.id,
      operation: expiration ? 'options-chain' : 'options-expirations',
      route: expiration ? '/api/market/options/chain' : '/api/market/options/expirations',
      symbol,
      url,
      init: { cache: 'no-store' },
      timeoutMs: 10_000,
      // A 429 is negatively cached by OptionsMarketDataService and the browser
      // coordinators. Retrying it inside this single route invocation multiplies
      // one UI request into an upstream burst, so Options gets one bounded attempt.
      maxAttempts: 1,
    });
    try {
      const response = alphaVantageOptionsResponseSchema.parse(payload);
      const asOf = this.now().toISOString();
      const normalized = normalizeOptionContracts(
        response.data.map((row) => ({
          contractSymbol: row.contractID,
          underlyingSymbol: row.symbol,
          type: row.type,
          expiration: row.expiration,
          strike: row.strike,
          bid: row.bid,
          ask: row.ask,
          last: row.last,
          mark: row.mark,
          volume: row.volume,
          openInterest: row.open_interest,
          impliedVolatility: row.implied_volatility,
          delta: row.delta,
          gamma: row.gamma,
          theta: row.theta,
          vega: row.vega,
          rho: row.rho,
          asOf,
        })),
        {
          provider: this.id,
          asOf,
          // REALTIME_OPTIONS does not supply a trustworthy exchange/provider
          // quote timestamp, so `asOf` is precisely our receipt clock.
          timestampKind: 'receipt',
          // The response does not carry an exchange timestamp that proves a
          // realtime snapshot. Treat receipt-time data conservatively as
          // delayed instead of presenting an unverifiable realtime claim.
          status: 'delayed',
          delayedMinutes: null,
          ivUnit: 'decimal',
          defaultMultiplier: 100,
          defaultCurrency: 'USD',
          expiration,
        },
      );
      if (!normalized.contracts.length) {
        throw new MarketDataError('insufficient-data', `No valid options contracts were returned for ${symbol}`);
      }
      return normalized;
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) {
        throw new MarketDataError('invalid-provider-response', 'Options provider response did not match its validated schema');
      }
      throw cause;
    }
  }
}
