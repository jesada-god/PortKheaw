import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { clientEnv, isSupabaseConfigured } from '@/src/config/env/client';
import type { Database } from '@/src/types/database';
import type { ProviderResult, SymbolSearchResult } from '@/src/lib/market-data/types';
import type { InstrumentAssetType } from './types';
import { normalizeLogoUrl } from './logo-policy';

export interface InstrumentSearchOptions {
  assetType?: InstrumentAssetType;
  includeDelisted?: boolean;
  limit?: number;
}

export interface InstrumentSearchOutcome {
  configured: boolean;
  databaseEmpty: boolean;
  result: ProviderResult<SymbolSearchResult[]> | null;
}

const CACHE_SECONDS = 30;
const cache = new Map<string, { expiresAt: number; outcome: InstrumentSearchOutcome }>();

/**
 * The persisted logo for each hit, in one query.
 *
 * The search RPC predates the metadata columns and returns its own row shape, so
 * the logos are read alongside rather than by changing a function every search
 * depends on. A failure here costs a monogram, never a search result.
 */
async function readPersistedLogos(
  client: ReturnType<typeof createClient<Database>>,
  symbols: readonly string[],
): Promise<Map<string, string | null>> {
  const logos = new Map<string, string | null>();
  if (symbols.length === 0) return logos;
  const { data, error } = await client
    .from('market_instruments')
    .select('symbol,logo_url')
    .in('symbol', [...new Set(symbols)]);
  if (error) return logos;
  for (const row of (data ?? []) as unknown as Array<{ symbol: string; logo_url: string | null }>) {
    logos.set(row.symbol, normalizeLogoUrl(row.logo_url));
  }
  return logos;
}

function sanitizeSearchQuery(query: string): string {
  return query.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export async function searchInstrumentMaster(query: string, options: InstrumentSearchOptions = {}): Promise<InstrumentSearchOutcome> {
  if (!isSupabaseConfigured) return { configured: false, databaseEmpty: true, result: null };
  const normalized = sanitizeSearchQuery(query);
  const key = JSON.stringify([normalized.toLowerCase(), options.assetType ?? null, Boolean(options.includeDelisted), options.limit ?? 15]);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.outcome;

  const client = createClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL as string,
    clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { count, error: countError } = await client.from('market_instruments').select('id', { count: 'exact', head: true });
  if (countError) {
    if (countError.code === '42P01' || countError.code === 'PGRST205') return { configured: true, databaseEmpty: true, result: null };
    throw countError;
  }
  if (!count) {
    const outcome = { configured: true, databaseEmpty: true, result: null };
    cache.set(key, { expiresAt: Date.now() + CACHE_SECONDS * 1000, outcome });
    return outcome;
  }
  const { data, error } = await client.rpc('search_market_instruments', {
    input_query: normalized,
    input_asset_type: options.assetType ?? null,
    input_include_delisted: options.includeDelisted ?? false,
    input_limit: options.limit ?? 15,
  });
  if (error) throw error;
  const rows = data ?? [];
  const logos = await readPersistedLogos(client, rows.map((row) => row.symbol));
  const result: ProviderResult<SymbolSearchResult[]> = {
    data: rows.map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      exchange: instrument.exchange,
      assetType: instrument.asset_type,
      currency: instrument.currency,
      status: instrument.status === 'delisted' ? 'delisted' : 'active',
      marketOpen: null,
      marketClose: null,
      timezone: null,
      matchScore: instrument.match_score,
      logoUrl: logos.get(instrument.symbol) ?? null,
    })),
    freshness: { status: 'cached', asOf: null, maxAgeSeconds: CACHE_SECONDS },
    provider: 'supabase-instrument-master',
  };
  const outcome = { configured: true, databaseEmpty: false, result };
  cache.set(key, { expiresAt: Date.now() + CACHE_SECONDS * 1000, outcome });
  return outcome;
}
