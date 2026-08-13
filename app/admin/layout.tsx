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
  await requireAdminPage();
  return <>{children}</>;
}
