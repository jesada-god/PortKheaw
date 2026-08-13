import 'server-only';

import { notFound } from 'next/navigation';
import {
  resolveRequestAccountAccess,
  type RequestAccountAccess,
} from '@/src/lib/subscription/account-access';

/**
 * The operator gate, for a page.
 *
 * This exists because of a property of the App Router that a layout guard cannot
 * work around: **a layout and the page beneath it render concurrently.** When
 * `app/admin/layout.tsx` calls `notFound()`, the page has already run — its
 * projections were queried, its tree was built, and that tree is serialised into
 * the streamed payload beside the 404 marker. The reader's browser shows the
 * not-found screen, and the console's markup is on the wire anyway, under a 200.
 *
 * So the gate has to be *inside* the thing being guarded. Every operator page
 * awaits this on its first line, before it reads anything, so a non-operator's
 * request produces no console markup at all rather than markup that is thrown
 * away after the fact.
 *
 * It reads the same snapshot the layout does — `resolveRequestAccountAccess`
 * resolves the *stored* role through the database's own projection, never a
 * cookie, never a header, never a running access preview, and is memoised per
 * request, so eight pages asking cost one round trip. An administrator
 * previewing Basic is still an administrator here; that is the whole reason the
 * role and the preview are separate values.
 *
 * `notFound()` rather than a 403, matching the layout: a 403 confirms the console
 * exists and that this account is not on it, and there is no legitimate reason
 * for a reader to learn either fact.
 *
 * This is one of three independent layers. Middleware refuses the URL before it
 * reaches a renderer, this refuses the render, and every routine the console
 * calls re-checks `is_platform_admin` inside the database and refuses on its own
 * terms. None of them is trusted to be the only one.
 */
export async function requireAdminPage(): Promise<RequestAccountAccess> {
  const access = await resolveRequestAccountAccess();
  if (!access.isAdmin) notFound();
  return access;
}
