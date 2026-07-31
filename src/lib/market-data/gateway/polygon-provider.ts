import 'server-only';
import { z, ZodError } from 'zod';
import { MarketDataError, mapProviderFailure } from '../errors';
import { candleRangeBounds } from '../candles/range';
import { normalizedBarSchema, normalizedBarsResultSchema, normalizedMarketSessionSchema, normalizedQuoteSchema } from './contracts';
import type { CandleInterval, HistoricalRange, MarketDataStatus, MarketSessionMode, NormalizedBar, ResolvedInstrument } from './contracts';
import { polygonAggregateResolution } from './capabilities';
import { bucketOverlapsRegularSession } from '../session';
import type { MarketDataProviderV2 } from './provider';

const BASE_URL = 'https://api.polygon.io';
const TIMEOUT_MS = 10_000;
const MAX_BARS = 50_000;

const aggregateSchema = z.object({
  status: z.string().optional(),
  ticker: z.string().optional(),
  resultsCount: z.number().int().nonnegative().optional(),
  results: z.array(z.object({
    t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number(),
    n: z.number().int().nonnegative().optional(), vw: z.number().optional(),
  }).passthrough()).optional(),
  error: z.string().optional(),
}).passthrough();

const snapshotSchema = z.object({
  status: z.string().optional(),
  ticker: z.object({
    ticker: z.string(),
    updated: z.number().optional(),
    todaysChange: z.number().optional(),
    todaysChangePerc: z.number().optional(),
    day: z.object({ o: z.number().optional(), h: z.number().optional(), l: z.number().optional(), c: z.number().optional(), v: z.number().optional() }).passthrough().optional(),
    prevDay: z.object({ c: z.number().optional() }).passthrough().optional(),
    lastTrade: z.object({ p: z.number().optional(), t: z.number().optional() }).passthrough().optional(),
    min: z.object({ c: z.number().optional(), t: z.number().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  error: z.string().optional(),
}).passthrough();

const previousCloseSchema = z.object({
  status: z.string().optional(),
  ticker: z.string().optional(),
  resultsCount: z.number().int().nonnegative().optional(),
  results: z.array(z.object({
    T: z.string().optional(),
    o: z.number().optional(), h: z.number().optional(), l: z.number().optional(), c: z.number().optional(),
    v: z.number().optional(), t: z.number().optional(),
  }).passthrough()).optional(),
  error: z.string().optional(),
}).passthrough();

const marketStatusSchema = z.object({
  market: z.string().optional(),
  serverTime: z.string().optional(),
  earlyHours: z.boolean().optional(),
  afterHours: z.boolean().optional(),
  exchanges: z.record(z.string(), z.string()).optional(),
}).passthrough();

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1_000)) : undefined;
}

function epochSeconds(value: number | undefined): number | null {
  if (!value || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1e17) return Math.floor(value / 1e9);
  if (value >= 1e12) return Math.floor(value / 1e3);
  return Math.floor(value);
}

function localDate(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp * 1_000));
}

function localMinutes(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp * 1_000));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function dataRecency(timestamp: number, nowSeconds: number, daily: boolean): { status: MarketDataStatus; delayedByMinutes: number | null } {
  const delaySeconds = Math.max(0, nowSeconds - timestamp);
  const delayedByMinutes = Math.floor(delaySeconds / 60);
  if (daily) return { status: 'end-of-day', delayedByMinutes };
  if (delaySeconds <= 120) return { status: 'real-time', delayedByMinutes: 0 };
  if (delaySeconds <= 36 * 60 * 60) return { status: 'delayed', delayedByMinutes };
  return { status: 'stale', delayedByMinutes };
}

function responseTicker(expected: string, actual: string | undefined): void {
  if (!actual || actual.toUpperCase() !== expected.toUpperCase()) {
    throw new MarketDataError('invalid-provider-response', 'Polygon response ticker did not match the resolved provider symbol');
  }
}

