import {
  companyProfileSchema,
  historicalPricesSchema,
  marketOverviewSchema,
  quoteSchema,
  symbolSearchResultSchema,
  type HistoricalRange,
} from '../../types';
import {
  alphaVantageHistoryResponseSchema,
  alphaVantageMarketStatusResponseSchema,
  alphaVantageProfileResponseSchema,
  alphaVantageQuoteResponseSchema,
  alphaVantageSearchResponseSchema,
} from './schemas';

function nullableText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'None' && trimmed !== '-' ? trimmed : null;
}

function nullableNumber(value: string | undefined): number | null {
  if (!value || value === 'None' || value === '-') return null;
  const parsed = Number(value.replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableInteger(value: string | undefined): number | null {
  const parsed = nullableNumber(value);
  return parsed === null ? null : Math.max(0, Math.trunc(parsed));
}

function isoDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

function website(value: string | undefined): string | null {
  const text = nullableText(value);
  if (!text) return null;
  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

function rangeStart(range: HistoricalRange, now: Date): Date | null {
  if (range === 'max') return null;
  const start = new Date(now);
  const amounts: Record<Exclude<HistoricalRange, 'max'>, [number, 'month' | 'year']> = {
    '1m': [1, 'month'],
    '3m': [3, 'month'],
    '6m': [6, 'month'],
    '1y': [1, 'year'],
    '5y': [5, 'year'],
  };
  const [amount, unit] = amounts[range];
  if (unit === 'month') start.setUTCMonth(start.getUTCMonth() - amount);
  else start.setUTCFullYear(start.getUTCFullYear() - amount);
  return start;
}

export function normalizeSearchResponse(input: unknown) {
  const parsed = alphaVantageSearchResponseSchema.parse(input);
  return parsed.bestMatches.map((match) => symbolSearchResultSchema.parse({
    symbol: match['1. symbol'].toUpperCase(),
    name: match['2. name'],
    assetType: match['3. type'].toLowerCase() === 'etf' ? 'ETF' : 'Stock',
    exchange: null,
    status: 'active',
    region: match['4. region'],
    marketOpen: nullableText(match['5. marketOpen']),
    marketClose: nullableText(match['6. marketClose']),
    timezone: nullableText(match['7. timezone']),
    currency: nullableText(match['8. currency']),
    matchScore: nullableNumber(match['9. matchScore']),
  }));
}

export function normalizeQuoteResponse(input: unknown) {
  const quote = alphaVantageQuoteResponseSchema.parse(input)['Global Quote'];
  return quoteSchema.parse({
    symbol: quote['01. symbol'].toUpperCase(),
    price: nullableNumber(quote['05. price']),
    open: nullableNumber(quote['02. open']),
    high: nullableNumber(quote['03. high']),
    low: nullableNumber(quote['04. low']),
    previousClose: nullableNumber(quote['08. previous close']),
    change: nullableNumber(quote['09. change']),
    changePercent: nullableNumber(quote['10. change percent']),
    volume: nullableInteger(quote['06. volume']),
    latestTradingDay: isoDate(quote['07. latest trading day']),
  });
}

export function normalizeHistoryResponse(
  input: unknown,
  symbol: string,
  range: HistoricalRange,
  now = new Date(),
) {
  const parsed = alphaVantageHistoryResponseSchema.parse(input);
  const start = rangeStart(range, now);
  const prices = Object.entries(parsed['Time Series (Daily)'])
    .filter(([date]) => !start || new Date(`${date}T00:00:00.000Z`) >= start)
    .map(([date, price]) => ({
      date,
      open: Number(price['1. open']),
      high: Number(price['2. high']),
      low: Number(price['3. low']),
      close: Number(price['4. close']),
      volume: nullableInteger(price['5. volume']),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return historicalPricesSchema.parse({ symbol, range, interval: '1d', prices });
}

export function normalizeProfileResponse(input: unknown) {
  const profile = alphaVantageProfileResponseSchema.parse(input);
  return companyProfileSchema.parse({
    symbol: profile.Symbol.toUpperCase(),
    name: profile.Name,
    description: nullableText(profile.Description),
    exchange: nullableText(profile.Exchange),
    currency: nullableText(profile.Currency),
    country: nullableText(profile.Country),
    sector: nullableText(profile.Sector),
    industry: nullableText(profile.Industry),
    website: website(profile.OfficialSite),
    logoUrl: null,
    marketCapitalization: nullableNumber(profile.MarketCapitalization),
    employees: nullableInteger(profile.FullTimeEmployees),
    fiscalYearEnd: nullableText(profile.FiscalYearEnd),
    latestQuarter: isoDate(profile.LatestQuarter),
  });
}

export function normalizeMarketOverviewResponse(input: unknown) {
  const parsed = alphaVantageMarketStatusResponseSchema.parse(input);
  return marketOverviewSchema.parse({
    markets: parsed.markets.map((market) => ({
      marketType: market.market_type,
      region: market.region,
      primaryExchanges: (market.primary_exchanges ?? '')
        .split(',')
        .map((exchange) => exchange.trim())
        .filter(Boolean),
      localOpen: nullableText(market.local_open),
      localClose: nullableText(market.local_close),
      currentStatus: normalizeProviderMarketStatus(market.current_status, market.notes),
      notes: nullableText(market.notes),
    })),
  });
}

function normalizeProviderMarketStatus(status: string | undefined, notes: string | undefined) {
  const value = `${status ?? ''} ${notes ?? ''}`.trim().toLowerCase();
  if (/\b(holiday|market holiday)\b/.test(value)) return 'holiday' as const;
  if (/\b(early[- ]?close|closing early)\b/.test(value)) return 'early-close' as const;
  if (/\b(pre[- ]?market|before market)\b/.test(value)) return 'pre-market' as const;
  if (/\b(after[- ]?hours|post[- ]?market)\b/.test(value)) return 'after-hours' as const;
  if (status?.trim().toLowerCase() === 'open') return 'open' as const;
  if (status?.trim().toLowerCase() === 'closed') return 'closed' as const;
  return 'unknown' as const;
}
