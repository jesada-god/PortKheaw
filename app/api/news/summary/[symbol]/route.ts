import { handleNewsSummaryRequest } from '@/src/lib/news/summary-route';

export async function GET(
  _request: Request,
  context: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await context.params;
  return handleNewsSummaryRequest(symbol);
}
