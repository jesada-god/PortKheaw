import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { OptionSide, OptionTarget, OptionTargetMode } from './types';

type Row = Database['public']['Tables']['portfolio_option_targets']['Row'];

function mapRow(row: Row): OptionTarget {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    contractSymbol: row.contract_symbol,
    side: row.side,
    mode: row.mode,
    targetValue: Number(row.target_value),
    targetPremium: Number(row.target_premium),
    estimatedFee: Number(row.estimated_fee),
    enabled: row.enabled,
    triggeredAt: row.triggered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class OptionTargetRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async getAll(portfolioId: string): Promise<OptionTarget[]> {
    const { data, error } = await this.client.from('portfolio_option_targets').select('*')
      .eq('portfolio_id', portfolioId).order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapRow);
  }

  async upsert(input: {
    id?: string;
    contractSymbol: string;
    side: OptionSide;
    mode: OptionTargetMode;
    targetValue: number;
    targetPremium: number;
    estimatedFee: number;
  }): Promise<string> {
    const { data, error } = await this.client.rpc('upsert_portfolio_option_target', {
      input_id: input.id ?? null,
      input_contract_symbol: input.contractSymbol.toUpperCase(),
      input_side: input.side,
      input_mode: input.mode,
      input_target_value: String(input.targetValue),
      input_target_premium: String(input.targetPremium),
      input_estimated_fee: String(input.estimatedFee),
    });
    if (error || !data) throw error ?? new Error('Option target was not saved');
    return data;
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.rpc('delete_portfolio_option_target', { target_id: id });
    if (error) throw error;
  }

  async evaluate(target: OptionTarget, observedPremium: number, observedAt: string): Promise<string | null> {
    const { data, error } = await this.client.rpc('evaluate_portfolio_option_target', {
      target_id: target.id,
      observed_premium: observedPremium,
      observed_at: observedAt,
      notification_title: `ออปชัน ${target.contractSymbol} ถึงเป้าหมายแล้ว`,
      notification_message: `ราคาประเมิน ${observedPremium.toFixed(2)} ถึงเป้าหมาย ${target.targetPremium.toFixed(2)} ที่ตั้งไว้ในพอร์ต`,
    });
    if (error) throw error;
    return data;
  }
}
