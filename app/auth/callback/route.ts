import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/src/lib/supabase/server';
import { getSafeReturnPath } from '@/src/lib/auth/paths';
import { describeAuthError, describeOAuthCallbackError } from '@/src/lib/auth/errors';
import { recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';

/**
 * The top of the rollout funnel, recorded where the account first has a session.
 *
 * This handler also serves password recovery and a returning Google sign-in, so
 * "somebody arrived here" is not the same as "somebody signed up". The account's
 * own `created_at` is what distinguishes them: a confirmation link or a first
 * OAuth login lands here minutes after the record was made, and a recovery link
 * for a year-old account does not. The event is additionally once-per-account
 * forever inside the database, so a retried callback cannot double-count.
 *
 * Never awaited for a result and never able to throw: an analytics row must not
 * stand between somebody and the session they just confirmed.
 */
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;

function noteSignupIfNew(createdAt: string | undefined): void {
  if (!createdAt) return;
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created) || Date.now() - created > SIGNUP_WINDOW_MS) return;
  void recordBetaFunnelEvent({ event: 'signup_completed' }).catch(() => {});
}

/**
 * The single landing point for every link Supabase issues: the sign-up
 * confirmation, the password recovery link, and the Google OAuth redirect.
 *
 * Nothing here is logged. The `code` is a one-time credential for the session
 * it mints, so it never reaches a log line, an error message, or the URL the
 * visitor is left on — the redirect out of this handler always drops it.
 */
function failure(request: NextRequest, message: string): NextResponse {
  const url = new URL('/auth/sign-in', request.url);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = getSafeReturnPath(params.get('next'));
  const code = params.get('code');

  const supabase = await createClient();
  if (!supabase) return NextResponse.redirect(new URL('/auth/configuration-required', request.url));

  // The provider reports refusal (including the visitor pressing "cancel") by
  // redirecting back with error parameters rather than a code.
  if (params.has('error') || params.has('error_code')) {
    return failure(request, describeOAuthCallbackError(params));
  }

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      noteSignupIfNew(data.user?.created_at);
      return NextResponse.redirect(new URL(next, request.url));
    }

    // A code can only be spent once. Reloading the callback, or a second tab
    // racing the first, lands here with a session already established — that is
    // success arriving twice, not a failure, and it must not sign the visitor
    // out or create anything a second time.
    const { data: { user } } = await supabase.auth.getUser();
    if (user) return NextResponse.redirect(new URL(next, request.url));

    return failure(request, describeAuthError(error, 'oauth'));
  }

  // No code and no error: either a stale bookmark or a reload after the session
  // was already established.
  const { data: { user } } = await supabase.auth.getUser();
  if (user) return NextResponse.redirect(new URL(next, request.url));
  return failure(request, describeOAuthCallbackError(params));
}
