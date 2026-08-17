import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type {
  DeletedPortfolioSummary,
  PortfolioGoal,
  PortfolioRecord,
  PortfolioResetOutcome,
  PortfolioTransaction,
  PortfolioType,
} from './types';
import type { TransferExpectation, TransferLeg } from './transfer/plan';
import type { TransactionInput } from './validation';
import type { OptionPurchaseQuoteSnapshot, OptionPurchaseRequest } from './options/purchase';
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
    normalizedFeeUsd: numericString(row.normalized_fee_usd),
    /*
     * A row written before the fee box existed states no mode, and 'total' is
     * what it means: whatever fee it carries (usually none at all) was the whole
     * order's. Nothing computes from this — the money is `fee` — so the default
     * cannot move a number.
     */
    feeMode: row.fee_mode ?? 'total',
    broker: row.broker, occurredAtTime: row.occurred_at_time,
    underlyingSymbol: row.underlying_symbol, contractSymbol: row.contract_symbol, optionKind: row.option_kind,
    optionSide: row.option_side, strikePrice: numericString(row.strike_price), expirationDate: row.expiration_date,
    multiplier: numericString(row.multiplier), transferId: row.transfer_id,
    counterpartyPortfolioId: row.counterparty_portfolio_id,
    transferGroupId: row.transfer_group_id,
    transferCostBasisUsd: numericString(row.transfer_cost_basis_usd),
    transferAcquiredAt: row.transfer_acquired_at,
    transferSourceName: row.transfer_source_name,
    transferDestinationName: row.transfer_destination_name,
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

  /**
   * Every portfolio the reader still has, which never includes a soft-deleted
   * one. The filter is here, in the one method the whole application reads
   * portfolios through, rather than at each of its callers: a page that forgot
   * it would show a portfolio the reader has already deleted, and one that
   * linked to it would hand out a `portfolio_id` every write path refuses.
   */
  async getAll(): Promise<PortfolioRecord[]> {
    await this.ensureDefault();
    const [{ data: portfolios, error: portfolioError }, { data: rows, error: rowsError }] = await Promise.all([
      this.client.from('portfolios')
        .select('id, name, base_currency, portfolio_type, is_legacy, archived_at, deleted_at, purge_after, target_value_usd, target_date, created_at')
        .is('deleted_at', null)
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
      deletedAt: portfolio.deleted_at,
      purgeAfter: portfolio.purge_after,
      targetValueUsd: portfolio.target_value_usd === null ? null : Number(portfolio.target_value_usd),
      targetDate: portfolio.target_date,
      baseCurrency: portfolio.base_currency,
      transactions: transactions.get(portfolio.id) ?? [],
    }));
  }

  /**
   * The recovery window, and the only read that returns deleted portfolios.
   * Names and dates only — a list meant for choosing what to bring back does not
   * need the ledger, and loading one would put a deleted portfolio's holdings
   * back into the page it was deleted from.
   */
  async getRecentlyDeleted(): Promise<DeletedPortfolioSummary[]> {
    const { data, error } = await this.client.from('portfolios')
      .select('id, name, portfolio_type, deleted_at, purge_after')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false });
    if (error) throw error;
    return (data ?? [])
      .filter((portfolio): portfolio is typeof portfolio & { deleted_at: string; purge_after: string } =>
        Boolean(portfolio.deleted_at) && Boolean(portfolio.purge_after))
      .map((portfolio) => ({
        id: portfolio.id,
        name: portfolio.name,
        type: portfolio.portfolio_type,
        deletedAt: portfolio.deleted_at,
        purgeAfter: portfolio.purge_after,
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

  async createOptionPurchase(
    input: OptionPurchaseRequest,
    quote: OptionPurchaseQuoteSnapshot,
    feeTotal: number,
  ): Promise<string> {
    const { data, error } = await this.client.rpc('create_portfolio_option_purchase', {
      input_portfolio_id: input.portfolioId,
      input_underlying_symbol: quote.underlyingSymbol,
      input_contract_symbol: quote.contractSymbol,
      input_option_kind: quote.optionKind,
      input_strike_price: String(quote.strike),
      input_expiration_date: quote.expiration,
      input_contracts: input.contracts,
      input_purchase_price: input.purchasePrice,
      input_occurred_at: transactionDateTimeToUtcIso(input.occurredAt, input.timezone),
      input_quote_timestamp: quote.quoteTimestamp,
      input_idempotency_key: input.idempotencyKey,
      // The whole-order fee, and a note of how it was typed. Only the first is
      // money; the mode is kept so the row can say where the number came from.
      input_fee: feeTotal.toFixed(8),
      input_fee_mode: input.feeMode,
    });
    if (error || !data) throw error ?? new Error('Option purchase was not created');
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

  /**
   * The name is sent so the database can refuse a deletion aimed at the wrong
   * portfolio. The interface checks it too, to keep the button disabled, but the
   * check that counts is the one made against the row being deleted.
   */
  async softDeletePortfolio(id: string, expectedName: string): Promise<string> {
    const { data, error } = await this.client.rpc('soft_delete_portfolio', {
      target_portfolio_id: id,
      input_expected_name: expectedName,
    });
    if (error || !data) throw error ?? new Error('Portfolio was not deleted');
    return data;
  }

  /**
   * Empties one portfolio and keeps it. The database decides ownership from the
   * session, so the id sent here is a filter and never a permission; what comes
   * back is what was actually cleared, which is what the interface reports.
   */
  async resetPortfolio(id: string): Promise<PortfolioResetOutcome> {
    const { data, error } = await this.client.rpc('reset_portfolio', { target_portfolio_id: id });
    if (error) throw error;
    const row = data?.[0];
    if (!row) throw new Error('Portfolio was not reset');
    return {
      transactionsRemoved: Number(row.transactions_removed),
      optionPositionsRemoved: Number(row.option_positions_removed),
      optionTargetsRemoved: Number(row.option_targets_removed),
      goalCleared: row.goal_cleared,
    };
  }

  /** Returns the name it came back under, which is not always the one it left. */
  async restoreDeletedPortfolio(id: string): Promise<string> {
    const { data, error } = await this.client.rpc('restore_deleted_portfolio', {
      target_portfolio_id: id,
    });
    if (error || !data) throw error ?? new Error('Portfolio was not restored');
    return data;
  }

  /**
   * One atomic move. The legs carry amounts this process derived from the
   * ledger; the expectations let the database refuse them if the ledger has
   * moved on since. Nothing here originates in a browser except which positions
   * and how many of each.
   */
  async transferAssets(input: {
    sourcePortfolioId: string;
    destinationPortfolioId: string;
    groupId: string;
    legs: TransferLeg[];
    expectations: TransferExpectation[];
    occurredAt: string;
    note?: string;
  }): Promise<{ groupId: string; legsWritten: number; alreadyApplied: boolean }> {
    const { data, error } = await this.client.rpc('transfer_portfolio_assets', {
      input_source_portfolio_id: input.sourcePortfolioId,
      input_destination_portfolio_id: input.destinationPortfolioId,
      input_group_id: input.groupId,
      input_legs: input.legs,
      input_expected: input.expectations,
      input_occurred_at: input.occurredAt,
      input_note: input.note?.trim() || null,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Transfer did not report a result');
    return {
      groupId: row.transfer_group_id,
      legsWritten: row.legs_written,
      alreadyApplied: row.already_applied,
    };
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
    .select('id, name, base_currency, portfolio_type, is_legacy, archived_at, deleted_at, purge_after, target_value_usd, target_date, created_at')
    .eq('user_id', userId)
    // A scheduled summary must not report a portfolio its owner has deleted.
    .is('deleted_at', null)
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
    deletedAt: portfolio.deleted_at,
    purgeAfter: portfolio.purge_after,
    targetValueUsd: portfolio.target_value_usd === null ? null : Number(portfolio.target_value_usd),
    targetDate: portfolio.target_date,
    baseCurrency: portfolio.base_currency,
    transactions: transactions.get(portfolio.id) ?? [],
  }));
}
