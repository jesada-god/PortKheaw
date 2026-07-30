import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { PortfolioRecord, PortfolioTransaction } from './types';
import type { TransactionInput } from './validation';
import { optionContractSymbolStatus } from './options/contract-symbol-status';

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
    multiplier: numericString(row.multiplier),
    note: row.note, idempotencyKey: row.idempotency_key, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function rpcInput(input: TransactionInput) {
  const asset = input.type === 'acquisition' || input.type === 'disposal' || input.type === 'initial_position';
  const option = input.type === 'buy_to_open' || input.type === 'sell_to_close'
    || input.type === 'sell_to_open' || input.type === 'buy_to_close'
    || input.type === 'exercise' || input.type === 'assignment' || input.type === 'expired';
  const cash = !asset && !option;
  const occurredAt = /^\d{4}-\d{2}-\d{2}$/.test(input.occurredAt)
    ? `${input.occurredAt}T12:00:00+07:00`
    : /(?:Z|[+-]\d{2}:\d{2})$/.test(input.occurredAt)
      ? input.occurredAt
      : `${input.occurredAt}${input.occurredAt.length === 16 ? ':00' : ''}+07:00`;
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

  private async canonicalizeResolvedOption(input: TransactionInput): Promise<void> {
    const contractSymbol = input.contractSymbol?.trim().toUpperCase() ?? '';
    if (!contractSymbol || optionContractSymbolStatus(contractSymbol) !== 'official') return;
    const { error } = await this.client.from('portfolio_transactions')
      .update({ contract_symbol: contractSymbol, updated_at: new Date().toISOString() })
      .eq('underlying_symbol', input.underlyingSymbol!.trim().toUpperCase())
      .eq('option_kind', input.optionKind!)
      .eq('strike_price', input.strikePrice!)
      .eq('expiration_date', input.expirationDate!)
      .like('contract_symbol', 'UNRESOLVED-%');
    if (error) throw error;
  }

  async ensureDefault(): Promise<string> {
    const { data, error } = await this.client.rpc('get_or_create_default_portfolio');
    if (error || !data) throw error ?? new Error('Default portfolio was not created');
    return data;
  }

  async getDefault(): Promise<PortfolioRecord> {
    const id = await this.ensureDefault();
    const [{ data: portfolio, error: portfolioError }, { data: rows, error: rowsError }] = await Promise.all([
      this.client.from('portfolios').select('id, name, base_currency').eq('id', id).single(),
      this.client.from('portfolio_transactions').select('*').eq('portfolio_id', id)
        .order('occurred_at', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true }),
    ]);
    if (portfolioError || !portfolio) throw portfolioError ?? new Error('Portfolio not found');
    if (rowsError) throw rowsError;
    return { id: portfolio.id, name: portfolio.name, baseCurrency: portfolio.base_currency, transactions: (rows ?? []).map(mapTransaction) };
  }

  async getTransaction(id: string): Promise<PortfolioTransaction | null> {
    const { data, error } = await this.client.from('portfolio_transactions').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? mapTransaction(data) : null;
  }

  async create(input: TransactionInput): Promise<string> {
    await this.canonicalizeResolvedOption(input);
    const { data, error } = await this.client.rpc('create_portfolio_ledger_transaction', { ...rpcInput(input), input_idempotency_key: input.idempotencyKey });
    if (error || !data) throw error ?? new Error('Transaction was not created');
    return data;
  }

  async update(id: string, input: TransactionInput): Promise<void> {
    await this.canonicalizeResolvedOption(input);
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
}
