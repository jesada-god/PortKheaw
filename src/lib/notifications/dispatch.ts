import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/src/lib/supabase/admin';
import type { Database } from '@/src/types/database';
import { ACCOUNT_NOTIFICATION_TYPE, type AccountNotification } from './account-events';

/**
 * Putting an account event into the Inbox.
 *
 * Everything goes through `enqueue_account_notification_service`, which is the
 * routine the price alerts and the daily summary already use — so quiet hours,
 * the digest, the preference switches and the push outbox all apply to a billing
 * notice exactly as they do to a price alert, without any of that being restated
 * here.
 *
 * Delivery never fails a caller. A webhook that granted a plan and then could
 * not write an Inbox row has still granted the plan, and answering the provider
 * with an error would ask it to redeliver an event that was already applied. So
 * every function below reports success or failure as a boolean and throws
 * nothing.
 */

type AdminClient = SupabaseClient<Database>;

async function enqueue(
  client: AdminClient,
  userId: string,
  item: AccountNotification,
): Promise<boolean> {
  try {
    const { error } = await client.rpc('enqueue_account_notification_service', {
      input_user_id: userId,
      input_type: ACCOUNT_NOTIFICATION_TYPE,
      input_title: item.title,
      input_message: item.message,
      input_metadata: item.metadata,
      input_idempotency_key: item.idempotencyKey,
      input_observed_at: item.observedAt,
    });
    if (error) throw error;
    return true;
  } catch {
    // The kind is a product fact; the account is not. Nothing identifying is
    // logged, on purpose.
    console.warn(JSON.stringify({ event: 'notification_enqueue_failed', kind: item.kind }));
    return false;
  }
}

/** Notify one reader. Returns false if it could not be recorded. */
export async function notifyAccount(
  userId: string | null,
  item: AccountNotification | null,
  client?: AdminClient,
): Promise<boolean> {
  if (!userId || !item) return false;
  const admin = client ?? createAdminClient();
  if (!admin) return false;
  return enqueue(admin, userId, item);
}

/**
 * Notify every operator.
 *
 * The recipient list is read from `user_roles` at send time rather than from a
 * configured address, so promoting or demoting an account changes who is paged
 * without a deployment. The same idempotency key is used for all of them —
 * that key is unique per `(user_id, idempotency_key)`, so each operator gets the
 * alert once and a re-run adds nobody a second copy.
 */
export async function notifyAdmins(
  item: AccountNotification | null,
  client?: AdminClient,
): Promise<number> {
  if (!item) return 0;
  const admin = client ?? createAdminClient();
  if (!admin) return 0;

  let recipients: string[];
  try {
    const { data, error } = await admin
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin')
      .limit(20);
    if (error) throw error;
    recipients = (data ?? []).map((row) => row.user_id);
  } catch {
    console.warn(JSON.stringify({ event: 'notification_admin_lookup_failed', kind: item.kind }));
    return 0;
  }

  let delivered = 0;
  for (const recipient of recipients) {
    if (await enqueue(admin, recipient, item)) delivered += 1;
  }
  return delivered;
}
