/**
 * The one place that decides which logo a symbol shows, and for how long a
 * failure is remembered.
 *
 * Deliberately free of `server-only` and of any I/O: the same rules run on the
 * server (where a logo is resolved and persisted) and in the browser (where a
 * broken image falls back to a monogram). Anything that talks to Supabase or a
 * provider lives in `logo-store.ts` / `presentation.ts`; anything that renders
 * lives in `InstrumentLogo`.
 */

/**
 * How long "this symbol has no logo anywhere" is believed before the providers
 * are asked again. Long enough that a page render never re-asks, short enough
 * that a newly listed company is picked up the same day.
 */
export const LOGO_NEGATIVE_TTL_MS = 6 * 60 * 60_000;

/**
 * How long a symbol whose logo source was UNAVAILABLE is left alone before a
 * background render asks again.
 *
 * The providers are on a daily quota, and the profile service's own cooldown is
 * only a minute — long enough that a busy site would spend the whole day's
 * allowance re-asking about symbols nobody can answer for. A reader-initiated
 * add always bypasses this; only background resolution honours it.
 */
export const LOGO_DEFERRED_TTL_MS = 15 * 60_000;

/**
 * How long a resolved logo is trusted in-process without re-reading it.
 *
 * The database is the real cache; this only covers the gap where a symbol has no
 * row on the instrument master to write to, so nothing would otherwise stop the
 * next render from asking the provider all over again.
 */
export const LOGO_RESOLVED_TTL_MS = 24 * 60 * 60_000;

/**
 * How long a *browser* remembers that one URL failed to paint. Shorter than the
 * server's, because the usual cause is a dropped request rather than a missing
 * file, and a reader who scrolls back should get another chance at the picture.
 */
export const LOGO_FAILURE_TTL_MS = 10 * 60_000;

/**
 * Accepts only what can be rendered safely and unambiguously: a credential-free
 * HTTPS URL, or a root-relative asset this deployment serves itself.
 *
 * Everything else — an empty string, `http:`, a protocol-relative `//host`, a
 * `data:` payload, a string a provider filled with the word "null" — collapses
 * to `null`, which is the signal for "show the monogram" and, crucially, the
 * signal that a value must never be written over a logo that already works.
 */
export function normalizeLogoUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined') {
    return null;
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed.split('#', 1)[0] || null;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The resolution order the product promises, in one expression:
 *   1. the logo already persisted on the instrument master,
 *   2. whatever the profile provider returned this time,
 *   3. nothing — the caller renders a stable symbol badge.
 *
 * A provider that answers with `null`, `''` or an unusable URL therefore cannot
 * take a working logo away; it can only fill a gap.
 */
export function chooseInstrumentLogoUrl(input: {
  persisted?: string | null;
  provider?: string | null;
}): string | null {
  return normalizeLogoUrl(input.persisted) ?? normalizeLogoUrl(input.provider);
}

/**
 * Whether a resolution is worth a write. Only a real URL that differs from what
 * is stored is — so a page render that resolves the same logo it read costs no
 * database traffic, and a failed resolution never blanks the column.
 */
export function shouldPersistInstrumentLogo(input: {
  persisted?: string | null;
  resolved?: string | null;
}): boolean {
  const resolved = normalizeLogoUrl(input.resolved);
  if (!resolved) return false;
  return resolved !== normalizeLogoUrl(input.persisted);
}

/**
 * A remembered failure that expires.
 *
 * Used for both "no provider has a logo for this symbol" (server) and "this URL
 * did not paint" (browser). The TTL is the whole point: without it a single bad
 * afternoon would hide a company's logo until the process restarted, and with a
 * retry-on-every-render instead we would hammer the provider. Between those two
 * failure modes sits one attempt per TTL.
 */
export class ExpiringFailureMemory {
  private readonly entries = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  has(key: string, now: number = Date.now()): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > now) return true;
    this.entries.delete(key);
    return false;
  }

  remember(key: string, now: number = Date.now()): void {
    this.entries.set(key, now + this.ttlMs);
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Trims the listing-file suffix off an instrument-master name.
 *
 * The master stores the exchange's own wording — "Rocket Lab Corporation -
 * Common Stock" — which is correct but reads as noise in a row that is already
 * labelled with the symbol. Only the trailing share-class clause is removed;
 * the company name itself is never rewritten.
 */
export function tidyInstrumentName(name: string): string {
  const trimmed = name.trim();
  const tidied = trimmed.replace(
    /\s+-\s+(?:(?:Class\s+[A-Z]\s+)?(?:Common|Ordinary)\s+(?:Stock|Shares)|American Depositary Shares?|Common Shares?|Depositary Shares?)\.?$/i,
    '',
  ).trim();
  return tidied || trimmed;
}
