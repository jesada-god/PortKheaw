import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { serverEnv } from '@/src/config/env/server';
import { createAdminClient } from '@/src/lib/supabase/admin';
import { runDailySnapshotCapture } from '@/src/lib/market-data/daily-snapshot-run';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Post-market capture of the day's closes.
 *
 * Schedule it after the closing bell — 16:10 ET is the intended slot, which
 * leaves the provider ten minutes to settle its official close and still lands
 * well inside the after-hours window. Firing it early is not a data hazard: the
 * run refuses to write while the market is open, and refuses again for any
 * target date that is not a trading date. A run that refuses returns 200 with
 * the reason, because a scheduler that fires on a public holiday has not
 * failed — there was simply nothing to capture.
 *
 * Same bearer-secret shape as `/api/cron/alerts`, compared in constant time.
 */
function authorized(request: NextRequest): boolean {
  const expected = serverEnv.CRON_SECRET;
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected); const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const client = createAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Daily snapshot capture is not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json({ data: await runDailySnapshotCapture(client) });
  } catch {
    return NextResponse.json({ error: 'Daily snapshot capture failed' }, { status: 503 });
  }
}
