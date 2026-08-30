import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * The capture endpoint: who may call it, and what it says afterwards.
 *
 * ===========================================================================
 * WHY THE LOG LINES ARE ASSERTED AND NOT JUST THE RESPONSE
 * ===========================================================================
 * This job's characteristic failure is silence. A run that refused, a run that
 * threw, and a run that never fired all leave the same empty table, and for the
 * weeks this endpoint existed unscheduled there was no way to tell them apart
 * without querying production.
 *
 * The log line is the thing that distinguishes them from the Vercel dashboard
 * alone, so it is part of the contract rather than a debugging aid — which
 * means it is tested like one.
 *
 * The capture itself is stubbed here. Its refusals are proved against the real
 * function in `src/lib/market-data/daily-snapshot-run.test.ts`; this file is
 * about the route around it.
 */

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  runDailySnapshotCapture: vi.fn(),
}));

vi.mock('@/src/config/env/server', () => ({
  serverEnv: { CRON_SECRET: 'cron-secret' },
}));
vi.mock('@/src/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock('@/src/lib/market-data/daily-snapshot-run', () => ({
  runDailySnapshotCapture: mocks.runDailySnapshotCapture,
}));

import { GET } from './route';

const URL_ = 'https://portkheaw.vercel.app/api/cron/daily-snapshot';

const request = (authorization?: string) => new NextRequest(
  URL_,
  authorization === undefined ? undefined : { headers: { authorization } },
);

const CAPTURED = {
  date: '2026-12-09',
  written: 12,
  skipped: 0,
  symbols: 10,
  contracts: 2,
  unpriced: 0,
  refused: null,
};

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

/** The parsed audit lines this run emitted, in order. */
const lines = (spy: typeof info) =>
  spy.mock.calls.map(([payload]) => JSON.parse(String(payload)) as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAdminClient.mockReturnValue({ admin: true });
  mocks.runDailySnapshotCapture.mockResolvedValue(CAPTURED);
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authorization', () => {
  it('rejects a caller with no Authorization header', async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.runDailySnapshotCapture).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    const response = await GET(request('Bearer not-the-secret'));
    expect(response.status).toBe(401);
    expect(mocks.runDailySnapshotCapture).not.toHaveBeenCalled();
  });

  /*
   * A wrong secret of a DIFFERENT LENGTH must be rejected without reaching
   * `timingSafeEqual`, which throws on mismatched buffers. The length guard in
   * the route is what turns that throw into a 401.
   */
  it('rejects a secret of the wrong length without throwing', async () => {
    const response = await GET(request('Bearer short'));
    expect(response.status).toBe(401);
  });

  /*
   * A bare token with no `Bearer ` prefix is ACCEPTED, because the scheme is
   * stripped with a regex that simply does not match when it is absent. This
   * is the same behaviour `/api/cron/alerts` has had since it was written, and
   * it is recorded here rather than quietly tightened: the secret is still
   * required either way, so this is laxness about the header's shape and not
   * about its contents. Vercel always sends the `Bearer ` form.
   */
  it('accepts a bare token without the Bearer scheme, as /api/cron/alerts does', async () => {
    expect((await GET(request('cron-secret'))).status).toBe(200);
  });

  it('accepts the configured secret, case-insensitively on the scheme', async () => {
    expect((await GET(request('Bearer cron-secret'))).status).toBe(200);
    expect((await GET(request('bearer cron-secret'))).status).toBe(200);
  });

  it('logs a rejection as a warning, and names no secret', async () => {
    await GET(request('Bearer not-the-secret'));
    expect(lines(warn)).toEqual([
      { event: 'daily_snapshot_rejected', reason: 'unauthorized' },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('cron-secret');
  });
});

