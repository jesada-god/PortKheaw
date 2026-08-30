import { describe, expect, it, vi } from 'vitest';

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
 * function's behalf while reporting that the scheduler was never wired up. This
 * file is what entitles it to.
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

describe('the capture is scheduled nowhere in this repository', () => {
  /*
   * A regression test for the FINDING, not for the code.
   *
   * The route's header documents a 16:10 ET slot that nothing implements: there
   * is no `vercel.json` (it was deleted in dcbfa99 when notifications moved to
   * Supabase pg_cron) and no migration schedules this endpoint. That is recorded
   * in docs/operations/daily-snapshot-verification.md.
   *
   * This test does not demand a scheduler — choosing the mechanism is a decision
   * that has not been made. It fails when one APPEARS, so that whoever adds it
   * is sent to the document to update the finding and record which DST
   * behaviour they chose, rather than leaving a doc that says "never scheduled"
   * next to a live cron.
   */
  it('still has no scheduler, and this test is the reminder to update the doc when one is added', async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const root = new URL('../../../', import.meta.url);

    expect(
      existsSync(new URL('vercel.json', root)),
      'A vercel.json appeared — if it schedules /api/cron/daily-snapshot, update '
      + 'docs/operations/daily-snapshot-verification.md and delete this test.',
    ).toBe(false);

    const migrations = new URL('supabase/migrations/', root);
    const scheduled = readdirSync(migrations)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => {
        const sql = readFileSync(new URL(file, migrations), 'utf8');
        return sql.includes('cron.schedule') && sql.includes('daily-snapshot');
      });
    expect(
      scheduled,
      'A migration now schedules the daily snapshot — update the verification doc.',
    ).toEqual([]);
  });
});
