import 'server-only';

import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/src/lib/supabase/server';
import { ADMIN_SECURITY_PATH } from '@/src/lib/security/admin-assurance';
import { resolveAdminAssurance } from '@/src/lib/security/admin-assurance-server';
import {
  consumeRateLimit, resolveClientAddress,
} from '@/src/lib/security/rate-limit';
import { recordSecurityEvent } from '@/src/lib/security/security-audit';
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
 * This is one of four independent layers. Middleware refuses the URL before it
 * reaches a renderer, this refuses the render, every mutation re-checks for
 * itself, and every routine the console calls re-checks `is_platform_admin`
 * inside the database and refuses on its own terms. None of them is trusted to
 * be the only one.
 */

export interface AdminPageGuardOptions {
  /**
   * Whether this page requires a second factor to have been presented in this
   * session.
   *
   * `'required'` is the default, so a console page added tomorrow is behind the
   * requirement without anybody remembering to put it there. `'exempt'` exists
   * for exactly two callers and both are named at their call site: the layout,
   * which must not refuse before the page beneath it has decided (and which is
   * coverage, not a boundary), and `/admin/security`, which is the page where
   * the factor is presented and therefore cannot demand one.
   */
  assurance?: 'required' | 'exempt';
}

/**
 * One class-B charge per console page render.
 *
 * Memoised per request because the layout and the page both call the guard, and
 * a limiter that counts a single page view twice halves the operator's budget
 * for no reason. The burst layer at the edge has already bounded the same
 * request; this is the part that holds across instances.
 *
 * The result is deliberately ignored. A console read that is over its bound is
 * not an attack worth turning into a broken operations page during an incident —
 * the value here is the recorded, shared counter and the edge burst gate that
 * actually sheds the load. Writes are the ones that get refused, and they are
 * bounded separately and harder.
 */
const chargeAdminRead = cache(async (userId: string | null): Promise<void> => {
  const client = await createClient();
  await consumeRateLimit(client, {
    scope: 'admin.read',
    userId,
    clientAddress: await resolveClientAddress(),
  });
});

export async function requireAdminPage(
  options: AdminPageGuardOptions = {},
): Promise<RequestAccountAccess> {
  const access = await resolveRequestAccountAccess();
  if (!access.isAdmin) {
    /*
     * Middleware already refused this URL, so reaching here means the render was
     * entered some other way — which is itself worth recording. `void`, not
     * `await`: the 404 must not wait on an audit write, and a timing difference
     * is exactly what the bare `notFound()` exists to avoid handing over.
     */
    void recordSecurityEvent({
      event: 'admin.authorization.denied',
      targetRef: 'admin-page-render',
      outcome: 'denied',
      userId: access.userId,
    });
    notFound();
  }

  await chargeAdminRead(access.userId);

  if (options.assurance !== 'exempt') {
    const assurance = await resolveAdminAssurance();
    /*
     * A redirect, not a `notFound()`. This caller *is* an operator — they have
     * already passed the check above — and the only thing standing between them
     * and the console is a step they can complete. Hiding that behind a 404
     * would be indistinguishable from having lost the role.
     *
     * Middleware normally redirects first and carries a `next` parameter. This
     * path is what answers when a render is reached some other way, so it aims
     * at the security page's default destination rather than inventing one.
     */
    if (!assurance.satisfied) redirect(ADMIN_SECURITY_PATH);
  }

  /*
   * The console was opened by an operator with a valid server identity and, on
   * every page but one, a presented second factor. Recorded once per operator
   * per minute rather than once per render — see `security-audit.ts` — because
   * the useful fact is "the console was in use at this time", not that a person
   * clicked eight links.
   */
  void recordSecurityEvent({
    event: 'admin.access.granted',
    targetRef: 'admin-console',
    outcome: 'allowed',
    userId: access.userId,
  });

  return access;
}
