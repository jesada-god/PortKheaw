import { ZodError } from 'zod';
import type { MarketDataApiError, MarketDataErrorCode } from './types';

const STATUS_BY_CODE: Record<MarketDataErrorCode, number> = {
  'provider-not-configured': 503,
  'invalid-request': 400,
  'invalid-symbol': 404,
  'not-found': 404,
  'rate-limited': 429,
  timeout: 504,
  'provider-unauthorized': 502,
  forbidden: 403,
  'provider-unavailable': 503,
  unsupported: 501,
  'stale-data': 503,
  'upstream-unavailable': 502,
  'invalid-provider-response': 502,
  'insufficient-data': 422,
  'internal-error': 500,
};

const RETRYABLE_CODES = new Set<MarketDataErrorCode>([
  // 'provider-not-configured' is a deployment/configuration fault, not a transient
  // upstream failure: retrying cannot succeed until an operator changes env, so it
  // is intentionally excluded to keep it retryable=false and free of auto-retry.
  'rate-limited',
  'timeout',
  'provider-unavailable',
  'stale-data',
  'upstream-unavailable',
  'insufficient-data',
  'internal-error',
]);

export class MarketDataError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    readonly code: MarketDataErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly issues?: MarketDataApiError['issues'],
    readonly context?: Pick<MarketDataApiError, 'reason' | 'lastAvailableAt' | 'primaryReason' | 'fallbackReason'>,
  ) {
    super(message);
    this.name = 'MarketDataError';
    this.status = STATUS_BY_CODE[code];
    this.retryable = RETRYABLE_CODES.has(code);
  }

  toApiError(): MarketDataApiError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterSeconds ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      ...(this.retryAfterSeconds ? { retryAfter: this.retryAfterSeconds } : {}),
      ...(this.context?.reason ? { reason: this.context.reason } : {}),
      ...(this.context && 'lastAvailableAt' in this.context ? { lastAvailableAt: this.context.lastAvailableAt } : {}),
      ...(this.context?.primaryReason ? { primaryReason: this.context.primaryReason } : {}),
      ...(this.context?.fallbackReason ? { fallbackReason: this.context.fallbackReason } : {}),
      ...(this.issues?.length ? { issues: this.issues } : {}),
    };
  }
}

export interface ProviderFailureInput {
  status?: number;
  payload?: unknown;
  cause?: unknown;
  retryAfterSeconds?: number;
}

function providerMessage(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ['Note', 'Information', 'Error Message', 'message']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return undefined;
}

/**
 * High-precision plan/entitlement signals. These must be matched BEFORE the quota
 * matcher because several providers advertise their paid tiers *inside* an
 * entitlement refusal — Alpha Vantage's REALTIME_OPTIONS denial is literally
 * "This is a premium endpoint ... subscribe to the 600 requests per minute ...
 * plan", whose "requests per minute" fragment otherwise matches the rate-limit
 * regex and turns a permanent block into an endlessly retried 429.
 *
 * Every pattern here is anchored to wording only a refusal uses, so a genuine
 * quota notice ("...unlock all premium endpoints") does NOT match: that notice
 * says "premium endpoints" (plural, as an upsell), never "this is a premium
 * endpoint" (singular, describing the endpoint just requested).
 */
const ENTITLEMENT_PATTERN = new RegExp([
  'this is a premium endpoint',            // Alpha Vantage premium refusal
  'sample data (schema )?(below )?is artificial', // Alpha Vantage illustrative-only payload
  '(are|is) not entitled',                 // Polygon
  'not authorized',                        // Polygon NOT_AUTHORIZED
  'have access to this resource',          // Finnhub
  'only available for legacy users',       // FMP retired endpoints
  'agreement is not signed',               // Alpaca OPRA
  'not entitled|entitlement',
  'subscription required|requires a subscription',
  'upgrade (your|to a|the) .{0,24}plan',
].join('|'), 'i');

export function mapProviderFailure(input: ProviderFailureInput): MarketDataError {
  const message = providerMessage(input.payload);
  const isAbort = input.cause instanceof Error && (
    input.cause.name === 'AbortError' || input.cause.name === 'TimeoutError'
  );

  if (isAbort) return new MarketDataError('timeout', 'Market data provider timed out');
  // Entitlement is checked first and deliberately: it is a permanent, operator-only
  // fault. Misreading it as a quota makes it retryable, which produces exactly the
  // upstream request storm this ordering exists to prevent.
  if (input.status === 402 || ENTITLEMENT_PATTERN.test(message ?? '')) {
    return new MarketDataError('forbidden', 'The configured provider plan does not authorize this market data operation');
  }
  // Alpha Vantage quota messages often mention the API key. Quota signals must win
  // over the more general key matcher or exhausted free-tier keys become 502s.
  if (input.status === 429 || /frequency|rate limit|call volume|requests per|calls per|daily.*limit/i.test(message ?? '')) {
    return new MarketDataError(
      'rate-limited',
      'Market data provider rate limit exceeded',
      input.retryAfterSeconds,
    );
  }
  if (input.status === 402 || /premium endpoint|subscription|current plan|upgrade.*plan|not entitled|entitlement/i.test(message ?? '')) {
    return new MarketDataError('forbidden', 'The configured provider plan does not authorize this market data operation');
  }
  // 401 (or an explicit invalid-key message) means the credential itself was rejected.
  if (input.status === 401 || /invalid api key|invalid apikey|api key is invalid|apikey is invalid/i.test(message ?? '')) {
    return new MarketDataError('provider-unauthorized', 'Market data provider rejected the API key');
  }
  // A bare 403 is an entitlement/authorization boundary (valid key, plan not permitted).
  if (input.status === 403) {
    return new MarketDataError('forbidden', 'The configured provider plan is not entitled to this market data operation');
  }
  if (/invalid api call|invalid symbol|symbol.*invalid/i.test(message ?? '')) {
    return new MarketDataError('invalid-symbol', 'The market symbol is invalid or unsupported');
  }
  if (input.status && input.status >= 500) {
    return new MarketDataError('upstream-unavailable', 'Market data provider is unavailable');
  }
  if (input.cause instanceof TypeError) {
    return new MarketDataError('upstream-unavailable', 'Could not reach market data provider');
  }
  if (message) return new MarketDataError('invalid-provider-response', 'Market data provider returned an unrecognized response');
  return new MarketDataError('invalid-provider-response', 'Market data provider returned an invalid response');
}

export function fromZodError(error: ZodError): MarketDataError {
  return new MarketDataError(
    'invalid-request',
    'Invalid market data request',
    undefined,
    error.issues.map((issue) => ({
      path: issue.path.join('.') || 'request',
      message: issue.message,
    })),
  );
}
