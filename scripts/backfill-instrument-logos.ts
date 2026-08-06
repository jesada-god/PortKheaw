/**
 * One-time (and re-runnable) logo backfill for the instrument master.
 *
 * `market_instruments.logo_url` has existed since the metadata migration but was
 * never filled, so every logo the product showed came from a live profile
 * request — which is why the same company appeared with a picture on one page
 * and a monogram on the next. This walks the instruments that actually appear in
 * the product, asks the profile provider once each, verifies the URL really
 * serves an image, and stores it. Nothing is invented: a symbol the provider has
 * no logo for is left null and renders its symbol badge.
 *
 * Scope, in order: every symbol in a portfolio or watchlist, the market overview
 * proxies, then the ranking universe — so the pages a reader opens first are
 * filled first, and `--limit` can stop it anywhere without leaving a mess.
 *
 * Run: npm run instruments:backfill-logos -- [--limit=400] [--dry-run] [SYMBOL...]
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeLogoUrl } from '@/src/lib/instruments/logo-policy';

const CONCURRENCY = 4;
const IMAGE_TIMEOUT_MS = 8_000;

interface Row { symbol: string; logo_url: string | null }

/**
 * The provider's daily quota is spent. Every remaining symbol would fail the
 * same way, so the run stops and says so rather than reporting hundreds of
 * indistinguishable failures — the rest are picked up by the next run, and in
 * the meantime the resolver fills them in as pages are opened.
 */
class RateLimited extends Error {
  constructor() { super('provider daily limit reached'); }
}

function argValue(name: string): string | null {
  const match = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
}

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Math.max(1, Number(argValue('limit') ?? 500));
const EXPLICIT = process.argv.slice(2)
  .filter((value) => !value.startsWith('--'))
  .map((value) => value.trim().toUpperCase());

function client(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Symbols the product already shows, most-visible first. */
async function targetSymbols(db: SupabaseClient): Promise<string[]> {
  if (EXPLICIT.length > 0) return EXPLICIT;
  const ordered: string[] = [];
  const add = (symbol: string | null | undefined) => {
    const value = symbol?.trim().toUpperCase();
    if (value && !ordered.includes(value)) ordered.push(value);
  };

  const holdings = await db.from('portfolio_transactions').select('symbol').limit(5_000);
  for (const row of (holdings.data ?? []) as Array<{ symbol: string | null }>) add(row.symbol);
  const watched = await db.from('watchlist_items').select('symbol').limit(5_000);
  for (const row of (watched.data ?? []) as Array<{ symbol: string | null }>) add(row.symbol);

  const { MARKET_ASSETS } = await import('@/src/lib/overview/market-assets');
  for (const asset of MARKET_ASSETS) add(asset.symbol);

  /*
   * The ranking universe, read from the generated classification rather than
   * through `instruments/master` — that module is `server-only` and refuses to
   * load outside a request. Same dataset, same eligibility rule, capped per
   * industry so the budget is spread across groups instead of spent on one.
   */
  const dataset = (await import('@/src/generated/instrument-classification.json'))
    .default as { instruments: Array<{ symbol: string; rankingEligible: boolean; stableSlug: string | null }> };
  const perIndustry = new Map<string, number>();
  for (const item of dataset.instruments) {
    if (!item.rankingEligible || !item.stableSlug) continue;
    const taken = perIndustry.get(item.stableSlug) ?? 0;
    if (taken >= 8) continue;
    perIndustry.set(item.stableSlug, taken + 1);
    add(item.symbol);
  }

  return ordered;
}

/** The provider's answer, and proof that it actually serves a picture. */
async function resolveLogo(symbol: string, apiKey: string): Promise<string | null> {
  const url = new URL('https://financialmodelingprep.com/stable/profile');
  url.searchParams.set('symbol', symbol);
  const response = await fetch(url, {
    headers: { Accept: 'application/json', apikey: apiKey },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (response.status === 429) throw new RateLimited();
  if (!response.ok) throw new Error(`profile ${response.status}`);
  const payload: unknown = await response.json();
  const row = Array.isArray(payload) ? payload[0] as { image?: string | null } : null;
  const candidate = normalizeLogoUrl(row?.image ?? null);
  if (!candidate) return null;

  /*
   * A URL is only stored once it has been fetched. Persisting an unverified
   * string is how a broken image becomes permanent for every reader at once.
   */
  const image = await fetch(candidate, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!image.ok) return null;
  const contentType = image.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.startsWith('image/') ? candidate : null;
}

async function main() {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY is required');
  const db = client();
  const symbols = (await targetSymbols(db)).slice(0, LIMIT * 3);

  const existing = new Map<string, string | null>();
  for (let index = 0; index < symbols.length; index += 200) {
    const slice = symbols.slice(index, index + 200);
    const { data, error } = await db.from('market_instruments')
      .select('symbol,logo_url').in('symbol', slice);
    if (error) throw new Error(`read failed: ${error.message}`);
    for (const row of (data ?? []) as Row[]) existing.set(row.symbol, row.logo_url);
  }

  const pending = symbols
    .filter((symbol) => existing.has(symbol) && !normalizeLogoUrl(existing.get(symbol)))
    .slice(0, LIMIT);
  process.stdout.write(`${JSON.stringify({
    event: 'logo_backfill_start',
    candidates: symbols.length,
    known: existing.size,
    pending: pending.length,
    dryRun: DRY_RUN,
  })}\n`);

  const counts = { written: 0, noLogo: 0, failed: 0 };
  let rateLimited = false;
  let cursor = 0;
  const updatedAt = new Date().toISOString();
  const worker = async () => {
    while (cursor < pending.length && !rateLimited) {
      const symbol = pending[cursor++];
      if (!symbol) continue;
      try {
        const logoUrl = await resolveLogo(symbol, apiKey);
        if (!logoUrl) { counts.noLogo += 1; continue; }
        if (DRY_RUN) { counts.written += 1; continue; }
        const { error } = await db.from('market_instruments')
          .update({
            logo_url: logoUrl,
            metadata_source: 'company-profile',
            metadata_updated_at: updatedAt,
          })
          .eq('symbol', symbol);
        if (error) { counts.failed += 1; continue; }
        counts.written += 1;
      } catch (error) {
        if (error instanceof RateLimited) { rateLimited = true; break; }
        counts.failed += 1;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(CONCURRENCY, Math.max(1, pending.length)) },
    () => worker(),
  ));

  process.stdout.write(`${JSON.stringify({ event: 'logo_backfill_done', ...counts })}\n`);
  if (counts.written === 0 && pending.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    event: 'logo_backfill_failed',
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exit(1);
});
