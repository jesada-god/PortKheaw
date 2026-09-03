/**
 * WHAT THE S&P 500 DID ON EACH DAY THIS CALENDAR ALREADY HAS A RELEASE FOR.
 *
 * ===========================================================================
 * IT MEASURES. IT DOES NOT EXPLAIN, AND IT INVENTS NOTHING.
 * ===========================================================================
 * Every number this writes is a close-to-close change on a session that
 * happened, taken from bars this product already reads for `^GSPC`. It attaches
 * no cause: that the index fell 1.1% on a day CPI was published is a fact, and
 * "because of CPI" is a claim nobody here computed. The wording rules that keep
 * the rendered version on the right side of that line live in
 * `src/lib/market-events/reactions.ts`.
 *
 * It also invents no release dates. It reads the calendar it is given and joins
 * what is already there; a calendar with no history produces an empty file,
 * which is the state it is in today.
 *
 * ===========================================================================
 * ONE REQUEST, AND NONE AT ALL WHEN THERE IS NOTHING TO JOIN
 * ===========================================================================
 * Five years of `^GSPC` daily bars is a single Yahoo chart call through
 * `getYahooChartProvider` — the same provider and the same class the Market
 * Status card already quotes `^GSPC` through, so nothing new is wired in and no
 * key is added.
 *
 * The eligible rows are counted BEFORE the provider is touched. With no past
 * release in the file there is nothing a bar could be joined to, so the request
 * is never made and the empty file is written anyway. "No history yet" is a
 * successful run, not an error.
 *
 * ===========================================================================
 * THE JOIN IS ON THE NEW YORK DAY. THIS IS THE WHOLE CORRECTNESS ARGUMENT.
 * ===========================================================================
 * The calendar is keyed in BANGKOK, because that is the day its reader lives
 * in. A trading session is keyed in NEW YORK. For an 8:30 a.m. release the two
 * agree; for a 2:00 p.m. FOMC statement they do not — that instant is the NEXT
 * day in Bangkok. Joining on the Bangkok key would match the December statement
 * to the session AFTER the one it moved, produce a plausible number, and be
 * wrong in a way no reader could detect.
 *
 * So both sides of the join go through `newYorkDayKey` from
 * `src/lib/market-events/time.ts`: the release instant, and the bar's own
 * timestamp. Not two converters that agree — the same function twice, so there
 * is no second answer available.
 *
 * ===========================================================================
 * A DAY WITH NO SESSION IS RECORDED, NEVER SLID
 * ===========================================================================
 * A release on a holiday has no close-to-close change, and the next session's
 * change is a different day's number. Sliding to it would manufacture a
 * measurement. Such rows go to `unmeasured` with the reason, so the gap is
 * visible in the file rather than absent from it.
 *
 * Run: npm run backfill:event-reactions
 */
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getYahooChartProvider } from '@/src/lib/market-data/candles';
import { isUsTradingDay, lastUsSessionClose } from '@/src/lib/market-data/us-market-calendar';
import { MARKET_EVENTS } from '@/src/lib/market-events/calendar';
import { releaseTimingOf, type ReleaseTiming } from '@/src/lib/market-events/release-timing';
import { newYorkDayKey } from '@/src/lib/market-events/time';
import type { MarketEvent } from '@/src/lib/market-events/types';

const OUT_PATH = path.resolve('src/data/market-event-reactions.json');
const BENCHMARK_SYMBOL = '^GSPC';

interface ReactionRow {
  eventId: string;
  kind: MarketEvent['kind'];
  /** The New York session the release fell in. */
  sessionDate: string;
  /** The session the change is measured FROM — the previous bar, not a date computed here. */
  previousSessionDate: string;
  close: number;
  previousClose: number;
  /** Close-to-close, in percent. */
  changePercent: number;
}

type UnmeasuredReason =
  /** The release day is not a US trading day at all. */
  | 'no-session'
  /** A trading day the provider returned no completed bar for. */
  | 'missing-bar'
  /** Inside the window, but the first bar in it — nothing to measure from. */
  | 'no-prior-session'
  /** Older than the history that was fetched. */
  | 'outside-history'
  /** The instant could not be read, so no New York day could be resolved. */
  | 'unreadable-instant';

