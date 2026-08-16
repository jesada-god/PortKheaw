'use server';

import { recordBetaFunnelEventSafely } from '@/src/lib/beta/beta-server';
import { isOnboardingPath, onboardingDestination } from '@/src/lib/onboarding/onboarding';
import { createClient } from '@/src/lib/supabase/server';

/**
 * The three writes onboarding needs, and no more.
 *
 * All of them land on the account's own `user_settings` row through its own
 * session, so row-level security is the boundary and there is nothing here to
 * authorize separately. None of them can fail a page: onboarding is help, and
 * help that breaks the product is not help.
 */

export interface OnboardingActionResult {
  ok: boolean;
  /** Where to send the reader, for the choice action. Always an existing route. */
  href?: string;
}

async function writeSettings(update: Record<string, string | null>): Promise<boolean> {
  try {
    const client = await createClient();
    if (!client) return false;
    const { data: { user } } = await client.auth.getUser();
    if (!user) return false;
    const { error } = await client.from('user_settings').upsert({
      user_id: user.id,
      ...update,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    return !error;
  } catch {
    return false;
  }
}

/** "อยากเริ่มจากอะไร?" — answered once, then never asked again. */
export async function chooseOnboardingPathAction(path: string): Promise<OnboardingActionResult> {
  if (!isOnboardingPath(path)) return { ok: false };
  const now = new Date().toISOString();
  const saved = await writeSettings({ onboarding_path: path, onboarding_chosen_at: now });
  /*
   * Which of four starting points a reader picked, and nothing else. The event
   * carries the path as its feature key — our own vocabulary, four possible
   * values — and lands once per account by the funnel's own dedupe rule.
   */
  recordBetaFunnelEventSafely({ event: 'onboarding_path_chosen', featureKey: path });
  return { ok: saved, href: onboardingDestination(path) };
}

/** The question waved away. It does not come back. */
export async function dismissOnboardingAction(): Promise<OnboardingActionResult> {
  return { ok: await writeSettings({ onboarding_dismissed_at: new Date().toISOString() }) };
}

/**
 * The first hint is finished — followed through or waved away.
 *
 * One timestamp for both, because the product does the same thing either way:
 * it stops asking, permanently, on every device.
 */
export async function completeOnboardingHintAction(): Promise<OnboardingActionResult> {
  return { ok: await writeSettings({ onboarding_hint_done_at: new Date().toISOString() }) };
}
