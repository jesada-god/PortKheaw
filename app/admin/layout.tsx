import { notFound } from 'next/navigation';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';

/**
 * The operator console's gate.
 *
 * One check, at the layout, so every page beneath it is covered by construction
 * rather than by each page remembering. `resolveRequestAccountAccess` reads the
 * **stored** role through the database's own resolver — never a cookie, never a
 * header, never a running access preview — so an administrator previewing Basic
 * is still an administrator here, and nothing a client sends can promote anyone.
 *
 * A non-operator gets `notFound()` rather than a 403. A 403 confirms that the
 * console exists and that this account is not on it; a 404 says nothing at all,
 * and there is no legitimate reason for a reader to learn either fact.
 *
 * This is the convenience layer. Every routine the console calls re-checks the
 * role inside the database, and every table it reads is behind row-level
 * security that admits operators explicitly — so a bug in this file cannot open
 * anybody's records.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const access = await resolveRequestAccountAccess();
  if (!access.isAdmin) notFound();
  return <>{children}</>;
}
