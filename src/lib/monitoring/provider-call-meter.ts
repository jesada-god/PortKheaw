/**
 * How many times this product actually called a paid provider, and why.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * The two providers whose bills the profile and translation work is meant to
 * cut — Financial Modeling Prep and Gemini — are the two that were invisible.
 * Both call `fetch` directly rather than going through `provider-http.ts`, so
 * neither ever emitted the `provider_request` line every other provider logs,
 * and there was no number anywhere in this product that could answer "how many
 * FMP calls did we make yesterday".
 *
 * That makes a cost claim unfalsifiable, which is the same as untrue. A cache
 * that is added without a counter is a cache nobody can show worked.
 *
 * ===========================================================================
 * WHAT IT RECORDS, AND WHAT IT DELIBERATELY DOES NOT
 * ===========================================================================
 * One line per call, carrying the provider, the operation, whether the answer
 * was served without touching the provider, and the outcome. It carries no
 * symbol, no account, no request body and no key: a per-symbol breakdown would
 * make this a log of what individual readers looked at, and the question being
 * answered is a billing question, not a behavioural one.
 *
 * `source` is the field the whole exercise turns on:
 *
 *   `provider`     the upstream was called and this one costs money
 *   `db-snapshot`  answered from the shared table, no upstream call
 *   `memory`       answered from this instance's cache, no upstream call
 *
 * Before the snapshot lands, effectively every profile resolution logs
 * `provider`. After it lands, the same traffic should log `db-snapshot`. The
 * ratio between those two counts IS the evidence, and it is readable from log
 * search on day one without any dashboard access.
 *
 * ===========================================================================
 * THE ROLLUP, AND WHY IT IS BOUNDED
 * ===========================================================================
 * Per-call lines answer "what happened just now"; a rollup answers "what is
 * this costing" without anybody having to aggregate a log search by hand. The
 * counters are kept in a map that is bounded in both directions — a fixed key
 * space (provider × operation × source × outcome, all from closed sets) and a
 * hard cap that refuses new keys rather than growing — because a meter that can
 * be made to allocate by an attacker is a second bug, not an observability
 * feature.
 */

export type ProviderCallSource = 'provider' | 'db-snapshot' | 'memory';
export type ProviderCallOutcome = 'success' | 'error';

export interface ProviderCallEvent {
  /** The upstream being paid, e.g. `financial-modeling-prep`, `gemini`. */
  provider: string;
  /** What was asked for, e.g. `company-profile`, `company-profile-translation`. */
  operation: string;
  /** Whether this resolution actually cost an upstream call. */
  source: ProviderCallSource;
  outcome: ProviderCallOutcome;
  /** Wall time for the upstream call, when one happened. */
  durationMs?: number;
}

/**
 * How often the rollup is printed. A minute is short enough that a spike is
 * visible while it is happening and long enough that the rollup is never a
 * meaningful share of the log volume it is summarising.
 */
const ROLLUP_INTERVAL_MS = 60_000;

/**
 * The key space is closed by construction, so this cap is only ever reached by
 * a caller passing an unbounded `provider`/`operation` — which is a bug. The
 * meter drops those rather than growing, and says so once.
 */
const MAX_COUNTER_KEYS = 200;

interface Counter {
  calls: number;
  errors: number;
  durationMsTotal: number;
}

const counters = new Map<string, Counter>();
let windowStartedAt = Date.now();
let overflowed = false;

function counterKey(event: ProviderCallEvent): string {
  return `${event.provider}|${event.operation}|${event.source}`;
}

function flush(now: number): void {
  if (counters.size === 0) {
    windowStartedAt = now;
    return;
  }
  const rows = [...counters.entries()].map(([key, counter]) => {
    const [provider, operation, source] = key.split('|');
    return {
      provider,
      operation,
      source,
      calls: counter.calls,
      errors: counter.errors,
      // Only upstream calls have a meaningful duration; a cache hit's is zero
      // and averaging it in would understate what the provider actually costs.
      avgDurationMs: counter.calls > 0
        ? Math.round(counter.durationMsTotal / counter.calls)
        : 0,
    };
  });
  console.info(JSON.stringify({
    event: 'provider_call_rollup',
    windowStartedAt: new Date(windowStartedAt).toISOString(),
    windowEndedAt: new Date(now).toISOString(),
    rows,
    ...(overflowed ? { counterOverflow: true } : {}),
  }));
  counters.clear();
  windowStartedAt = now;
  overflowed = false;
}

/**
 * Record one resolution.
 *
 * Never throws and never awaits: a meter that can fail a request, or slow one
 * down, is worse than no meter. Callers may call it on both the success and the
 * failure path without guarding it.
 */
export function recordProviderCall(event: ProviderCallEvent): void {
  try {
    const now = Date.now();
    console.info(JSON.stringify({
      event: 'provider_call',
      provider: event.provider,
      operation: event.operation,
      source: event.source,
      outcome: event.outcome,
      ...(event.durationMs === undefined ? {} : { durationMs: Math.round(event.durationMs) }),
      timestamp: new Date(now).toISOString(),
    }));

    const key = counterKey(event);
    let counter = counters.get(key);
    if (!counter) {
      if (counters.size >= MAX_COUNTER_KEYS) {
        overflowed = true;
      } else {
        counter = { calls: 0, errors: 0, durationMsTotal: 0 };
        counters.set(key, counter);
      }
    }
    if (counter) {
      counter.calls += 1;
      if (event.outcome === 'error') counter.errors += 1;
      counter.durationMsTotal += event.durationMs ?? 0;
    }

    /*
     * Rolled up on the next call after the window closes rather than on a
     * timer. A `setInterval` here would hold a serverless instance awake purely
     * to print a line about work it is no longer doing, and would have to be
     * unref'd and torn down in tests. Piggy-backing on traffic means an idle
     * instance simply prints nothing, which is the correct rollup for an
     * instance that did no work.
     */
    if (now - windowStartedAt >= ROLLUP_INTERVAL_MS) flush(now);
  } catch {
    // An observability failure must never become a request failure.
  }
}

/** Test seam: drop the window without printing it. */
export function resetProviderCallMeter(): void {
  counters.clear();
  windowStartedAt = Date.now();
  overflowed = false;
}

/** Test seam: what the current window holds, without flushing it. */
export function providerCallMeterSnapshot(): Array<ProviderCallEvent & { calls: number; errors: number }> {
  return [...counters.entries()].map(([key, counter]) => {
    const [provider, operation, source] = key.split('|');
    return {
      provider,
      operation,
      source: source as ProviderCallSource,
      outcome: counter.errors > 0 ? 'error' as const : 'success' as const,
      calls: counter.calls,
      errors: counter.errors,
    };
  });
}
