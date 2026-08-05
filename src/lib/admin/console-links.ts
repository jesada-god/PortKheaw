/**
 * Deep links into the provider and the database, built on the server.
 *
 * An operator investigating a payment eventually has to open Stripe or Supabase.
 * Building those addresses here rather than in a component means three things
 * hold by construction:
 *
 *   * the identifier lives in an `href` and never in rendered text — the label
 *     beside every one of these is masked;
 *   * the address is composed from a validated identifier shape, so a malformed
 *     value produces no link at all rather than a link to somewhere unintended;
 *   * the whole module is reachable only from pages behind the operator gate.
 *
 * Nothing here reads or embeds a key. A Stripe dashboard address is a public URL
 * that grants nothing on its own; opening it still requires the operator's own
 * Stripe session.
 */

export type ProviderMode = 'test' | 'live';

/** Stripe object ids are `prefix_alphanumerics`. Anything else is not linked. */
function validIdentifier(value: string | null | undefined): string | null {
  const text = value?.trim() ?? '';
  return /^[A-Za-z]{2,10}_[A-Za-z0-9]{6,64}$/.test(text) ? text : null;
}

function stripeBase(mode: ProviderMode): string {
  return mode === 'live'
    ? 'https://dashboard.stripe.com'
    : 'https://dashboard.stripe.com/test';
}

export function stripeInvoiceUrl(mode: ProviderMode, invoiceId: string | null | undefined): string | null {
  const id = validIdentifier(invoiceId);
  return id ? `${stripeBase(mode)}/invoices/${id}` : null;
}

export function stripeCustomerUrl(mode: ProviderMode, customerId: string | null | undefined): string | null {
  const id = validIdentifier(customerId);
  return id ? `${stripeBase(mode)}/customers/${id}` : null;
}

export function stripeEventUrl(mode: ProviderMode, eventId: string | null | undefined): string | null {
  const id = validIdentifier(eventId);
  return id ? `${stripeBase(mode)}/events/${id}` : null;
}

/**
 * The Supabase project reference, read from the public API URL.
 *
 * The URL is already public — it ships in the browser bundle — so deriving the
 * reference from it introduces no exposure. It is *not* taken from the service
 * key, which must never be read outside the server modules that use it.
 */
export function supabaseProjectRef(supabaseUrl: string | null | undefined): string | null {
  const text = supabaseUrl?.trim() ?? '';
  if (!text) return null;
  try {
    const host = new URL(text).hostname;
    const [ref] = host.split('.');
    return /^[a-z0-9]{16,32}$/.test(ref ?? '') ? ref : null;
  } catch {
    return null;
  }
}

/** A filtered table view in the Supabase dashboard, for one account's rows. */
export function supabaseAccountUrl(projectRef: string | null, userId: string | null | undefined): string | null {
  const id = userId?.trim() ?? '';
  if (!projectRef) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return `https://supabase.com/dashboard/project/${projectRef}/auth/users?filter=${encodeURIComponent(id)}`;
}
