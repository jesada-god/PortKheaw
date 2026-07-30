'use client';

import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/src/lib/supabase/client';
import { describeAuthError } from '@/src/lib/auth/errors';
import { getSafeReturnPath } from '@/src/lib/auth/paths';

/**
 * Kept in its own module, away from the rest of the auth controls, because it is
 * the only one that needs the Supabase browser client. Bundled together with the
 * submit button and the banner it put roughly 95 kB of auth SDK on every auth
 * page — including "forgot password", which never signs anyone in with Google.
 * The pages now load this lazily and only when the provider is actually enabled.
 */
function GoogleGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" width="20" height="20" className="shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/**
 * Starts the real Google OAuth flow through Supabase.
 *
 * Only ever rendered when the project reports Google as an enabled provider
 * (see `getEnabledAuthProviders`), so this is never a control that looks live
 * and leads to a provider error page.
 *
 * The return path is sanitised here as well as in the callback: `next` is
 * rebuilt onto this origin's `/auth/callback`, so a crafted link cannot turn a
 * sign-in into an off-site redirect carrying the session.
 */
export function GoogleAuthButton({ next, label }: { next: string; label: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * The guard has to be a ref, not the `pending` state. Two clicks dispatched in
   * the same tick — a double tap, or an impatient second click before React has
   * re-rendered the button as `disabled` — both read the *previous* `pending`
   * from this closure, so a state-based check lets the second one through and
   * starts a second `/auth/v1/authorize` round trip. A ref flips synchronously,
   * so only the first click ever reaches the provider.
   */
  const started = useRef(false);

  async function start() {
    if (started.current) return;
    started.current = true;
    setPending(true);
    setError(null);
    const supabase = createClient();
    if (!supabase) {
      setError('ยังไม่ได้ตั้งค่าการเข้าสู่ระบบ');
      setPending(false);
      started.current = false;
      return;
    }
    const redirectTo = new URL('/auth/callback', window.location.origin);
    redirectTo.searchParams.set('next', getSafeReturnPath(next));
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectTo.toString() },
    });
    // Reaching this line at all means no redirect happened. A failed attempt is
    // released so the visitor can try again; a successful one stays latched,
    // because the browser is already on its way to Google.
    if (oauthError) {
      setError(describeAuthError(oauthError, 'oauth'));
      setPending(false);
      started.current = false;
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={start}
        disabled={pending}
        aria-busy={pending}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl border px-5 text-base font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--auth-focus)] disabled:cursor-not-allowed disabled:opacity-70"
        style={{
          background: 'var(--auth-card-soft)',
          borderColor: 'var(--auth-input-border)',
          color: 'var(--auth-text)',
        }}
      >
        {pending ? <Loader2 aria-hidden="true" size={18} className="motion-safe:animate-spin" /> : <GoogleGlyph />}
        {pending ? 'กำลังเปิดหน้า Google…' : label}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-xs leading-5 font-medium text-[var(--auth-danger)]">{error}</p>
      ) : null}
    </div>
  );
}
