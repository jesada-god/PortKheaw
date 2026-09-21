import { getCompanyProfileService } from '@/src/lib/market-data';
import { companyProfileMarketDataResponse } from '@/src/lib/market-data/route';
import { symbolSchema } from '@/src/lib/market-data/validation';

export async function GET(_request: Request, context: { params: Promise<{ symbol: string }> }) {
  /*
   * `sharedCache`: a company profile is a public fact about a public company,
   * byte-identical for every reader, and `/stock/{symbol}` is a public page.
   * It is also the response most worth letting a CDN hold — behind it sits a
   * provider call this product pays for.
   *
   * Stated rather than inherited: public caching is opt-in as of the
   * cache-header change, because the old default put `public, s-maxage` on
   * anything with a freshness window, including responses behind a session.
   */
  return companyProfileMarketDataResponse(async () => {
    const { symbol: rawSymbol } = await context.params;
    const symbol = symbolSchema.parse(rawSymbol);
    return getCompanyProfileService().getCompanyProfile(symbol);
  }, { sharedCache: true });
}
