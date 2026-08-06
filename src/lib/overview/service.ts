import 'server-only';

import { getCandleMarketDataService, getYahooChartProvider } from '@/src/lib/market-data/candles';
import { resolveCurrentMarketSession } from '@/src/lib/market-data/current-session';
import { canonicalRegularTradingDateAt } from '@/src/lib/market-data/current-session';
import { getMarketDataGateway } from '@/src/lib/market-data/gateway/service';
import { resolveCanonicalMarketSnapshot } from '@/src/lib/market-data/market-snapshot';
import { loadResilientQuote } from '@/src/lib/market-data/quote-service';
import {
  exchangeSessionDate,
  US_EQUITY_TIMEZONE,
} from '@/src/lib/market-data/session';
import { buildStockPriceHeaderModel } from '@/src/components/stock/price-header';
import {
  getIndustryInstrumentUniverse,
  getIndustryInstruments,
  getInstrumentClassificationMetadata,
  getInstrumentMetadata,
} from '@/src/lib/instruments/master';
import { getInstrumentPresentationMetadata } from '@/src/lib/instruments/presentation';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { buildIndustryRanking, calculateMarketBreadth, type IndustryQuoteCandidate } from './industry-ranking';
import {
  LastGoodSnapshotCoordinator,
  mapWithConcurrencyDeadline,
} from './industry-snapshot';
import { loadContinuousMarketPrice } from './continuous-market';
import { overviewPriceStatus } from './presentation';
import { equityMarketSymbols, MARKET_ASSETS } from './market-assets';
import {
  aggregateIndustryChartSeries,
  attachBenchmark,
  INDUSTRY_CHART_MIN_COVERAGE,
  type MemberCandleSeries,
} from './industry-chart';
import type {
  IndustryChartResult,
  IndustryGroup,
  IndustryTimeframe,
  InstrumentMetadata,
  MarketIndexCard,
  OverviewPrice,
  ServiceStatus,
} from './types';
import type { ResolvedInstrument } from '@/src/lib/market-data/gateway/contracts';

const unavailableFreshness = {
  status: 'unavailable' as const,
  asOf: null,
  maxAgeSeconds: null,
};

const priceCache = new SharedRequestCache();
const industryChartCache = new SharedRequestCache();
const INDUSTRY_REFRESH_DEADLINE_MS = 20_000;
const INDUSTRY_SNAPSHOT_POLICY = {
  freshMs: 2 * 60_000,
  staleMs: 10 * 60_000,
};

interface IndustryDashboardSnapshot {
  industries: ReturnType<typeof buildIndustryRanking>;
  breadth: ReturnType<typeof calculateMarketBreadth>;
  candidateCount: number;
  completedCount: number;
  deadlineReached: boolean;
  quotesUpdatedAt: string;
}

interface IndustryDashboardResult {
  industries: IndustryGroup[];
  breadth: ReturnType<typeof calculateMarketBreadth>;
  candidateCount: number;
  completedCount: number;
  deadlineReached: boolean;
  quotesUpdatedAt: string | null;
  classificationUpdatedAt: string;
  stale: boolean;
  state: 'ready' | 'refreshing' | 'unavailable';
}

const industrySnapshots = new LastGoodSnapshotCoordinator<IndustryDashboardSnapshot>(
  INDUSTRY_SNAPSHOT_POLICY,
);

interface LoadedPrice {
  display: OverviewPrice;
  validForRanking: boolean;
  volume: number | null;
}

function phaseLabel(phase: OverviewPrice['session']): string {
  if (phase === 'PRE') return 'ก่อนตลาดเปิด';
  if (phase === 'REGULAR') return 'ตลาดเปิด';
  if (phase === 'POST') return 'หลังตลาด';
  if (phase === 'CONTINUOUS') return 'ซื้อขายตลอด 24 ชม.';
  return 'ตลาดปิด';
}

