import { describe, expect, it } from 'vitest';

/**
 * THE WRITER GUARD ON THE DAILY CAPTURE.
 *
 * ===========================================================================
 * WHY THIS IS WORTH A TEST OF ITS OWN
 * ===========================================================================
 * The capture is the one thing in this product that runs unattended, writes to
 * a table nobody looks at, and is triggered by a scheduler whose firing time is
 * configured outside the repository. Every one of those makes a mistake here
 * quiet: a run that fires at the wrong hour does not fail, it writes a *wrong
 * close* — a mid-session price recorded as the day's official one — and every
 * page that later reads it reports that number as settled fact.
 *
 * So the guard is what makes the scheduling decision low-stakes. As long as a
 * run refuses while the market is open and refuses for a date that is not a
 * completed session, firing early or on a public holiday costs nothing and the
 * exact minute of the cron stops being a correctness question.
 *
 * `docs/operations/daily-snapshot-verification.md` makes that claim on this
 * function's behalf when it explains why a fixed UTC cron drifting an hour
 * across the DST boundary is acceptable. This file is what entitles it to.
 *
 * ===========================================================================
 * THE CLIENT IS A THROWING PROXY, ON PURPOSE
 * ===========================================================================
 * A refusal must happen BEFORE the database is touched. Passing a stub that
 * quietly returns empty results would let a regression that queries first and
 * refuses second pass this test — the outcome would still be `refused`, and the
 * point is that no query was issued at all. Any property access on this client
 * throws, so reaching for it is the failure rather than a detail of it.
 */

import { runDailySnapshotCapture } from './daily-snapshot-run';

type Client = Parameters<typeof runDailySnapshotCapture>[0];

const untouchable = new Proxy({}, {
  get(_target, property) {
    throw new Error(
      `the capture touched the database (.${String(property)}) before refusing`,
    );
  },
}) as Client;

/*
 * Instants checked against `marketSession` rather than assumed:
 *   2026-08-31T15:00Z — Monday 11:00 ET, mid-session      → OPEN
 *   2026-08-30T15:00Z — Sunday                            → CLOSED
 *   2026-09-07T15:00Z — Labor Day, a US market holiday    → CLOSED
 */
const MID_SESSION = new Date('2026-08-31T15:00:00.000Z');

describe('the daily snapshot capture refuses before it writes', () => {
  it('refuses while the market is open, without touching the database', async () => {
    const result = await runDailySnapshotCapture(untouchable, MID_SESSION);
    expect(result.refused).toBe('market-open');
    expect(result.written).toBe(0);
    expect(result.date).toBeNull();
  });

  /*
   * A refusal is a 200 with a reason, not an error — a scheduler that fires on
   * a holiday has not failed, there was simply nothing to capture. The route
   * returns whatever this hands back, so "refused" must be a value rather than
   * a throw or the dashboard would show red on every public holiday.
   */
  it('reports a refusal as a result rather than throwing', async () => {
    await expect(runDailySnapshotCapture(untouchable, MID_SESSION)).resolves.toBeTruthy();
  });

  it('writes nothing on any of the refusal paths', async () => {
    const result = await runDailySnapshotCapture(untouchable, MID_SESSION);
    expect(result).toMatchObject({ written: 0, skipped: 0, symbols: 0, contracts: 0 });
  });

  /*
   * Outside the session the guard opens, and the very next thing the function
   * does is ask the database which symbols are held. That is the boundary this
   * asserts: the throwing client is now REACHED, which proves the open-market
   * refusals above returned early rather than because the function never
   * queries at all.
   *
   * Without this, all three tests above would still pass against a
   * `runDailySnapshotCapture` that had been gutted to `return empty`.
   */
  it('proceeds to the held-symbol query once the session is over', async () => {
    const afterHours = new Date('2026-08-31T21:00:00.000Z'); // Monday 17:00 ET
    await expect(runDailySnapshotCapture(untouchable, afterHours))
      .rejects.toThrow(/touched the database/);
  });
});

describe('the capture is scheduled, and the schedule is the checked one', () => {
  /*
   * REPLACES the "no scheduler exists" reminder that stood here while the
   * endpoint was orphaned. That test failed the moment `vercel.json` appeared,
   * which is what sent whoever added it back to the verification doc — this is
   * the note it was pointing at, now that there is something to assert.
   *
   * What is pinned is the SCHEDULE, because the value is not arbitrary and the
   * reason it is not arbitrary lives three files away. Vercel cron expressions
   * are UTC with no zone to set, so one schedule has to be past the closing
   * bell under both offsets:
   *
   *     20:10 UTC → 15:10 ET in winter — market OPEN, refused for four months
   *     21:10 UTC → 16:10 ET in winter, 17:10 ET in summer — after the close
   *
   * `daily-snapshot-capture.test.ts` proves both halves of that against the
   * real session functions. This asserts the deployed file still says what
   * those tests were written about.
   */
  it('schedules /api/cron/daily-snapshot at 21:10 UTC, Monday to Friday', async () => {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(
      readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'),
    ) as { crons?: Array<{ path: string; schedule: string }> };

    const capture = config.crons?.find((job) => job.path === '/api/cron/daily-snapshot');
    expect(capture, 'the capture must be scheduled in vercel.json').toBeDefined();
    expect(capture!.schedule).toBe('10 21 * * 1-5');
  });

  /*
   * `/api/cron/alerts` must NOT come back here. It runs from Supabase pg_cron
   * (`portkheaw-background-notifications`, every 15 minutes), and a Vercel cron
   * beside it would double-fire the notification pass — two schedulers for one
   * endpoint, each invisible from the other's dashboard.
   *
   * This is the specific mistake this file exists to prevent, because the
   * obvious way to "restore" vercel.json is to put back what was deleted.
   */
  it('does not re-add the alerts cron, which lives in Supabase pg_cron', async () => {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(
      readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8'),
    ) as { crons?: Array<{ path: string }> };
    expect(config.crons?.map((job) => job.path)).toEqual(['/api/cron/daily-snapshot']);
  });

  /*
   * And no migration schedules the capture either. Two schedulers for one
   * endpoint is the same defect in the other direction, and it is reachable by
   * somebody following the pg_cron pattern the alerts job set.
   */
  it('is not also scheduled from a migration', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const migrations = new URL('../../../supabase/migrations/', import.meta.url);
    const scheduled = readdirSync(migrations)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => {
        const sql = readFileSync(new URL(file, migrations), 'utf8');
        return sql.includes('cron.schedule') && sql.includes('daily-snapshot');
      });
    expect(scheduled).toEqual([]);
  });
});
