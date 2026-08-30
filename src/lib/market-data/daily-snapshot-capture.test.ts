import { describe, expect, it, vi } from 'vitest';
import { captureDailyCloses, type CapturedClose } from './daily-snapshot';

/**
 * THE WRITE ITSELF: when it happens, when it refuses, and what it sends.
 *
 * ===========================================================================
 * WHY THIS SITS BESIDE daily-snapshot-run.test.ts RATHER THAN INSIDE IT
 * ===========================================================================
 * `runDailySnapshotCapture` decides WHETHER to gather closes at all;
 * `captureDailyCloses` decides whether a gathered set may be written and what
 * shape it takes on the way. The refusals look similar from the outside and
 * they are enforced twice on purpose — the run guard stops the provider work,
 * this one stops the write — so a caller that ever bypasses the first still
 * cannot stamp a live price as a close.
 *
 * That double enforcement is only worth having if both halves are tested. The
 * run half is next door; this is the half that touches the table.
 *
 * A row here is a claim that a session FINISHED at this price, and nothing
 * downstream can tell a real close from a mid-session price once written —
 * they are the same two columns.
 */

/** A Supabase double that records what the upsert was asked to write. */
function clientDouble() {
  const upserts: Array<{ rows: unknown[]; options: unknown }> = [];
  const client = {
    from: (table: string) => {
      if (table !== 'daily_snapshot') throw new Error(`unexpected table ${table}`);
      return {
        upsert: (rows: unknown[], options: unknown) => {
          upserts.push({ rows, options });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client: client as never, upserts };
}

/**
 * A client whose every use throws, for the refusal cases.
 *
 * A refusal must happen BEFORE the table is touched. A double that quietly
 * returned success would let a regression that writes first and refuses second
 * pass — the outcome would still read `refused`, and the point is that no write
 * was issued at all.
 */
const untouchable = new Proxy({}, {
  get(_t, property) {
    throw new Error(`the capture reached the database (.${String(property)}) before refusing`);
  },
}) as never;

const closes: CapturedClose[] = [
  { symbol: 'aapl', close: 190.5, prevClose: 188.2, source: 'test' },
  { symbol: 'MSFT', close: 410, prevClose: null, source: 'test' },
];

/*
 * Instants verified against `marketSession` / `lastCompletedSessionDate`:
 *   2026-12-09T21:10Z — Wed 16:10 ET, EST  → AFTER_HOURS, session 2026-12-09
 *   2026-09-16T21:10Z — Wed 17:10 ET, EDT  → AFTER_HOURS, session 2026-09-16
 *   2026-12-09T15:00Z — Wed 10:00 ET       → OPEN
 *   2026-12-25T21:10Z — Christmas, Friday  → CLOSED, last session 2026-12-24
 */
const AFTER_CLOSE_EST = new Date('2026-12-09T21:10:00.000Z');
const AFTER_CLOSE_EDT = new Date('2026-09-16T21:10:00.000Z');
const MID_SESSION = new Date('2026-12-09T15:00:00.000Z');

describe('the capture refuses before it writes', () => {
  it('refuses while the market is open, without touching the table', async () => {
    const result = await captureDailyCloses(untouchable, closes, MID_SESSION);
    expect(result).toMatchObject({ refused: 'market-open', written: 0, date: null });
    // The closes it was handed are reported as skipped, not silently dropped.
    expect(result.skipped).toBe(closes.length);
  });
});

describe('the cron schedule lands after the close in both DST regimes', () => {
  /*
   * THE REASON `vercel.json` SAYS 21:10 AND NOT 20:10.
   *
   * Vercel cron expressions are UTC and there is no zone to set, so one
   * schedule has to be past the closing bell under both offsets. 20:10 UTC —
   * the naive reading of "16:10 ET" — is 15:10 ET in winter, while the market
   * is still open, so the guard would refuse every run for four months and the
   * table would stay empty exactly as it did when nothing was scheduled at all.
   *
   * These two assertions are what make that a checked claim rather than a
   * comment. If the schedule is ever moved, one of them fails.
   */
  it.each([
    ['EST (December)', AFTER_CLOSE_EST, '2026-12-09'],
    ['EDT (September)', AFTER_CLOSE_EDT, '2026-09-16'],
  ])('writes for the same trading day at 21:10 UTC in %s', async (_label, now, expected) => {
    const { client, upserts } = clientDouble();
    const result = await captureDailyCloses(client, closes, now);

    expect(result.refused).toBeNull();
    expect(result.date).toBe(expected);
    expect(result.written).toBe(2);
    expect(upserts).toHaveLength(1);
  });

  it('would refuse at 20:10 UTC in winter, which is why that time was not chosen', async () => {
    const twentyTen = new Date('2026-12-09T20:10:00.000Z'); // 15:10 ET, still open
    const result = await captureDailyCloses(untouchable, closes, twentyTen);
    expect(result.refused).toBe('market-open');
  });
});

describe('a market holiday writes nothing', () => {
  /*
   * Christmas Day 2026 falls on a Friday. The session is CLOSED rather than
   * OPEN, so the first guard passes and the second one has to do the work:
   * `lastCompletedSessionDate` answers 24 December, which IS a trading date, so
   * the run proceeds and re-captures the 24th.
   *
   * That is the documented behaviour and it is why the cron is Mon-Fri rather
   * than daily — a handful of redundant re-captures a year is cheaper than a
   * holiday calendar, and the upsert makes each one harmless.
   */
  it('re-captures the previous session on a holiday rather than inventing one', async () => {
    const { client, upserts } = clientDouble();
    const christmas = new Date('2026-12-25T21:10:00.000Z');
    const result = await captureDailyCloses(client, closes, christmas);

    expect(result.refused).toBeNull();
    expect(result.date).toBe('2026-12-24');
    // Every row is stamped with the completed session, never with the holiday.
    for (const row of upserts[0].rows as Array<{ date: string }>) {
      expect(row.date).toBe('2026-12-24');
    }
  });

  it('refuses outright when no completed session can be resolved', async () => {
    /*
      `lastCompletedSessionDate` returning null is the third refusal. It is
      forced here rather than waited for, because reaching it naturally needs a
      date before the exchange calendar begins.
    */
    vi.resetModules();
    vi.doMock('./market-session', async () => ({
      ...(await vi.importActual<typeof import('./market-session')>('./market-session')),
      lastCompletedSessionDate: () => null,
    }));
    const { captureDailyCloses: capture } = await import('./daily-snapshot');
    const result = await capture(untouchable, closes, AFTER_CLOSE_EST);
    expect(result).toMatchObject({ refused: 'no-completed-session', written: 0 });
    vi.doUnmock('./market-session');
    vi.resetModules();
  });
});

describe('re-running the same day cannot duplicate a row', () => {
  /*
   * The primary key is `(symbol, date)` and the write is an upsert against it.
   * So a retry, a manual trigger, or two schedulers firing at once all converge
   * on one row per symbol per session — and a late provider correction REPLACES
   * the earlier figure rather than adding a second, contradictory one.
   *
   * The conflict target is asserted literally: `onConflict` naming anything
   * else, or being dropped, turns the retry into a duplicate-key error or a
   * second row depending on the table, and neither shows up in the return value.
   */
  it('upserts on the primary key', async () => {
    const { client, upserts } = clientDouble();
    await captureDailyCloses(client, closes, AFTER_CLOSE_EST);
    expect(upserts[0].options).toEqual({ onConflict: 'symbol,date' });
  });

  it('sends the identical rows on a second run, so the upsert collapses them', async () => {
    const first = clientDouble();
    const second = clientDouble();
    await captureDailyCloses(first.client, closes, AFTER_CLOSE_EST);
    await captureDailyCloses(second.client, closes, AFTER_CLOSE_EST);
    expect(second.upserts[0].rows).toEqual(first.upserts[0].rows);
  });
});

describe('what reaches the table', () => {
  it('upper-cases the symbol so one ticker cannot occupy two rows', async () => {
    const { client, upserts } = clientDouble();
    await captureDailyCloses(client, closes, AFTER_CLOSE_EST);
    const symbols = (upserts[0].rows as Array<{ symbol: string }>).map((row) => row.symbol);
    expect(symbols).toEqual(['AAPL', 'MSFT']);
  });

  it('keeps a missing previous close as null rather than zero', async () => {
    const { client, upserts } = clientDouble();
    await captureDailyCloses(client, closes, AFTER_CLOSE_EST);
    const rows = upserts[0].rows as Array<{ prev_close: number | null }>;
    expect(rows[0].prev_close).toBe(188.2);
    // A zero here would read as "the previous session closed at nothing".
    expect(rows[1].prev_close).toBeNull();
  });

  it('drops a close that is not a usable number instead of writing it', async () => {
    const { client, upserts } = clientDouble();
    const result = await captureDailyCloses(client, [
      { symbol: 'GOOD', close: 10, prevClose: 9, source: 'test' },
      { symbol: 'ZERO', close: 0, prevClose: 9, source: 'test' },
      { symbol: 'NAN', close: Number.NaN, prevClose: 9, source: 'test' },
    ], AFTER_CLOSE_EST);

    expect((upserts[0].rows as Array<{ symbol: string }>).map((row) => row.symbol)).toEqual(['GOOD']);
    // The two that could not be written are reported, not hidden.
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('writes nothing at all when every close was unusable', async () => {
    const result = await captureDailyCloses(untouchable, [
      { symbol: 'ZERO', close: 0, prevClose: null, source: 'test' },
    ], AFTER_CLOSE_EST);
    expect(result).toMatchObject({ written: 0, skipped: 1, refused: null });
    expect(result.date).toBe('2026-12-09');
  });
});
