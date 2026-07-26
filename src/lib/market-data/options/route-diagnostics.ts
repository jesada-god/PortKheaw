export interface OptionsRouteDiagnosticsInput {
  route: 'options-expirations' | 'options-chain';
  symbol: string | null;
  routeRateLimited?: boolean;
  providerHint?: string | null;
}

function safeSymbol(value: string | null): string | null {
  const symbol = value?.trim().toUpperCase() ?? '';
  return /^[A-Z0-9.^=-]{1,32}$/.test(symbol) ? symbol : null;
}

/**
 * Adds secret-free, production-readable Options diagnostics. The response body
 * remains untouched; headers make browser Network inspection sufficient to
 * distinguish a Nexora route limit from an upstream provider 429.
 */
export function withOptionsRouteDiagnostics<T extends Response>(
  response: T,
  input: OptionsRouteDiagnosticsInput,
): T {
  const retryAfter = response.headers.get('retry-after');
  const rateLimitSource = response.status !== 429
    ? 'none'
    : input.routeRateLimited ? 'nexora' : 'upstream';
  const provider = response.ok
    ? response.headers.get('x-market-data-provider') ?? input.providerHint ?? null
    : input.routeRateLimited ? null : input.providerHint ?? null;
  const cacheStatus = response.headers.get('x-market-data-cache-status')
    ?? (response.ok ? 'provider-or-fresh-cache' : 'none');
  const failureKind = response.ok
    ? 'none'
    : rateLimitSource === 'nexora'
      ? 'nexora-rate-limit'
      : rateLimitSource === 'upstream'
        ? 'upstream-rate-limit'
        : `route-http-${response.status}`;

  response.headers.set('X-Options-Route-Status', String(response.status));
  response.headers.set('X-Options-Rate-Limit-Source', rateLimitSource);
  response.headers.set('X-Options-Cache-Status', cacheStatus);
  response.headers.set('X-Options-Single-Flight', 'enabled');
  response.headers.set('X-Options-Failure-Kind', failureKind);
  if (provider) response.headers.set('X-Options-Provider', provider);

  console.info(JSON.stringify({
    event: 'options_request_diagnostic',
    route: input.route,
    symbol: safeSymbol(input.symbol),
    provider,
    cacheStatus,
    singleFlightStatus: 'enabled',
    routeStatus: response.status,
    upstreamStatus: rateLimitSource === 'upstream' ? response.status : null,
    retryAfter: retryAfter ? Number(retryAfter) || null : null,
    failureKind,
  }));
  return response;
}
