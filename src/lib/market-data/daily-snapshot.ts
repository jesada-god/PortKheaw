import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { DaySnapshotInput } from '@/src/lib/portfolio/day-change';
import {
  isTradingDate,
  lastCompletedSessionDate,
  marketSession,
  previousTradingDate,
} from './market-session';

/**
 * Reading and writing `public.daily_snapshot` — the captured regular-session
 * closes the day figure falls back to whenever the market is not open.
 *
 * The table is service-role only (RLS on, no policy), so everything here runs
 * behind the server and asks for the symbols one reader actually holds rather
 * than pulling the end-of-day file.
 */

type Client = SupabaseClient<Database>;

/** The lookback for "the most recent snapshot for this symbol". */
const MAX_LOOKBACK_DAYS = 30;

/** Supabase rejects very large `in` lists; symbols are chunked to stay under it. */
const SYMBOL_CHUNK = 200;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * The most recent captured close for each requested symbol.
 *
 * Bounded on both ends. `date <= sessionDate` is what makes this a SNAPSHOT
 * loader and not a cache: a row for a session that has not finished cannot be
 * returned even if one somehow exists, so a bad capture cannot leak a
 * mid-session price into a figure captioned as a close.
 *
 * The floor is 30 days back. A symbol whose last capture is older than that has
 * effectively no snapshot, and returning one anyway would caption today's card
 * with a month-old date — technically true, and useless. Better that the card
 * says the figure is unavailable and why.
 *
 * Returns an empty map rather than throwing when the table is unreachable: a
 * missing fallback degrades the day figure, and must never take down the page
 * the figure is one line of.
 */
export async function loadDailySnapshots(
  client: Client,
  symbols: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, DaySnapshotInput>> {
  const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].filter(Boolean);
  if (unique.length === 0) return new Map();

  const sessionDate = lastCompletedSessionDate(now);
  if (sessionDate === null) return new Map();
  const floor = new Date(Date.parse(`${sessionDate}T00:00:00Z`) - MAX_LOOKBACK_DAYS * 86_400_000)
    .toISOString().slice(0, 10);

  const found = new Map<string, DaySnapshotInput>();
  for (const group of chunk(unique, SYMBOL_CHUNK)) {
    const { data, error } = await client
      .from('daily_snapshot')
      .select('symbol, date, close, prev_close, source')
      .in('symbol', group)
      .lte('date', sessionDate)
      .gte('date', floor)
      .order('date', { ascending: false });
    if (error || !data) continue;
    for (const row of data) {
      // Ordered newest-first, so the first row seen for a symbol is its latest.
      if (found.has(row.symbol)) continue;
      const close = Number(row.close);
      if (!Number.isFinite(close) || close <= 0) continue;
      const prevClose = row.prev_close === null ? null : Number(row.prev_close);
      found.set(row.symbol, {
        date: row.date,
        close,
        prevClose: prevClose !== null && Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
        source: row.source,
      });
    }
  }
  return found;
}

export interface CapturedClose {
  symbol: string;
  close: number;
  /** Close of the previous trading session, when the capture could establish one. */
  prevClose: number | null;
  source: string;
}

export interface CaptureResult {
  /** The trading date the rows were written for, or null when none was capturable. */
  date: string | null;
  written: number;
  skipped: number;
  /** Set when the run refused to write, with the reason. */
  refused: 'market-open' | 'not-a-trading-day' | 'no-completed-session' | null;
}

/**
 * Write one trading date's closes.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSALS ARE THE POINT
 * ---------------------------------------------------------------------------
 * A row in this table is a claim that a session FINISHED at this price, and
 * nothing downstream can tell a real close from a mid-session price once it is
 * written — they are the same two columns. So the guard lives here, before the
 * write, and not in the caller that happened to schedule it:
 *
 *  - refuses while the market is OPEN. A cron that fires early, a manual
 *    trigger, a retry that lands during the next session: all of them would
 *    otherwise stamp a live price as a close.
 *  - refuses when the target is not a trading date at all.
 *
 * Upsert on (symbol, date) so a re-run is safe and a late correction from the
 * provider replaces the earlier row rather than adding a second one.
 */
export async function captureDailyCloses(
  client: Client,
  closes: readonly CapturedClose[],
  now: Date = new Date(),
): Promise<CaptureResult> {
  if (marketSession(now) === 'OPEN') {
    return { date: null, written: 0, skipped: closes.length, refused: 'market-open' };
  }
  const date = lastCompletedSessionDate(now);
  if (date === null) {
    return { date: null, written: 0, skipped: closes.length, refused: 'no-completed-session' };
  }
  if (!isTradingDate(date)) {
    return { date, written: 0, skipped: closes.length, refused: 'not-a-trading-day' };
  }

  const rows = closes.flatMap((entry) => {
    const symbol = entry.symbol.toUpperCase();
    if (!Number.isFinite(entry.close) || entry.close <= 0) return [];
    const prevClose = entry.prevClose !== null
      && Number.isFinite(entry.prevClose)
      && entry.prevClose > 0
      ? entry.prevClose
      : null;
    return [{
      symbol,
      date,
      close: entry.close,
      prev_close: prevClose,
      source: entry.source,
    }];
  });
  if (rows.length === 0) {
    return { date, written: 0, skipped: closes.length, refused: null };
  }

  let written = 0;
  for (const group of chunk(rows, SYMBOL_CHUNK)) {
    const { error } = await client
      .from('daily_snapshot')
      .upsert(group, { onConflict: 'symbol,date' });
    if (!error) written += group.length;
  }
  return { date, written, skipped: closes.length - written, refused: null };
}

/**
 * The previous session's close for each symbol, read back out of the table.
 *
 * The capture job uses this to fill `prev_close` when the provider's payload
 * does not carry one, which is the common case for the contract quotes. It
 * resolves the previous TRADING date explicitly rather than subtracting a day,
 * so a Monday capture reads Friday and never an empty Sunday.
 */
export async function loadPreviousCloses(
  client: Client,
  symbols: readonly string[],
  date: string,
): Promise<Map<string, number>> {
  const previous = previousTradingDate(date);
  const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].filter(Boolean);
  if (previous === null || unique.length === 0) return new Map();

  const found = new Map<string, number>();
  for (const group of chunk(unique, SYMBOL_CHUNK)) {
    const { data, error } = await client
      .from('daily_snapshot')
      .select('symbol, close')
      .in('symbol', group)
      .eq('date', previous);
    if (error || !data) continue;
    for (const row of data) {
      const close = Number(row.close);
      if (Number.isFinite(close) && close > 0) found.set(row.symbol, close);
    }
  }
  return found;
}
