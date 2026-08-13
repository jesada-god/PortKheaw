import 'server-only';

import { cache } from 'react';
import { createClient } from '@/src/lib/supabase/server';
import {
  isBlockedDuringLockdown,
  LOCKDOWN_DENIAL_MESSAGE,
  type LockdownClass,
} from './lockdown';

/**
 * The security lockdown, resolved on the server.
 *
 * This is the layer that knows *what the caller is about to do*. Middleware sees
 * a POST to a page URL and can only refuse by path; a server action knows it is
 * about to change a role, and can name that. The two are independent on purpose
 * — a server action is reachable by its identifier alone, without ever passing
 * through the page whose form submits it, so a URL-shaped filter cannot be the
 * boundary.
 *
 * **How this fails, and why.** The switch is read from the database. If that read
 * fails, the answer is "not locked down" — the product keeps working. That is
 * the opposite of how the *authorization* gates fail, and the difference is
 * deliberate: this predicate only ever takes privileges away, and every caller
 * has already passed its own authorization check before reaching here. An
 * unreadable switch declining to take privileges away leaves the product exactly
 * as protected as it was before lockdown existed. An unreadable switch that
 * refused everything would mean a database blip is an outage of the console the
 * operator needs to fix the blip.
 *
 * The layer that does *not* fail this way is the database itself: the triggers on
 * `user_roles` and `admin_access_previews` consult the flag in the same
 * transaction as the write, so the two writes that actually grant privilege are
 * refused by the row's own table whether or not this module was consulted.
 */

async function resolveUncached(): Promise<boolean> {
  try {
    const client = await createClient();
    if (!client) return false;
    const { data, error } = await client.rpc('resolve_runtime_posture');
    if (error) throw error;
    return data?.[0]?.security_lockdown_enabled === true;
  } catch {
    return false;
  }
}

/**
 * Memoised per request. A page, its layout and the action it posts to may all
 * ask; they must observe one answer and cost one round trip.
 */
export const resolveSecurityLockdown = cache(resolveUncached);

export class SecurityLockdownError extends Error {
  constructor(readonly lockdownClass: LockdownClass) {
    super('SECURITY_LOCKDOWN');
    this.name = 'SecurityLockdownError';
  }
}

/** Recognises both this error and the database's own refusal of the same name. */
export function isSecurityLockdownError(error: unknown): boolean {
  if (error instanceof SecurityLockdownError) return true;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes('SECURITY_LOCKDOWN');
}

/**
 * The gate a classified mutation opens with.
 *
 * Classes that are never blocked — the lockdown toggle and the maintenance
 * toggle — short-circuit before the read, so releasing the switch costs nothing
 * and cannot be prevented by the database being slow at the worst moment.
 */
export async function assertMutationAllowed(lockdownClass: LockdownClass): Promise<void> {
  if (!isBlockedDuringLockdown(lockdownClass)) return;
  if (await resolveSecurityLockdown()) throw new SecurityLockdownError(lockdownClass);
}

export { LOCKDOWN_DENIAL_MESSAGE };
