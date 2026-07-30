import { clientEnv, isSupabaseConfigured } from '@/src/config/env/client';

/**
 * Which external sign-in providers this Supabase project actually has switched
 * on, read from the project's own `/auth/v1/settings` document.
 *
 * The alternative — rendering a "ดำเนินการต่อด้วย Google" button because the
 * design has one — produces a control that sends the visitor to a provider
 * error page. So the button is bound to the live answer: it appears when Google
 * is enabled and disappears when it is not, with no redeploy and no env flag to
 * keep in sync. Anything unexpected (network failure, unparseable body) is
 * treated as "not available", because a missing button is a smaller failure
 * than a broken one.
 */
export interface EnabledAuthProviders {
  google: boolean;
}

export const NO_EXTERNAL_PROVIDERS: EnabledAuthProviders = { google: false };

export function parseEnabledProviders(payload: unknown): EnabledAuthProviders {
  if (!payload || typeof payload !== 'object') return NO_EXTERNAL_PROVIDERS;
  const external = (payload as { external?: unknown }).external;
  if (!external || typeof external !== 'object') return NO_EXTERNAL_PROVIDERS;
  return { google: (external as { google?: unknown }).google === true };
}

/**
 * Cached for five minutes at the data-cache layer: flipping a provider on in the
 * Supabase dashboard shows up within one cache window, while a burst of visits
 * to the sign-in page does not turn into a burst of settings requests.
 */
export async function getEnabledAuthProviders(): Promise<EnabledAuthProviders> {
  if (!isSupabaseConfigured) return NO_EXTERNAL_PROVIDERS;
  try {
    const response = await fetch(`${clientEnv.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string },
      next: { revalidate: 300 },
    });
    if (!response.ok) return NO_EXTERNAL_PROVIDERS;
    return parseEnabledProviders(await response.json());
  } catch {
    return NO_EXTERNAL_PROVIDERS;
  }
}