interface UnmeasuredRow {
  eventId: string;
  kind: MarketEvent['kind'];
  newYorkDayKey: string | null;
  reason: UnmeasuredReason;
}

interface ReactionFile {
  schemaVersion: 1;
  _README: string[];
  generatedAt: string;
  benchmark: {
    symbol: string;
    labelTh: string;
    provider: string | null;
    measure: 'close-to-close';
  };
  history: { firstSessionDate: string | null; lastSessionDate: string | null; sessions: number };
  /*
   * THREE BUCKETS, NOT ONE LIST WITH A FIELD ON IT.
   *
   * A field would let a consumer concatenate the three by accident and print
   * them under one heading, which is the exact mistake the split is for. Making
   * them separate arrays means combining them has to be typed out.
   */
  beforeOpen: ReactionRow[];
  intraday: ReactionRow[];
  afterClose: ReactionRow[];
  unmeasured: UnmeasuredRow[];
}

const README: string[] = [
  'Generated by scripts/backfill-event-reactions.ts. Do not hand-edit: re-run it.',
  'Every number is a CLOSE-TO-CLOSE change on a session that happened. It carries no claim about cause.',
  'beforeOpen / intraday / afterClose are separate arrays because they are DIFFERENT MEASUREMENTS. An 8:30 a.m. ET release is contained by the session that follows it; a 2:00 p.m. FOMC statement is not - the same close-to-close number then includes a morning that happened before it. Do not concatenate them.',
  'The join is on the NEW YORK day, for the release instant and for the bar timestamp, through one converter (market-events/time.ts newYorkDayKey). The calendar is keyed in Bangkok and joining on that key would match an FOMC statement to the session after the one it moved.',
  'A release with no session that day is in `unmeasured` with a reason. Nothing is ever slid to the next session: that is a different day’s number.',
  'Empty arrays mean the calendar holds no past release yet, not that the fetch failed. See docs/market-events-backfill.md.',
];

function ratioPercent(close: number, previousClose: number): number {
  // Rounded to the precision the reader is shown, so the file cannot imply more.
  return Math.round(((close - previousClose) / previousClose) * 10_000) / 100;
}