function unavailablePrice(instrument: InstrumentMetadata): LoadedPrice {
  return {
    display: {
      symbol: instrument.symbol,
      instrument,
      price: null,
      currency: instrument.currency,
      change: null,
      changePercent: null,
      session: 'CLOSED',
      sessionLabel: 'กำลังตรวจสอบสถานะตลาด',
      status: 'unavailable',
      asOf: null,
      tradingDate: null,
      extended: null,
      freshness: unavailableFreshness,
      sparkline: [],
    },
    validForRanking: false,
    volume: null,
  };
}

async function loadPriceUncached(
  instrument: InstrumentMetadata,
  now: Date,
  resolvedInstrument?: ResolvedInstrument,
): Promise<LoadedPrice> {
  const gateway = getMarketDataGateway();
  const resolved = resolvedInstrument ?? await gateway.resolveInstrument(instrument.symbol);
  const quotePromise = loadResilientQuote(
    instrument.symbol,
    gateway,
    getYahooChartProvider(),
    resolved,
    () => now,
  );
  const sessionPromise = gateway.getSession({ instrument: resolved }).catch(() => null);
  const extendedPromise = getYahooChartProvider().getExtendedQuote(instrument.symbol)
    .catch(() => null);
  const [quote, marketSession, extended] = await Promise.all([
    quotePromise,
    sessionPromise,
    extendedPromise,
  ]);
  const currentSession = resolveCurrentMarketSession({
    now,
    marketStatus: marketSession ? {
      status: marketSession.status,
      asOf: new Date(marketSession.asOf * 1_000).toISOString(),
      source: marketSession.source,
      stale: marketSession.stale,
      maxAgeSeconds: 30,
    } : null,
  });
  const snapshot = resolveCanonicalMarketSnapshot({
    symbol: instrument.symbol,
    session: currentSession,
    quote: {
      data: quote.data,
      freshness: quote.freshness,
      provider: quote.provider ?? null,
    },
    initialQuote: {
      data: quote.data,
      freshness: quote.freshness,
      provider: quote.provider ?? null,
    },
    extended: extended ? {
      session: extended.session,
      price: extended.price,
      asOf: extended.asOf,
      tradingDate: extended.tradingDate,
      provider: extended.provider,
      freshness: extended.freshness,
    } : null,
    now,
  });
  const model = buildStockPriceHeaderModel({
    snapshot,
    evaluatedAt: now.toISOString(),
  });
  const price = model.main.price;
  const change = model.main.change;
  const secondary = model.secondary;
  const display: OverviewPrice = {
    symbol: instrument.symbol,
    instrument,
    price,
    currency: quote.data.currency ?? instrument.currency,
    change: change?.amount ?? null,
    changePercent: change?.percent ?? null,
    session: snapshot.session,
    sessionLabel: phaseLabel(snapshot.session),
    status: overviewPriceStatus(
      model.main.freshness,
      model.main.role === 'regular-close',
    ),
    asOf: model.main.asOf,
    source: quote.provider ?? null,
    unavailableReason: null,
    tradingDate: model.main.tradingDate,
    extended: secondary ? {
      label: secondary.session === 'premarket' ? 'ก่อนตลาดเปิด' : 'หลังตลาด',
      price: secondary.price,
      change: secondary.change?.amount ?? null,
      changePercent: secondary.change?.percent ?? null,
      asOf: secondary.asOf,
    } : null,
    freshness: model.main.freshness,
    sparkline: [],
  };
  const rejected = new Set(snapshot.flags);
  const validForRanking = price !== null
    && change !== null
    && quote.freshness.status !== 'stale'
    && quote.freshness.status !== 'unavailable'
    && !rejected.has('trading-date-mismatch')
    && !rejected.has('stale-main-price')
    && snapshot.tradingDate !== null;
  return {
    display,
    validForRanking,
    volume: quote.data.volume ?? null,
  };
}

