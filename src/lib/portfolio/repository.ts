import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { PortfolioGoal, PortfolioRecord, PortfolioTransaction, PortfolioType } from './types';
import type { TransactionInput } from './validation';
import {
  resolveTransactionTimeZone,
  transactionDateTimeToUtcIso,
} from './transaction-datetime';

type TransactionRow = Database['public']['Tables']['portfolio_transactions']['Row'];

function numericString(value: string | number | null): string | null {
  if (value == null) return null;
  return typeof value === 'number' ? value.toFixed(8) : String(value);
}

function mapTransaction(row: TransactionRow): PortfolioTransaction {
  return {
    id: row.id, portfolioId: row.portfolio_id, type: row.transaction_type, symbol: row.symbol,
    quantity: numericString(row.quantity), price: numericString(row.price), amount: numericString(row.amount), occurredAt: row.occurred_at,
    originalAmount: numericString(row.original_amount), originalCurrency: row.original_currency,
    fxRateAtTransaction: numericString(row.fx_rate_at_transaction), normalizedAmountUsd: numericString(row.normalized_amount_usd),
    normalizedPriceUsd: numericString(row.normalized_price_usd), fee: numericString(row.fee),
    normalizedFeeUsd: numericString(row.normalized_fee_usd), broker: row.broker, occurredAtTime: row.occurred_at_time,
    underlyingSymbol: row.underlying_symbol, contractSymbol: row.contract_symbol, optionKind: row.option_kind,
    optionSide: row.option_side, strikePrice: numericString(row.strike_price), expirationDate: row.expiration_date,
    multiplier: numericString(row.multiplier), transferId: row.transfer_id,
    counterpartyPortfolioId: row.counterparty_portfolio_id,
    note: row.note, idempotencyKey: row.idempotency_key, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function rpcInput(input: TransactionInput) {
  const asset = input.type === 'acquisition' || input.type === 'disposal' || input.type === 'initial_position';
  const option = input.type === 'buy_to_open' || input.type === 'sell_to_close'
    || input.type === 'sell_to_open' || input.type === 'buy_to_close'
    || input.type === 'exercise' || input.type === 'assignment' || input.type === 'expired';
  const cash = !asset && !option;
  const occurredAt = transactionDateTimeToUtcIso(input.occurredAt, input.timezone);
  return {
    input_type: input.type,
    input_symbol: asset ? input.symbol!.trim().toUpperCase() : null,
    input_quantity: asset || option ? input.quantity! : null,
    input_price: asset || option ? input.price || '0' : null,
    input_amount: cash || input.type === 'initial_position' ? input.amount || '0' : null,
    input_fee: asset || option ? input.fee || '0' : null,
    input_original_currency: input.originalCurrency,
    input_fx_rate_at_transaction: input.originalCurrency === 'USD' ? null : input.fxRateAtTransaction || null,
    input_occurred_at: occurredAt,
    input_broker: input.broker?.trim() || null,
    input_underlying_symbol: option ? input.underlyingSymbol!.trim().toUpperCase() : null,
    input_contract_symbol: option ? input.contractSymbol!.trim().toUpperCase() : null,
    input_option_kind: option ? input.optionKind! : null,
    input_option_side: option ? (input.optionSide ?? (
      input.type === 'buy_to_open' || input.type === 'sell_to_close' || input.type === 'exercise' ? 'long' : 'short'
    )) : null,
    input_strike_price: option ? input.strikePrice! : null,
    input_expiration_date: option ? input.expirationDate! : null,
    input_multiplier: option ? input.multiplier || '100' : null,
    input_note: input.note?.trim() || null,
  };
}

export class PortfolioRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async ensureDefault(): Promise<string> {
    const { data, error } = await this.client.rpc('get_or_create_default_portfolio');
    if (error || !data) throw error ?? new Error('Default portfolio was not created');
    return data;
  }

  async getAll(): Promise<PortfolioRecord[]> {
    await this.ensureDefault();
    const [{ data: portfolios, error: portfolioError }, { data: rows, error: rowsError }] = await Promise.all([
      this.client.from('portfolios')
        .select('id, name, base_currency, portfolio_type, is_legacy, archived_at, target_value_usd, target_date, created_at')
        .order('created_at', { ascending: true }).order('id', { ascending: true }),
      this.client.from('portfolio_transactions').select('*')
        .order('occurred_at_time', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true }),
    ]);
    if (portfolioError) throw portfolioError;
    if (rowsError) throw rowsError;
    const transactions = new Map<string, PortfolioTransaction[]>();
    for (const row of rows ?? []) {
      const mapped = mapTransaction(row);
      transactions.set(mapped.portfolioId, [...(transactions.get(mapped.portfolioId) ?? []), mapped]);
    }
    return (portfolios ?? []).map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      type: portfolio.portfolio_type,
      isLegacy: portfolio.is_legacy,
      archivedAt: portfolio.archived_at,
      targetValueUsd: portfolio.target_value_usd === null ? null : Number(portfolio.target_value_usd),
      targetDate: portfolio.target_date,
      baseCurrency: portfolio.base_currency,
      transactions: transactions.get(portfolio.id) ?? [],
    }));
  }

  async getDefault(): Promise<PortfolioRecord> {
    const id = await this.ensureDefault();
    const portfolio = (await this.getAll()).find((item) => item.id === id);
    if (!portfolio) throw new Error('Portfolio not found');
    return portfolio;
  }

  async getById(id: string): Promise<PortfolioRecord | null> {
    return (await this.getAll()).find((portfolio) => portfolio.id === id) ?? null;
  }

  async getAggregateGoal(): Promise<PortfolioGoal> {
    const { data, error } = await this.client.from('user_settings')
      .select('aggregate_target_value_usd, aggregate_target_date').single();
    if (error) throw error;
    return {
      targetValueUsd: data.aggregate_target_value_usd === null ? null : Number(data.aggregate_target_value_usd),
      targetDate: data.aggregate_target_date,
    };
  }

  async getTimeZone(): Promise<string> {
    const { data, error } = await this.client.from('user_settings')
      .select('timezone').single();
    if (error) return resolveTransactionTimeZone(null);
    return resolveTransactionTimeZone(data.timezone);
  }

  async getTransaction(id: string): Promise<PortfolioTransaction | null> {
    const { data, error } = await this.client.from('portfolio_transactions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? mapTransaction(data) : null;
  }

  async create(input: TransactionInput): Promise<string> {
    const { data, error } = await this.client.rpc('create_portfolio_ledger_transaction', {
      input_portfolio_id: input.portfolioId,
      ...rpcInput(input),
      input_idempotency_key: input.idempotencyKey,
    });
    if (error || !data) throw error ?? new Error('Transaction was not created');
    return data;
  }

  async update(id: string, input: TransactionInput): Promise<void> {
    const { error } = await this.client.rpc('update_portfolio_ledger_transaction', { transaction_id: id, ...rpcInput(input) });
    if (error) throw error;
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.rpc('delete_portfolio_ledger_transaction', { transaction_id: id });
    if (error) throw error;
  }

  async setBaseCurrency(currency: 'USD' | 'THB'): Promise<void> {
    const { error } = await this.client.rpc('set_portfolio_base_currency', { input_currency: currency });
    if (error) throw error;
  }

  async createPortfolio(name: string, type: Exclude<PortfolioType, 'LEGACY'>): Promise<string> {
    const { data, error } = await this.client.rpc('create_portfolio', { input_name: name, input_type: type });
    if (error || !data) throw error ?? new Error('Portfolio was not created');
    return data;
  }

  async updatePortfolio(id: string, name: string, type: PortfolioType): Promise<void> {
    const { error } = await this.client.rpc('update_portfolio_details', {
      target_portfolio_id: id,
      input_name: name,
      input_type: type,
    });
    if (error) throw error;
  }

  async setPortfolioGoal(id: string, goal: PortfolioGoal): Promise<void> {
    const { error } = await this.client.rpc('set_portfolio_goal', {
      target_portfolio_id: id,
      input_target_value_usd: goal.targetValueUsd === null ? null : String(goal.targetValueUsd),
      input_target_date: goal.targetDate,
    });
    if (error) throw error;
  }

  async setAggregateGoal(goal: PortfolioGoal): Promise<void> {
    const { error } = await this.client.rpc('set_aggregate_portfolio_goal', {
      input_target_value_usd: goal.targetValueUsd === null ? null : String(goal.targetValueUsd),
      input_target_date: goal.targetDate,
    });
    if (error) throw error;
  }

  async archivePortfolio(id: string): Promise<void> {
    const { error } = await this.client.rpc('archive_portfolio', { target_portfolio_id: id });
    if (error) throw error;
  }

  async restorePortfolio(id: string): Promise<void> {
    const { error } = await this.client.rpc('restore_portfolio', { target_portfolio_id: id });
    if (error) throw error;
  }

  async deleteEmptyPortfolio(id: string): Promise<void> {
    const { error } = await this.client.rpc('delete_empty_portfolio', { target_portfolio_id: id });
    if (error) throw error;
  }

  async transferCash(input: {
    sourcePortfolioId: string;
    destinationPortfolioId: string;
    amountUsd: number;
    occurredAt: string;
    timezone: string;
    note?: string;
    idempotencyKey: string;
  }): Promise<string> {
    const { data, error } = await this.client.rpc('transfer_portfolio_cash', {
      source_portfolio_id: input.sourcePortfolioId,
      destination_portfolio_id: input.destinationPortfolioId,
      input_amount_usd: String(input.amountUsd),
      input_occurred_at: transactionDateTimeToUtcIso(input.occurredAt, input.timezone),
      input_note: input.note?.trim() || null,
      input_idempotency_key: input.idempotencyKey,
    });
    if (error || !data) throw error ?? new Error('Transfer was not created');
    return data;
  }
}

