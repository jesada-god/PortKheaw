import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { guardAuthenticatedMarketRoute } from '@/src/lib/market-data/api-access';
import { loadIndustryChart } from '@/src/lib/overview/service';

const slugSchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/);
const timeframeSchema = z.enum(['1D', '1W', '1M', '3M', '1Y']);

/**
 * The industry chart, for `/industry/{slug}` — a page that now requires a
 * session, so this does too.
 *
 * The address-keyed `checkMarketDataRateLimit` is replaced rather than added
 * to: with a session guaranteed, `guardAuthenticatedMarketRoute` can key the
 * limit on the ACCOUNT as well as the address, which is the bound that a
 * shared NAT does not break and a proxy pool does not dodge.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const access = await guardAuthenticatedMarketRoute(request, 'industry-chart');
  if (access.refusal) return access.refusal;

  const parsedSlug = slugSchema.safeParse(decodeURIComponent((await context.params).slug));
  const parsedTimeframe = timeframeSchema.safeParse(
    request.nextUrl.searchParams.get('timeframe') ?? '1D',
  );
  if (!parsedSlug.success || !parsedTimeframe.success) {
    return NextResponse.json(
      { data: null, error: { code: 'invalid-request', message: 'ช่วงเวลาหรืออุตสาหกรรมไม่ถูกต้อง' } },
      { status: 400 },
    );
  }
  const data = await loadIndustryChart(parsedSlug.data, parsedTimeframe.data);
  return NextResponse.json(
    { data, error: null },
    {
      /*
       * `private`, not `public`, now that a session is required.
       *
       * The chart itself is not personal, but a shared cache holding a 200 for
       * this URL would hand it to the next caller without a session — which is
       * the authentication above, undone by a cache header. `Vary: Cookie`
       * states the input that decides between the 200 and the 401.
       */
      headers: {
        'Cache-Control': 'private, max-age=60, stale-while-revalidate=840',
        Vary: 'Cookie',
      },
    },
  );
}
