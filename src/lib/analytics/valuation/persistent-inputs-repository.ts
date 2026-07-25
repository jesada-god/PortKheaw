import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { clientEnv } from '@/src/config/env/client';
import { serverEnv } from '@/src/config/env/server';
import type { Database, Json } from '@/src/types/database';
import {
  ValuationInputLkgService,
  type ValuationInputLkgEntry,
  type ValuationInputLkgRepository,
} from './persistent-inputs';

let service: ValuationInputLkgService | null = null;

export function valuationInputLkgRepositoryConfigured(): boolean {
  return Boolean(clientEnv.NEXT_PUBLIC_SUPABASE_URL && serverEnv.SUPABASE_SERVICE_ROLE_KEY);
}

export function createValuationInputLkgRepository(): ValuationInputLkgRepository | null {
  const url = clientEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = serverEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async list(ownerKey): Promise<ValuationInputLkgEntry[]> {
      const { data, error } = await client
        .from('analytics_valuation_inputs_lkg')
        .select('*')
        .eq('owner_key', ownerKey);
      if (error) throw new Error(`Valuation LKG read failed: ${error.code}`);
      return (data ?? []).map((row) => ({
        scope: row.scope,
        ownerKey: row.owner_key,
        metric: row.metric,
        period: row.period,
        data: row.data,
        source: row.source,
        origin: row.origin,
        asOf: row.source_as_of,
        fetchedAt: row.fetched_at,
        validatedAt: row.validated_at,
        freshness: row.freshness,
        schemaVersion: row.schema_version,
        provenance: row.provenance as ValuationInputLkgEntry['provenance'],
      }));
    },
    async upsert(entry): Promise<void> {
      const { error } = await client.from('analytics_valuation_inputs_lkg').upsert({
        scope: entry.scope,
        owner_key: entry.ownerKey,
        metric: entry.metric,
        period: entry.period,
        data: entry.data as Json,
        source: entry.source,
        origin: entry.origin,
        source_as_of: entry.asOf,
        fetched_at: entry.fetchedAt,
        validated_at: entry.validatedAt,
        freshness: entry.freshness,
        schema_version: entry.schemaVersion,
        provenance: entry.provenance as unknown as Json,
      }, { onConflict: 'scope,owner_key,metric,period' });
      if (error) throw new Error(`Valuation LKG write failed: ${error.code}`);
    },
  };
}

export function getValuationInputLkgService(): ValuationInputLkgService {
  service ??= new ValuationInputLkgService(createValuationInputLkgRepository());
  return service;
}
