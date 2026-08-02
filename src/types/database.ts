export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Currency = 'THB' | 'USD';
export type AppLanguage = 'th' | 'en';
export type PortfolioType = 'STOCK' | 'OPTION' | 'LEGACY';

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          full_name?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_settings: {
        Row: {
          user_id: string;
          base_currency: Currency;
          language: AppLanguage;
          price_alerts_enabled: boolean;
          daily_summary_enabled: boolean;
          daily_summary_time: string;
          daily_summary_last_local_date: string | null;
          push_enabled: boolean;
          price_alert_extended_hours: boolean;
          quiet_hours_enabled: boolean;
          quiet_hours_start: string;
          quiet_hours_end: string;
          timezone: string;
          aggregate_target_value_usd: string | null;
          aggregate_target_date: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          base_currency?: Currency;
          language?: AppLanguage;
          price_alerts_enabled?: boolean;
          daily_summary_enabled?: boolean;
          daily_summary_time?: string;
          daily_summary_last_local_date?: string | null;
          push_enabled?: boolean;
          price_alert_extended_hours?: boolean;
          quiet_hours_enabled?: boolean;
          quiet_hours_start?: string;
          quiet_hours_end?: string;
          timezone?: string;
          aggregate_target_value_usd?: string | null;
          aggregate_target_date?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          base_currency?: Currency;
          language?: AppLanguage;
          price_alerts_enabled?: boolean;
          daily_summary_enabled?: boolean;
          daily_summary_time?: string;
          daily_summary_last_local_date?: string | null;
          push_enabled?: boolean;
          price_alert_extended_hours?: boolean;
          quiet_hours_enabled?: boolean;
          quiet_hours_start?: string;
          quiet_hours_end?: string;
          timezone?: string;
          aggregate_target_value_usd?: string | null;
          aggregate_target_date?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      watchlists: {
        Row: { id: string; user_id: string; name: string; created_at: string; updated_at: string };
        Insert: { id?: string; user_id: string; name?: string; created_at?: string; updated_at?: string };
        Update: { name?: string; updated_at?: string };
        Relationships: [];
      };
      watchlist_items: {
        Row: { id: string; watchlist_id: string; symbol: string; created_at: string };
        Insert: { id?: string; watchlist_id: string; symbol: string; created_at?: string };
        Update: { symbol?: string };
        Relationships: [];
      };
      portfolios: {
        Row: {
          id: string; user_id: string; name: string; base_currency: Currency; portfolio_type: PortfolioType;
          is_legacy: boolean; archived_at: string | null; target_value_usd: string | null; target_date: string | null;
          created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; user_id: string; name?: string; base_currency?: Currency; portfolio_type?: PortfolioType;
          is_legacy?: boolean; archived_at?: string | null; target_value_usd?: string | null; target_date?: string | null;
          created_at?: string; updated_at?: string;
        };
        Update: {
          name?: string; base_currency?: Currency; portfolio_type?: PortfolioType; is_legacy?: boolean;
          archived_at?: string | null; target_value_usd?: string | null; target_date?: string | null; updated_at?: string;
        };
        Relationships: [];
      };
      portfolio_transactions: {
        Row: {
          id: string; portfolio_id: string; transaction_type: 'acquisition' | 'disposal' | 'initial_position' | 'dividend' | 'deposit' | 'withdrawal' | 'fee' | 'adjustment' | 'transfer_out' | 'transfer_in' | 'buy_to_open' | 'sell_to_close' | 'sell_to_open' | 'buy_to_close' | 'exercise' | 'assignment' | 'expired';
          symbol: string | null; quantity: string | null; price: string | null; amount: string | null; occurred_at: string;
          original_amount: string | null; original_currency: Currency; fx_rate_at_transaction: string | null; normalized_amount_usd: string | null;
          normalized_price_usd: string | null; fee: string | null; normalized_fee_usd: string | null; broker: string | null;
          occurred_at_time: string; underlying_symbol: string | null; contract_symbol: string | null;
          option_kind: 'call' | 'put' | null; option_side: 'long' | 'short' | null; strike_price: string | null;
          expiration_date: string | null; multiplier: string | null;
          transfer_id: string | null; counterparty_portfolio_id: string | null;
          note: string | null; idempotency_key: string; created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; portfolio_id: string; transaction_type: 'acquisition' | 'disposal' | 'initial_position' | 'dividend' | 'deposit' | 'withdrawal' | 'fee' | 'adjustment' | 'transfer_out' | 'transfer_in' | 'buy_to_open' | 'sell_to_close' | 'sell_to_open' | 'buy_to_close' | 'exercise' | 'assignment' | 'expired';
          symbol?: string | null; quantity?: string | null; price?: string | null; amount?: string | null; occurred_at: string;
          original_amount?: string | null; original_currency?: Currency; fx_rate_at_transaction?: string | null; normalized_amount_usd?: string | null;
          normalized_price_usd?: string | null; fee?: string | null; normalized_fee_usd?: string | null; broker?: string | null;
          occurred_at_time: string; underlying_symbol?: string | null; contract_symbol?: string | null;
          option_kind?: 'call' | 'put' | null; option_side?: 'long' | 'short' | null; strike_price?: string | null;
          expiration_date?: string | null; multiplier?: string | null;
          transfer_id?: string | null; counterparty_portfolio_id?: string | null;
          note?: string | null; idempotency_key: string; created_at?: string; updated_at?: string;
        };
        Update: {
          transaction_type?: 'acquisition' | 'disposal' | 'initial_position' | 'dividend' | 'deposit' | 'withdrawal' | 'fee' | 'adjustment' | 'transfer_out' | 'transfer_in' | 'buy_to_open' | 'sell_to_close' | 'sell_to_open' | 'buy_to_close' | 'exercise' | 'assignment' | 'expired';
          symbol?: string | null; quantity?: string | null; price?: string | null; amount?: string | null; occurred_at?: string;
          original_amount?: string | null; original_currency?: Currency; fx_rate_at_transaction?: string | null; normalized_amount_usd?: string | null;
          normalized_price_usd?: string | null; fee?: string | null; normalized_fee_usd?: string | null; broker?: string | null;
          occurred_at_time?: string; underlying_symbol?: string | null; contract_symbol?: string | null;
          option_kind?: 'call' | 'put' | null; option_side?: 'long' | 'short' | null; strike_price?: string | null;
          expiration_date?: string | null; multiplier?: string | null;
          transfer_id?: string | null; counterparty_portfolio_id?: string | null;
          note?: string | null; updated_at?: string;
        };
        Relationships: [];
      };
      portfolio_option_targets: {
        Row: {
          id: string; portfolio_id: string; contract_symbol: string; side: 'long' | 'short'; mode: 'premium' | 'profit_percent';
          target_value: string; target_premium: string; estimated_fee: string; enabled: boolean; triggered_at: string | null;
          created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; portfolio_id: string; contract_symbol: string; side: 'long' | 'short'; mode: 'premium' | 'profit_percent';
          target_value: string; target_premium: string; estimated_fee?: string; enabled?: boolean; triggered_at?: string | null;
          created_at?: string; updated_at?: string;
        };
        Update: {
          side?: 'long' | 'short'; mode?: 'premium' | 'profit_percent'; target_value?: string; target_premium?: string; estimated_fee?: string;
          enabled?: boolean; triggered_at?: string | null; updated_at?: string;
        };
        Relationships: [];
      };
      portfolio_option_positions: {
        Row: {
          id: string; portfolio_id: string; underlying_symbol: string; option_kind: 'call' | 'put'; contracts: number;
          premium_per_share: string; strike_price: string; opened_at: string; expiration_date: string;
          implied_volatility: string | null; delta: string | null; theta: string | null; note: string | null;
          status: 'open' | 'closed' | 'cancelled'; closed_at: string | null; idempotency_key: string; created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; portfolio_id: string; underlying_symbol: string; option_kind: 'call' | 'put'; contracts: number;
          premium_per_share: string; strike_price: string; opened_at: string; expiration_date: string;
          implied_volatility?: string | null; delta?: string | null; theta?: string | null; note?: string | null;
          status?: 'open' | 'closed' | 'cancelled'; closed_at?: string | null; idempotency_key: string; created_at?: string; updated_at?: string;
        };
        Update: {
          underlying_symbol?: string; option_kind?: 'call' | 'put'; contracts?: number; premium_per_share?: string; strike_price?: string;
          opened_at?: string; expiration_date?: string; implied_volatility?: string | null; delta?: string | null; theta?: string | null;
          note?: string | null; status?: 'open' | 'closed' | 'cancelled'; closed_at?: string | null; updated_at?: string;
        };
        Relationships: [];
      };
      market_instruments: {
        Row: {
          id: string; symbol: string; name: string; exchange: string | null; asset_type: 'Stock' | 'ETF';
          currency: string; country: string; status: 'active' | 'delisted'; ipo_date: string | null;
          delisting_date: string | null; provider: string; provider_symbol: string; searchable_text: string;
          sector: string | null; industry: string | null; website_domain: string | null; logo_url: string | null;
          metadata_source: string | null; metadata_updated_at: string | null;
          last_synced_at: string; created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; symbol: string; name: string; exchange?: string | null; asset_type: 'Stock' | 'ETF';
          currency?: string; country?: string; status: 'active' | 'delisted'; ipo_date?: string | null;
          delisting_date?: string | null; provider: string; provider_symbol: string;
          sector?: string | null; industry?: string | null; website_domain?: string | null; logo_url?: string | null;
          metadata_source?: string | null; metadata_updated_at?: string | null; last_synced_at?: string;
          created_at?: string; updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['market_instruments']['Insert']>;
        Relationships: [];
      };
      market_instrument_sync_runs: {
        Row: { id: string; provider: string; idempotency_key: string; status: 'staging' | 'completed' | 'failed'; inserted_count: number; updated_count: number; skipped_count: number; failed_count: number; error: Json | null; started_at: string; completed_at: string | null };
        Insert: { id?: string; provider: string; idempotency_key: string; status?: 'staging' | 'completed' | 'failed'; inserted_count?: number; updated_count?: number; skipped_count?: number; failed_count?: number; error?: Json | null; started_at?: string; completed_at?: string | null };
        Update: Partial<Database['public']['Tables']['market_instrument_sync_runs']['Insert']>;
        Relationships: [];
      };
      market_instrument_sync_stage: {
        Row: { run_id: string; provider_symbol: string; symbol: string; name: string; exchange: string | null; asset_type: 'Stock' | 'ETF'; currency: string; country: string; status: 'active' | 'delisted'; ipo_date: string | null; delisting_date: string | null };
        Insert: Database['public']['Tables']['market_instrument_sync_stage']['Row'];
        Update: Partial<Database['public']['Tables']['market_instrument_sync_stage']['Row']>;
        Relationships: [];
      };
      market_fx_rates: {
        Row: { base_currency: Currency; quote_currency: Currency; rate: string; source: string; provider_updated_at: string; fetched_at: string; created_at: string; updated_at: string };
        Insert: { base_currency: Currency; quote_currency: Currency; rate: string; source: string; provider_updated_at: string; fetched_at: string; created_at?: string; updated_at?: string };
        Update: Partial<Database['public']['Tables']['market_fx_rates']['Insert']>;
        Relationships: [];
      };
      analytics_fundamentals_lkg: {
        Row: {
          symbol: string; dataset: string; financial_periods: Json; snapshot: Json;
          provider: string; source_as_of: string; fetched_at: string; validated_at: string;
          schema_version: number; created_at: string; updated_at: string;
        };
        Insert: {
          symbol: string; dataset: string; financial_periods: Json; snapshot: Json;
          provider: string; source_as_of: string; fetched_at: string; validated_at: string;
          schema_version: number; created_at?: string; updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['analytics_fundamentals_lkg']['Insert']>;
        Relationships: [];
      };
      analytics_valuation_inputs_lkg: {
        Row: {
          scope: 'company' | 'market' | 'peers';
          owner_key: string;
          metric: 'beta' | 'risk-free-rate' | 'equity-risk-premium' | 'forward-eps' | 'forward-revenue' | 'peer-forward-pe' | 'peer-forward-ev-sales';
          period: string;
          data: Json;
          source: string;
          origin: 'provider' | 'derived' | 'gemini-grounded';
          source_as_of: string;
          fetched_at: string;
          validated_at: string;
          freshness: 'fresh' | 'stale';
          schema_version: number;
          provenance: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          scope: 'company' | 'market' | 'peers';
          owner_key: string;
          metric: 'beta' | 'risk-free-rate' | 'equity-risk-premium' | 'forward-eps' | 'forward-revenue' | 'peer-forward-pe' | 'peer-forward-ev-sales';
          period: string;
          data: Json;
          source: string;
          origin: 'provider' | 'derived' | 'gemini-grounded';
          source_as_of: string;
          fetched_at: string;
          validated_at: string;
          freshness: 'fresh' | 'stale';
          schema_version: number;
          provenance?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['analytics_valuation_inputs_lkg']['Insert']>;
        Relationships: [];
      };
      price_alerts: {
        Row: { id: string; user_id: string; symbol: string; condition: 'above' | 'below' | 'percent_change_up' | 'percent_change_down'; target_value: string; enabled: boolean; cooldown_minutes: number; last_evaluated_at: string | null; last_triggered_at: string | null; was_matching: boolean; last_observed_price: string | null; last_observed_session: 'regular' | 'pre-market' | 'after-hours' | null; last_observed_source: string | null; last_observed_at: string | null; created_at: string; updated_at: string };
        Insert: { id?: string; user_id: string; symbol: string; condition: 'above' | 'below' | 'percent_change_up' | 'percent_change_down'; target_value: string; enabled?: boolean; cooldown_minutes?: number; last_evaluated_at?: string | null; last_triggered_at?: string | null; was_matching?: boolean; last_observed_price?: string | null; last_observed_session?: 'regular' | 'pre-market' | 'after-hours' | null; last_observed_source?: string | null; last_observed_at?: string | null; created_at?: string; updated_at?: string };
        Update: { symbol?: string; condition?: 'above' | 'below' | 'percent_change_up' | 'percent_change_down'; target_value?: string; enabled?: boolean; cooldown_minutes?: number; last_evaluated_at?: string | null; last_triggered_at?: string | null; was_matching?: boolean; last_observed_price?: string | null; last_observed_session?: 'regular' | 'pre-market' | 'after-hours' | null; last_observed_source?: string | null; last_observed_at?: string | null; updated_at?: string };
        Relationships: [];
      };
      notifications: {
        Row: { id: string; user_id: string; price_alert_id: string | null; type: 'price_alert' | 'daily_summary' | 'quiet_hours_digest' | 'system'; title: string; message: string; metadata: Json; idempotency_key: string | null; read_at: string | null; created_at: string };
        Insert: { id?: string; user_id: string; price_alert_id?: string | null; type?: 'price_alert' | 'daily_summary' | 'quiet_hours_digest' | 'system'; title: string; message: string; metadata?: Json; idempotency_key?: string | null; read_at?: string | null; created_at?: string };
        Update: { read_at?: string | null };
        Relationships: [];
      };
      queued_notifications: {
        Row: { id: string; user_id: string; type: 'price_alert' | 'daily_summary' | 'system'; title: string; message: string; metadata: Json; idempotency_key: string; release_after: string; delivered_at: string | null; created_at: string };
        Insert: { id?: string; user_id: string; type: 'price_alert' | 'daily_summary' | 'system'; title: string; message: string; metadata?: Json; idempotency_key: string; release_after: string; delivered_at?: string | null; created_at?: string };
        Update: { delivered_at?: string | null };
        Relationships: [];
      };
      push_subscriptions: {
        Row: { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; expiration_time: number | null; user_agent: string | null; device_label: string | null; enabled: boolean; last_seen_at: string; last_success_at: string | null; last_test_at: string | null; failure_count: number; disabled_at: string | null; created_at: string; updated_at: string };
        Insert: { id?: string; user_id: string; endpoint: string; p256dh: string; auth: string; expiration_time?: number | null; user_agent?: string | null; device_label?: string | null; enabled?: boolean; last_seen_at?: string; last_success_at?: string | null; last_test_at?: string | null; failure_count?: number; disabled_at?: string | null; created_at?: string; updated_at?: string };
        Update: Partial<Database['public']['Tables']['push_subscriptions']['Insert']>;
        Relationships: [];
      };
      push_deliveries: {
        Row: { id: string; notification_id: string; subscription_id: string | null; channel: 'web_push'; status: 'pending' | 'processing' | 'retrying' | 'sent' | 'failed' | 'skipped'; attempt_count: number; next_attempt_at: string; provider_status: string | null; last_error_code: string | null; claim_token: string | null; claimed_at: string | null; sent_at: string | null; created_at: string; updated_at: string };
        Insert: { id?: string; notification_id: string; subscription_id?: string | null; channel?: 'web_push'; status?: 'pending' | 'processing' | 'retrying' | 'sent' | 'failed' | 'skipped'; attempt_count?: number; next_attempt_at?: string; provider_status?: string | null; last_error_code?: string | null; claim_token?: string | null; claimed_at?: string | null; sent_at?: string | null; created_at?: string; updated_at?: string };
        Update: Partial<Database['public']['Tables']['push_deliveries']['Insert']>;
        Relationships: [];
      };
      alert_evaluation_runs: {
        Row: { id: string; schedule_window: string; status: 'running' | 'completed' | 'partial' | 'failed'; evaluated_count: number; triggered_count: number; unavailable_count: number; push_sent_count: number; push_failed_count: number; error_code: string | null; started_at: string; completed_at: string | null };
        Insert: { id?: string; schedule_window: string; status?: 'running' | 'completed' | 'partial' | 'failed'; evaluated_count?: number; triggered_count?: number; unavailable_count?: number; push_sent_count?: number; push_failed_count?: number; error_code?: string | null; started_at?: string; completed_at?: string | null };
        Update: Partial<Database['public']['Tables']['alert_evaluation_runs']['Insert']>;
        Relationships: [];
      };
      option_simulations: {
        Row: {
          id: string; user_id: string; name: string; description: string; symbol: string; company_name: string; currency: string;
          simulation_type: 'what-if' | 'monte-carlo'; strategy_type: string; inputs_json: Json; assumptions_json: Json;
          settings_json: Json; results_summary_json: Json | null; methodology_version: string; data_source: string | null;
          data_status: 'live' | 'delayed' | 'stale' | 'manual' | 'unavailable'; source_timestamp: string | null;
          version: number; created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; user_id: string; name: string; description?: string; symbol: string; company_name: string; currency: string;
          simulation_type: 'what-if' | 'monte-carlo'; strategy_type: string; inputs_json: Json; assumptions_json?: Json;
          settings_json: Json; results_summary_json?: Json | null; methodology_version?: string; data_source?: string | null;
          data_status: 'live' | 'delayed' | 'stale' | 'manual' | 'unavailable'; source_timestamp?: string | null;
          version?: number; created_at?: string; updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['option_simulations']['Insert']>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      delete_own_account: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      get_or_create_default_watchlist: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      get_or_create_default_portfolio: { Args: Record<PropertyKey, never>; Returns: string };
      create_portfolio: { Args: { input_name: string; input_type: 'STOCK' | 'OPTION' }; Returns: string };
      update_portfolio_details: { Args: { target_portfolio_id: string; input_name: string; input_type: PortfolioType }; Returns: undefined };
      set_portfolio_goal: { Args: { target_portfolio_id: string; input_target_value_usd: string | null; input_target_date: string | null }; Returns: undefined };
      set_aggregate_portfolio_goal: { Args: { input_target_value_usd: string | null; input_target_date: string | null }; Returns: undefined };
      archive_portfolio: { Args: { target_portfolio_id: string }; Returns: undefined };
      restore_portfolio: { Args: { target_portfolio_id: string }; Returns: undefined };
      delete_empty_portfolio: { Args: { target_portfolio_id: string }; Returns: undefined };
      create_portfolio_transaction: {
        Args: { input_type: string; input_symbol: string | null; input_quantity: string | null; input_price: string | null; input_amount: string | null; input_occurred_at: string; input_note: string | null; input_idempotency_key: string; input_original_currency: Currency; input_fx_rate_at_transaction: string | null };
        Returns: string;
      };
      update_portfolio_transaction: {
        Args: { transaction_id: string; input_type: string; input_symbol: string | null; input_quantity: string | null; input_price: string | null; input_amount: string | null; input_occurred_at: string; input_note: string | null; input_original_currency: Currency; input_fx_rate_at_transaction: string | null };
        Returns: undefined;
      };
      delete_portfolio_transaction: { Args: { transaction_id: string }; Returns: undefined };
      create_portfolio_ledger_transaction: {
        Args: {
          input_portfolio_id: string;
          input_type: string; input_symbol: string | null; input_quantity: string | null; input_price: string | null;
          input_amount: string | null; input_fee: string | null; input_original_currency: Currency;
          input_fx_rate_at_transaction: string | null; input_occurred_at: string; input_broker: string | null;
          input_underlying_symbol: string | null; input_contract_symbol: string | null; input_option_kind: string | null;
          input_option_side: string | null; input_strike_price: string | null; input_expiration_date: string | null;
          input_multiplier: string | null; input_note: string | null; input_idempotency_key: string;
        };
        Returns: string;
      };
      update_portfolio_ledger_transaction: {
        Args: {
          transaction_id: string; input_type: string; input_symbol: string | null; input_quantity: string | null;
          input_price: string | null; input_amount: string | null; input_fee: string | null;
          input_original_currency: Currency; input_fx_rate_at_transaction: string | null; input_occurred_at: string;
          input_broker: string | null; input_underlying_symbol: string | null; input_contract_symbol: string | null;
          input_option_kind: string | null; input_option_side: string | null; input_strike_price: string | null;
          input_expiration_date: string | null; input_multiplier: string | null; input_note: string | null;
        };
        Returns: undefined;
      };
      delete_portfolio_ledger_transaction: { Args: { transaction_id: string }; Returns: undefined };
      transfer_portfolio_cash: {
        Args: {
          source_portfolio_id: string; destination_portfolio_id: string; input_amount_usd: string;
          input_occurred_at: string; input_note: string | null; input_idempotency_key: string;
        };
        Returns: string;
      };
      upsert_portfolio_option_target: {
        Args: { input_portfolio_id: string; input_id: string | null; input_contract_symbol: string; input_side: string; input_mode: string; input_target_value: string; input_target_premium: string; input_estimated_fee: string };
        Returns: string;
      };
      delete_portfolio_option_target: { Args: { target_id: string }; Returns: undefined };
      evaluate_portfolio_option_target: {
        Args: { target_id: string; observed_premium: number; observed_at: string; notification_title: string; notification_message: string };
        Returns: string | null;
      };
      set_portfolio_base_currency: { Args: { input_currency: Currency }; Returns: undefined };
      create_option_position: {
        Args: { input_underlying_symbol: string; input_option_kind: string; input_contracts: number; input_premium_per_share: string; input_strike_price: string; input_opened_at: string; input_expiration_date: string; input_implied_volatility: string | null; input_delta: string | null; input_theta: string | null; input_note: string | null; input_status: string; input_idempotency_key: string };
        Returns: string;
      };
      update_option_position: {
        Args: { position_id: string; input_underlying_symbol: string; input_option_kind: string; input_contracts: number; input_premium_per_share: string; input_strike_price: string; input_opened_at: string; input_expiration_date: string; input_implied_volatility: string | null; input_delta: string | null; input_theta: string | null; input_note: string | null; input_status: string };
        Returns: undefined;
      };
      close_option_position: { Args: { position_id: string; input_closed_at: string }; Returns: undefined };
      delete_option_position: { Args: { position_id: string }; Returns: undefined };
      search_market_instruments: {
        Args: { input_query: string; input_asset_type?: string | null; input_include_delisted?: boolean; input_limit?: number };
        Returns: Array<{ symbol: string; name: string; exchange: string | null; asset_type: string; currency: string; status: string; match_score: number }>;
      };
      begin_market_instrument_sync: { Args: { input_provider: string; input_idempotency_key: string }; Returns: string };
      stage_market_instruments: { Args: { input_run_id: string; input_rows: Json }; Returns: number };
      fail_market_instrument_sync: { Args: { input_run_id: string; input_error: Json }; Returns: undefined };
      finalize_market_instrument_sync: { Args: { input_run_id: string; input_failed_count?: number }; Returns: Array<{ inserted: number; updated: number; skipped: number; failed: number }> };
      trigger_price_alert: { Args: { alert_id: string; observed_price: number; observed_change_percent: number; observed_at: string; notification_title: string; notification_message: string }; Returns: string | null };
      trigger_price_alert_service: { Args: { alert_id: string; observed_price: number; observed_change_percent: number; observed_at: string; observed_session: string; observed_source: string; notification_title: string; notification_message: string; input_idempotency_key: string }; Returns: string | null };
      enqueue_account_notification_service: { Args: { input_user_id: string; input_type: string; input_title: string; input_message: string; input_metadata: Json; input_idempotency_key: string; input_observed_at: string }; Returns: string };
      flush_queued_notifications_service: { Args: { input_now: string }; Returns: number };
      upsert_push_subscription: { Args: { input_endpoint: string; input_expiration_time: number | null; input_p256dh: string; input_auth: string; input_user_agent: string | null; input_device_label: string | null; input_now: string }; Returns: string };
      claim_push_test: { Args: { input_endpoint: string; input_now: string }; Returns: Array<{ subscription_id: string; allowed: boolean; retry_after_seconds: number }> };
      claim_push_deliveries_service: { Args: { input_limit: number; input_now: string; input_claim_token: string }; Returns: Array<Database['public']['Tables']['push_deliveries']['Row']> };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
