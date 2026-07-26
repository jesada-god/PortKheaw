import { normalizedCandleSchema, type CandleInterval, type NormalizedCandle } from './contracts';

const INTRADAY_SECONDS: Partial<Record<CandleInterval, number>> = {
  '2m': 2 * 60,
  '3m': 3 * 60,
  '10m': 10 * 60,
  '30m': 30 * 60,
  '45m': 45 * 60,
  '1h': 60 * 60,
  '2h': 2 * 60 * 60,
  '3h': 3 * 60 * 60,
  '4h': 4 * 60 * 60,
};

/** Bucket width of each interval a provider can be asked to aggregate *from*. */
const SOURCE_SECONDS: Partial<Record<CandleInterval, number>> = {
  '1m': 60,
  '2m': 120,
  '3m': 180,
  '5m': 300,
  '10m': 600,
  '15m': 900,
  '30m': 1_800,
  '45m': 2_700,
  '1h': 3_600,
};

function localDate(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp * 1_000));
}

function monthKey(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(new Date(timestamp * 1_000));
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  return `${year}-${month}`;
}

function weekKey(timestamp: number, timeZone: string): string {
  const date = localDate(timestamp, timeZone);
  const parsed = new Date(`${date}T12:00:00.000Z`);
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(parsed.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((parsed.valueOf() - yearStart.valueOf()) / 86_400_000) + 1) / 7);
  return `${parsed.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function aggregateGroup(group: NormalizedCandle[], partial: boolean): NormalizedCandle {
  const first = group[0];
  const last = group.at(-1)!;
  return normalizedCandleSchema.parse({
    timestamp: first.timestamp,
    open: first.open,
    high: Math.max(...group.map((bar) => bar.high)),
    low: Math.min(...group.map((bar) => bar.low)),
    close: last.close,
    ...(last.adjustedClose === undefined ? {} : { adjustedClose: last.adjustedClose }),
    volume: group.reduce((sum, bar) => sum + bar.volume, 0),
    ...(first.session ? { session: first.session } : {}),
    ...(partial ? { partial: true } : {}),
  });
}

export function aggregateCandles(
  candles: readonly NormalizedCandle[],
  targetInterval: CandleInterval,
  sourceInterval: CandleInterval,
  exchangeTimezone: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): NormalizedCandle[] {
  if (targetInterval === sourceInterval) return [...candles];
  const ordered = [...candles].sort((left, right) => left.timestamp - right.timestamp);
  const buckets = new Map<string, NormalizedCandle[]>();
  const intradaySeconds = INTRADAY_SECONDS[targetInterval];
  const firstBySession = new Map<string, number>();

  for (const candle of ordered) {
    const date = localDate(candle.timestamp, exchangeTimezone);
    const sessionKey = `${date}:${candle.session ?? 'regular'}`;
    if (!firstBySession.has(sessionKey)) firstBySession.set(sessionKey, candle.timestamp);
    const key = targetInterval === 'Week'
      ? weekKey(candle.timestamp, exchangeTimezone)
      : targetInterval === 'Month'
        ? monthKey(candle.timestamp, exchangeTimezone)
        : intradaySeconds
          ? `${sessionKey}:${Math.floor((candle.timestamp - firstBySession.get(sessionKey)!) / intradaySeconds)}`
          : `${sessionKey}:${candle.timestamp}`;
    buckets.set(key, [...(buckets.get(key) ?? []), candle]);
  }

  const groups = [...buckets.values()];
  return groups.map((group, index) => {
    const isLast = index === groups.length - 1;
    let partial = false;
    if (isLast && intradaySeconds) {
      const sourceSeconds = SOURCE_SECONDS[sourceInterval] ?? intradaySeconds;
      partial = group.length < Math.max(1, intradaySeconds / sourceSeconds);
    }
    if (isLast && targetInterval === 'Week') {
      partial = weekKey(group.at(-1)!.timestamp, exchangeTimezone) === weekKey(nowSeconds, exchangeTimezone);
    }
    if (isLast && targetInterval === 'Month') {
      partial = monthKey(group.at(-1)!.timestamp, exchangeTimezone) === monthKey(nowSeconds, exchangeTimezone);
    }
    return aggregateGroup(group, partial);
  });
}
