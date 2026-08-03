export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Currency = 'THB' | 'USD';
export type AppLanguage = 'th' | 'en';
export type PortfolioType = 'STOCK' | 'OPTION' | 'LEGACY';
export type SubscriptionTier = 'basic' | 'pro' | 'elite';
export type SubscriptionStatus = 'basic' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';
export type UserRole = 'user' | 'admin';
export type AdminPreviewMode = 'actual' | 'basic' | 'pro' | 'elite' | 'elite_trial' | 'expired_trial';
export type BillingProvider = 'stripe';
export type BillingPlanKey =
  | 'pro_monthly' | 'pro_annual' | 'pro_annual_founder'
  | 'elite_monthly' | 'elite_annual' | 'elite_annual_founder';
export type BillingInterval = 'month' | 'year';
export type BillingPaymentStatus = 'succeeded' | 'failed';
/** Every terminal state a webhook delivery can be recorded in. */
export type BillingWebhookStatus =
  'received' | 'applied' | 'ignored' | 'stale' | 'duplicate' | 'failed';

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
      /**
       * Operator role, deliberately separate from `user_subscriptions`. Read-only
       * to the account it belongs to; there is no client write path at all, so
       * `Insert` and `Update` exist only for the migration's own seeding.
       */
      user_roles: {
        Row: {
          user_id: string;
          role: UserRole;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          role?: UserRole;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          role?: UserRole;
          updated_at?: string;
        };
        Relationships: [];
      };
      /** Written only by the trusted preview routines; no grant to any client role. */
      admin_access_previews: {
        Row: {
          user_id: string;
          mode: AdminPreviewMode;
          expires_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          mode: AdminPreviewMode;
          expires_at: string;
          updated_at?: string;
        };
        Update: {
          mode?: AdminPreviewMode;
          expires_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_subscriptions: {
        Row: {
          user_id: string;
          tier: SubscriptionTier;
          status: SubscriptionStatus;
          trial_started_at: string | null;
          trial_ends_at: string | null;
          trial_used_at: string | null;
          current_period_start: string | null;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          billing_customer_id: string | null;
          billing_subscription_id: string | null;
          billing_price_id: string | null;
          founder_promo_applied: boolean;
          /* Phase 4 billing columns. Written only by the webhook's trusted
             routine; `authenticated` holds SELECT on this table and nothing more. */
          billing_provider: BillingProvider | null;
          billing_plan_key: BillingPlanKey | null;
          billing_interval: BillingInterval | null;
          latest_invoice_id: string | null;
          latest_payment_status: BillingPaymentStatus | null;
          latest_payment_at: string | null;
          provider_event_at: string | null;
          provider_event_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          tier?: SubscriptionTier;
          status?: SubscriptionStatus;
          trial_started_at?: string | null;
          trial_ends_at?: string | null;
          trial_used_at?: string | null;
          current_period_start?: string | null;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
          billing_customer_id?: string | null;
          billing_subscription_id?: string | null;
          billing_price_id?: string | null;
          founder_promo_applied?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          tier?: SubscriptionTier;
          status?: SubscriptionStatus;
          trial_started_at?: string | null;
          trial_ends_at?: string | null;
          trial_used_at?: string | null;
          current_period_start?: string | null;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
          billing_customer_id?: string | null;
          billing_subscription_id?: string | null;
          billing_price_id?: string | null;
          founder_promo_applied?: boolean;
          billing_provider?: BillingProvider | null;
          billing_plan_key?: BillingPlanKey | null;
          billing_interval?: BillingInterval | null;
          latest_invoice_id?: string | null;
          latest_payment_status?: BillingPaymentStatus | null;
          latest_payment_at?: string | null;
          provider_event_at?: string | null;
          provider_event_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      /**
       * The webhook idempotency ledger. No grant exists for `anon` or
       * `authenticated`, so this is reachable only with the service role — the
       * type is here for the trusted server, never for a browser query.
       */
      billing_webhook_events: {
        Row: {
          id: number;
          provider: BillingProvider;
          provider_event_id: string;
          event_type: string;
          status: BillingWebhookStatus;
          user_id: string | null;
          occurred_at: string | null;
          received_at: string;
          processed_at: string | null;
          error_code: string | null;
          /** A digest of the delivered body — never the body itself. */
          payload_digest: string | null;
        };
        Insert: {
          provider: BillingProvider;
          provider_event_id: string;
          event_type: string;
          status?: BillingWebhookStatus;
          user_id?: string | null;
          occurred_at?: string | null;
          processed_at?: string | null;
          error_code?: string | null;
          payload_digest?: string | null;
        };
        Update: {
          status?: BillingWebhookStatus;
          processed_at?: string | null;
          error_code?: string | null;
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
      get_my_subscription_snapshot: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          user_id: string;
          tier: SubscriptionTier;
          status: SubscriptionStatus;
          trial_started_at: string | null;
          trial_ends_at: string | null;
          trial_used_at: string | null;
          current_period_start: string | null;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          billing_customer_id: string | null;
          billing_subscription_id: string | null;
          billing_price_id: string | null;
          founder_promo_applied: boolean;
          created_at: string | null;
          updated_at: string | null;
          database_now: string;
        }>;
      };
      /**
       * The reader's own billing state, sanitized. Provider customer,
       * subscription, price and invoice identifiers are deliberately absent —
       * the manage page answers "what plan, when does it renew, for how much"
       * without any of them reaching the browser.
       */
      get_my_billing_snapshot: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          user_id: string;
          tier: SubscriptionTier;
          status: SubscriptionStatus;
          billing_provider: BillingProvider | null;
          billing_plan_key: BillingPlanKey | null;
          billing_interval: BillingInterval | null;
          current_period_start: string | null;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          founder_promo_applied: boolean;
          latest_payment_status: BillingPaymentStatus | null;
          latest_payment_at: string | null;
          trial_ends_at: string | null;
          trial_used_at: string | null;
          has_billing_customer: boolean;
          database_now: string;
        }>;
      };
      /**
       * The only routine that changes billing state, and it is granted to
       * neither `anon` nor `authenticated`. The webhook route reaches it with
       * the service role after verifying the provider's signature; identity,
       * idempotency, row locking and staleness are all decided inside it.
       */
      apply_billing_subscription_event: {
        Args: {
          input_provider: BillingProvider;
          input_event_id: string;
          input_event_type: string;
          input_occurred_at: string | null;
          input_payload_digest: string | null;
          input_user_id: string | null;
          input_customer_id: string | null;
          input_subscription_id: string | null;
          input_plan_key: BillingPlanKey | null;
          input_price_id: string | null;
          input_tier: SubscriptionTier | null;
          input_status: SubscriptionStatus | null;
          input_interval: BillingInterval | null;
          input_period_start: string | null;
          input_period_end: string | null;
          input_cancel_at_period_end: boolean | null;
          input_invoice_id: string | null;
          input_payment_status: BillingPaymentStatus | null;
          input_founder: boolean | null;
        };
        Returns: Array<{
          outcome:
            | 'applied' | 'duplicate' | 'ignored' | 'stale'
            | 'unknown_user' | 'customer_mismatch' | 'subscription_mismatch';
          applied_user_id: string | null;
        }>;
      };
      /**
       * Takes no arguments on purpose: identity, clock and current subscription
       * are all read inside the database, and billing identifiers are never
       * part of the projection it returns.
       */
      start_elite_trial: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          user_id: string;
          tier: SubscriptionTier;
          status: SubscriptionStatus;
          trial_started_at: string | null;
          trial_ends_at: string | null;
          trial_used_at: string | null;
          database_now: string;
        }>;
      };
      /**
       * Role, running preview and subscription in one trusted read. The database
       * has already dropped a lapsed preview and a preview held by an account
       * that is no longer an administrator, so the caller never has to.
       */
      get_my_account_access: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          user_id: string;
          role: UserRole;
          preview_mode: AdminPreviewMode;
          preview_expires_at: string | null;
          tier: SubscriptionTier;
          status: SubscriptionStatus;
          trial_ends_at: string | null;
          trial_used_at: string | null;
          current_period_end: string | null;
          database_now: string;
        }>;
      };
      /**
       * Takes a mode and nothing else. Identity comes from `auth.uid()`, the
       * administrator check is made against the stored role inside the database,
       * and no subscription, billing or trial column is read or written.
       */
      set_my_admin_access_preview: {
        Args: { input_mode: AdminPreviewMode };
        Returns: Array<{
          mode: AdminPreviewMode;
          expires_at: string | null;
          database_now: string;
        }>;
      };
      clear_my_admin_access_preview: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
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
      create_push_test_notification: { Args: { input_subscription_id: string; input_now: string }; Returns: Array<{ notification_id: string; delivery_id: string }> };
      claim_push_deliveries_service: { Args: { input_limit: number; input_now: string; input_claim_token: string }; Returns: Array<Database['public']['Tables']['push_deliveries']['Row']> };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