/**
 * Service-role read for scheduled summaries. The user id comes from the
 * server-owned user_settings row selected by the cron worker, never from a
 * browser request.
 */
export async function loadPortfoliosForUser(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<PortfolioRecord[]> {
  const { data: portfolios, error: portfolioError } = await client.from('portfolios')
    .select('id, name, base_currency, portfolio_type, is_legacy, archived_at, target_value_usd, target_date, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (portfolioError) throw portfolioError;
  const ids = (portfolios ?? []).map((portfolio) => portfolio.id);
  if (!ids.length) return [];

  const { data: rows, error: rowsError } = await client.from('portfolio_transactions')
    .select('*')
    .in('portfolio_id', ids)
    .order('occurred_at_time', { ascending: true })
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (rowsError) throw rowsError;

  const transactions = new Map<string, PortfolioTransaction[]>();
  for (const row of rows ?? []) {
    const mapped = mapTransaction(row);
    transactions.set(mapped.portfolioId, [...(transactions.get(mapped.portfolioId) ?? []), mapped]);
  }
  return (portfolios ?? []).map((portfolio) => ({
    id: portfolio.id,
    name: portfolio.name,
    type: portfolio.portfolio_type,
    isLegacy: portfolio.is_legacy,
    archivedAt: portfolio.archived_at,
    targetValueUsd: portfolio.target_value_usd === null ? null : Number(portfolio.target_value_usd),
    targetDate: portfolio.target_date,
    baseCurrency: portfolio.base_currency,
    transactions: transactions.get(portfolio.id) ?? [],
  }));
}
