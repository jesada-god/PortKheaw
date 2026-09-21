import type { NextRequest } from 'next/server';
import { guardAuthenticatedMarketRoute } from '@/src/lib/market-data/api-access';
import { handleMarketNewsSummaryRequest } from '@/src/lib/news/market-summary-route';

/**
 * The market-wide AI summary card, for the dashboard.
 *
 * Same reasoning as `/api/news`: its only caller is `NewsFeed` on `/`, which
 * now needs a session. This one is the more expensive of the two — a miss is a
 * language-model call, shared through Redis but still bought by somebody — so
 * leaving it open would be paying for anonymous traffic on a page anonymous
 * visitors can no longer reach.
 */
export async function GET(request: NextRequest) {
  const access = await guardAuthenticatedMarketRoute(request, 'news-market-summary');
  if (access.refusal) return access.refusal;
  return handleMarketNewsSummaryRequest();
}
