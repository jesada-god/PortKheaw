import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const candleChart = read('src/components/stock/IntradayChartPanel.tsx');
const options = read('src/components/stock/OptionsChainPanel.tsx');
const chart = read('src/components/stock/ChartPanel.tsx');
const simulator = read('src/components/options-simulator/SimulatorWorkspace.tsx');
const middleware = read('middleware.ts');

describe('Phase 11 market UI production contract', () => {
  it('keeps candle requests isolated, cancellable, visibility-aware and independent of pan/zoom', () => {
    expect(candleChart).toContain('new Map<string, ChartResult>()');
    expect(candleChart).toContain('chartRequestKey({ symbol, interval, range, adjusted, session })');
    expect(candleChart).toContain('AbortController');
    expect(candleChart).toContain('generation.current');
    expect(candleChart).toContain('useAppActive');
    expect(candleChart).toContain('inflight.current');
    expect(candleChart).not.toMatch(/onPan|onZoom|wheel.*fetch|pointer.*fetch/i);
  });

  it('uses one server-normalized gateway route with legacy trader presets and an optional history range', () => {
    expect(candleChart).toContain('/api/market/candles?');
    expect(candleChart).not.toContain('aggregateSessionAwareIntraday');
    expect(candleChart).toContain('No candle is mocked, interpolated, forward-filled, or replaced by another provider');
    expect(candleChart).toContain('OptionToolRealtimeChart');
    expect(candleChart).not.toContain('TechnicalIndicatorControls');
    expect(chart).toContain('aria-label="Historical range"');
    expect(chart).toContain('aria-label="Candle interval"');
    expect(chart).toContain('compatibleSelection');
    expect(chart).toContain('TRADER_TIMEFRAME_PRESETS');
    expect(chart).toContain('data-testid="legacy-trader-chart-controls"');
  });

  it('lazy-loads the options UI with generation guards, cooldown and virtualization', () => {
    expect(options).toContain('generation.current');
    expect(options).toContain('AbortController');
    expect(options).toContain('Retry-After');
    expect(options).toContain('Virtualized options chain');
    expect(options).toContain('VIEWPORT_HEIGHT');
    expect(options).toContain('connection?.saveData');
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
