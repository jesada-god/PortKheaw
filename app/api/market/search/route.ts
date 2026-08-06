import { after, type NextRequest } from 'next/server';
import { getMarketDataProvider } from '@/src/lib/market-data';
import { marketDataResponse } from '@/src/lib/market-data/route';
import { searchParamsSchema } from '@/src/lib/market-data/validation';

/** How many results a single search may warm logos for. */
const SEARCH_LOGO_WARM_LIMIT = 5;

export async function GET(request: NextRequest) {
  return marketDataResponse(async () => {
    const { q, assetType, includeDelisted, limit } = searchParamsSchema.parse({
      q: request.nextUrl.searchParams.get('q') ?? '',
      assetType: request.nextUrl.searchParams.get('assetType') ?? undefined,
      includeDelisted: request.nextUrl.searchParams.get('includeDelisted') ?? undefined,
      limit: request.nextUrl.searchParams.get('limit') ?? undefined,
    });
    const { searchInstrumentMaster } = await import('@/src/lib/instruments/search');
    const master = await searchInstrumentMaster(q, { assetType, includeDelisted, limit });
    const { resolveInstrumentSearch } = await import('@/src/lib/instruments/search-resolution');
    const result = await resolveInstrumentSearch(
      master,
      getMarketDataProvider,
      q,
      { assetType, includeDelisted, limit },
    );

    /*
     * Search is where a symbol is seen for the first time, so it is where the
     * pipeline starts working on its logo — after the response, never in front
     * of it. The reader waits for nothing; by the time they open the result or
     * add it to a list, the logo is usually already stored.
     *
     * Bounded on purpose: the first few hits only, two at a time, and each
     * symbol deduped and remembered by `ensureInstrumentLogos`, so typing does
     * not turn into a burst of provider requests.
     */
    const missing = result.data
      .filter((item) => !item.logoUrl)
      .map((item) => ({ symbol: item.symbol }));
    if (missing.length > 0) {
      after(async () => {
        const { ensureInstrumentLogos } = await import('@/src/lib/instruments/presentation');
        await ensureInstrumentLogos(missing, {
          limit: SEARCH_LOGO_WARM_LIMIT,
          concurrency: 2,
          background: true,
        }).catch(() => new Map());
      });
    }
    return result;
  });
}
