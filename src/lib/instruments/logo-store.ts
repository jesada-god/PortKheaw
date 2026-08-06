import 'server-only';

import { createAdminClient } from '@/src/lib/supabase/admin';
import {
  ExpiringFailureMemory,
  LOGO_NEGATIVE_TTL_MS,
  normalizeLogoUrl,
  shouldPersistInstrumentLogo,
} from './logo-policy';

/**
 * Writes resolved logos back onto the instrument master, and takes one back when
 * the browser reports that it no longer paints.
 *
 * Persisting is what makes a logo survive a cold start: without it every render
 * re-asks the profile providers, which are rate limited, so the same company
 * appears with a picture on one page and a monogram on the next.
 */

const LOGO_METADATA_SOURCE = 'company-profile';

/**
 * URLs a browser has just reported as broken.
 *
 * Without it the next render would resolve the very URL that was cleared —
 * providers keep answering with it — and write it straight back, so the reader
 * would see the same broken image and the same invalidation forever. With it,
 * that URL is not a candidate again until the TTL lapses, which is also how a
 * genuinely temporary outage heals itself.
 */
const brokenLogoUrls = new ExpiringFailureMemory(LOGO_NEGATIVE_TTL_MS);

export function rememberBrokenLogoUrl(url: string): void {
  const normalized = normalizeLogoUrl(url);
  if (normalized) brokenLogoUrls.remember(normalized);
}

export function isBrokenLogoUrl(url: string | null | undefined): boolean {
  const normalized = normalizeLogoUrl(url);
  return normalized !== null && brokenLogoUrls.has(normalized);
}

/** Test seam: forgets every reported failure. */
export function resetBrokenLogoUrls(): void {
  brokenLogoUrls.clear();
}

export interface InstrumentLogoWrite {
  symbol: string;
  logoUrl: string;
  /** What the row held before, so an unchanged value costs no write. */
  persisted?: string | null;
}

/**
 * Stores newly resolved logos. Returns the symbols actually written.
 *
 * Never blocks a page: a missing service-role key, a schema without the column
 * or a failed write all resolve to "nothing persisted", and the caller still has
 * the URL it just resolved to render this time.
 */
export async function persistInstrumentLogos(
  writes: readonly InstrumentLogoWrite[],
): Promise<string[]> {
  const pending = writes.filter((write) => shouldPersistInstrumentLogo({
    persisted: write.persisted,
    resolved: write.logoUrl,
  }));
  if (pending.length === 0) return [];
  const client = createAdminClient();
  if (!client) return [];

  const updatedAt = new Date().toISOString();
  const written: string[] = [];
  await Promise.all(pending.map(async (write) => {
    const logoUrl = normalizeLogoUrl(write.logoUrl);
    if (!logoUrl) return;
    /*
     * An update, never an upsert: this table is owned by the instrument sync and
     * a row that does not exist here is not one this resolver may invent.
     */
    const { error } = await client
      .from('market_instruments')
      .update({
        logo_url: logoUrl,
        metadata_source: LOGO_METADATA_SOURCE,
        metadata_updated_at: updatedAt,
      } as never)
      .eq('symbol', write.symbol);
    if (!error) written.push(write.symbol);
  }));
  return written;
}

/**
 * Clears a stored logo, but only when it is exactly the URL that failed.
 *
 * The equality check is the whole guard: a caller can retire a picture the
 * browser could not load, and can do nothing else — not clear an unrelated
 * symbol, not install a URL of its own. The next resolution re-asks the
 * providers, so a URL that has merely moved comes straight back.
 */
export async function invalidateInstrumentLogo(
  symbol: string,
  brokenUrl: string,
): Promise<boolean> {
  const normalized = normalizeLogoUrl(brokenUrl);
  if (!normalized) return false;
  const client = createAdminClient();
  if (!client) return false;
  const { data, error } = await client
    .from('market_instruments')
    .update({ logo_url: null, metadata_updated_at: new Date().toISOString() } as never)
    .eq('symbol', symbol)
    .eq('logo_url', normalized)
    .select('symbol');
  if (error) return false;
  return (data ?? []).length > 0;
}
