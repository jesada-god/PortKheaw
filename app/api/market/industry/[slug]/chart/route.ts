import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkMarketDataRateLimit } from '@/src/lib/market-data/api-rate-limit';
import { loadIndustryChart } from '@/src/lib/overview/service';

const slugSchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/);
const timeframeSchema = z.enum(['1D', '1W', '1M', '3M', '1Y']);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const rate = checkMarketDataRateLimit(request, 'candles');
  if (!rate.allowed) {
    return NextResponse.json(
      { data: null, error: { code: 'rate-limited', message: 'คำขอข้อมูลตลาดเกินขีดจำกัดชั่วคราว' } },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } },
    );
  }
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
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=86400' } },
  );
}
