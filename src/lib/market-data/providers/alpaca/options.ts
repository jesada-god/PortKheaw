import 'server-only';
import { z, ZodError } from 'zod';
import { MarketDataError } from '../../errors';
import { ProviderHttpClient } from '../../provider-http';
import type { NormalizedOptionContracts } from '../../options/contracts';
import { normalizeOptionContracts } from '../../options/normalize';
import type { OptionsContractsProvider } from '../alpha-vantage/options';

/**
 * Alpaca options contracts adapter.
 *
 * Why this provider exists: a capability probe of every provider configured for
 * Nexora found that Alpaca is the only one whose current plan actually returns
 * real options data. Alpha Vantage's REALTIME_OPTIONS answers HTTP 200 with an
 * explicitly ARTIFICIAL sample payload behind a premium gate, Polygon's options
 * snapshot is 403 "not entitled", Finnhub's option-chain is 403, and FMP's
 * options endpoints are 403 legacy / 404.
 *
 * What this endpoint does and does not carry, verified against live responses:
 *   - open interest  : REAL (`open_interest`, dated by `open_interest_date`)
 *   - strike / type / expiration / multiplier : REAL
 *   - last           : previous close (`close_price`, dated by `close_price_date`)
 *   - bid / ask / volume / IV / Greeks : NOT PROVIDED — normalized to null.
 *
 * Greeks and implied volatility are never synthesised here. The canonical
 * contract keeps them null so the UI renders "—" instead of a fabricated number.
 * Open interest is an end-of-day settlement figure, so the snapshot is reported
 * as `delayed` and the OI as-of date is surfaced as a warning.
 */

const DEFAULT_TRADING_BASE_URL = 'https://paper-api.alpaca.markets';

/** Alpaca returns numerics as strings; `open_interest` is absent for contracts with no settled OI. */
const scalar = z.union([z.string(), z.number()]).nullable().optional();
const alpacaOptionContractSchema = z.object({
  symbol: z.string(),
  underlying_symbol: z.string(),
  type: z.enum(['call', 'put']),
  expiration_date: z.string(),
  strike_price: scalar,
  multiplier: scalar,
  open_interest: scalar,
  open_interest_date: z.string().nullable().optional(),
  close_price: scalar,
  close_price_date: z.string().nullable().optional(),
});
const alpacaOptionsResponseSchema = z.object({
  option_contracts: z.array(alpacaOptionContractSchema).nullable(),
  next_page_token: z.string().nullable().optional(),
});

/**
 * One request must be able to enumerate every expiration, so the page limit is
 * set to Alpaca's maximum. Verified live: AAPL returns all 24 expirations in a
 * single call with no continuation token when filtered to calls only.
 */
const MAX_PAGE_LIMIT = 10_000;

export interface AlpacaOptionsCredentials {
  keyId: string;
  secretKey: string;
  /** Alpaca serves options contracts from the Trading API; paper hosts the same catalogue. */
  baseUrl?: string;
}

export class AlpacaOptionsProvider implements OptionsContractsProvider {
  readonly id = 'alpaca';
  private readonly baseUrl: string;

  constructor(
    private readonly credentials: AlpacaOptionsCredentials,
    private readonly http = new ProviderHttpClient(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.baseUrl = (credentials.baseUrl?.trim() || DEFAULT_TRADING_BASE_URL).replace(/\/+$/, '');
  }

  private buildUrl(symbol: string, expiration: string | undefined, today: string): URL {
    const url = new URL(`${this.baseUrl}/v2/options/contracts`);
    url.searchParams.set('underlying_symbols', symbol.toUpperCase());
    url.searchParams.set('limit', String(MAX_PAGE_LIMIT));
    if (expiration) {
      url.searchParams.set('expiration_date', expiration);
    } else {
      // Expiration discovery only needs the distinct dates. Restricting to calls
      // halves the payload, which is what lets a single unpaginated request cover
      // the full expiration ladder including LEAPS.
      url.searchParams.set('type', 'call');
      url.searchParams.set('expiration_date_gte', today);
    }
    return url;
  }

  async getOptionsContracts(symbol: string, expiration?: string): Promise<NormalizedOptionContracts> {
    const today = this.now().toISOString().slice(0, 10);
    const payload = await this.http.json({
      provider: this.id,
      operation: expiration ? 'options-chain' : 'options-expirations',
      route: expiration ? '/api/market/options/chain' : '/api/market/options/expirations',
      symbol,
      url: this.buildUrl(symbol, expiration, today),
      init: {
        cache: 'no-store',
        headers: {
          'APCA-API-KEY-ID': this.credentials.keyId,
          'APCA-API-SECRET-KEY': this.credentials.secretKey,
        },
      },
      timeoutMs: 12_000,
      // Options gets exactly one bounded upstream attempt per route invocation.
      // Retrying here would multiply a single UI action into an upstream burst.
      maxAttempts: 1,
    });

    try {
      const response = alpacaOptionsResponseSchema.parse(payload);
      const rows = response.option_contracts ?? [];
      const asOf = this.now().toISOString();
      const openInterestDates = new Set<string>();

      const normalized = normalizeOptionContracts(
        rows.map((row) => {
          if (row.open_interest_date) openInterestDates.add(row.open_interest_date);
          return {
            contractSymbol: row.symbol,
            underlyingSymbol: row.underlying_symbol,
            type: row.type,
            expiration: row.expiration_date,
            strike: row.strike_price,
            // Alpaca's contracts catalogue carries no live quote, and none of these
            // may be inferred from the previous close.
            bid: null,
            ask: null,
            last: row.close_price,
            mark: null,
            volume: null,
            openInterest: row.open_interest,
            impliedVolatility: null,
            delta: null,
            gamma: null,
            theta: null,
            vega: null,
            rho: null,
            multiplier: row.multiplier,
            asOf,
          };
        }),
        {
          provider: this.id,
          asOf,
          // `asOf` is our receipt clock; Alpaca dates the data separately per field
          // (open_interest_date / close_price_date) rather than stamping the snapshot.
          timestampKind: 'receipt',
          // Open interest settles end-of-day, so this snapshot is never realtime.
          status: 'delayed',
          delayedMinutes: null,
          ivUnit: 'decimal',
          defaultMultiplier: 100,
          defaultCurrency: 'USD',
          expiration,
        },
      );

      if (!normalized.contracts.length) {
        throw new MarketDataError('not-found', `No options contracts were returned for ${symbol}`);
      }

      const warnings = [...normalized.warnings];
      const settledOn = [...openInterestDates].sort().at(-1);
      if (settledOn) warnings.push(`Open interest is end-of-day and settled on ${settledOn}`);
      warnings.push('Alpaca options contracts do not provide bid/ask, volume, implied volatility, or Greeks; those fields are reported as unavailable');
      // Expiration discovery is calls-only, so this snapshot holds one side of the
      // book and may only be used to list expirations — never served as a chain.
      return { ...normalized, warnings, partial: !expiration };
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) {
        throw new MarketDataError('invalid-provider-response', 'Options provider response did not match its validated schema');
      }
      throw cause;
    }
  }
}
