import type { NextRequest } from 'next/server';
import { observedMarketDataResponse } from '@/src/lib/market-data/route';
import { loadResilientQuote, type ResilientQuoteDiagnostics } from '@/src/lib/market-data/quote-service';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { commodityMarketAsset, continuousMarketAsset } from '@/src/lib/overview/market-assets';
import { loadContinuousQuote } from '@/src/lib/stock-detail/continuous-snapshot';

export async function GET(request: NextRequest, context: { params: Promise<{ symbol: string }> }) {
  const rawSymbol = (await context.params).symbol;
  const observed: { diagnostics: ResilientQuoteDiagnostics | null } = { diagnostics: null };
  const response = await observedMarketDataResponse(
    request,
    { route: '/api/market/quote/[symbol]', symbol: rawSymbol },
    async () => {
      const symbol = symbolSchema.parse(rawSymbol);
      /*
       * Neither a continuous asset nor a futures contract ever reaches the
       * US-equity pipeline: neither has a row in `market_instruments`, so the
       * resolver would reject it as an invalid symbol, and the trading-date
       * reconciliation downstream assumes an exchange session neither has. The
       * chart pipeline they are both quoted from answers instead — the same one
       * that rendered the page, so the poll cannot disagree with the first paint.
       *
       * This is what makes the commodity detail page a LIVE page rather than a
       * server-rendered snapshot: without it every refresh of /stock/GC-F asked
       * the equity resolver for a COMEX contract and was told the symbol does
       * not exist, so the price never moved after the first render.
       */
      if (continuousMarketAsset(symbol) || commodityMarketAsset(symbol)) {
        const result = await loadContinuousQuote(symbol);
        observed.diagnostics = {
          symbol,
          routeStatus: 200,
          provider: result.provider ?? 'yahoo-finance-chart',
          providerStatus: 200,
          failureKind: 'none',
        };
        return result;
      }
      const result = await loadResilientQuote(symbol);
      observed.diagnostics = result.diagnostics;
      return result;
    },
  );
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set(
    'X-Market-Data-Provenance',
    observed.diagnostics?.provider ?? 'market-data-gateway',
  );
  response.headers.set('X-Market-Quote-Provider', observed.diagnostics?.provider ?? 'unavailable');
  response.headers.set('X-Market-Provider-Status', String(observed.diagnostics?.providerStatus ?? response.status));
  response.headers.set('X-Market-Failure-Kind', observed.diagnostics?.failureKind ?? `route-http-${response.status}`);
  return response;
}
