import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { guardApiRequest } from '@/src/lib/security/request-guard';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';
import {
  CompanyProfileTranslationError,
  getCompanyProfileTranslationService,
} from '@/src/lib/translation/company-profile';

/**
 * The Thai company profile.
 *
 * ===========================================================================
 * WHAT THIS ENDPOINT USED TO BE
 * ===========================================================================
 * An unauthenticated POST that reached a paid language model, whose only
 * defence was a 16KB body cap and whose only cache lived in one process's
 * memory. Its cache key was derived from `sourceText` IN THE REQUEST BODY, so a
 * caller who changed one character was guaranteed a cache miss and another
 * model call — which meant no cache anywhere could bound the spend.
 *
 * Three things changed, and the FIRST is the one that matters:
 *
 *   1. **The body no longer carries the text.** It names a symbol; the server
 *      reads that company's description for itself. The input space is now the
 *      instruments that exist rather than every string a caller can type, which
 *      is what makes a cache able to hold at all.
 *   2. **A shared store**, keyed by the hash of what the server read, so one
 *      translation serves every reader on every instance until the description
 *      itself changes.
 *   3. **A rate limit**, per account and per address, through the same guard
 *      the other expensive routes use.
 *
 * ===========================================================================
 * WHY THERE IS NO ENTITLEMENT GATE
 * ===========================================================================
 * `/stock/{symbol}` is a page a signed-out visitor is meant to be able to read,
 * and this card is part of it. Requiring a plan here would take the Thai
 * description off a page that is deliberately public. The cost argument that
 * would have justified a gate is answered by (1) and (2) instead: a translation
 * is bought once per company, not once per reader.
 *
 * A failure is never fatal to the page. The card falls back to the English
 * paragraph on any error, so this route answers with an error envelope and lets
 * the reader keep reading.
 */

export async function POST(request: Request) {
  const timestamp = new Date().toISOString();

  /*
   * Rate first, before the body is read and long before the model is reached.
   *
   * `expensive` and `analytics.expensive` are the existing class and scope for
   * "one request buys real work somebody pays for" — the same pair the options
   * analytics use. The account id comes from the resolved session and is null
   * for an anonymous reader, who is then bounded by address alone; both are
   * counted, and the tighter one wins.
   */
  const access = await resolveRequestAccountAccess();
  const limited = await guardApiRequest(request, {
    abuseClass: 'expensive',
    scope: 'analytics.expensive',
    userId: access.userId,
    operation: 'company-profile-translation',
  });
  if (limited.refusal) return limited.refusal;

  try {
    const body = await request.json();
    const result = await getCompanyProfileTranslationService().translate(body);
    return NextResponse.json({
      data: result.data,
      meta: { cached: result.cached, timestamp },
    }, {
      headers: {
        'Cache-Control': 'private, max-age=0',
      },
    });
  } catch (cause) {
    const error = cause instanceof CompanyProfileTranslationError
      ? cause
      : cause instanceof ZodError || cause instanceof SyntaxError
        ? new CompanyProfileTranslationError('invalid-request', 'Invalid translation request')
        : new CompanyProfileTranslationError('upstream-unavailable', 'Translation is temporarily unavailable');
    const response = NextResponse.json({
      data: null,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      },
      meta: { cached: false, timestamp },
    }, { status: error.status });
    response.headers.set('Cache-Control', 'no-store');
    if (error.retryAfterSeconds) response.headers.set('Retry-After', String(error.retryAfterSeconds));
    return response;
  }
}
