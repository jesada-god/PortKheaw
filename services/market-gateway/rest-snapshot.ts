import {
  normalizeAlpacaMessage,
  normalizedTradeSchema,
  classifyUsEquityTimestamp,
  type MarketSnapshot,
  type NormalizedBar,
  type NormalizedQuote,
  type NormalizedTrade,
} from '@/src/lib/market-data/realtime';
import type { AlpacaFeed } from '@/src/lib/market-data/realtime';

/**
 * Server-side Alpaca Market Data REST bootstrap for the initial snapshot.
 *
 * When a symbol is subscribed that no client was streaming yet, the Gateway
 * fetches its latest eligible trade, latest top-of-book quote and a short run of
 * recent 1-minute bars from Alpaca's REST API — the SAME entitlement the live
 * stream uses — and hands the browser a snapshot immediately, instead of leaving
 * the header on a REST/previous-close fallback until the next trade prints.
 *
 * The Alpaca credentials live ONLY on the Gateway host (Railway); they are read
 * from the same config as the upstream socket and never cross to a client. Wire
 * messages are shaped into Alpaca's `T`-discriminated form and run through the
 * shared {@link normalizeAlpacaMessage}, so REST and stream data normalize
 * through exactly one code path (non-positive prices / bad timestamps rejected
 * identically). A failure on any leg degrades to a partial (or null) snapshot —
 * the caller then simply serves what the live stream produces.
 */

const DEFAULT_BASE_URL = 'https://data.alpaca.markets';
const DEFAULT_BAR_LIMIT = 30;
const DEFAULT_TIMEOUT_MS = 4_000;

export interface AlpacaRestConfig {
  keyId: string;
  secretKey: string;
  feed: AlpacaFeed;
  baseUrl?: string;
  barLimit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface FinnhubRestConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface FinnhubQuoteResponse {
  c?: number;
  t?: number;
  error?: string;
}

/**
 * Bootstrap a cold Finnhub symbol from the provider's real `/quote` response.
 * Finnhub does not expose recent 1m bars on this endpoint, so bars/book remain
 * absent instead of being invented; Polygon history is loaded independently by
 * Next.js. Size is zero because the endpoint supplies no executed-trade size.
 */
export async function fetchFinnhubRestSnapshot(
  symbol: string,
  config: FinnhubRestConfig,
): Promise<MarketSnapshot | null> {
  const upper = symbol.trim().toUpperCase();
  const base = config.baseUrl ?? 'https://finnhub.io/api/v1';
  const url = new URL(`${base}/quote`);
  url.searchParams.set('symbol', upper);
  url.searchParams.set('token', config.apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await (config.fetchImpl ?? fetch)(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json() as FinnhubQuoteResponse;
    if (typeof body.error === 'string') return null;
    const timestampMs = typeof body.t === 'number' ? body.t * 1_000 : Number.NaN;
    const parsed = normalizedTradeSchema.safeParse({
      kind: 'trade',
      symbol: upper,
      price: body.c,
      size: 0,
      timestampMs,
      provider: 'finnhub',
      tradeId: `${upper}:rest:${timestampMs}:${body.c}`,
      session: classifyUsEquityTimestamp(timestampMs),
    });
    if (!parsed.success) return null;
    return {
      symbol: upper,
      trade: parsed.data,
      quote: null,
      bars: [],
      origin: 'rest',
      asOfMs: (config.now ?? Date.now)(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

interface LatestTradeResponse {
  symbol?: string;
  trade?: { t?: string; p?: number; s?: number; c?: string[]; z?: string };
}

interface LatestQuoteResponse {
  symbol?: string;
  quote?: { t?: string; bp?: number; bs?: number; ap?: number; as?: number };
}

interface BarsResponse {
  symbol?: string;
  bars?: Array<{ t?: string; o?: number; h?: number; l?: number; c?: number; v?: number }>;
}

/**
 * Fetch the current market snapshot for `symbol` from Alpaca REST. Returns null
 * only when every leg fails AND no data at all could be assembled; a partial
 * result (e.g. bars but no fresh trade) is still returned so the client gets
 * whatever real data exists.
 */
export async function fetchRestSnapshot(
  symbol: string,
  config: AlpacaRestConfig,
): Promise<MarketSnapshot | null> {
  // The `/v2/test` sandbox (FAKEPACA) is a WebSocket-only synthetic feed with no
  // REST market data — there is nothing to bootstrap, so skip it entirely.
  if (config.feed === 'test') return null;

  const upper = symbol.toUpperCase();
  const [trade, quote, bars] = await Promise.all([
    fetchLatestTrade(upper, config),
    fetchLatestQuote(upper, config),
    fetchRecentBars(upper, config),
  ]);

  if (!trade && !quote && bars.length === 0) return null;
  return {
    symbol: upper,
    trade,
    quote,
    bars,
    origin: 'rest',
    asOfMs: (config.now ?? Date.now)(),
  };
}

async function fetchLatestTrade(symbol: string, config: AlpacaRestConfig): Promise<NormalizedTrade | null> {
  const body = await getJson<LatestTradeResponse>(`/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`, config);
  const raw = body?.trade;
  if (!raw || raw.t === undefined) return null;
  const event = normalizeAlpacaMessage({ T: 't', S: symbol, p: raw.p, s: raw.s, t: raw.t, c: raw.c, z: raw.z });
  return event?.kind === 'trade' ? event : null;
}

async function fetchLatestQuote(symbol: string, config: AlpacaRestConfig): Promise<NormalizedQuote | null> {
  const body = await getJson<LatestQuoteResponse>(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`, config);
  const raw = body?.quote;
  if (!raw || raw.t === undefined) return null;
  const event = normalizeAlpacaMessage({ T: 'q', S: symbol, bp: raw.bp, bs: raw.bs, ap: raw.ap, as: raw.as, t: raw.t });
  return event?.kind === 'quote' ? event : null;
}

async function fetchRecentBars(symbol: string, config: AlpacaRestConfig): Promise<NormalizedBar[]> {
  const limit = config.barLimit ?? DEFAULT_BAR_LIMIT;
  const body = await getJson<BarsResponse>(
    `/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Min&limit=${limit}&sort=desc`,
    config,
  );
  const rows = body?.bars;
  if (!Array.isArray(rows)) return [];
  const bars: NormalizedBar[] = [];
  for (const row of rows) {
    if (row.t === undefined) continue;
    const event = normalizeAlpacaMessage({ T: 'b', S: symbol, o: row.o, h: row.h, l: row.l, c: row.c, v: row.v, t: row.t });
    if (event?.kind === 'bar') bars.push(event);
  }
  // Alpaca returns newest-first for sort=desc; the store and snapshot expect
  // ascending canonical minutes.
  return bars.sort((a, b) => a.timestampMs - b.timestampMs);
}

async function getJson<T>(path: string, config: AlpacaRestConfig): Promise<T | null> {
  const base = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${sep}feed=${config.feed}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'APCA-API-KEY-ID': config.keyId,
        'APCA-API-SECRET-KEY': config.secretKey,
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // Network error, timeout, or non-JSON body: treat this leg as absent.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
