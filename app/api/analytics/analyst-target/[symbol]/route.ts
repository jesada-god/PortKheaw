import { NextResponse } from 'next/server';
import { loadAnalystConsensus } from '@/src/lib/analytics/analyst-target/service';
import { checkAnalyticsRateLimit } from '@/src/lib/analytics/rate-limit';
import { getMarketDataGateway } from '@/src/lib/market-data/gateway/service';
import { loadResilientQuote } from '@/src/lib/market-data/quote-service';
import { symbolSchema } from '@/src/lib/market-data/validation';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ symbol: string }> },
): Promise<NextResponse> {
  const parsed = symbolSchema.safeParse((await context.params).symbol);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid-request', message: 'Malformed symbol' } },
      { status: 400 },
    );
  }
  const symbol = parsed.data;

  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const identity = forwardedFor && /^[0-9a-f:.]{3,64}$/i.test(forwardedFor)
    ? forwardedFor : 'anonymous';
  const rate = checkAnalyticsRateLimit(`analyst-target:${identity}`, 20);
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: {
          code: 'rate-limited',
          message: 'ระบบจำกัดคำขอชั่วคราว กรุณาลองใหม่ภายหลัง',
        },
      },
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
      },
    );
  }

  let listingCurrency: string | null = null;
  let currentPrice: number | null = null;
  let currentPriceAsOf: string | null = null;
  try {
    const gateway = getMarketDataGateway();
    const instrument = await gateway.resolveInstrument(symbol);
    listingCurrency = instrument.currency;
    const quote = await loadResilientQuote(symbol, gateway, undefined, instrument);
    listingCurrency = quote.data.currency ?? listingCurrency;
    currentPrice = Number.isFinite(quote.data.price) && quote.data.price > 0
      ? quote.data.price : null;
    currentPriceAsOf = quote.freshness.asOf;
  } catch {
    // Consensus may still be shown without upside/downside. We never replace a
    // missing accepted market quote with a provider target or zero.
  }

  const data = await loadAnalystConsensus(symbol, {
    listingCurrency,
    currentPrice,
    currentPriceAsOf,
  });
  return NextResponse.json(
    { data },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
