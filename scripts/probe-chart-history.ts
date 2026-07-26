/**
 * Stock Detail → Chart historical-provider probe.
 *
 * Answers the production question this phase closes, against a real deployment:
 * for each symbol and each range the chart offers, does `/api/market/candles`
 * serve real bars from Yahoo, is the adjusted/raw provenance truthful, and do
 * candles and volume land on identical timestamps?
 *
 * It calls the deployed route over HTTP (so the whole shipped server path runs:
 * validation, provider, aggregation, cache, envelope) and then pushes each
 * response through the exact canonical-bars layer the chart draws from, so
 * alignment is *checked on the real payload* rather than asserted. The reported
 * provider comes from the response, so a non-Yahoo provider cannot hide.
 *
 * Nothing is mocked and no value is invented: a failure is reported as a failure
 * and the process exits non-zero.
 *
 * Run: npm run probe:chart-history -- <base-url> [SYMBOL...]
 *   e.g. npm run probe:chart-history -- https://example.vercel.app NVTS AAPL RKLB
 */

import {
  assertAlignedSeries,
  deriveCanonicalSeries,
  normalizeCanonicalBars,
} from '@/src/lib/analytics/canonical-bars';
import { normalizedCandleResultSchema, type CandleInterval, type CandleRange } from '@/src/lib/market-data/candles/contracts';
import { isChartSelectionSupported } from '@/src/lib/analytics/timeframe/compatibility';
import { isAdjustableInterval } from '@/src/lib/analytics/price-adjustment';

const [baseArg, ...symbolArgs] = process.argv.slice(2);
if (!baseArg || !/^https?:\/\//.test(baseArg)) {
  console.error('Usage: npm run probe:chart-history -- <base-url> [SYMBOL...]');
  process.exit(2);
}
const BASE = baseArg.replace(/\/+$/, '');
const SYMBOLS = (symbolArgs.filter((value) => /^[A-Za-z][A-Za-z0-9.\-]*$/.test(value)));

/** The selections section 12 of the release checklist requires. */
const TARGETS: Array<{ interval: CandleInterval; range: CandleRange; label: string }> = [
  { interval: '1m', range: '1d', label: '1m · 1D' },
  { interval: '15m', range: '5d', label: '15m · 5D' },
  { interval: '1D', range: '1y', label: '1D · 12 เดือน' },
  { interval: 'Week', range: '1y', label: 'Week · 12 เดือน' },
  { interval: '1D', range: '5y', label: '1D · 5Y' },
  { interval: 'Week', range: '5y', label: 'Week · 5Y' },
];

interface Row {
  symbol: string;
  label: string;
  status: number | string;
  provider: string;
  attempted: string;
  bars: number | string;
  adjusted: string;
  aligned: string;
  ascending: string;
  tail: string;
  span: string;
  note: string;
}

let httpErrors = 0;
const urlsRequested: string[] = [];

