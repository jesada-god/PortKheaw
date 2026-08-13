import { requireAdminPage } from '@/src/lib/admin/admin-guard';

/**
 * The operator console's outermost gate.
 *
 * It is deliberately *not* the only one, and it is not the one that stops the
 * leak. A layout and the page beneath it render concurrently in the App Router:
 * when this refuses, the page has already run, and its tree is serialised into
 * the response next to the 404 marker. So every page under here calls
 * `requireAdminPage()` on its own first line, and middleware refuses the URL
 * before either of them is reached.
 *
 * What this layer is for is coverage by construction — a page added tomorrow
 * that forgets the guard is still behind a check, and the contract test in
 * `admin-console.contract.test.ts` fails the build until it has its own.
 *
 * `requireAdminPage` reads the *stored* role through the database's own resolver
 * — never a cookie, never a header, never a running access preview — so an
 * administrator previewing Basic is still an administrator here, and nothing a
 * client sends can promote anyone. Beneath all of it, every routine the console
 * calls re-checks `is_platform_admin` inside the database and every table it
 * reads is behind row-level security that admits operators explicitly, so a bug
 * in this file cannot open anybody's records.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  /*
   * The role, and only the role.
   *
   * The second-factor requirement is left to the pages, because one of them —
   * `/admin/security` — is where the factor is presented and must render at
   * `aal1`. A layout cannot tell which page is beneath it, so a layout that
   * enforced assurance would redirect the operator away from the only page that
   * can end the redirect.
   *
   * Nothing is lost by leaving it out here: `requireAdminPage()` defaults to
   * requiring assurance, so every page except that one enforces it on its own
   * first line, middleware refuses the URL before either runs, and the console's
   * mutations refuse independently of all three.
   */
  await requireAdminPage({ assurance: 'exempt' });
  return <>{children}</>;
}
