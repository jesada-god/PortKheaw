import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { clientEnv, isSupabaseConfigured } from '@/src/config/env/client';
import type { Database } from '@/src/types/database';
import type { InstrumentMetadata } from '@/src/lib/overview/types';
import classificationData from '@/src/generated/instrument-classification.json';
import type {
  InstrumentClassification,
  InstrumentClassificationDataset,
} from './classification';
import { selectMarketBreadthUniverse } from '@/src/lib/overview/market-breadth-universe';

type BasicRow = Database['public']['Tables']['market_instruments']['Row'];
type EnrichedRow = BasicRow & {
  sector: string | null;
  industry: string | null;
  website_domain: string | null;
  logo_url: string | null;
  metadata_source: string | null;
  metadata_updated_at: string | null;
};

const dataset = classificationData as InstrumentClassificationDataset;
const classificationBySymbol = new Map(
  dataset.instruments.map((item) => [item.symbol, item]),
);
const industryMemberCounts = dataset.instruments.reduce((counts, item) => {
  if (item.rankingEligible && item.stableSlug) {
    counts.set(item.stableSlug, (counts.get(item.stableSlug) ?? 0) + 1);
  }
  return counts;
}, new Map<string, number>());

function fromClassification(item: InstrumentClassification): InstrumentMetadata {
  return {
    symbol: item.symbol,
    companyIdentity: item.companyIdentity,
    companyName: item.companyName,
    exchange: item.exchange,
    assetType: item.assetType,
    currency: item.currency,
    sector: item.sectorNameEn,
    industry: item.industryNameEn,
    industryNameTh: item.industryNameTh,
    industrySlug: item.stableSlug,
    industryMemberCount: item.stableSlug
      ? industryMemberCounts.get(item.stableSlug) ?? null
      : null,
    rankingEligible: item.rankingEligible,
    websiteDomain: item.websiteDomain,
    logoUrl: item.logoUrl,
    metadataSource: item.metadataSource,
    updatedAt: item.updatedAt,
  };
}

function metadata(row: BasicRow | EnrichedRow): InstrumentMetadata {
  const enriched = row as Partial<EnrichedRow>;
  const classified = classificationBySymbol.get(row.symbol);
  return {
    symbol: row.symbol,
    companyIdentity: classified?.companyIdentity ?? null,
    companyName: row.name,
    exchange: row.exchange,
    assetType: row.asset_type,
    currency: row.currency,
    sector: enriched.sector ?? classified?.sectorNameEn ?? null,
    industry: enriched.industry ?? classified?.industryNameEn ?? null,
    industryNameTh: classified?.industryNameTh ?? null,
    industrySlug: classified?.stableSlug ?? null,
    industryMemberCount: classified?.stableSlug
      ? industryMemberCounts.get(classified.stableSlug) ?? null
      : null,
    rankingEligible: classified?.rankingEligible ?? false,
    websiteDomain: enriched.website_domain ?? classified?.websiteDomain ?? null,
    logoUrl: enriched.logo_url ?? classified?.logoUrl ?? null,
    metadataSource: enriched.metadata_source ?? classified?.metadataSource ?? row.provider,
    updatedAt: enriched.metadata_updated_at ?? classified?.updatedAt ?? row.updated_at,
  };
}

function fallback(symbol: string): InstrumentMetadata {
  const classified = classificationBySymbol.get(symbol);
  if (classified) return fromClassification(classified);
  return {
    symbol,
    companyIdentity: null,
    companyName: symbol,
    exchange: null,
    assetType: 'Stock',
    currency: 'USD',
    sector: null,
    industry: null,
    industryNameTh: null,
    industrySlug: null,
    industryMemberCount: null,
    rankingEligible: false,
    websiteDomain: null,
    logoUrl: null,
    metadataSource: 'instrument-master',
    updatedAt: null,
  };
}

function publicClient() {
  if (!isSupabaseConfigured) return null;
  return createClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL as string,
    clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

const ENRICHED_COLUMNS = [
  'id', 'symbol', 'name', 'exchange', 'asset_type', 'currency', 'country',
  'status', 'ipo_date', 'delisting_date', 'provider', 'provider_symbol',
  'searchable_text', 'last_synced_at', 'created_at', 'updated_at', 'sector',
  'industry', 'website_domain', 'logo_url', 'metadata_source',
  'metadata_updated_at',
].join(',');

export async function getInstrumentMetadata(
  symbols: readonly string[],
): Promise<Map<string, InstrumentMetadata>> {
  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))]
    .filter(Boolean);
  const output = new Map(normalized.map((symbol) => [symbol, fallback(symbol)]));
  const client = publicClient();
  if (!client || !normalized.length) return output;

  const enriched = await client.from('market_instruments')
    .select(ENRICHED_COLUMNS)
    .in('symbol', normalized);
  if (!enriched.error) {
    for (const row of enriched.data as unknown as EnrichedRow[]) {
      output.set(row.symbol, metadata(row));
    }
    return output;
  }

  const basic = await client.from('market_instruments').select('*').in('symbol', normalized);
  if (!basic.error) {
    for (const row of basic.data ?? []) output.set(row.symbol, metadata(row));
  }
  return output;
}

export async function getIndustryInstrumentUniverse(
  limit = 300,
  perIndustry = 6,
): Promise<InstrumentMetadata[]> {
  const groups = new Map<string, InstrumentMetadata[]>();
  for (const item of dataset.instruments) {
    if (!item.rankingEligible || !item.stableSlug) continue;
    const values = groups.get(item.stableSlug) ?? [];
    values.push(fromClassification(item));
    groups.set(item.stableSlug, values);
  }
  const exchangePriority = (exchange: string | null): number => {
    if (/^(NYSE|NASDAQ)$/i.test(exchange ?? '')) return 0;
    if (/^[QG]$/i.test(exchange ?? '')) return 1;
    if (/^S$/i.test(exchange ?? '')) return 2;
    return 3;
  };
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, values]) => values
      .sort((left, right) =>
        exchangePriority(left.exchange) - exchangePriority(right.exchange)
        || left.symbol.length - right.symbol.length
        || left.symbol.localeCompare(right.symbol))
      .slice(0, Math.max(1, perIndustry)))
    .slice(0, Math.max(1, Math.min(limit, 500)));
}

export async function getMarketBreadthInstrumentUniverse(): Promise<InstrumentMetadata[]> {
  return selectMarketBreadthUniverse(dataset.instruments).map(fromClassification);
}

export async function getIndustryInstruments(
  slug: string,
  limit = 120,
): Promise<InstrumentMetadata[]> {
  return dataset.instruments
    .filter((item) => item.rankingEligible && item.stableSlug === slug)
    .map(fromClassification)
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export function getInstrumentClassificationCoverage() {
  return dataset.coverage;
}

export function getInstrumentClassificationMetadata() {
  return {
    generatedAt: dataset.generatedAt,
    taxonomyVersion: dataset.taxonomyVersion,
    sourceLastModified: dataset.source.submissionsLastModified,
  };
}
