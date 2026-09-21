import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { clientEnv } from '@/src/config/env/client';
import { serverEnv } from '@/src/config/env/server';
import type { Database } from '@/src/types/database';

/**
 * The shared translation cache, read and written with the service role.
 *
 * Third use of the pattern `createFundamentalsLkgRepository` established and
 * `createCompanyProfileSnapshotRepository` reused: service-role client, a
 * `get`/`upsert` pair, errors that carry a PostgREST code and nothing else.
 */

export interface ProfileTranslationRecord {
  symbol: string;
  targetLanguage: 'th';
  /** The hash of the profile the SERVER read when this was produced. */
  sourceHash: string;
  translatedText: string;
  provider: string;
  model: string;
  fetchedAt: string;
}

export interface ProfileTranslationRepository {
  /**
   * The stored translation for this symbol and language, or `null`.
   *
   * The caller compares `sourceHash` against the profile it just read: a row
   * whose hash does not match describes a profile that no longer exists and is
   * a miss, not a hit.
   */
  get(symbol: string, targetLanguage: 'th'): Promise<ProfileTranslationRecord | null>;
  upsert(record: ProfileTranslationRecord): Promise<void>;
}

export function createProfileTranslationRepository(): ProfileTranslationRepository | null {
  const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = serverEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async get(symbol, targetLanguage): Promise<ProfileTranslationRecord | null> {
      const { data, error } = await client
        .from('market_instrument_profile_translations')
        .select('*')
        .eq('symbol', symbol)
        .eq('target_language', targetLanguage)
        .maybeSingle();
      if (error) throw new Error(`Profile translation read failed: ${error.code}`);
      if (!data) return null;
      return {
        symbol: data.symbol,
        targetLanguage: data.target_language,
        sourceHash: data.source_hash,
        translatedText: data.translated_text,
        provider: data.provider,
        model: data.model,
        fetchedAt: data.fetched_at,
      };
    },
    async upsert(record): Promise<void> {
      const { error } = await client.from('market_instrument_profile_translations').upsert({
        symbol: record.symbol,
        target_language: record.targetLanguage,
        source_hash: record.sourceHash,
        translated_text: record.translatedText,
        provider: record.provider,
        model: record.model,
        fetched_at: record.fetchedAt,
      }, { onConflict: 'symbol,target_language' });
      if (error) throw new Error(`Profile translation write failed: ${error.code}`);
    },
  };
}
