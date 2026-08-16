import 'server-only';

import { loadEarningsSchedule } from '@/src/lib/analytics/earnings/service';
import type { EarningsSchedule } from '@/src/lib/analytics/earnings/types';
import { mapWithConcurrency } from '@/src/lib/overview/service';

/**
 * How many symbols one page render may ask the earnings calendar about.
 *
 * The calendar is a per-symbol provider call behind a twelve-hour cache, so a
 * reader watching forty symbols must not turn one page view into forty provider
 * requests. The cap is on the *request*, not on the feature: cached symbols cost
 * nothing, and a symbol left out simply contributes no earnings row rather than
 * a guessed one.
 */
export const UPCOMING_EARNINGS_SYMBOL_LIMIT = 8;

/** How long a page will wait for the calendar before rendering without it. */
const DEFAULT_DEADLINE_MS = 1_500;

/**
 * Symbols worth asking about, most relevant first.
 *
 * What is held outranks what is watched, because an earnings date matters more
 * when there is money on it. Deduplicated so a symbol that is both does not
 * spend two slots.
 */
export function upcomingEarningsSymbols(
  held: readonly string[],
  watched: readonly string[],
  limit = UPCOMING_EARNINGS_SYMBOL_LIMIT,
): string[] {
  return [...new Set([...held, ...watched].map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))]
    .slice(0, Math.max(0, limit));
}

/**
 * The next scheduled report for each symbol, or nothing at all.
 *
 * Bounded three ways: by the symbol cap above, by concurrency, and by a
 * wall-clock deadline after which the page renders without the section rather
 * than holding the whole response for a slow provider. Every failure mode —
 * refusal, timeout, missing key — resolves to "no row", never to a fabricated
 * date.
 */
export async function loadUpcomingEarnings(
  symbols: readonly string[],
  { deadlineMs = DEFAULT_DEADLINE_MS }: { deadlineMs?: number } = {},
): Promise<EarningsSchedule[]> {
  if (symbols.length === 0) return [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const loaded = await Promise.race([
      mapWithConcurrency(
        [...symbols],
        3,
        (symbol) => loadEarningsSchedule(symbol).catch(() => null),
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), deadlineMs);
      }),
    ]);
    if (loaded === null) return [];
    return loaded.filter((schedule): schedule is EarningsSchedule => schedule !== null);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
