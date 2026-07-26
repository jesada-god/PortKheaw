import 'server-only';
import { z, ZodError } from 'zod';
import { MarketDataError } from '../../errors';
import { ProviderHttpClient } from '../../provider-http';

/**
 * Alpaca **Options Market Data** adapter — the quote/trade/Greeks half of the
 * options pipeline, deliberately separate from the Trading API contract
 * catalogue in `./options.ts`.
 *
 * Why this file exists: the catalogue endpoint (`/v2/options/contracts`) carries
 * identity, strike, expiration and settled open interest but NO market data, so
 * every price and Greek rendered as "—". A live probe of
 * `/v1beta1/options/snapshots/{underlying}` proved this endpoint answers 200 on
 * the configured plan and does carry them.
 *
 * Verified entitlement of the configured account (probe, 2026-07-26):
 *   - `feed=opra`       : HTTP 403 "OPRA agreement is not signed" — unavailable.
 *   - `feed=indicative` : HTTP 200. Carries `latestQuote` (bid/ask), `latestTrade`
 *     (last), `dailyBar` (volume) and, for contracts with a real two-sided
 *     market, `impliedVolatility` and `greeks` (delta/gamma/theta/vega/rho).
 *
 * So the snapshot is served as INDICATIVE and reported as delayed. Real-time is
 * never claimed. A contract Alpaca could not value keeps IV/Greeks null; nothing
 * is synthesised in this adapter.
 *
 * Request shape: one logical request per expiration. `expiration_date` narrows
 * the response to the selected chain and `limit=1000` (Alpaca's documented
 * maximum) covered every probed expiration in a single page with no continuation
 * token. Pagination is still honoured, but bounded by {@link MAX_PAGES} so a
 * pathological underlying can never turn one UI action into an unbounded burst.
 */

const DEFAULT_DATA_BASE_URL = 'https://data.alpaca.markets';

/** Alpaca's documented maximum page size for the options snapshot endpoint. */
const MAX_PAGE_LIMIT = 1_000;
/**
 * Hard ceiling on continuation follow-ups for ONE expiration. Every probed
 * expiration fit in a single page; this only bounds the tail case.
 */
const MAX_PAGES = 4;

const numeric = z.number().finite();

const quoteSchema = z.object({
  ap: numeric.optional(), // ask price
  as: numeric.optional(), // ask size
  bp: numeric.optional(), // bid price
  bs: numeric.optional(), // bid size
  t: z.string().optional(),
}).passthrough();

const tradeSchema = z.object({
  p: numeric.optional(),
  s: numeric.optional(),
  t: z.string().optional(),
}).passthrough();

const barSchema = z.object({
  c: numeric.optional(),
  v: numeric.optional(),
  t: z.string().optional(),
}).passthrough();

const greeksSchema = z.object({
  delta: numeric.optional(),
  gamma: numeric.optional(),
  theta: numeric.optional(),
  vega: numeric.optional(),
  rho: numeric.optional(),
}).passthrough();

const snapshotSchema = z.object({
  latestQuote: quoteSchema.optional(),
  latestTrade: tradeSchema.optional(),
  dailyBar: barSchema.optional(),
  minuteBar: barSchema.optional(),
  impliedVolatility: numeric.optional(),
  greeks: greeksSchema.optional(),
}).passthrough();

const snapshotsResponseSchema = z.object({
  snapshots: z.record(z.string(), snapshotSchema).nullable().optional(),
  next_page_token: z.string().nullable().optional(),
});

/** Market data for one contract, keyed by its exact OCC contract symbol. */
export interface OptionMarketSnapshot {
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
  /** Newest observation timestamp across the quote/trade legs of this snapshot. */
  observedAt: string | null;
}

export interface OptionsSnapshotResult {
  /** Keyed by exact contract symbol — never by array position. */
  snapshots: Map<string, OptionMarketSnapshot>;
  provider: string;
  feed: string;
  asOf: string;
  warnings: string[];
}

export interface AlpacaOptionsSnapshotCredentials {
  keyId: string;
  secretKey: string;
  /** Alpaca serves market data from a host distinct from the Trading API. */
  dataBaseUrl?: string;
  /** Entitled feed. Defaults to `indicative`, the only feed this plan may read. */
  feed?: string;
}