export async function loadOverviewPrice(
  instrument: InstrumentMetadata,
  now: Date = new Date(),
  resolvedInstrument?: ResolvedInstrument,
): Promise<LoadedPrice> {
  try {
    const resolution = await priceCache.resolve(
      `overview-price:${instrument.symbol}`,
      () => loadPriceUncached(instrument, now, resolvedInstrument),
      { freshMs: 30_000, staleMs: 5 * 60_000, errorMs: 30_000 },
    );
    if (resolution.state !== 'stale') return resolution.value;
    return {
      ...resolution.value,
      validForRanking: false,
      display: {
        ...resolution.value.display,
        status: 'saved',
        freshness: resolution.value.display.freshness
          ? { ...resolution.value.display.freshness, status: 'stale' }
          : resolution.value.display.freshness,
      },
    };
  } catch {
    return unavailablePrice(instrument);
  }
}

class ContinuousPriceUnavailable extends Error {
  constructor(readonly display: OverviewPrice) {
    super(display.unavailableReason ?? 'Continuous market data is unavailable');
    this.name = 'ContinuousPriceUnavailable';
  }
}

async function loadContinuousOverviewPrice(
  instrument: InstrumentMetadata,
  now: Date,
): Promise<LoadedPrice> {
  try {
    const resolution = await priceCache.resolve(
      `overview-price:${instrument.symbol}`,
      async () => {
        const referenceSeconds = Math.floor(now.valueOf() / 1_000);
        const display = await loadContinuousMarketPrice({
          instrument,
          quote: getYahooChartProvider().getQuote(instrument.symbol),
          candles: getCandleMarketDataService().getCandles({
            symbol: instrument.symbol,
            interval: '5m',
            range: '1d',
            period1: referenceSeconds - 86_400,
            period2: referenceSeconds + 300,
            adjusted: false,
            session: 'regular',
          }),
        });
        if (display.status === 'unavailable') throw new ContinuousPriceUnavailable(display);
        return {
          display,
          validForRanking: false,
          volume: null,
        } satisfies LoadedPrice;
      },
      { freshMs: 30_000, staleMs: 5 * 60_000, errorMs: 30_000 },
    );
    if (resolution.state !== 'stale') return resolution.value;
    return {
      ...resolution.value,
      display: {
        ...resolution.value.display,
        status: 'saved',
        freshness: resolution.value.display.freshness
          ? { ...resolution.value.display.freshness, status: 'stale' }
          : resolution.value.display.freshness,
      },
    };
  } catch (cause) {
    if (cause instanceof ContinuousPriceUnavailable) {
      return {
        display: cause.display,
        validForRanking: false,
        volume: null,
      };
    }
    return unavailablePrice(instrument);
  }
}

