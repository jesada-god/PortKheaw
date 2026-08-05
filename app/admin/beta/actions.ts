'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/src/lib/supabase/server';
import { requireAdmin, isAdminRequiredError } from '@/src/lib/subscription/account-access';
import { resolveRequestId } from '@/src/lib/monitoring/request-id';
import { captureServerError } from '@/src/lib/monitoring/report';
import {
  consumeRateLimit, rateLimitMessage, resolveClientAddress,
} from '@/src/lib/security/rate-limit';
import {
  BETA_OUTCOME_MESSAGE, capIsInBand, normalizeBetaStage, stageAcceptsCap,
} from '@/src/lib/beta/beta-stages';

/**
 * The three operator mutations the rollout has.
 *
 * Each one is the same five steps, in the same order, and the order is the
 * safety argument:
 *
 *   1. **Authorize.** `requireAdmin()` reads the *stored* role through the
 *      database's own resolver — never a cookie, never a header, never a running
 *      access preview. It is a convenience: every routine below re-checks the
 *      role inside the database and refuses on its own terms, so a bug here
 *      cannot promote anybody.
 *   2. **Bound.** A shared, database-backed limiter, so a script cannot hammer
 *      the invite routine faster than a person could ever mean to.
 *   3. **Validate** what the form sent, against the same bands the database
 *      enforces — so the console cannot offer a cohort size the routine refuses.
 *   4. **Mutate**, through a `security definer` routine that writes the audit row
 *      in the same transaction. An action that succeeded and an audit row that
 *      did not is not a state this can reach.
 *   5. **Report** an outcome the operator can act on, never a raw database error.
 *
 * Nothing here switches the stage on a timer, on a threshold, or on anything but
 * an operator pressing a button and confirming it.
 */

export type BetaActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

const UNAVAILABLE = 'ทำรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
const FORBIDDEN = 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้';
const CONFIRMATION_REQUIRED = 'กรุณายืนยันก่อนเปลี่ยนสถานะการเปิดใช้งาน';

function outcomeMessage(outcome: string): string {
  return BETA_OUTCOME_MESSAGE[outcome] ?? UNAVAILABLE;
}

/** Steps 1 and 2, which every mutation shares. */
async function authorizeAndBound(scope: 'admin.mutation'): Promise<
  | { ok: true; client: NonNullable<Awaited<ReturnType<typeof createClient>>>; requestId: string }
  | { ok: false; message: string }
> {
  try {
    await requireAdmin();
  } catch (cause) {
    return { ok: false, message: isAdminRequiredError(cause) ? FORBIDDEN : UNAVAILABLE };
  }

  const client = await createClient();
  if (!client) return { ok: false, message: UNAVAILABLE };

  const { data: { user } } = await client.auth.getUser();
  const limit = await consumeRateLimit(client, {
    scope,
    userId: user?.id ?? null,
    clientAddress: await resolveClientAddress(),
  });
  if (!limit.allowed) return { ok: false, message: rateLimitMessage(limit.retryAfterSeconds) };

  return { ok: true, client, requestId: await resolveRequestId() };
}

/**
 * Move the rollout to another stage.
 *
 * `confirm` is required and is checked here rather than only in the browser: the
 * control that opens a product to the public must not be reachable by a stray
 * submit, and a client-side confirmation dialog is not a check.
 */
export async function setBetaStageAction(formData: FormData): Promise<BetaActionResult> {
  const gate = await authorizeAndBound('admin.mutation');
  if (!gate.ok) return gate;

  if (formData.get('confirm') !== 'yes') {
    return { ok: false, message: CONFIRMATION_REQUIRED };
  }

  const stage = normalizeBetaStage(formData.get('stage'));
  const rawCap = String(formData.get('cap') ?? '').trim();
  const cap = stageAcceptsCap(stage) && rawCap ? Number(rawCap) : null;
  if (!capIsInBand(stage, cap)) return { ok: false, message: outcomeMessage('cap_out_of_band') };

  try {
    const { data, error } = await gate.client.rpc('admin_set_beta_stage', {
      input_stage: stage,
      input_cap: cap,
      input_request_id: gate.requestId,
    });
    if (error) throw error;
    revalidatePath('/admin/beta');
    revalidatePath('/settings/subscription');
    return data === 'updated' || data === 'unchanged'
      ? { ok: true, message: outcomeMessage(data) }
      : { ok: false, message: outcomeMessage(String(data)) };
  } catch (cause) {
    captureServerError({
      scope: 'admin.beta-stage',
      cause,
      context: { operation: 'set_stage', stage, requestId: gate.requestId },
    });
    return { ok: false, message: isAdminRequiredError(cause) ? FORBIDDEN : UNAVAILABLE };
  }
}

/** Invite one mailbox. The cohort cap is enforced inside the database. */
export async function addBetaInviteAction(formData: FormData): Promise<BetaActionResult> {
  const gate = await authorizeAndBound('admin.mutation');
  if (!gate.ok) return gate;

  const email = String(formData.get('email') ?? '').trim();
  if (!email) return { ok: false, message: outcomeMessage('invalid_email') };

  try {
    const { data, error } = await gate.client.rpc('admin_add_beta_invite', {
      input_email: email,
      input_request_id: gate.requestId,
    });
    if (error) throw error;
    const row = data?.[0];
    if (!row) return { ok: false, message: UNAVAILABLE };
    revalidatePath('/admin/beta');
    return row.outcome === 'invited'
      ? { ok: true, message: outcomeMessage(row.outcome) }
      : { ok: false, message: outcomeMessage(row.outcome) };
  } catch (cause) {
    captureServerError({
      scope: 'admin.beta-invite',
      cause,
      // The mailbox is deliberately not in the report. See `sanitize.ts`.
      context: { operation: 'add_invite', requestId: gate.requestId },
    });
    return { ok: false, message: isAdminRequiredError(cause) ? FORBIDDEN : UNAVAILABLE };
  }
}

/** Withdraw an invitation. The row is stamped, never deleted. */
export async function revokeBetaInviteAction(formData: FormData): Promise<BetaActionResult> {
  const gate = await authorizeAndBound('admin.mutation');
  if (!gate.ok) return gate;

  const inviteId = String(formData.get('inviteId') ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(inviteId)) return { ok: false, message: UNAVAILABLE };

  try {
    const { data, error } = await gate.client.rpc('admin_revoke_beta_invite', {
      input_invite_id: inviteId,
      input_request_id: gate.requestId,
    });
    if (error) throw error;
    revalidatePath('/admin/beta');
    return data === 'revoked' || data === 'unchanged'
      ? { ok: true, message: outcomeMessage(String(data)) }
      : { ok: false, message: outcomeMessage(String(data)) };
  } catch (cause) {
    captureServerError({
      scope: 'admin.beta-invite',
      cause,
      context: { operation: 'revoke_invite', requestId: gate.requestId },
    });
    return { ok: false, message: isAdminRequiredError(cause) ? FORBIDDEN : UNAVAILABLE };
  }
}