describe('a successful capture', () => {
  it('returns the run result', async () => {
    const response = await GET(request('Bearer cron-secret'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: CAPTURED });
  });

  /*
   * The counts are the whole reason this line exists: "it ran" is not the
   * question, "how many rows did it write, for which date" is.
   */
  it('logs the date and the counts', async () => {
    await GET(request('Bearer cron-secret'));
    expect(lines(info)).toEqual([{
      event: 'daily_snapshot_written',
      date: '2026-12-09',
      written: 12,
      skipped: 0,
      symbols: 10,
      contracts: 2,
      unpriced: 0,
    }]);
    expect(warn).not.toHaveBeenCalled();
  });

  /*
   * Counts are product facts; identities are not. `unpriced` is a count and is
   * expected to be present, which is why this checks for the things that would
   * actually be a leak — a ticker, an account, a money value — rather than for
   * substrings that a field NAME happens to contain.
   */
  it('names no symbol, account or price value in the log', async () => {
    mocks.runDailySnapshotCapture.mockResolvedValue({
      ...CAPTURED, symbols: 1, written: 1,
    });
    await GET(request('Bearer cron-secret'));
    const logged = JSON.stringify(info.mock.calls);
    for (const leak of ['AAPL', 'user_id', 'userId', 'closePrice', '@']) {
      expect(logged).not.toContain(leak);
    }
    // Only the keys the route promises, and nothing else.
    expect(Object.keys(lines(info)[0]).sort()).toEqual([
      'contracts', 'date', 'event', 'skipped', 'symbols', 'unpriced', 'written',
    ]);
  });
});

describe('a refusal is an outcome, not an error', () => {
  /*
   * All three refusals return 200. A scheduler that fires on a public holiday
   * has not failed — there was nothing to capture — and a red dashboard every
   * Thanksgiving would train whoever watches it to ignore the job.
   */
  it.each([
    ['market-open', null],
    ['not-a-trading-day', '2026-12-25'],
    ['no-completed-session', null],
  ])('answers 200 and logs the reason for %s', async (refused, date) => {
    mocks.runDailySnapshotCapture.mockResolvedValue({
      date, written: 0, skipped: 0, symbols: 0, contracts: 0, unpriced: 0, refused,
    });
    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { refused, written: 0 } });
    expect(lines(info)).toEqual([{ event: 'daily_snapshot_refused', refused, date }]);
    // Not a warning: this is the job working, not the job failing.
    expect(warn).not.toHaveBeenCalled();
  });

  /*
   * The distinction the empty table could never make. A refusal and a zero-row
   * success are different events with different log lines, so a reader of the
   * Vercel log can tell "nothing to do today" from "ran and found no symbols".
   */
  it('distinguishes a refusal from a run that wrote nothing', async () => {
    mocks.runDailySnapshotCapture.mockResolvedValue({
      date: '2026-12-09', written: 0, skipped: 0, symbols: 0, contracts: 0, unpriced: 0, refused: null,
    });
    await GET(request('Bearer cron-secret'));
    expect(lines(info)[0].event).toBe('daily_snapshot_written');
    expect(lines(info)[0].written).toBe(0);
  });
});

describe('failures', () => {
  it('answers 503 and warns when Supabase is not configured', async () => {
    mocks.createAdminClient.mockReturnValue(null);
    const response = await GET(request('Bearer cron-secret'));
    expect(response.status).toBe(503);
    expect(lines(warn)).toEqual([
      { event: 'daily_snapshot_failed', reason: 'not_configured' },
    ]);
  });

  it('answers 503 and warns when the capture throws', async () => {
    mocks.runDailySnapshotCapture.mockRejectedValue(new Error('provider down'));
    const response = await GET(request('Bearer cron-secret'));
    expect(response.status).toBe(503);
    expect(lines(warn)).toEqual([
      { event: 'daily_snapshot_failed', reason: 'capture_threw' },
    ]);
  });

  /*
   * The thrown error's own message must not reach the log. It can carry a
   * provider url, a key fragment, or a row of the payload that failed.
   */
  it('does not log the thrown error itself', async () => {
    mocks.runDailySnapshotCapture.mockRejectedValue(new Error('https://provider/?apikey=secret'));
    await GET(request('Bearer cron-secret'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('apikey');
  });
});
