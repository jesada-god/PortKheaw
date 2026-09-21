import 'server-only';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { clientEnv } from '@/src/config/env/client';
import { serverEnv } from '@/src/config/env/server';
import type { Database, Json } from '@/src/types/database';
import { companyProfileSchema, type CompanyProfile } from './types';

/**
 * The shared company-profile snapshot, read and written with the service role.
 *
 * Shaped after `createFundamentalsLkgRepository` deliberately — same service
 * role client, same `get`/`upsert` pair, same "re-validate the jsonb on the way
 * out" rule, same error strings that carry a PostgREST code and nothing else.
 * There is one way to cache a provider answer in this product and this is a
 * second use of it, not a second design.
 */

/**
 * Bumped when `companyProfileSchema` changes shape.
 *
 * A row written by an older deploy is not deleted, it is ignored: the reader
 * treats a mismatched version as a miss and the next write replaces it. That is
 * what lets a schema change deploy without a backfill and without serving a
 * profile parsed into the wrong object.
 */
export const COMPANY_PROFILE_SCHEMA_VERSION = 1;

export interface CompanyProfileSnapshot {
  symbol: string;
  profile: CompanyProfile;
  provider: string;
  /** sha256 of the canonical payload — the translation cache keys on it. */
  sourceHash: string;
  /** When the provider answered. Freshness is measured from this, not `updated_at`. */
  fetchedAt: string;
}

export interface CompanyProfileSnapshotRepository {
  get(symbol: string): Promise<CompanyProfileSnapshot | null>;
  upsert(snapshot: CompanyProfileSnapshot): Promise<void>;
}

/**
 * The hash the snapshot and the translation cache agree on.
 *
 * Keys are sorted before stringifying so two structurally identical profiles
 * that happened to arrive with different key order hash the same. Without that
 * a provider changing its serialisation order would look like every company in
 * the market changing its description at once, and would re-translate the
 * entire corpus.
 */
export function companyProfileSourceHash(profile: CompanyProfile): string {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(profile as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function companyProfileSnapshotConfigured(): boolean {
  return Boolean(clientEnv.NEXT_PUBLIC_SUPABASE_URL && serverEnv.SUPABASE_SERVICE_ROLE_KEY);
}

export function createCompanyProfileSnapshotRepository(): CompanyProfileSnapshotRepository | null {
  const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = serverEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async get(symbol: string): Promise<CompanyProfileSnapshot | null> {
      const { data, error } = await client
        .from('market_instrument_profiles')
        .select('*')
        .eq('symbol', symbol)
        .maybeSingle();
      if (error) throw new Error(`Company profile snapshot read failed: ${error.code}`);
      if (!data) return null;
      // A row from an older deploy is a miss, not a parse error — see the note
      // on COMPANY_PROFILE_SCHEMA_VERSION.
      if (data.schema_version !== COMPANY_PROFILE_SCHEMA_VERSION) return null;
      /*
       * Re-validated, never cast. The column is `jsonb` and the type is `Json`,
       * so nothing about the stored value is guaranteed by the compiler — and
       * the row may have been written by a deploy whose notion of a profile was
       * not this one. A parse failure here is a miss, which costs one provider
       * call, rather than a malformed profile rendered to a reader.
       */
      const parsed = companyProfileSchema.safeParse(data.payload);
      if (!parsed.success) return null;
      return {
        symbol: data.symbol,
        profile: parsed.data,
        provider: data.provider,
        sourceHash: data.source_hash,
        fetchedAt: data.fetched_at,
      };
    },
    async upsert(snapshot: CompanyProfileSnapshot): Promise<void> {
      const { error } = await client.from('market_instrument_profiles').upsert({
        symbol: snapshot.symbol,
        payload: snapshot.profile as unknown as Json,
        provider: snapshot.provider,
        source_hash: snapshot.sourceHash,
        fetched_at: snapshot.fetchedAt,
        schema_version: COMPANY_PROFILE_SCHEMA_VERSION,
      }, { onConflict: 'symbol' });
      if (error) throw new Error(`Company profile snapshot write failed: ${error.code}`);
    },
  };
}
