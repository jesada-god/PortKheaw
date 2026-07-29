import {
  resolveCurrentMarketSession,
  sessionPhaseOf,
  type CurrentMarketSession,
  type CurrentMarketSessionResult,
  type MarketCloseReason,
} from '@/src/lib/market-data/current-session';
import {
  resolveCanonicalMarketSnapshot,
  type CanonicalMarketSnapshot,
  type SnapshotExtendedInput,
  type SnapshotQuoteInput,
} from '@/src/lib/market-data/market-snapshot';
import type { DataFreshness, Quote } from '@/src/lib/market-data/types';

/**
 * Shared fixtures for building a {@link CanonicalMarketSnapshot} in tests.
 *
 * Every header test drives the real resolver rather than hand-writing a snapshot
 * literal, so a test can never assert a state the resolver cannot actually produce —
 * which is the failure mode that let the extended-overwrites-close defect ship past
 * a green suite.
 */

/** A resolved session result, without going through the calendar. */
export function sessionResult(
  session: CurrentMarketSession,
  options: {
    evaluatedAt?: string;
    exchangeDate?: string | null;
    closeReason?: MarketCloseReason | null;
  } = {},
): CurrentMarketSessionResult {
  const evaluatedAt = options.evaluatedAt ?? '2026-07-29T14:31:00.000Z';
  return {
    session,
    phase: sessionPhaseOf(session),
    closeReason: options.closeReason
      ?? (sessionPhaseOf(session) === 'CLOSED' ? 'NORMAL' : null),
    evaluatedAt,
    source: 'exchange-calendar',
    exchangeDate: options.exchangeDate ?? evaluatedAt.slice(0, 10),
    provider: { accepted: false, status: null, asOf: null, source: null, rejection: 'missing' },
  };
}

/** A session resolved from the real exchange calendar at a given instant. */
export function calendarSessionAt(now: string): CurrentMarketSessionResult {
  return resolveCurrentMarketSession({ now });
}

export function quoteResource(
  data: Quote | null,
  freshness: DataFreshness,
  provider: string | null = 'polygon',
): SnapshotQuoteInput {
  return { data, freshness, provider };
}

export function extendedPrint(
  overrides: Partial<SnapshotExtendedInput> & Pick<SnapshotExtendedInput, 'price' | 'asOf'>,
): SnapshotExtendedInput {
  return {
    session: 'after-hours',
    tradingDate: null,
    provider: 'yahoo-finance-chart',
    freshness: { status: 'delayed', asOf: overrides.asOf, maxAgeSeconds: 900 },
    ...overrides,
  };
}

/** Build a canonical snapshot through the real resolver. */
export function snapshotOf(input: {
  symbol?: string;
  session: CurrentMarketSessionResult;
  quote: SnapshotQuoteInput | null;
  initialQuote?: SnapshotQuoteInput | null;
  extended?: SnapshotExtendedInput | null;
  now?: string;
}): CanonicalMarketSnapshot {
  return resolveCanonicalMarketSnapshot({
    symbol: input.symbol ?? 'TEST',
    session: input.session,
    quote: input.quote,
    initialQuote: input.initialQuote ?? null,
    extended: input.extended ?? null,
    now: input.now ?? input.session.evaluatedAt,
  });
}