function dateBounds(range: HistoricalRange, now: Date): { from: string; to: string } {
  const bounds = candleRangeBounds(range, now);
  const fromDate = new Date(bounds.period1 * 1_000);
  if (range === '1d') fromDate.setUTCDate(fromDate.getUTCDate() - 4);
  return {
    from: fromDate.toISOString().slice(0, 10),
    to: new Date(bounds.period2 * 1_000).toISOString().slice(0, 10),
  };
}

export class PolygonMarketDataProvider implements MarketDataProviderV2 {
  readonly id = 'polygon';
  private snapshotCapability: 'unknown' | 'available' | 'forbidden' = 'unknown';
  private previousCloseCapability: 'unknown' | 'available' | 'forbidden' = 'unknown';

  constructor(
    private readonly apiKey: string,
    private readonly now: () => Date = () => new Date(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, BASE_URL);
    Object.entries({ ...query, apiKey: this.apiKey }).forEach(([key, value]) => url.searchParams.set(key, value));
    let lastFailure: MarketDataError | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        lastFailure = mapProviderFailure({ cause });
        if (attempt === 2 || lastFailure.code !== 'upstream-unavailable') throw lastFailure;
        continue;
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch (cause) { throw mapProviderFailure({ status: response.status, cause }); }
      if (response.ok) return payload;
      const failure = mapProviderFailure({
        status: response.status,
        payload,
        retryAfterSeconds: retryAfterSeconds(response),
      });
      if (response.status < 500 || attempt === 2) throw failure;
      lastFailure = failure;
    }
    throw lastFailure ?? new MarketDataError('upstream-unavailable', 'Polygon request failed');
  }

  async getQuote(instrument: ResolvedInstrument) {
    let snapshotFailure: unknown;
    try {
      if (this.snapshotCapability === 'forbidden') {
        throw new MarketDataError('forbidden', 'Polygon snapshot entitlement is unavailable');
      }
      const quote = await this.snapshotQuote(instrument);
      this.snapshotCapability = 'available';
      return quote;
    } catch (cause) {
      snapshotFailure = cause;
      if (cause instanceof MarketDataError && cause.code === 'forbidden') {
        this.snapshotCapability = 'forbidden';
      }
      // The real-time/snapshot endpoint is a premium Polygon entitlement. When the
      // configured plan is not authorized (403 → forbidden) or the symbol simply has
      // no snapshot, fall back to the free previous-close aggregate — a truthful
      // end-of-day quote — instead of surfacing a bare 403. Real-time is never
      // fabricated; a genuine unavailability still throws the typed error below.
      if (cause instanceof MarketDataError && (cause.code === 'forbidden' || cause.code === 'not-found')) {
        try {
          if (this.previousCloseCapability === 'forbidden') {
            throw new MarketDataError('forbidden', 'Polygon previous-close entitlement is unavailable');
          }
          const quote = await this.previousCloseQuote(instrument);
          this.previousCloseCapability = 'available';
          return quote;
        } catch (fallbackCause) {
          if (fallbackCause instanceof MarketDataError && fallbackCause.code === 'forbidden') {
            this.previousCloseCapability = 'forbidden';
          }
          // Neither endpoint is entitled/available: surface the primary snapshot
          // error so the typed reason stays truthful about the root cause.
          throw fallbackCause instanceof MarketDataError && fallbackCause.code === 'invalid-symbol'
            ? fallbackCause
            : snapshotFailure;
        }
      }
      throw cause;
    }
  }

  private async snapshotQuote(instrument: ResolvedInstrument) {
    try {
      const payload = snapshotSchema.parse(await this.request(
        `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(instrument.providerSymbol)}`,
      ));
      const ticker = payload.ticker;
      if (!ticker) throw new MarketDataError('not-found', `No Polygon quote was returned for ${instrument.canonicalSymbol}`);
      responseTicker(instrument.providerSymbol, ticker.ticker);
      const price = ticker.lastTrade?.p ?? ticker.min?.c ?? ticker.day?.c;
      const timestamp = epochSeconds(ticker.lastTrade?.t ?? ticker.min?.t ?? ticker.updated);
      if (!Number.isFinite(price) || !timestamp) throw new MarketDataError('insufficient-data', 'Polygon quote did not include a valid price and timestamp');
      const previousClose = Number.isFinite(ticker.prevDay?.c) ? ticker.prevDay?.c ?? null : null;
      const regularClose = Number.isFinite(ticker.day?.c) && (ticker.day?.c ?? 0) > 0
        ? ticker.day?.c ?? null
        : null;
      const change = Number.isFinite(ticker.todaysChange)
        ? ticker.todaysChange ?? null
        : previousClose == null ? null : price! - previousClose;
      const changePercent = Number.isFinite(ticker.todaysChangePerc)
        ? ticker.todaysChangePerc ?? null
        : previousClose ? ((price! - previousClose) / previousClose) * 100 : null;
      const recency = dataRecency(timestamp, Math.floor(this.now().valueOf() / 1_000), false);
      return normalizedQuoteSchema.parse({
        symbol: instrument.canonicalSymbol,
        price,
        previousClose,
        regularClose,
        change,
        changePercent,
        timestamp,
        provider: this.id,
        exchange: instrument.exchange,
        currency: instrument.currency,
        status: recency.status,
        delayedByMinutes: recency.delayedByMinutes,
        open: ticker.day?.o ?? null,
        high: ticker.day?.h ?? null,
        low: ticker.day?.l ?? null,
        volume: ticker.day?.v ?? null,
      });
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) throw new MarketDataError('invalid-provider-response', 'Polygon quote response did not match its validated schema');
      throw cause;
    }
  }

  /**
   * Free-tier previous-close aggregate fallback for the premium snapshot quote.
   * Returns a truthful end-of-day quote (the latest completed trading day's OHLCV).
   *
   * The daily change is derived ONLY from two real daily closes — the displayed
   * session's close and the immediately-preceding session's close (see
   * {@link priorDailyClose}). It is never inferred from this bar's own open/high/low,
   * and when a genuine prior close cannot be found the change fields stay null
   * rather than being fabricated.
   */
  private async previousCloseQuote(instrument: ResolvedInstrument) {
    try {
      const payload = previousCloseSchema.parse(await this.request(
        `/v2/aggs/ticker/${encodeURIComponent(instrument.providerSymbol)}/prev`,
        { adjusted: 'true' },
      ));
      responseTicker(instrument.providerSymbol, payload.ticker);
      const result = payload.results?.[0];
      const close = result?.c;
      const timestamp = epochSeconds(result?.t);
      if (!result || !Number.isFinite(close) || !timestamp) {
        throw new MarketDataError('not-found', `No Polygon previous-close aggregate was returned for ${instrument.canonicalSymbol}`);
      }
      if (result.T && result.T.toUpperCase() !== instrument.providerSymbol.toUpperCase()) {
        throw new MarketDataError('invalid-provider-response', 'Polygon previous-close ticker did not match the resolved provider symbol');
      }
      // Two real daily closes → a truthful daily change for this end-of-day quote.
      // The prior close is the newest daily bar strictly before this session; when
      // none exists (single available close) it stays null and change is hidden.
      const previousClose = await this.priorDailyClose(instrument, timestamp);
      const change = previousClose == null ? null : close! - previousClose;
      const changePercent = previousClose ? ((close! - previousClose) / previousClose) * 100 : null;
      const recency = dataRecency(timestamp, Math.floor(this.now().valueOf() / 1_000), true);
      return normalizedQuoteSchema.parse({
        symbol: instrument.canonicalSymbol,
        price: close,
        previousClose,
        regularClose: close,
        change,
        changePercent,
        timestamp,
        provider: this.id,
        exchange: instrument.exchange,
        currency: instrument.currency,
        status: recency.status,
        delayedByMinutes: recency.delayedByMinutes,
        open: result.o ?? null,
        high: result.h ?? null,
        low: result.l ?? null,
        volume: result.v ?? null,
      });
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) throw new MarketDataError('invalid-provider-response', 'Polygon previous-close response did not match its validated schema');
      throw cause;
    }
  }

  /**
   * The close of the daily session immediately BEFORE the displayed session, from
   * the free daily-aggregates endpoint. Returns null (never a guessed value) when
   * the request fails or there is no earlier session, so the fallback change is
   * only ever computed from two genuine daily closes. A best-effort enrichment: a
   * failure here degrades to "no change", it never fails the quote.
   *
   * Sessions are matched by their exchange-local calendar DATE, not by raw
   * timestamp: Polygon dates the `/prev` bar at the session close (e.g. 20:00Z)
   * but the daily-aggregates bar at the session start (e.g. 04:00Z), so a naive
   * numeric comparison would treat the SAME session as "earlier" and report a zero
   * change. The prior close is the newest daily bar whose local date is strictly
   * before the displayed session's local date.
   */
  private async priorDailyClose(instrument: ResolvedInstrument, latestSeconds: number): Promise<number | null> {
    const tz = instrument.timezone;
    const latestDate = localDate(latestSeconds, tz);
    // ~3 calendar weeks guarantees at least one earlier trading session across
    // weekends/holidays; `to` is the displayed session's date, so a still-forming
    // current-day bar can never be mistaken for the prior close.
    const to = latestDate;
    const from = localDate(latestSeconds - 21 * 24 * 60 * 60, tz);
    try {
      const payload = aggregateSchema.parse(await this.request(
        `/v2/aggs/ticker/${encodeURIComponent(instrument.providerSymbol)}/range/1/day/${from}/${to}`,
        { adjusted: 'true', sort: 'asc', limit: '60' },
      ));
      if (payload.ticker && payload.ticker.toUpperCase() !== instrument.providerSymbol.toUpperCase()) return null;
      let prior: number | null = null;
      for (const bar of payload.results ?? []) {
        const time = epochSeconds(bar.t);
        if (time == null || !Number.isFinite(bar.c)) continue;
        // Strictly-earlier local session only; take the newest such close (asc).
        if (localDate(time, tz) < latestDate) prior = bar.c;
      }
      return prior;
    } catch {
      return null;
    }
  }

  async getBars(input: { instrument: ResolvedInstrument; interval: CandleInterval; range: HistoricalRange; adjusted: boolean; session: MarketSessionMode }) {
    const resolution = polygonAggregateResolution(input.interval);
    const bounds = dateBounds(input.range, this.now());
    try {
      const payload = aggregateSchema.parse(await this.request(
        `/v2/aggs/ticker/${encodeURIComponent(input.instrument.providerSymbol)}/range/${resolution.multiplier}/${resolution.timespan}/${bounds.from}/${bounds.to}`,
        { adjusted: String(input.adjusted), sort: 'asc', limit: String(MAX_BARS) },
      ));
      responseTicker(input.instrument.providerSymbol, payload.ticker);
      const invalidWarnings: string[] = [];
      const byTime = new Map<number, NormalizedBar>();
      for (const result of payload.results ?? []) {
        const time = epochSeconds(result.t);
        if (!time) continue;
        if (input.session === 'regular' && (resolution.timespan === 'minute' || resolution.timespan === 'hour')) {
          // Filter by the bucket's actual overlap with [09:30, 16:00), not by its
          // start alone: a provider-native multi-hour bucket (e.g. 08:00–12:00 4h,
          // or 09:00–10:00 1h) starts before 09:30 yet overlaps the open, so it
          // must be kept with its OHLCV preserved unchanged. Only buckets lying
          // entirely outside the regular session are dropped. (Extended-session
          // requests skip this filter entirely and are never substituted.)
          const startMinute = localMinutes(time, input.instrument.timezone);
          if (!bucketOverlapsRegularSession(startMinute, resolution.seconds / 60)) continue;
        }
        const parsed = normalizedBarSchema.safeParse({
          time, open: result.o, high: result.h, low: result.l, close: result.c,
          volume: result.v, transactions: result.n, vwap: result.vw, partial: false,
        });
        if (!parsed.success) { invalidWarnings.push(`Rejected invalid Polygon bar at ${time}`); continue; }
        byTime.set(time, parsed.data);
      }
      let bars = [...byTime.values()].sort((left, right) => left.time - right.time);
      if (input.range === '1d' && (resolution.timespan === 'minute' || resolution.timespan === 'hour') && bars.length) {
        const latestDate = localDate(bars.at(-1)!.time, input.instrument.timezone);
        bars = bars.filter((bar) => localDate(bar.time, input.instrument.timezone) === latestDate);
      }
      const nowSeconds = Math.floor(this.now().valueOf() / 1_000);
      const last = bars.at(-1);
      if (last && nowSeconds - last.time < resolution.seconds) last.partial = true;
      const daily = ['day', 'week', 'month'].includes(resolution.timespan);
      const recency = last ? dataRecency(last.time, nowSeconds, daily) : { status: 'unavailable' as const, delayedByMinutes: null };
      return normalizedBarsResultSchema.parse({
        symbol: input.instrument.canonicalSymbol,
        provider: this.id,
        interval: input.interval,
        range: input.range,
        adjusted: input.adjusted,
        session: input.session,
        timezone: input.instrument.timezone,
        currency: input.instrument.currency,
        firstTimestamp: bars[0]?.time ?? null,
        lastTimestamp: last?.time ?? null,
        asOf: last?.time ?? null,
        dataStatus: last?.partial && recency.status === 'real-time' ? 'partial' : recency.status,
        delayedByMinutes: recency.delayedByMinutes,
        bars,
        warnings: invalidWarnings,
      });
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) throw new MarketDataError('invalid-provider-response', 'Polygon aggregate response did not match its validated schema');
      throw cause;
    }
  }

  async getSession(instrument: ResolvedInstrument) {
    try {
      const payload = marketStatusSchema.parse(await this.request('/v1/marketstatus/now'));
      const asOf = payload.serverTime ? Math.floor(new Date(payload.serverTime).valueOf() / 1_000) : Math.floor(this.now().valueOf() / 1_000);
      if (!Number.isFinite(asOf)) throw new MarketDataError('invalid-provider-response', 'Polygon market status had an invalid server time');
      const exchangeKey = instrument.mic === 'XNAS' ? 'nasdaq'
        : instrument.mic === 'XNYS' || instrument.mic === 'ARCX' || instrument.mic === 'XASE' ? 'nyse'
          : instrument.mic === 'OTCM' ? 'otc' : null;
      const exchangeStatus = exchangeKey ? payload.exchanges?.[exchangeKey]?.toLowerCase() : undefined;
      const market = payload.market?.toLowerCase();
      const status = payload.earlyHours ? 'pre-market'
        : payload.afterHours ? 'after-hours'
          : market === 'open' || exchangeStatus === 'open' ? 'open'
            : market === 'closed' || exchangeStatus === 'closed' ? 'closed'
              : market === 'extended-hours' ? 'after-hours' : 'unknown';
      return normalizedMarketSessionSchema.parse({
        status,
        exchange: instrument.exchange,
        timezone: instrument.timezone,
        sessionDate: localDate(asOf, instrument.timezone),
        nextOpen: null,
        nextClose: null,
        asOf,
        provider: this.id,
        source: 'polygon-market-status',
        stale: Math.floor(this.now().valueOf() / 1_000) - asOf > 5 * 60,
        reason: status === 'unknown' ? 'Polygon did not report a recognized exchange status' : null,
      });
    } catch (cause) {
      if (cause instanceof MarketDataError) throw cause;
      if (cause instanceof ZodError) throw new MarketDataError('invalid-provider-response', 'Polygon market status response did not match its validated schema');
      throw cause;
    }
  }
}
