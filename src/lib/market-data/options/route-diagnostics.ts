export interface OptionsRouteDiagnosticsInput {
  route: 'options-expirations' | 'options-chain' | 'options-walls';
  symbol: string | null;
  routeRateLimited?: boolean;
  providerHint?: string | null;
}

/**
 * A subscription refusal and a provider entitlement refusal are both 403s and
 * mean opposite things: one is answered by the reader's own plan, the other by
 * our data contract. The subscription guard names itself in the body, which is
 * the only place the two differ, so the classifier reads it from there.
 */
const SUBSCRIPTION_DENIAL_KIND: Record<string, string> = {
  UPGRADE_REQUIRED: 'subscription-upgrade-required',
  AUTHENTICATION_REQUIRED: 'subscription-authentication-required',
};

function subscriptionDenialKind(response: Response): string | null {
  if (response.status !== 401 && response.status !== 403) return null;
  const code = response.headers.get('x-entitlement-denial');
  return code ? SUBSCRIPTION_DENIAL_KIND[code] ?? null : null;
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
  // An entitlement refusal and a throttle are different faults with different
  // remedies: one needs an external plan change, the other needs a wait. They are
  // reported distinctly so production Network inspection can never conflate them.
  const failureKind = response.ok
    ? 'none'
    : subscriptionDenialKind(response)
      ?? (rateLimitSource === 'nexora'
        ? 'nexora-rate-limit'
        : rateLimitSource === 'upstream'
          ? 'upstream-rate-limit'
          : response.status === 403
            ? 'provider-entitlement'
            : response.status === 404
              ? 'no-data'
              : `route-http-${response.status}`);

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
