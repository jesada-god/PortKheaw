import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { serverEnv } from '@/src/config/env/server';
import { createAdminClient } from '@/src/lib/supabase/admin';
import { runBackgroundAlerts } from '@/src/lib/alerts/background';
import { deliverPendingPushes } from '@/src/lib/push/service';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
  if (!client) return NextResponse.json({ error: 'Background alerts are not configured' }, { status: 503 });
  try {
    const notifications = await runBackgroundAlerts(client);
    try {
      const push = await deliverPendingPushes(client);
      return NextResponse.json({
        data: { ...notifications, push, pushUnavailable: false },
      });
    } catch {
      // Inbox creation is the source of truth. A delivery-provider or outbox
      // failure must not turn a successfully created Inbox item into a failed
      // notification run.
      return NextResponse.json({
        data: {
          ...notifications,
          push: null,
          pushUnavailable: true,
        },
      });
    }
  } catch {
    return NextResponse.json({ error: 'Background alert run failed' }, { status: 503 });
  }
}
