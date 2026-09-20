import { NextRequest, NextResponse } from 'next/server';
import { guardAuthenticatedMarketRoute } from '@/src/lib/market-data/api-access';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { currencySchema, fxApiEnvelopeSchema } from '@/src/lib/market-data/fx/types';

/**
 * USD/THB, for the portfolio and the simulator.
 *
 * Both callers now sit behind a session — `/portfolio` always did, `/tools/*`
 * does as of the public/authenticated split — so this endpoint has no
 * signed-out caller left and stops being reachable without one. It already
 * answered `private`, so nothing about caching changes.
 */
export async function GET(request: NextRequest) {
  const access = await guardAuthenticatedMarketRoute(request, 'fx-rate');
  if (access.refusal) return access.refusal;

  const base = currencySchema.safeParse(request.nextUrl.searchParams.get('base'));
  const quote = currencySchema.safeParse(request.nextUrl.searchParams.get('quote'));
  if (!base.success || !quote.success) return NextResponse.json({ data: null, error: 'รองรับเฉพาะ USD และ THB' }, { status: 400 });
  if (base.data === quote.data) return NextResponse.json({ data: null, error: 'กรุณาระบุคู่สกุลเงินที่ต่างกัน' }, { status: 400 });
  try {
    const result = await getFxRate(base.data, quote.data);
    if (!result.quote) return NextResponse.json({ data: null, error: 'ไม่มีอัตราแลกเปลี่ยนจริงหรืออัตราที่บันทึกไว้' }, { status: 503 });
    const warning = result.quote.stale ? 'กำลังใช้อัตราแลกเปลี่ยนล่าสุดที่บันทึกไว้' : null;
    const envelope = fxApiEnvelopeSchema.parse({ data: { ...result.quote, warning } });
    return NextResponse.json(envelope, {
      headers: { 'Cache-Control': 'private, max-age=60, stale-while-revalidate=840' },
    });
  } catch {
    return NextResponse.json({ data: null, error: 'ไม่สามารถโหลดอัตราแลกเปลี่ยนได้' }, { status: 503 });
  }
}