function positive(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function nonnegativeInteger(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function newestTimestamp(...values: (string | undefined)[]): string | null {
  let newest: number | null = null;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) continue;
    if (newest === null || parsed > newest) newest = parsed;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

export class AlpacaOptionsSnapshotProvider {
  readonly id = 'alpaca-options-data';
  private readonly baseUrl: string;
  readonly feed: string;

  constructor(
    private readonly credentials: AlpacaOptionsSnapshotCredentials,
    private readonly http = new ProviderHttpClient(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.baseUrl = (credentials.dataBaseUrl?.trim() || DEFAULT_DATA_BASE_URL).replace(/\/+$/, '');
    this.feed = credentials.feed?.trim() || 'indicative';
  }

  private buildUrl(symbol: string, expiration: string, pageToken: string | null): URL {
    const url = new URL(`${this.baseUrl}/v1beta1/options/snapshots/${encodeURIComponent(symbol.toUpperCase())}`);
    url.searchParams.set('feed', this.feed);
    url.searchParams.set('expiration_date', expiration);
    url.searchParams.set('limit', String(MAX_PAGE_LIMIT));
    if (pageToken) url.searchParams.set('page_token', pageToken);
    return url;
  }

  /**
   * One bounded market-data read for a single expiration.
   *
   * Never throws for a data-shaped problem: options market data is an
   * ENRICHMENT of a chain that is already valid without it, so an unentitled or
   * unavailable snapshot must degrade to "prices unavailable" rather than
   * destroy a working chain. Only the caller's own abort propagates.
   */
  async getSnapshots(symbol: string, expiration: string): Promise<OptionsSnapshotResult> {
    const warnings: string[] = [];
    const snapshots = new Map<string, OptionMarketSnapshot>();
    let pageToken: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      let payload: unknown;
      try {
        payload = await this.http.json({
          provider: this.id,
          operation: 'options-snapshots',
          route: '/api/market/options/chain',
          symbol,
          url: this.buildUrl(symbol, expiration, pageToken),
          init: {
            cache: 'no-store',
            headers: {
              'APCA-API-KEY-ID': this.credentials.keyId,
              'APCA-API-SECRET-KEY': this.credentials.secretKey,
            },
          },
          timeoutMs: 12_000,
          // Enrichment gets exactly one attempt per page: a retry here would
          // multiply a single UI action into an upstream burst.
          maxAttempts: 1,
        });
      } catch (cause) {
        warnings.push(cause instanceof MarketDataError && cause.code === 'forbidden'
          ? `Options market data is not entitled on the ${this.feed} feed; prices and Greeks are reported as unavailable`
          : 'Options market data was unavailable; prices and Greeks are reported as unavailable');
        break;
      }

      let parsed: z.infer<typeof snapshotsResponseSchema>;
      try {
        parsed = snapshotsResponseSchema.parse(payload);
      } catch (cause) {
        if (!(cause instanceof ZodError)) throw cause;
        warnings.push('Options market-data response did not match its validated schema; prices and Greeks are reported as unavailable');
        break;
      }

      for (const [contractSymbol, snapshot] of Object.entries(parsed.snapshots ?? {})) {
        const bid = positive(snapshot.latestQuote?.bp);
        const ask = positive(snapshot.latestQuote?.ap);
        snapshots.set(contractSymbol, {
          // A crossed book is a corrupt observation, not a tighter one.
          bid: bid !== null && ask !== null && bid > ask ? null : bid,
          ask: bid !== null && ask !== null && bid > ask ? null : ask,
          last: positive(snapshot.latestTrade?.p),
          volume: nonnegativeInteger(snapshot.dailyBar?.v),
          impliedVolatility: positive(snapshot.impliedVolatility),
          delta: finiteOrNull(snapshot.greeks?.delta),
          gamma: finiteOrNull(snapshot.greeks?.gamma),
          theta: finiteOrNull(snapshot.greeks?.theta),
          vega: finiteOrNull(snapshot.greeks?.vega),
          rho: finiteOrNull(snapshot.greeks?.rho),
          observedAt: newestTimestamp(snapshot.latestQuote?.t, snapshot.latestTrade?.t),
        });
      }

      pageToken = parsed.next_page_token ?? null;
      if (!pageToken) break;
      if (page === MAX_PAGES - 1) {
        warnings.push('Options market data was truncated at the bounded page limit; some contracts show unavailable prices');
      }
    }

    return {
      snapshots,
      provider: this.id,
      feed: this.feed,
      asOf: this.now().toISOString(),
      warnings,
    };
  }
}
