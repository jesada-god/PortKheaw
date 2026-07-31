import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import {
  loadIndustryDashboard,
  loadMarketIndices,
  loadWatchlistPrices,
} from '@/src/lib/overview/service';
import { loadMarketBreadth } from '@/src/lib/overview/market-breadth';

const sectionSchema = z.enum(['market', 'industries', 'watchlist', 'breadth']);

export async function GET(request: NextRequest) {
  const parsed = sectionSchema.safeParse(request.nextUrl.searchParams.get('section'));
  if (!parsed.success) {
    return NextResponse.json(
      { data: null, error: { code: 'INVALID_SECTION', message: 'ไม่พบส่วนข้อมูลที่ต้องการ' } },
      { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  const generatedAt = new Date().toISOString();
  try {
    let value: unknown;
    let related: {
      breadth?: unknown;
      industryData: {
        state: string;
        classificationUpdatedAt: string;
        quotesUpdatedAt: string | null;
        candidateCount: number;
        completedCount: number;
        deadlineReached: boolean;
      };
    } | null = null;
    if (parsed.data === 'market') {
      value = await loadMarketIndices(new Date(generatedAt), true);
    } else if (parsed.data === 'watchlist') {
      const client = await createClient();
      const user = client ? (await client.auth.getUser()).data.user : null;
      const symbols = client && user
        ? (await new WatchlistRepository(client).getDefault()).items.map((item) => item.symbol)
        : [];
      value = await loadWatchlistPrices(symbols, new Date(generatedAt), true);
    } else if (parsed.data === 'breadth') {
      value = await loadMarketBreadth(new Date(generatedAt), true);
    } else {
      const result = await loadIndustryDashboard(new Date(generatedAt), true);
      value = result.industries;
      related = {
        industryData: {
          state: result.state,
          classificationUpdatedAt: result.classificationUpdatedAt,
          quotesUpdatedAt: result.quotesUpdatedAt,
          candidateCount: result.candidateCount,
          completedCount: result.completedCount,
          deadlineReached: result.deadlineReached,
        },
      };
    }
    return NextResponse.json({
      data: { section: parsed.data, value, related, generatedAt },
      error: null,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json({
      data: null,
      error: {
        code: 'OVERVIEW_SECTION_TEMPORARILY_UNAVAILABLE',
        message: 'ข้อมูลส่วนนี้ยังไม่พร้อม กรุณาลองใหม่',
      },
    }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
