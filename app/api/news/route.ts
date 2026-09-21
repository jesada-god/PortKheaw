import type { NextRequest } from 'next/server';
import { guardAuthenticatedMarketRoute } from '@/src/lib/market-data/api-access';
import { handleNewsRequest } from '@/src/lib/news/route';

/**
 * The news feed, for the dashboard.
 *
 * `/` requires a session as of the public/authenticated split, and `NewsFeed`
 * renders nowhere else — the stock page's news tab is `NewsTab`, which calls
 * `/api/news/summary/{symbol}` and stays public with that page.
 *
 * Worth gating rather than leaving open: every miss here is a call to the news
 * provider, and the endpoint takes a symbol list, so an unauthenticated caller
 * could walk the market through it.
 */
export async function GET(request: NextRequest) {
  const access = await guardAuthenticatedMarketRoute(request, 'news-feed');
  if (access.refusal) return access.refusal;
  return handleNewsRequest(request);
}
