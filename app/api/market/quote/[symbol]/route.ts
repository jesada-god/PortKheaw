import type { NextRequest } from 'next/server';
import { observedMarketDataResponse } from '@/src/lib/market-data/route';
import { loadResilientQuote, type ResilientQuoteDiagnostics } from '@/src/lib/market-data/quote-service';
import { symbolSchema } from '@/src/lib/market-data/validation';

export async function GET(request: NextRequest, context: { params: Promise<{ symbol: string }> }) {
  const rawSymbol = (await context.params).symbol;
  const observed: { diagnostics: ResilientQuoteDiagnostics | null } = { diagnostics: null };
  const response = await observedMarketDataResponse(
    request,
    { route: '/api/market/quote/[symbol]', symbol: rawSymbol },
    async () => {
      const symbol = symbolSchema.parse(rawSymbol);
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
