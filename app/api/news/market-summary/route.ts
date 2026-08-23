import { handleMarketNewsSummaryRequest } from '@/src/lib/news/market-summary-route';

export function GET() {
  return handleMarketNewsSummaryRequest();
}
