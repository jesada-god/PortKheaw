import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const candleChart = read('src/components/stock/IntradayChartPanel.tsx');
const options = read('src/components/stock/OptionsChainPanel.tsx');
const optionsCoordinator = read('src/lib/stock-detail/options-source/chain-coordinator.ts');
const optionsClient = read('src/lib/stock-detail/options-source/client.ts');
const chart = read('src/components/stock/ChartPanel.tsx');
const simulator = read('src/components/options-simulator/SimulatorWorkspace.tsx');
const middleware = read('middleware.ts');

describe('Phase 11 market UI production contract', () => {
  it('keeps candle requests isolated, cancellable, visibility-aware and independent of pan/zoom', () => {
    expect(candleChart).toContain('new Map<string, ChartCacheEntry>()');
    expect(candleChart).toContain('chartRequestKey({ symbol, interval, range, adjusted, session })');
    expect(candleChart).toContain('AbortController');
    expect(candleChart).toContain('generation.current');
    expect(candleChart).toContain('useAppActive');
    expect(candleChart).toContain('inflight.current');
    expect(candleChart).not.toMatch(/onPan|onZoom|wheel.*fetch|pointer.*fetch/i);
  });

  it('loads historical candles from the Yahoo pipeline, with Polygon off the critical path', () => {
    // One server-normalized historical pipeline: the Yahoo Finance Chart JSON
    // route. The Polygon gateway chart route and its client adapter must not be
    // reachable from the chart, so a Polygon free-tier 429 cannot break candles,
    // volume, 12 เดือน/5Y, the indicators, VPVR, S/R or Heikin-Ashi.
    expect(candleChart).toContain('/api/market/candles?');
    expect(candleChart).not.toContain('/api/market/chart?');
    expect(candleChart).not.toContain('polygon');
    expect(candleChart).not.toContain('chartGatewayResponseSchema');
    expect(candleChart).toContain('normalizedCandleResultSchema.safeParse(payload.data)');
  });

  it('drives the chart from the persisted interval/range selection', () => {
    expect(candleChart).not.toContain('aggregateSessionAwareIntraday');
    expect(candleChart).toContain('No candle is mocked, interpolated, forward-filled, or replaced by another provider');
    expect(candleChart).toContain('TechnicalAnalysisChart');
    expect(candleChart).not.toContain('TechnicalIndicatorControls');
    expect(chart).toContain('compatibleSelection');
    expect(chart).toContain('useChartPreferences');
    // Interval and range stay separate axes: the range is a canonical key from
    // the persisted preferences, never a candle interval.
    expect(chart).toContain('preferences.selectedInterval');
    expect(chart).toContain('preferences.selectedRange');
  });

  it('renders the technical suite from a single chart instance so candles and volume share one time scale', () => {
    const host = read('src/components/stock/chart/technical/TechnicalChartHost.tsx');
    expect(host.match(/createChart\(/g) ?? []).toHaveLength(1);
    // Candles and volume are panes of that one chart, not two synchronized charts.
    // The price series itself comes from the shared factory, which is the only
    // place a chart type decides which lightweight-charts series draws the bars.
    expect(host).toContain('addPriceSeries(chart');
    expect(host).toContain('HistogramSeries');
    expect(host).not.toContain('subscribeVisibleLogicalRangeChange(syncVolume)');
    const priceSeries = read('src/components/stock/chart/technical/price-series.ts');
    expect(priceSeries).toContain('CandlestickSeries');
    expect(priceSeries.match(/chart\.addSeries\(/g) ?? []).toHaveLength(4);
  });

  it('lazy-loads the options UI with generation guards, cooldown and virtualization', () => {
    expect(options).toContain('generation.current');
    expect(options).toContain('optionsChainCoordinator');
    expect(optionsCoordinator).toContain('AbortController');
    expect(optionsCoordinator).toContain('state.inflight');
    expect(optionsClient).toContain("headers.get('retry-after')");
    expect(options).toContain('Virtualized options chain');
    expect(options).toContain('VIEWPORT_HEIGHT');
    expect(options).toContain('connection?.saveData');
    expect(options).toContain('timestampKind={chain?.timestampKind ?? expirations?.timestampKind}');
    expect(read('src/components/market-data/DataProvenance.tsx')).toContain('เวลาที่ระบบได้รับข้อมูล');
  });

  it('revalidates a selected contract through the server API and marks edits custom', () => {
    expect(simulator).toContain('/api/market/options/chain?');
    expect(simulator).toContain('importOptionContract(current, parsed.data, contractSymbol)');
    expect(simulator).toContain("inputMode: 'custom' as const");
    expect(simulator).toContain("'ข้อมูลจริง' : 'กำหนดเอง'");
  });

  it('does not reference server market-data secrets from client components', () => {
    for (const source of [candleChart, options, chart, simulator]) {
      expect(source).not.toMatch(/ALPHA_VANTAGE_API_KEY|FMP_API_KEY|SUPABASE_SERVICE_ROLE_KEY|CRON_SECRET/);
    }
  });

  it('restricts browser connections and blocks framing through security headers', () => {
    expect(middleware).toContain("`connect-src ${[`'self'`, ...supabaseConnectSources(), ...marketWsConnectSources()].join(' ')}`");
    expect(middleware).toContain("`frame-ancestors 'none'`");
    expect(middleware).toContain("response.headers.set('X-Content-Type-Options', 'nosniff')");
  });
});
