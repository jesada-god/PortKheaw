import { NextResponse } from 'next/server';
import { resolveMaintenanceState } from '@/src/lib/maintenance/maintenance-server';

/**
 * The switch, for the notice page's recovery poller.
 *
 * Public and unauthenticated on purpose: the readers who need it are exactly the
 * ones currently locked out, and it discloses nothing beyond the notice already
 * printed on the page they are looking at. `is_admin` is deliberately not part
 * of the body — this endpoint answers "is the product back?", and nothing else.
 *
 * `no-store` is not decoration. A cached answer here is a reader who stays on
 * the maintenance page after the product came back, which is a worse outage than
 * the one that just ended.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const state = await resolveMaintenanceState();
  return NextResponse.json(
    {
      maintenance: state.enabled,
      message: state.message,
      expectedResumeAt: state.expectedResumeAt,
      startedAt: state.startedAt,
    },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  );
}
