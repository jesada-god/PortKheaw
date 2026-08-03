import 'server-only';

import { cache } from 'react';
import { createClient } from '@/src/lib/supabase/server';
import {
  resolveAccountAccess,
  type AccountAccess,
  type AdminPreviewMode,
} from './admin-access';
import { resolveEffectiveTier } from './resolve-effective-tier';
import type { SubscriptionStatus, SubscriptionTier } from './subscription-types';

/**
 * The trusted account snapshot: everything the server knows about who is asking
 * and what they may open, and nothing else.
 *
 * Deliberately absent: billing customer, subscription and price identifiers, and
 * any field belonging to another account. This shape reaches server components
 * and, in a narrowed form, the browser — so what is not here cannot leak.
 */
export interface RequestAccountAccess extends AccountAccess {
  authenticated: boolean;
  userId: string | null;
  /** The stored plan and status, for describing the subscription truthfully. */
  storedTier: SubscriptionTier;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  trialUsedAt: string | null;
  currentPeriodEnd: string | null;
  /** The database clock this snapshot was resolved against. */
  databaseNow: string | null;
}

/**
 * What an unreadable session resolves to. Basic, signed out, and — the part that
 * matters — never an administrator. Every failure below lands here.
 */
export const ANONYMOUS_ACCOUNT_ACCESS: RequestAccountAccess = {
  authenticated: false,
  userId: null,
  role: 'user',
  isAdmin: false,
  subscriptionEffectiveTier: 'basic',
  effectiveAccessTier: 'basic',
  adminPreviewMode: 'actual',
  previewExpiresAt: null,
  storedTier: 'basic',
  status: 'basic',
  trialEndsAt: null,
  trialUsedAt: null,
  currentPeriodEnd: null,
  databaseNow: null,
};

async function resolveUncached(): Promise<RequestAccountAccess> {
  const client = await createClient();
  if (!client) return ANONYMOUS_ACCOUNT_ACCESS;

  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return ANONYMOUS_ACCOUNT_ACCESS;

  try {
    const { data, error: rpcError } = await client.rpc('get_my_account_access');
    if (rpcError) throw rpcError;
    const row = data?.[0];
    if (!row) throw new Error('Authenticated account access was not found');

    const subscriptionEffectiveTier = resolveEffectiveTier(
      {
        tier: row.tier,
        status: row.status,
        trialEndsAt: row.trial_ends_at,
        currentPeriodEnd: row.current_period_end,
      },
      row.database_now,
    );

    return {
      ...resolveAccountAccess({
        role: row.role,
        subscriptionEffectiveTier,
        previewMode: row.preview_mode,
        previewExpiresAt: row.preview_expires_at,
        now: row.database_now,
      }),
      authenticated: true,
      userId: user.id,
      storedTier: row.tier,
      status: row.status,
      trialEndsAt: row.trial_ends_at,
      trialUsedAt: row.trial_used_at,
      currentPeriodEnd: row.current_period_end,
      databaseNow: row.database_now,
    };
  } catch {
    // A readable session whose access could not be resolved is still a signed-in
    // reader — they get the free surface, and they are not an administrator.
    return { ...ANONYMOUS_ACCOUNT_ACCESS, authenticated: true, userId: user.id };
  }
}

/**
 * React's server cache is scoped to one render or one request. The root layout,
 * a page and an API guard may all ask; they must observe one database-clock
 * answer and issue one round trip.
 */
export const resolveRequestAccountAccess = cache(resolveUncached);

export class AdminRequiredError extends Error {
  constructor() {
    super('ADMIN_REQUIRED');
    this.name = 'AdminRequiredError';
  }
}

/**
 * The administrator gate.
 *
 * It reads `role`, which is the *stored* role and is never touched by a running
 * preview. An administrator inside a Basic preview is still an administrator —
 * otherwise switching to Basic would lock them out of the control that switches
 * them back. The database enforces the same rule again inside the preview
 * routines, so this is the convenience, not the boundary.
 */
export async function requireAdmin(): Promise<RequestAccountAccess> {
  const access = await resolveRequestAccountAccess();
  if (!access.isAdmin) throw new AdminRequiredError();
  return access;
}

/** Recognises the database's own refusal, raised as the message text. */
export function isAdminRequiredError(error: unknown): boolean {
  if (error instanceof AdminRequiredError) return true;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.includes('ADMIN_REQUIRED');
}

export interface AdminPreviewGrant {
  mode: AdminPreviewMode;
  expiresAt: string | null;
  databaseNow: string;
}

/**
 * Start, change or end a preview. Nothing but the mode is sent: the database
 * reads the caller from `auth.uid()`, checks the stored role itself, and refuses
 * on its own terms. Errors surface unchanged so the caller can map the code.
 */
export async function setAdminAccessPreview(mode: AdminPreviewMode): Promise<AdminPreviewGrant> {
  const client = await createClient();
  if (!client) throw new Error('UNAVAILABLE');
  const { data, error } = await client.rpc('set_my_admin_access_preview', { input_mode: mode });
  if (error) throw error;
  const row = data?.[0];
  if (!row) throw new Error('Access preview did not return a state');
  return { mode: row.mode, expiresAt: row.expires_at, databaseNow: row.database_now };
}