async function loadIndustryRegularPrice(
  instrument: InstrumentMetadata,
  resolvedInstrument: ResolvedInstrument | undefined,
  now: Date,
): Promise<LoadedPrice> {
  if (!resolvedInstrument?.supported) return unavailablePrice(instrument);
  try {
    const quote = await loadResilientQuote(
      instrument.symbol,
      getMarketDataGateway(),
      getYahooChartProvider(),
      resolvedInstrument,
      () => now,
    );
    const expectedTradingDate = canonicalRegularTradingDateAt(now);
    const quoteTradingDate = quote.data.quoteTimestamp
      ? exchangeSessionDate(quote.data.quoteTimestamp, US_EQUITY_TIMEZONE)
      : quote.data.latestTradingDay;
    const price = quote.data.regularClose ?? quote.data.price;
    const previousClose = quote.data.previousRegularClose ?? quote.data.previousClose;
    const valid = expectedTradingDate !== null
      && quoteTradingDate === expectedTradingDate
      && Number.isFinite(price)
      && price > 0
      && previousClose !== null
      && Number.isFinite(previousClose)
      && previousClose > 0
      && quote.freshness.status !== 'stale'
      && quote.freshness.status !== 'unavailable';
    const change = valid ? price - previousClose : null;
    const changePercent = valid ? change! / previousClose * 100 : null;
    return {
      display: {
        symbol: instrument.symbol,
        instrument,
        price: valid ? price : null,
        currency: quote.data.currency ?? instrument.currency,
        change,
        changePercent,
        session: 'CLOSED',
        sessionLabel: 'ราคาช่วงตลาดปกติ',
        status: valid ? overviewPriceStatus(quote.freshness, true) : 'unavailable',
        asOf: quote.data.quoteTimestamp ?? quote.freshness.asOf,
        tradingDate: quoteTradingDate ?? null,
        extended: null,
        freshness: quote.freshness,
        sparkline: [],
      },
      validForRanking: valid,
      volume: quote.data.volume ?? null,
    };
  } catch {
    return unavailablePrice(instrument);
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        output[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

async function sparkline(symbol: string): Promise<number[]> {
  try {
    const result = await getCandleMarketDataService().getCandles({
      symbol,
      interval: '5m',
      range: '1d',
      adjusted: false,
      session: 'regular',
    });
    return result.data.candles.map((candle) => candle.close).filter(Number.isFinite);
  } catch {
    return [];
  }
}

export async function loadMarketIndices(
  now = new Date(),
  force = false,
): Promise<MarketIndexCard[]> {
  if (force) {
    MARKET_ASSETS.forEach((item) => priceCache.invalidate(`overview-price:${item.symbol}`));
  }
  const metadata = await getInstrumentMetadata(MARKET_ASSETS.map((item) => item.symbol));
  const equitySymbols = equityMarketSymbols();
  const resolved = await getMarketDataGateway()
    .resolveInstruments(equitySymbols);
  return mapWithConcurrency(MARKET_ASSETS, 4, async (proxy) => {
    const instrument = {
      ...metadata.get(proxy.symbol)!,
      logoUrl: proxy.logoUrl,
      ...(proxy.marketKind === 'continuous'
        ? { assetType: 'crypto', exchange: null }
        : {}),
    };
    if (proxy.marketKind === 'continuous') {
      const loaded = await loadContinuousOverviewPrice(instrument, now);
      return {
        ...loaded.display,
        name: proxy.name,
        proxyLabel: proxy.proxyLabel,
      };
    }
    const [loaded, points] = await Promise.all([
      loadOverviewPrice(instrument, now, resolved.get(proxy.symbol)),
      sparkline(proxy.symbol),
    ]);
    return {
      ...loaded.display,
      sparkline: points,
      name: proxy.name,
      proxyLabel: proxy.proxyLabel,
    };
  });
}

export async function loadWatchlistPrices(
  symbols: readonly string[],
  now = new Date(),
  force = false,
): Promise<OverviewPrice[]> {
  const visible = [...new Set(symbols)].slice(0, 6);
  if (force) {
    visible.forEach((symbol) => priceCache.invalidate(`overview-price:${symbol}`));
  }
  const metadata = await getInstrumentPresentationMetadata(visible);
  const resolved = await getMarketDataGateway().resolveInstruments(visible);
  const loaded = await mapWithConcurrency(
    visible,
    4,
    (symbol) => loadOverviewPrice(
      metadata.get(symbol)!,
      now,
      resolved.get(symbol),
    ),
  );
  return loaded.map((item) => item.display);
}

export async function loadPortfolioPrices(
  symbols: readonly string[],
  now = new Date(),
): Promise<Map<string, LoadedPrice>> {
  const unique = [...new Set(symbols)];
  const metadata = await getInstrumentPresentationMetadata(unique);
  const resolved = await getMarketDataGateway().resolveInstruments(unique);
  const loaded = await mapWithConcurrency(
    unique,
    4,
    (symbol) => loadOverviewPrice(
      metadata.get(symbol)!,
      now,
      resolved.get(symbol),
    ),
  );
  return new Map(unique.map((symbol, index) => [symbol, loaded[index]!]));
}

function industrySnapshotKey(now: Date): string {
  const tradingDate = canonicalRegularTradingDateAt(now)
    ?? exchangeSessionDate(now.toISOString(), US_EQUITY_TIMEZONE)
    ?? 'unknown';
  return `regular:${tradingDate}`;
}

async function settleBeforeDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<T | null> {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (!remainingMs) return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function calculateIndustryDashboard(
  now: Date,
  deadlineMs = INDUSTRY_REFRESH_DEADLINE_MS,
): Promise<IndustryDashboardSnapshot> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.max(1, deadlineMs);
  const instruments = await getIndustryInstrumentUniverse();
  const resolved = await settleBeforeDeadline(
    getMarketDataGateway().resolveInstruments(
      instruments.map((instrument) => instrument.symbol),
    ),
    deadlineAt,
  );
  if (!resolved) throw new Error('industry instrument resolution deadline reached');

  const collection = await mapWithConcurrencyDeadline(
    instruments,
    6,
    deadlineAt,
    (instrument) => loadIndustryRegularPrice(
      instrument,
      resolved.get(instrument.symbol),
      now,
    ),
  );
  const candidates: IndustryQuoteCandidate[] = collection.completed.map(({ index, value }) => ({
    price: value.display,
    sector: instruments[index]?.sector ?? null,
    industry: instruments[index]?.industry ?? null,
    industryNameTh: instruments[index]?.industryNameTh ?? null,
    industrySlug: instruments[index]?.industrySlug ?? null,
    valid: value.validForRanking,
    volume: value.volume,
    marketCap: null,
    groupTotalCount: instruments[index]?.industryMemberCount ?? null,
  }));
  const industries = buildIndustryRanking(candidates);
  if (!industries.length) {
    throw new Error('industry refresh produced no group with five valid companies');
  }
  return {
    industries,
    breadth: calculateMarketBreadth(candidates),
    candidateCount: instruments.length,
    completedCount: collection.completed.length,
    deadlineReached: collection.timedOut,
    quotesUpdatedAt: new Date().toISOString(),
  };
}

function emptyIndustryDashboard(
  state: 'refreshing' | 'unavailable',
): IndustryDashboardResult {
  return {
    industries: [],
    breadth: null,
    candidateCount: 0,
    completedCount: 0,
    deadlineReached: false,
    quotesUpdatedAt: null,
    classificationUpdatedAt: getInstrumentClassificationMetadata().generatedAt,
    stale: false,
    state,
  };
}

function readIndustryDashboardSnapshot(now: Date): IndustryDashboardResult {
  const key = industrySnapshotKey(now);
  const current = industrySnapshots.read(key);
  if (!current.value) return emptyIndustryDashboard('refreshing');
  return {
    ...current.value,
    classificationUpdatedAt: getInstrumentClassificationMetadata().generatedAt,
    stale: current.state === 'refreshing',
    state: current.state,
  };
}

/** Fast SSR read: this function never starts or awaits provider work. */
export function loadIndustryDashboardSnapshot(now = new Date()) {
  return readIndustryDashboardSnapshot(now);
}

/** Starts or joins one refresh for the current regular trading date. */
export function warmIndustryDashboard(now = new Date(), deadlineMs = INDUSTRY_REFRESH_DEADLINE_MS) {
  const key = industrySnapshotKey(now);
  return industrySnapshots.refresh(
    key,
    () => calculateIndustryDashboard(now, deadlineMs),
    (value) => value.industries.length > 0 && value.completedCount >= 5,
  );
}

/** Blocking batch path used only by the section endpoint and explicit retry. */
export async function loadIndustryDashboard(now = new Date(), force = false) {
  const current = readIndustryDashboardSnapshot(now);
  if (!force && current.state === 'ready') return current;

  await warmIndustryDashboard(now);
  const refreshed = readIndustryDashboardSnapshot(now);
  if (refreshed.industries.length) return refreshed;
  return emptyIndustryDashboard('unavailable');
}

export async function loadIndustryDetail(slug: string, now = new Date()) {
  const instruments = await getIndustryInstruments(slug);
  if (!instruments.length) return null;
  const deadlineAt = Date.now() + 12_000;
  const resolved = await settleBeforeDeadline(
    getMarketDataGateway().resolveInstruments(
      instruments.map((instrument) => instrument.symbol),
    ),
    deadlineAt,
  );
  if (!resolved) return null;
  const collection = await mapWithConcurrencyDeadline(
    instruments,
    6,
    deadlineAt,
    (instrument) => loadIndustryRegularPrice(
      instrument,
      resolved.get(instrument.symbol),
      now,
    ),
  );
  const candidates: IndustryQuoteCandidate[] = collection.completed.map(({ index, value }) => ({
    price: value.display,
    sector: instruments[index]?.sector ?? null,
    industry: instruments[index]?.industry ?? null,
    industryNameTh: instruments[index]?.industryNameTh ?? null,
    industrySlug: instruments[index]?.industrySlug ?? null,
    valid: value.validForRanking,
    volume: value.volume,
    marketCap: null,
    groupTotalCount: instruments[index]?.industryMemberCount ?? instruments.length,
  }));
  return buildIndustryRanking(candidates, 1)[0] ?? null;
}

const INDUSTRY_CHART_CONFIG: Record<IndustryTimeframe, {
  interval: '5m' | '1h' | '1D';
  range: '1d' | '5d' | '1m' | '3m' | '1y';
  minimumPoints: number;
}> = {
  '1D': { interval: '5m', range: '1d', minimumPoints: 12 },
  '1W': { interval: '1h', range: '5d', minimumPoints: 12 },
  '1M': { interval: '1D', range: '1m', minimumPoints: 10 },
  '3M': { interval: '1D', range: '3m', minimumPoints: 30 },
  '1Y': { interval: '1D', range: '1y', minimumPoints: 120 },
};

async function calculateIndustryChart(
  slug: string,
  timeframe: IndustryTimeframe,
): Promise<IndustryChartResult> {
  const config = INDUSTRY_CHART_CONFIG[timeframe];
  const instruments = await getIndustryInstruments(slug, 20);
  if (!instruments.length) throw new Error('ไม่พบสมาชิกอุตสาหกรรมที่ตรวจสอบได้');
  const deadlineAt = Date.now() + 12_000;
  const candles = getCandleMarketDataService();
  const benchmarkPromise = settleBeforeDeadline(
    candles.getCandles({
      symbol: 'SPY',
      interval: config.interval,
      range: config.range,
      adjusted: true,
      session: 'regular',
    }).catch(() => null),
    deadlineAt,
  );
  const collection = await mapWithConcurrencyDeadline(
    instruments,
    5,
    deadlineAt,
    async (instrument): Promise<MemberCandleSeries> => {
      const result = await candles.getCandles({
        symbol: instrument.symbol,
        interval: config.interval,
        range: config.range,
        adjusted: true,
        session: 'regular',
      });
      return {
        symbol: instrument.symbol,
        candles: result.data.candles,
      };
    },
  );
  const aggregated = aggregateIndustryChartSeries(
    collection.completed.map(({ value }) => value),
    instruments.length,
    config.minimumPoints,
  );
  if (!aggregated.points.length) {
    throw new Error(
      `ข้อมูลสมาชิกผ่านเกณฑ์ไม่ถึง ${Math.ceil(INDUSTRY_CHART_MIN_COVERAGE * 100)}% หรือจำนวนจุดไม่พอ`,
    );
  }
  const benchmark = await benchmarkPromise;
  if (!benchmark) throw new Error('ข้อมูล S&P 500 อ้างอิงไม่พร้อมภายในเวลาที่กำหนด');
  const points = attachBenchmark(aggregated.points, benchmark.data.candles);
  if (points.filter((point) => point.benchmarkReturn !== null).length < config.minimumPoints) {
    throw new Error('ข้อมูล S&P 500 ไม่ตรงกับช่วงเวลาของสมาชิกเพียงพอ');
  }
  return {
    timeframe,
    status: 'available',
    points,
    benchmarkSymbol: 'SPY',
    benchmarkLabel: 'S&P 500 (SPY ETF อ้างอิง)',
    coverage: {
      usable: aggregated.usableMembers,
      requested: instruments.length,
      thresholdPercent: INDUSTRY_CHART_MIN_COVERAGE * 100,
    },
    stale: collection.timedOut
      || benchmark.data.dataStatus === 'stale',
    asOf: points.length
      ? new Date(points.at(-1)!.timestamp * 1_000).toISOString()
      : null,
    reason: null,
  };
}

export async function loadIndustryChart(
  slug: string,
  timeframe: IndustryTimeframe,
): Promise<IndustryChartResult> {
  try {
    const resolution = await industryChartCache.resolve(
      `industry-chart:${slug}:${timeframe}`,
      () => calculateIndustryChart(slug, timeframe),
      {
        freshMs: timeframe === '1D' ? 60_000 : 6 * 60 * 60_000,
        staleMs: 24 * 60 * 60_000,
        errorMs: 30_000,
      },
    );
    return {
      ...resolution.value,
      stale: resolution.state === 'stale' || resolution.value.stale,
    };
  } catch (cause) {
    return {
      timeframe,
      status: 'unavailable',
      points: [],
      benchmarkSymbol: 'SPY',
      benchmarkLabel: 'S&P 500 (SPY ETF อ้างอิง)',
      coverage: {
        usable: 0,
        requested: 0,
        thresholdPercent: INDUSTRY_CHART_MIN_COVERAGE * 100,
      },
      stale: false,
      asOf: null,
      reason: cause instanceof Error ? cause.message : 'ข้อมูลกราฟยังไม่พร้อม',
    };
  }
}

export function buildServiceStatus(input: {
  checkedAt: string;
  indices: MarketIndexCard[];
  watchlist: OverviewPrice[];
  industryCandidateCount: number;
  industries: number;
  breadthAvailable: boolean;
  industryRefreshing?: boolean;
}): ServiceStatus {
  const affected: ServiceStatus['affected'] = [];
  if (input.indices.some((item) => item.status === 'unavailable')) {
    affected.push({ section: 'market', label: 'ภาพรวมตลาดบางรายการ' });
  }
  if (input.watchlist.some((item) => item.status === 'unavailable')) {
    affected.push({ section: 'watchlist', label: 'หุ้นที่ติดตามบางรายการ' });
  }
  if (input.industryRefreshing) {
    affected.push({ section: 'industries', label: 'กำลังอัปเดตอันดับอุตสาหกรรม' });
  } else if (input.industryCandidateCount === 0) {
    affected.push({ section: 'industries', label: 'อุตสาหกรรมเด่นวันนี้' });
  } else if (input.industries === 0) {
    affected.push({ section: 'industries', label: 'กลุ่มที่มีหุ้นผ่านเกณฑ์ไม่ถึง 5 ตัว' });
  }
  if (!input.breadthAvailable) {
    affected.push({ section: 'breadth', label: 'ภาพรวมแรงซื้อแรงขาย' });
  }
  const marketUnavailable = input.indices.every((item) => item.status === 'unavailable');
  const level = marketUnavailable ? 'connecting'
    : affected.length ? 'partial'
      : input.indices.some((item) => item.status === 'delayed' || item.status === 'saved')
        ? 'delayed' : 'ready';
  const label = level === 'ready' ? 'ข้อมูลตลาดพร้อมใช้งาน'
    : level === 'delayed' ? 'ข้อมูลบางส่วนล่าช้า'
      : level === 'partial' ? 'ผู้ให้บริการข้อมูลบางส่วนขัดข้อง'
        : 'กำลังเชื่อมต่อข้อมูลตลาด';
  return { level, label, checkedAt: input.checkedAt, affected };
}
