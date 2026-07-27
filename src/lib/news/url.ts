export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}

/**
 * Query parameters that identify a campaign/click, never the article. Stripping
 * them lets the same story syndicated through two links collapse into one card.
 */
const TRACKING_PARAMETERS = [
  /^utm_/i,
  /^(fbclid|gclid|dclid|msclkid|igshid|mc_cid|mc_eid|yclid|_hsenc|_hsmi)$/i,
  /^(ref|ref_src|refsrc|source|src|cmpid|ncid|guccounter|guce_referrer|guce_referrer_sig)$/i,
];

/**
 * Identity of an article link for de-duplication only — never rendered or fetched.
 *
 * News aggregators hand back the same article under links that differ solely by
 * `www.`, a trailing slash, or campaign parameters. Reducing to
 * `host + path + meaningful query` makes those collapse while keeping links that
 * genuinely differ (e.g. `?p=123`) apart. Returns `null` for anything unparseable
 * so the caller can fall back to another key instead of merging unrelated items.
 */
export function canonicalNewsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAMETERS.some((pattern) => pattern.test(key)))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return `${host}${path}${query ? `?${query}` : ''}`;
  } catch { return null; }
}
