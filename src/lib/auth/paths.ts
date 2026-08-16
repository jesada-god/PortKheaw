/**
 * `/admin` is here so a signed-out visitor is bounced to the sign-in form rather
 * than being told the console exists. Middleware refuses a signed-in
 * non-operator too — see {@link isAdminConsolePath} — but it is a filter, not
 * the boundary: it is there so no renderer runs for a caller who will be
 * refused. The boundary is `requireAdminPage()` inside every operator page and
 * `requireAdmin()` inside every operator action, and beneath both, the
 * `is_platform_admin` check inside every operator routine. All of them read the
 * *stored* role from the database, and none of them trusts anything the request
 * carries.
 *
 * `/support` is deliberately absent: the FAQ and the direct contact channels
 * must stay readable by somebody who cannot sign in, which is exactly the reader
 * most likely to need them.
 */
export const PROTECTED_PATHS = ['/portfolio', '/watchlist', '/alerts', '/notifications', '/settings', '/profile', '/upcoming', '/admin'] as const;

/**
 * Sending someone back to a page that starts an authentication attempt is how
 * redirect loops are built, so {@link getSafeReturnPath} refuses to hand any of
 * these back as a return path.
 *
 * `/auth/reset-password` is deliberately absent: it is a legitimate destination
 * for the recovery link, and rejecting it would break password recovery.
 */
export const AUTH_ENTRY_PATHS = [
  '/auth',
  '/auth/welcome',
  '/auth/sign-in',
  '/auth/sign-up',
  // The `/auth/login` and `/auth/register` aliases forward to the two forms
  // above. They are listed here so a crafted `next` cannot aim at the alias and
  // build the same loop the real paths are already protected against.
  '/auth/login',
  '/auth/register',
  '/auth/forgot-password',
  '/auth/callback',
] as const;

/**
 * The subset an already-signed-in visitor is bounced away from: the forms.
 *
 * `/auth/callback` is NOT bounced even though it is an entry path. It is where
 * a recovery or confirmation link lands, and those links are routinely opened
 * in a browser that already holds a session — redirecting before the handler
 * runs would leave the code unspent and the password reset impossible to
 * finish.
 */
export const AUTH_FORM_PATHS = [
  '/auth',
  '/auth/welcome',
  '/auth/sign-in',
  '/auth/sign-up',
  '/auth/forgot-password',
] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** The console's root, and everything under it. */
export const ADMIN_CONSOLE_PATH = '/admin';

/**
 * Whether a URL belongs to the operator console.
 *
 * Prefix matching on a path segment, never a bare `startsWith`: `/administrators`
 * is not an admin URL and must not be refused as one, and — the direction that
 * matters — a would-be reader must not be able to dodge the check by asking for
 * a path the guard does not recognise but the router does.
 */
export function isAdminConsolePath(pathname: string): boolean {
  return pathname === ADMIN_CONSOLE_PATH || pathname.startsWith(`${ADMIN_CONSOLE_PATH}/`);
}

/**
 * Everything under `/auth` renders on the standalone PortKheaw auth shell —
 * no sidebar, no bottom navigation — so the welcome/sign-in artwork owns the
 * whole viewport instead of sharing it with app chrome the visitor cannot use.
 */
export function isAuthShellPath(pathname: string): boolean {
  return pathname === '/auth' || pathname.startsWith('/auth/');
}

export function isAuthEntryPath(pathname: string): boolean {
  return (AUTH_ENTRY_PATHS as readonly string[]).includes(pathname);
}

export function isAuthFormPath(pathname: string): boolean {
  return (AUTH_FORM_PATHS as readonly string[]).includes(pathname);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reduces an untrusted `next`/return value to a path this origin can safely
 * redirect to, or `/`.
 *
 * Rejects anything that is not a same-origin absolute path: schemes, protocol
 * relative `//evil.com`, backslash variants Windows/IE normalise to a slash,
 * and control characters that can smuggle a second header or a scheme past a
 * naive prefix check. Percent-encoded payloads (`/%2F%2Fevil.com`) survive as
 * an *encoded* path segment, which the browser resolves against this origin —
 * they are not decoded here, because decoding is exactly what would turn them
 * back into an off-site redirect.
 */
export function getSafeReturnPath(value: FormDataEntryValue | string | null | undefined): string {
  if (
    typeof value !== 'string'
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || hasControlCharacter(value)
  ) return '/';

  const parsed = new URL(value, 'https://nexora.local');
  if (parsed.origin !== 'https://nexora.local') return '/';
  if (isAuthEntryPath(parsed.pathname)) return '/';
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