async function probeSelection(symbol: string, target: typeof TARGETS[number]): Promise<Row> {
  const base: Row = {
    symbol, label: target.label, status: '—', provider: '—', attempted: '—', bars: '—',
    adjusted: '—', aligned: '—', ascending: '—', tail: '—', span: '—', note: '',
  };
  if (!isChartSelectionSupported(target.interval, target.range)) {
    return { ...base, note: 'not offered by the chart matrix (no request made)' };
  }
  const adjusted = isAdjustableInterval(target.interval);
  const query = new URLSearchParams({
    symbol, interval: target.interval, range: target.range,
    adjusted: String(adjusted), session: 'regular',
  });
  const url = `${BASE}/api/market/candles?${query.toString()}`;
  urlsRequested.push(url);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  } catch (cause) {
    httpErrors += 1;
    return { ...base, status: 'network', note: cause instanceof Error ? cause.message : String(cause) };
  }
  const payload = await response.json().catch(() => null) as { data?: unknown; error?: { code?: string; message?: string }; meta?: { provider?: string } } | null;
  if (!response.ok) {
    httpErrors += 1;
    return { ...base, status: response.status, note: `${payload?.error?.code ?? 'error'}: ${payload?.error?.message ?? ''}`.trim() };
  }
  const parsed = normalizedCandleResultSchema.safeParse(payload?.data);
  if (!parsed.success) {
    httpErrors += 1;
    return { ...base, status: response.status, note: 'response failed the shipped schema' };
  }
  const data = parsed.data;
  const bars = normalizeCanonicalBars(data.candles.map((bar) => ({
    date: new Date(bar.timestamp * 1_000).toISOString(),
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    volume: bar.volume, partial: bar.partial,
  })));
  const series = deriveCanonicalSeries(bars);
  let aligned = `${series.price.length}=${series.volume.length}`;
  try {
    assertAlignedSeries(series.price, series.volume);
  } catch (cause) {
    aligned = `MISMATCH (${cause instanceof Error ? cause.message : 'unknown'})`;
    httpErrors += 1;
  }
  const times = bars.map((bar) => bar.time);
  const ascending = times.every((time, index) => index === 0 || time > times[index - 1]);
  if (!ascending) httpErrors += 1;
  return {
    symbol,
    label: target.label,
    status: response.status,
    provider: data.provider,
    attempted: data.attemptedProviders.join(',') || '—',
    bars: bars.length,
    adjusted: `${adjusted ? 'asked' : 'raw-by-design'}→${data.adjusted ? 'adjusted' : 'raw'}`,
    aligned,
    ascending: ascending ? 'yes' : 'NO',
    tail: bars.at(-1)?.partial ? 'forming' : 'complete',
    span: data.actualStart && data.actualEnd
      ? `${new Date(data.actualStart * 1_000).toISOString().slice(0, 10)}→${new Date(data.actualEnd * 1_000).toISOString().slice(0, 10)}`
      : '—',
    note: data.warnings.join('; '),
  };
}

async function main(): Promise<void> {
  const symbols = (SYMBOLS.length ? SYMBOLS : ['NVTS', 'AAPL', 'RKLB']).map((value) => value.toUpperCase());
  const rows: Row[] = [];
  for (const symbol of symbols) {
    for (const target of TARGETS) rows.push(await probeSelection(symbol, target));
  }

  const header = ['Symbol', 'Selection', 'HTTP', 'Provider', 'Attempted', 'Bars', 'Adjusted', 'Candle↔Volume', 'Asc', 'Tail', 'Span', 'Note'];
  const widths = [6, 16, 7, 20, 20, 6, 20, 15, 4, 8, 24, 0];
  const line = (cells: Array<string | number>) => cells
    .map((cell, index) => String(cell).padEnd(widths[index] ?? 0)).join(' | ');
  console.log(`\nBase: ${BASE}`);
  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(Math.max(width, 4))).join('-|-'));
  for (const row of rows) {
    console.log(line([row.symbol, row.label, row.status, row.provider, row.attempted, row.bars, row.adjusted, row.aligned, row.ascending, row.tail, row.span, row.note]));
  }

  const providers = new Set(rows.map((row) => row.provider).filter((provider) => provider !== '—'));
  const attempted = new Set(rows.flatMap((row) => row.attempted.split(',')).filter((item) => item && item !== '—'));
  console.log(`\nDistinct serving providers: ${[...providers].join(', ') || 'none'}`);
  console.log(`Distinct attempted providers: ${[...attempted].join(', ') || 'none'}`);
  console.log(`Non-Yahoo providers on the chart path: ${[...attempted].filter((item) => !item.startsWith('yahoo')).join(', ') || '0'}`);
  console.log(`Requests issued: ${urlsRequested.length} (one per offered selection, no duplicates)`);
  console.log(`Duplicate request URLs: ${urlsRequested.length - new Set(urlsRequested).size}`);
  console.log(`Failures: ${httpErrors}`);
  process.exitCode = httpErrors ? 1 : 0;
}

void main();
