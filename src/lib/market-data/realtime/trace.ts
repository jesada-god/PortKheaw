/**
 * Structured, rate-limited tracing for the real-time market pipeline.
 *
 * One single-line `key=value` record is emitted at each hop a market event
 * crosses, so an operator can follow one event end to end:
 *
 *   upstream_subscribe_sent → upstream_subscribed → upstream_market_event_received
 *   → gateway_market_event_normalized → gateway_market_event_broadcast
 *   → browser_market_event_received → price_header_updated
 *
 * The Gateway's hops land in the Railway process logs; the browser's land in the
 * DevTools console. High-volume per-tick stages are SAMPLED to at most one line
 * per (stage, symbol, type) every {@link TRACE_SAMPLE_INTERVAL_MS} so a busy feed
 * cannot flood production; low-volume lifecycle stages (subscribe/subscribed)
 * always log. A trace line NEVER carries a credential — only type/symbol/count.
 */

export type TraceStage =
  | 'upstream_subscribe_sent'
  | 'upstream_subscribed'
  | 'upstream_market_event_received'
  | 'gateway_market_event_normalized'
  | 'gateway_market_event_broadcast'
  | 'browser_market_event_received'
  | 'price_header_updated'
  | 'chart_updated'
  | 'options_underlying_updated';

export interface TraceRecord {
  stage: TraceStage;
  symbol?: string;
  /** Provider/normalized event type, e.g. `t`/`q`/`b` upstream or `trade`/`quote`. */
  type?: string;
  price?: number;
  clients?: number;
  /** Compact channel summary, e.g. `trades,quotes,bars`. */
  channels?: string;
  exchangeTimestampMs?: number;
  gatewayReceivedAtMs?: number | null;
  browserReceivedAtMs?: number;
  acceptedAtMs?: number;
  chartUpdatedAtMs?: number;
  latencyMs?: number;
}

export type TraceSink = (line: string) => void;

/** Stages that fire once per market tick and therefore MUST be sampled. */
const HIGH_VOLUME_STAGES: ReadonlySet<TraceStage> = new Set<TraceStage>([
  'upstream_market_event_received',
  'gateway_market_event_normalized',
  'gateway_market_event_broadcast',
  'browser_market_event_received',
  'price_header_updated',
  'chart_updated',
  'options_underlying_updated',
]);

/** Min gap between two sampled lines sharing a (stage, symbol, type) key. */
export const TRACE_SAMPLE_INTERVAL_MS = 2_000;

/** Render one trace record as a single stable `key=value` line. */
export function formatTrace(record: TraceRecord): string {
  const parts: string[] = [record.stage];
  if (record.symbol !== undefined) parts.push(`symbol=${record.symbol}`);
  if (record.type !== undefined) parts.push(`type=${record.type}`);
  if (record.price !== undefined) parts.push(`price=${record.price}`);
  if (record.clients !== undefined) parts.push(`clients=${record.clients}`);
  if (record.channels !== undefined) parts.push(`channels=${record.channels}`);
  if (record.exchangeTimestampMs !== undefined) parts.push(`exchangeTimestampMs=${record.exchangeTimestampMs}`);
  if (record.gatewayReceivedAtMs !== undefined) parts.push(`gatewayReceivedAtMs=${record.gatewayReceivedAtMs}`);
  if (record.browserReceivedAtMs !== undefined) parts.push(`browserReceivedAtMs=${record.browserReceivedAtMs}`);
  if (record.acceptedAtMs !== undefined) parts.push(`acceptedAtMs=${record.acceptedAtMs}`);
  if (record.chartUpdatedAtMs !== undefined) parts.push(`chartUpdatedAtMs=${record.chartUpdatedAtMs}`);
  if (record.latencyMs !== undefined) parts.push(`latencyMs=${record.latencyMs}`);
  return `[market-trace] ${parts.join(' ')}`;
}

export interface TracerOptions {
  /** Where formatted lines go. Defaults to `console.info`. Injected in tests. */
  sink?: TraceSink;
  now?: () => number;
  sampleIntervalMs?: number;
  /** Master switch; when false the tracer is inert (no formatting, no sink). */
  enabled?: boolean;
}

/**
 * A rate-limited tracer shared by the Gateway (Node) and the browser client. Each
 * runtime owns its own instance — sampling state is per-process — but both speak
 * the exact same {@link TraceStage} contract so the two log streams line up.
 */
export class MarketTracer {
  private readonly sink: TraceSink;
  private readonly now: () => number;
  private readonly sampleIntervalMs: number;
  private readonly enabled: boolean;
  /** Last emit time per `stage|symbol|type` key, for sampling. */
  private readonly lastAt = new Map<string, number>();

  constructor(options: TracerOptions = {}) {
    this.sink = options.sink ?? ((line) => console.info(line));
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ?? TRACE_SAMPLE_INTERVAL_MS;
    this.enabled = options.enabled ?? true;
  }

  trace(record: TraceRecord): void {
    if (!this.enabled) return;
    if (HIGH_VOLUME_STAGES.has(record.stage) && !this.allowSample(record)) return;
    this.sink(formatTrace(record));
  }

  private allowSample(record: TraceRecord): boolean {
    const key = `${record.stage}|${record.symbol ?? ''}|${record.type ?? ''}`;
    const t = this.now();
    const last = this.lastAt.get(key);
    if (last !== undefined && t - last < this.sampleIntervalMs) return false;
    this.lastAt.set(key, t);
    return true;
  }
}

/**
 * Whether pipeline tracing should be on for this runtime. Defaults ON (the whole
 * point is production diagnosis) but can be silenced with
 * `MARKET_TRACE=off`/`0`/`false` without a redeploy of code.
 */
export function isTracingEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}
