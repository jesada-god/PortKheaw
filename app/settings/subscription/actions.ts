'use server';

import { revalidatePath } from 'next/cache';
import { SubscriptionRepository } from '@/src/lib/subscription/repository';
import { createClient } from '@/src/lib/supabase/server';
import {
  trialFailureCode,
  trialFailureMessage,
  type TrialFailureCode,
} from '@/src/lib/subscription/trial';

export type StartTrialResult =
  | { ok: true; trialEndsAt: string; message: string }
  | { ok: false; code: TrialFailureCode; message: string };

/**
 * Surfaces the outcome in the same structured-log shape the rest of the server
 * uses. No identifiers are logged and no analytics dependency is introduced —
 * the event name and the typed code are the whole record.
 */
function record(event: 'trial_started' | 'trial_start_failed', code?: TrialFailureCode) {
  const payload = JSON.stringify({ event, ...(code ? { code } : {}) });
  if (event === 'trial_start_failed') console.warn(payload);
  else console.info(payload);
}

/**
 * Every entitlement surface that reads the subscription. The trial must be
 * visible everywhere the moment it is granted, without the reader signing out.
 */
const ENTITLEMENT_PATHS = ['/settings/subscription', '/settings', '/portfolio', '/tools', '/'] as const;

/**
 * Starts the Elite trial. The action passes no user, tier or timestamp: it
 * calls the trusted RPC, which decides everything from `auth.uid()` and the
 * database clock. Nothing is unlocked optimistically — the caller re-reads the
 * server snapshot after this returns.
 */
export async function startEliteTrialAction(): Promise<StartTrialResult> {
  const client = await createClient();
  if (!client) {
    record('trial_start_failed', 'UNAVAILABLE');
    return { ok: false, code: 'UNAVAILABLE', message: trialFailureMessage('UNAVAILABLE') };
  }

  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) {
    record('trial_start_failed', 'UNAUTHENTICATED');
    return { ok: false, code: 'UNAUTHENTICATED', message: trialFailureMessage('UNAUTHENTICATED') };
  }

  try {
    const grant = await new SubscriptionRepository(client).startEliteTrial();
    for (const path of ENTITLEMENT_PATHS) revalidatePath(path);
    record('trial_started');
    return {
      ok: true,
      trialEndsAt: grant.trialEndsAt ?? '',
      message: 'เริ่มทดลอง Elite แล้ว ใช้งานได้ทันที 7 วัน',
    };
  } catch (error) {
    const code = trialFailureCode(error);
    record('trial_start_failed', code);
    return { ok: false, code, message: trialFailureMessage(code) };
  }
}
