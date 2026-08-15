import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { StockPlanCreateInput, StockPlanUpdateInput } from './stock-plan-schema';

/**
 * Saved plans, read and written on the reader's own session.
 *
 * Every statement below carries `.eq('user_id', this.userId)` even though row
 * level security already restricts the table to `auth.uid()`. That is not
 * redundancy for its own sake: the filter and the policy fail independently, so a
 * policy that is ever dropped, replaced or widened by a later migration still
 * meets a query that only ever asked for one person's rows. Neither is trusted to
 * be the only thing standing there.
 *
 * The client is the caller's, built from their session — there is no service-role
 * client anywhere in this file, and none in the routes that use it.
 */

type Row = Database['public']['Tables']['stock_plans']['Row'];

export interface SavedStockPlan {
  id: string;
  symbol: string;
  /** The canonical accepted price when the plan was created. Never changes. */
  baselinePrice: number;
  targetPrice: number;
  invalidationPrice: number;
  horizonDate: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Postgres `numeric` arrives as a string through PostgREST when it exceeds the
 * range JS can hold exactly, so every price is coerced rather than cast. A value
 * that will not parse is a corrupt row, and `NaN` reaching the arithmetic would
 * be worse than failing here.
 */
function money(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Stored plan price is not a number');
  return parsed;
}

function mapRow(row: Row): SavedStockPlan {
  return {
    id: row.id,
    symbol: row.symbol,
    baselinePrice: money(row.baseline_price),
    targetPrice: money(row.target_price),
    invalidationPrice: money(row.invalidation_price),
    horizonDate: row.horizon_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class StockPlansRepository {
  constructor(
    private readonly client: SupabaseClient<Database>,
    private readonly userId: string,
  ) {}

  /** Live plans, newest first. Archived plans are never listed. */
  async list(limit = 50): Promise<SavedStockPlan[]> {
    const { data, error } = await this.client
      .from('stock_plans')
      .select('*')
      .eq('user_id', this.userId)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map(mapRow);
  }

  async create(input: StockPlanCreateInput): Promise<SavedStockPlan> {
    const { data, error } = await this.client
      .from('stock_plans')
      .insert({
        user_id: this.userId,
        symbol: input.symbol,
        baseline_price: input.baselinePrice,
        target_price: input.targetPrice,
        invalidation_price: input.invalidationPrice,
        horizon_date: input.horizonDate,
      })
      .select('*')
      .single();
    if (error || !data) throw error ?? new Error('Plan was not created');
    return mapRow(data);
  }

  /** The stored baseline, so an edit can be judged against it. `null` if not theirs. */
  async baselineOf(id: string): Promise<number | null> {
    const { data, error } = await this.client
      .from('stock_plans')
      .select('baseline_price')
      .eq('id', id)
      .eq('user_id', this.userId)
      .is('archived_at', null)
      .maybeSingle();
    if (error) throw error;
    return data ? money(data.baseline_price) : null;
  }

  /**
   * Edit the three things an edit may touch.
   *
   * The update object cannot name `baseline_price` — the `Update` type omits it —
   * so this method has no way to move a baseline even by mistake, and the
   * database's own trigger refuses it as well if anything ever finds one.
   */
  async update(id: string, input: StockPlanUpdateInput): Promise<SavedStockPlan | null> {
    const { data, error } = await this.client
      .from('stock_plans')
      .update({
        target_price: input.targetPrice,
        invalidation_price: input.invalidationPrice,
        horizon_date: input.horizonDate,
      })
      .eq('id', id)
      .eq('user_id', this.userId)
      .is('archived_at', null)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    return data ? mapRow(data) : null;
  }

  /**
   * Archive, which is what "delete" means here.
   *
   * The row stays, so a mis-tap costs nothing and an operator can restore it. The
   * reader stops seeing it, which is the whole of what they asked for.
   */
  async archive(id: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('stock_plans')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', this.userId)
      .is('archived_at', null)
      .select('id');
    if (error) throw error;
    return Boolean(data?.length);
  }
}
