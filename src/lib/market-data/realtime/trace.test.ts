import { describe, expect, it } from 'vitest';
import { MarketTracer, formatTrace, isTracingEnabled } from './trace';

describe('formatTrace', () => {
  it('renders a stable key=value line in field order', () => {
    expect(formatTrace({ stage: 'price_header_updated', symbol: 'RKLB', price: 12.5 })).toBe(
      '[market-trace] price_header_updated symbol=RKLB price=12.5',
    );
    expect(formatTrace({ stage: 'gateway_market_event_broadcast', type: 'trade', symbol: 'AAPL', clients: 3 })).toBe(
      '[market-trace] gateway_market_event_broadcast symbol=AAPL type=trade clients=3',
    );
    expect(formatTrace({ stage: 'upstream_subscribe_sent', symbol: 'AAPL', channels: 'trades,quotes' })).toBe(
      '[market-trace] upstream_subscribe_sent symbol=AAPL channels=trades,quotes',
    );
    expect(formatTrace({
      stage: 'chart_updated', symbol: 'AAPL', price: 100,
      exchangeTimestampMs: 100, gatewayReceivedAtMs: 120, browserReceivedAtMs: 140,
      acceptedAtMs: 141, chartUpdatedAtMs: 145, latencyMs: 45,
    })).toContain('exchangeTimestampMs=100 gatewayReceivedAtMs=120 browserReceivedAtMs=140 acceptedAtMs=141 chartUpdatedAtMs=145 latencyMs=45');
  });
});

describe('MarketTracer', () => {
  function capturing(now: () => number) {
    const lines: string[] = [];
    const tracer = new MarketTracer({ sink: (line) => lines.push(line), now, sampleIntervalMs: 2_000 });
    return { tracer, lines };
  }

  it('always logs low-volume lifecycle stages (no sampling)', () => {
    let t = 0;
    const { tracer, lines } = capturing(() => t);
    tracer.trace({ stage: 'upstream_subscribe_sent', symbol: 'AAPL' });
    tracer.trace({ stage: 'upstream_subscribed', symbol: 'AAPL' });
    tracer.trace({ stage: 'upstream_subscribe_sent', symbol: 'AAPL' }); // immediately again
    expect(lines).toHaveLength(3);
  });

  it('samples a high-volume stage to at most one line per key per interval', () => {
    let t = 0;
    const { tracer, lines } = capturing(() => t);
    for (let i = 0; i < 100; i++) tracer.trace({ stage: 'browser_market_event_received', type: 'trade', symbol: 'AAPL' });
    expect(lines).toHaveLength(1); // all within the same 2s window → one line

    t = 2_000; // window elapsed
    tracer.trace({ stage: 'browser_market_event_received', type: 'trade', symbol: 'AAPL' });
    expect(lines).toHaveLength(2);
  });

  it('samples per (stage, symbol, type) key independently', () => {
    let t = 0;
    const { tracer, lines } = capturing(() => t);
    tracer.trace({ stage: 'browser_market_event_received', type: 'trade', symbol: 'AAPL' });
    tracer.trace({ stage: 'browser_market_event_received', type: 'quote', symbol: 'AAPL' }); // different type
    tracer.trace({ stage: 'browser_market_event_received', type: 'trade', symbol: 'MSFT' }); // different symbol
    expect(lines).toHaveLength(3);
  });

  it('is inert when disabled', () => {
    const lines: string[] = [];
    const tracer = new MarketTracer({ sink: (line) => lines.push(line), enabled: false });
    tracer.trace({ stage: 'upstream_subscribe_sent', symbol: 'AAPL' });
    expect(lines).toHaveLength(0);
  });
});

describe('isTracingEnabled', () => {
  it('defaults on and honours explicit off values', () => {
    expect(isTracingEnabled(undefined)).toBe(true);
    expect(isTracingEnabled('1')).toBe(true);
    expect(isTracingEnabled('off')).toBe(false);
    expect(isTracingEnabled('FALSE')).toBe(false);
    expect(isTracingEnabled('0')).toBe(false);
    expect(isTracingEnabled('no')).toBe(false);
  });
});
