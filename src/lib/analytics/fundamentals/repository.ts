import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { clientEnv } from '@/src/config/env/client';
import { serverEnv } from '@/src/config/env/server';
import type { Database, Json } from '@/src/types/database';
import type { FundamentalsSnapshot } from './provider';
import type { FundamentalsLkgEntry, FundamentalsLkgRepository } from './service';
import { fundamentalsSnapshotSchema } from './validation';

export function fundamentalsLkgRepositoryConfigured(): boolean {
  return Boolean(clientEnv.NEXT_PUBLIC_SUPABASE_URL && serverEnv.SUPABASE_SERVICE_ROLE_KEY);
}

export function createFundamentalsLkgRepository(): FundamentalsLkgRepository | null {
  const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = serverEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async get(symbol, dataset): Promise<FundamentalsLkgEntry | null> {
      const { data, error } = await client
        .from('analytics_fundamentals_lkg')
        .select('*')
        .eq('symbol', symbol)
        .eq('dataset', dataset)
        .maybeSingle();
      if (error) throw new Error(`Fundamentals LKG read failed: ${error.code}`);
      if (!data || data.dataset !== 'financial-statements') return null;
      const snapshot = fundamentalsSnapshotSchema.parse(data.snapshot) as FundamentalsSnapshot;
      return {
        symbol: data.symbol,
        dataset: 'financial-statements',
        financialPeriods: snapshot.periods,
        snapshot,
        provider: data.provider,
        sourceAsOf: data.source_as_of,
        fetchedAt: data.fetched_at,
        validatedAt: data.validated_at,
        schemaVersion: data.schema_version,
      };
    },
    async upsert(entry): Promise<void> {
      const { error } = await client.from('analytics_fundamentals_lkg').upsert({
        symbol: entry.symbol,
        dataset: entry.dataset,
        financial_periods: entry.financialPeriods as unknown as Json,
        snapshot: entry.snapshot as unknown as Json,
        provider: entry.provider,
        source_as_of: entry.sourceAsOf,
        fetched_at: entry.fetchedAt,
        validated_at: entry.validatedAt,
        schema_version: entry.schemaVersion,
      }, { onConflict: 'symbol,dataset' });
      if (error) throw new Error(`Fundamentals LKG write failed: ${error.code}`);
    },
  };
}