async function main(): Promise<void> {
  const now = new Date();
  const lastSession = lastUsSessionClose(now.toISOString());
  if (!lastSession) throw new Error('could not resolve the last completed US session');

  /*
   * ELIGIBLE = the release's New York day is on or before the last session that
   * has actually CLOSED. A release earlier today has no close-to-close change
   * yet, and a bar for a session in progress is a partial one.
   */
  const eligible: Array<{ event: MarketEvent; dayKey: string }> = [];
  const unmeasured: UnmeasuredRow[] = [];

  for (const event of MARKET_EVENTS) {
    const dayKey = newYorkDayKey(event.at);
    if (!dayKey) {
      unmeasured.push({ eventId: event.id, kind: event.kind, newYorkDayKey: null, reason: 'unreadable-instant' });
      continue;
    }
    if (dayKey > lastSession.date) continue; // Not past yet. Not a gap.
    if (!isUsTradingDay(dayKey)) {
      unmeasured.push({ eventId: event.id, kind: event.kind, newYorkDayKey: dayKey, reason: 'no-session' });
      continue;
    }
    eligible.push({ event, dayKey });
  }

  const file: ReactionFile = {
    schemaVersion: 1,
    _README: README,
    generatedAt: now.toISOString(),
    benchmark: {
      symbol: BENCHMARK_SYMBOL,
      labelTh: 'S&P 500',
      provider: null,
      measure: 'close-to-close',
    },
    history: { firstSessionDate: null, lastSessionDate: null, sessions: 0 },
    beforeOpen: [],
    intraday: [],
    afterClose: [],
    unmeasured,
  };

  if (eligible.length === 0) {
    /*
      No request. There is nothing a bar could be joined to, and spending a
      provider call to prove it would be spending it on nothing.
    */
    console.log('No past release in the calendar. Nothing to join, and no request made.');
    console.log(`  unmeasured rows: ${unmeasured.length}`);
    write(file);
    return;
  }

  console.log(`Joining ${eligible.length} past release(s) against ${BENCHMARK_SYMBOL}…`);
  const candles = await getYahooChartProvider().getCandles({
    symbol: BENCHMARK_SYMBOL,
    interval: '1D',
    sourceInterval: '1D',
    range: '5y',
    adjusted: true,
    session: 'regular',
  });

  /*
   * The bars, keyed by their own New York day — the SAME converter the release
   * instants went through. A partial bar is the session still in progress and
   * has no close to compare; it is dropped before anything is keyed.
   */
  const sessions: Array<{ dayKey: string; close: number }> = [];
  for (const candle of candles.candles) {
    if (candle.partial) continue;
    const dayKey = newYorkDayKey(new Date(candle.timestamp * 1_000));
    if (!dayKey) continue;
    sessions.push({ dayKey, close: candle.adjustedClose ?? candle.close });
  }
  sessions.sort((left, right) => (left.dayKey < right.dayKey ? -1 : left.dayKey > right.dayKey ? 1 : 0));

  const indexOf = new Map(sessions.map((session, index) => [session.dayKey, index]));
  const earliest = sessions[0]?.dayKey ?? null;

  file.benchmark.provider = candles.provider;
  file.history = {
    firstSessionDate: earliest,
    lastSessionDate: sessions[sessions.length - 1]?.dayKey ?? null,
    sessions: sessions.length,
  };

  const bucket: Record<ReleaseTiming, ReactionRow[]> = {
    beforeOpen: file.beforeOpen,
    intraday: file.intraday,
    afterClose: file.afterClose,
  };

  for (const { event, dayKey } of eligible) {
    const index = indexOf.get(dayKey);
    if (index === undefined) {
      unmeasured.push({
        eventId: event.id,
        kind: event.kind,
        newYorkDayKey: dayKey,
        reason: earliest !== null && dayKey < earliest ? 'outside-history' : 'missing-bar',
      });
      continue;
    }
    const previous = sessions[index - 1];
    if (!previous) {
      unmeasured.push({ eventId: event.id, kind: event.kind, newYorkDayKey: dayKey, reason: 'no-prior-session' });
      continue;
    }
    const timing = releaseTimingOf(event.at);
    if (!timing) {
      unmeasured.push({ eventId: event.id, kind: event.kind, newYorkDayKey: dayKey, reason: 'unreadable-instant' });
      continue;
    }
    bucket[timing].push({
      eventId: event.id,
      kind: event.kind,
      sessionDate: dayKey,
      previousSessionDate: previous.dayKey,
      close: sessions[index].close,
      previousClose: previous.close,
      changePercent: ratioPercent(sessions[index].close, previous.close),
    });
  }

  console.log(`  sessions fetched : ${sessions.length} (${file.history.firstSessionDate} → ${file.history.lastSessionDate})`);
  console.log(`  before open      : ${file.beforeOpen.length}`);
  console.log(`  intraday (FOMC)  : ${file.intraday.length}`);
  console.log(`  after close      : ${file.afterClose.length}`);
  console.log(`  unmeasured       : ${unmeasured.length}`);
  for (const row of unmeasured) console.log(`      ${row.eventId} — ${row.reason}`);
  write(file);
}

/**
 * Writes only when something other than the timestamp changed.
 *
 * `generatedAt` moves on every run by definition, so writing unconditionally
 * would put a one-line diff in front of a reviewer for a run that found nothing
 * new. The timestamp is still worth keeping — it says how old the numbers are —
 * it just should not be the only reason the file appears in a commit.
 */
function write(file: ReactionFile): void {
  const next = `${JSON.stringify(file, null, 2)}\n`;
  let previous: string | null = null;
  try {
    previous = readFileSync(OUT_PATH, 'utf8');
  } catch {
    previous = null;
  }
  if (previous !== null) {
    const strip = (text: string) => text.replace(/"generatedAt": "[^"]*"/, '"generatedAt": ""');
    if (strip(previous) === strip(next)) {
      console.log(`Unchanged, so ${path.relative(process.cwd(), OUT_PATH)} was left alone.`);
      return;
    }
  }
  writeFileSync(OUT_PATH, next, 'utf8');
  console.log(`Wrote ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((error: unknown) => {
  /*
    A failed fetch must not leave a half-written file behind. `write` is only
    reached on the success path, so the previous generation — or no file at all —
    survives a provider outage, and the run exits non-zero so a caller notices.
  */
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
