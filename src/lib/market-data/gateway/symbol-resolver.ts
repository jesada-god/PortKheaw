import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { clientEnv, isSupabaseConfigured } from '@/src/config/env/client';
import type { Database } from '@/src/types/database';
import { resolvedInstrumentSchema, type ResolvedInstrument } from './contracts';

export interface InstrumentRecord {
  symbol: string;
  provider_symbol: string;
  name: string;
  exchange: string | null;
  asset_type: string;
  currency: string | null;
  status: string;
}

export interface InstrumentRepository {
  findExact(symbol: string): Promise<InstrumentRecord | null>;
  findMany?(symbols: readonly string[]): Promise<InstrumentRecord[]>;
}

const EXCHANGES: Array<{ pattern: RegExp; mic: string; timezone: string; supported: boolean }> = [
  // Nasdaq Trader's `Market Category` uses Q (Global Select), G (Global
  // Market), and S (Capital Market). Accept those legacy stored values as well
  // as normalized NASDAQ names so an instrument sync fallback cannot make a
  // valid Nasdaq symbol unsupported.
  { pattern: /NASDAQ|^[QGS]$/i, mic: 'XNAS', timezone: 'America/New_York', supported: true },
  { pattern: /NYSE\s*ARCA|ARCA/i, mic: 'ARCX', timezone: 'America/New_York', supported: true },
  { pattern: /NYSE/i, mic: 'XNYS', timezone: 'America/New_York', supported: true },
  { pattern: /AMEX|NYSE\s*MKT/i, mic: 'XASE', timezone: 'America/New_York', supported: true },
  { pattern: /OTC/i, mic: 'OTCM', timezone: 'America/New_York', supported: true },
];

function assetType(value: string, exchange: string | null): ResolvedInstrument['assetType'] {
  const normalized = value.toLowerCase();
  if (normalized.includes('etf')) return 'etf';
  if (normalized.includes('adr')) return 'adr';
  if (normalized.includes('reit')) return 'reit';
  if (normalized.includes('fund')) return 'fund';
  if (normalized.includes('index')) return 'index';
  if (exchange && /otc/i.test(exchange)) return 'otc';
  if (normalized.includes('stock')) return 'stock';
  return 'unknown';
}

class SupabaseInstrumentRepository implements InstrumentRepository {
  async findExact(symbol: string): Promise<InstrumentRecord | null> {
    if (!isSupabaseConfigured) return null;
    const client = createClient<Database>(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL as string,
      clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.from('market_instruments')
      .select('symbol,provider_symbol,name,exchange,asset_type,currency,status')
      .ilike('symbol', symbol)
      .limit(2);
    if (error) throw error;
    const exact = data?.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());
    return exact ?? null;
  }

  async findMany(symbols: readonly string[]): Promise<InstrumentRecord[]> {
    if (!isSupabaseConfigured || !symbols.length) return [];
    const client = createClient<Database>(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL as string,
      clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.from('market_instruments')
      .select('symbol,provider_symbol,name,exchange,asset_type,currency,status')
      .in('symbol', [...symbols]);
    if (error) throw error;
    return data ?? [];
  }
}

export class SymbolResolver {
  constructor(private readonly repository: InstrumentRepository = new SupabaseInstrumentRepository()) {}

  private resolved(requested: string, record: InstrumentRecord | null): ResolvedInstrument {
    if (!record) {
      return resolvedInstrumentSchema.parse({
        canonicalSymbol: requested,
        providerSymbol: requested,
        name: null,
        assetType: 'unknown',
        exchange: null,
        mic: null,
        currency: null,
        timezone: 'America/New_York',
        active: false,
        supported: false,
        unsupportedReason: isSupabaseConfigured
          ? 'Symbol is not present in market_instruments'
          : 'Instrument master is not configured',
      });
    }
    const exchange = EXCHANGES.find((candidate) => candidate.pattern.test(record.exchange ?? ''));
    const active = record.status === 'active';
    const type = assetType(record.asset_type, record.exchange);
    const supported = active && Boolean(exchange?.supported) && type !== 'unknown' && type !== 'index' && type !== 'fund';
    return resolvedInstrumentSchema.parse({
      canonicalSymbol: record.symbol.toUpperCase(),
      providerSymbol: record.provider_symbol.toUpperCase(),
      name: record.name || null,
      assetType: type,
      exchange: record.exchange,
      mic: exchange?.mic ?? null,
      currency: record.currency?.toUpperCase() ?? null,
      timezone: exchange?.timezone ?? 'America/New_York',
      active,
      supported,
      unsupportedReason: !active ? 'Instrument is delisted'
        : !exchange ? `Unsupported exchange: ${record.exchange ?? 'unknown'}`
          : type === 'index' || type === 'fund' || type === 'unknown' ? `Unsupported asset type: ${type}`
            : null,
    });
  }

  async resolve(symbol: string): Promise<ResolvedInstrument> {
    const requested = symbol.trim().toUpperCase();
    return this.resolved(requested, await this.repository.findExact(requested));
  }

  async resolveMany(symbols: readonly string[]): Promise<Map<string, ResolvedInstrument>> {
    const requested = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))]
      .filter(Boolean);
    if (!this.repository.findMany) {
      const values = await Promise.all(requested.map((symbol) => this.resolve(symbol)));
      return new Map(requested.map((symbol, index) => [symbol, values[index]!]));
    }
    const rows = await this.repository.findMany(requested);
    const bySymbol = new Map(rows.map((row) => [row.symbol.toUpperCase(), row]));
    return new Map(requested.map((symbol) => [
      symbol,
      this.resolved(symbol, bySymbol.get(symbol) ?? null),
    ]));
  }
}
