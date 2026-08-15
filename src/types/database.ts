export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Currency = 'THB' | 'USD';
export type AppLanguage = 'th' | 'en';
export type PortfolioType = 'STOCK' | 'OPTION' | 'LEGACY';
export type SubscriptionTier = 'basic' | 'pro' | 'elite';
export type SubscriptionStatus = 'basic' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';
export type UserRole = 'user' | 'admin';
export type AdminPreviewMode = 'actual' | 'basic' | 'pro' | 'elite' | 'elite_trial' | 'expired_trial';
/** How loudly a release note is presented. Never a reason to block a reader. */
export type ReleaseImportance = 'normal' | 'important';
export type BillingProvider = 'stripe';
export type BillingProviderMode = 'test' | 'live' | 'legacy_unknown';
export type BillingPlanKey =
  | 'pro_monthly' | 'pro_annual' | 'pro_annual_founder'
  | 'elite_monthly' | 'elite_annual' | 'elite_annual_founder';
export type BillingInterval = 'month' | 'year';
export type BillingPaymentStatus = 'succeeded' | 'failed';
/** How the provider collects: a stored card, or an invoice the reader pays. */
export type BillingCollectionMethod = 'charge_automatically' | 'send_invoice';
export type BillingPaymentMethod = 'card' | 'promptpay';
export type BillingPendingPaymentStatus =
  'awaiting_payment' | 'paid' | 'canceled' | 'expired';
/** Every terminal state a webhook delivery can be recorded in. */
export type BillingWebhookStatus =
  'received' | 'applied' | 'ignored' | 'stale' | 'duplicate' | 'failed';

/* ---------------------------------------------------------------------------
 * Phase 5 — billing operations, support and trust.
 * ------------------------------------------------------------------------ */

/** Why paid access was withdrawn. Only these two ever revoke; nothing else does. */
export type AccessRevocationReason = 'refund' | 'dispute';
export type BillingInvoiceStatus =
  'open' | 'paid' | 'void' | 'uncollectible' | 'refunded' | 'partially_refunded' | 'disputed';
export type BillingRefundEventKind = 'refund' | 'dispute_opened' | 'dispute_closed';
/** What a refund or dispute does to entitlement. Decided by a pure classifier. */
export type BillingRefundEntitlementAction = 'revoke' | 'suspend' | 'restore' | 'record_only';
export type BillingWebhookRetryStatus = 'retrying' | 'dead_letter' | 'resolved';
export type BillingReconciliationIssueType =
  | 'paid_invoice_without_active_tier'
  | 'active_tier_without_confirmed_payment'
  | 'tier_period_mismatch'
  | 'orphan_customer'
  | 'orphan_subscription'
  | 'revoked_access_still_active'
  | 'dead_letter_event';
export type BillingReconciliationSeverity = 'info' | 'warning' | 'critical';
export type SupportTicketCategory =
  'billing' | 'subscription' | 'portfolio' | 'market_data' | 'technical' | 'suggestion' | 'other';
export type SupportTicketStatus =
  'open' | 'in_progress' | 'waiting_user' | 'resolved' | 'closed';
export type RefundRequestStatus =
  'pending' | 'reviewing' | 'approved' | 'rejected' | 'refunded' | 'canceled';
export type RefundRequestReason =
  'duplicate_charge' | 'not_as_expected' | 'accidental_purchase' | 'technical_issue' | 'other';
export type SupportAuthorRole = 'user' | 'admin' | 'system';
export type BetaStage = 'closed' | 'beta_5_10' | 'beta_20_50' | 'public';
export type BetaAccessReason =
  | 'unconfigured' | 'admin' | 'public_stage' | 'pre_existing_account'
  | 'existing_subscriber' | 'invited' | 'closed_stage' | 'not_invited' | 'unauthenticated';
export type BetaFunnelEventKey =
  | 'signup_completed' | 'subscription_viewed' | 'checkout_started' | 'checkout_returned'
  | 'checkout_canceled' | 'payment_succeeded' | 'paywall_blocked'
  | 'promptpay_renewal_help_viewed' | 'promptpay_renewal_paid' | 'feature_used_before_purchase';
export type SchedulerStatus = 'ok' | 'lagging' | 'stale' | 'unknown';
/** The only image types an attachment may be. Nothing executable is storable. */
export type SupportAttachmentMimeType =
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

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
      /** Public singleton aggregate. Contains a count only, never profile data. */
      app_public_stats: {
        Row: {
          singleton: boolean;
          member_count: number;
          updated_at: string;
        };
        Insert: never;
        Update: never;
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
          is_legacy: boolean; archived_at: string | null; deleted_at: string | null; purge_after: string | null;
          target_value_usd: string | null; target_date: string | null;
          created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; user_id: string; name?: string; base_currency?: Currency; portfolio_type?: PortfolioType;
          is_legacy?: boolean; archived_at?: string | null; deleted_at?: string | null; purge_after?: string | null;
          target_value_usd?: string | null; target_date?: string | null;
          created_at?: string; updated_at?: string;
        };
        Update: {
          name?: string; base_currency?: Currency; portfolio_type?: PortfolioType; is_legacy?: boolean;
          archived_at?: string | null; deleted_at?: string | null; purge_after?: string | null;
          target_value_usd?: string | null; target_date?: string | null; updated_at?: string;
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
          billing_provider_mode: BillingProviderMode | null;
          billing_plan_key: BillingPlanKey | null;
          billing_interval: BillingInterval | null;
          /** Phase 4.4. Which rail this subscription is billed on. */
          billing_collection_method: BillingCollectionMethod | null;
          latest_invoice_id: string | null;
          latest_payment_status: BillingPaymentStatus | null;
          latest_payment_at: string | null;
          provider_event_at: string | null;
          provider_event_id: string | null;
          /**
           * Phase 5. Set when a provider-confirmed full refund or a chargeback
           * ended paid access. The billing evidence beside it is untouched;
           * these three columns say why the status moved and, for a reversible
           * dispute suspension, what to move it back to.
           */
          access_revoked_at: string | null;
          access_revoked_reason: AccessRevocationReason | null;
          access_revoked_restore_status: SubscriptionStatus | null;
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
          billing_provider_mode?: BillingProviderMode | null;
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
          billing_provider_mode?: BillingProviderMode | null;
          billing_plan_key?: BillingPlanKey | null;
          billing_interval?: BillingInterval | null;
          billing_collection_method?: BillingCollectionMethod | null;
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
          provider_mode: BillingProviderMode;
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
          provider_mode: BillingProviderMode;
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
          provider_mode?: BillingProviderMode;
          status?: BillingWebhookStatus;
          processed_at?: string | null;
          error_code?: string | null;
        };
        Relationships: [];
      };
      /**
       * Phase 4.4. An invoice that exists and has not been paid — the gap only
       * the PromptPay rail has, since a card resolves in seconds.
       *
       * It grants nothing: no tier, status or period lives here, and
       * `resolve_effective_subscription_tier` never reads it. `authenticated`
       * holds SELECT on their own row and no write privilege at all; every write
       * comes from a service-role routine.
       */
      billing_pending_payments: {
        Row: {
          user_id: string;
          provider: BillingProvider;
          provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          payment_method: Extract<BillingPaymentMethod, 'promptpay'>;
          plan_key: BillingPlanKey;
          subscription_id: string;
          invoice_id: string | null;
          /** The provider-hosted page that renders this invoice's QR. */
          hosted_invoice_url: string | null;
          amount_baht: number;
          status: BillingPendingPaymentStatus;
          due_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /**
       * Phase 5. What the provider actually billed and collected, written only
       * by the webhook. Holds no card detail of any kind — the rail is a type,
       * read from `user_subscriptions.billing_collection_method`.
       *
       * No grant to `anon` or `authenticated`: a reader reaches their own
       * purchases through `list_my_billing_invoices()`, which returns our uuid
       * and never the provider's invoice identifier.
       */
      billing_invoices: {
        Row: {
          id: string;
          user_id: string;
          provider: BillingProvider;
          provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          invoice_id: string;
          subscription_id: string | null;
          plan_key: BillingPlanKey | null;
          status: BillingInvoiceStatus;
          amount_due_minor: number;
          amount_paid_minor: number;
          amount_refunded_minor: number;
          currency: string;
          period_start: string | null;
          period_end: string | null;
          issued_at: string | null;
          paid_at: string | null;
          refunded_at: string | null;
          disputed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /** Phase 5. Provider-confirmed refunds, disputes and their resolutions. */
      billing_refund_events: {
        Row: {
          id: string;
          provider: BillingProvider;
          provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          provider_event_id: string;
          event_type: string;
          kind: BillingRefundEventKind;
          entitlement_action: BillingRefundEntitlementAction;
          outcome: string;
          entitlement_changed: boolean;
          user_id: string | null;
          subscription_id: string | null;
          invoice_id: string | null;
          charge_id: string | null;
          amount_minor: number;
          charge_amount_minor: number | null;
          currency: string;
          is_full: boolean;
          dispute_outcome: string | null;
          occurred_at: string;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /** Phase 5. Failed deliveries, their bounded attempts and the dead letter. */
      billing_webhook_retries: {
        Row: {
          id: string;
          provider: BillingProvider;
          provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          provider_event_id: string;
          event_type: string;
          user_id: string | null;
          attempt_count: number;
          status: BillingWebhookRetryStatus;
          last_error_code: string | null;
          first_failed_at: string;
          last_failed_at: string;
          next_attempt_at: string | null;
          dead_lettered_at: string | null;
          resolved_at: string | null;
          alerted_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      billing_reconciliation_runs: {
        Row: {
          id: string;
          local_date: string;
          provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          status: 'running' | 'completed' | 'failed';
          checked_count: number;
          issue_count: number;
          started_at: string;
          completed_at: string | null;
          error_code: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /** Phase 5. One row per distinct disagreement, re-stamped rather than duplicated. */
      billing_reconciliation_issues: {
        Row: {
          id: string;
          dedupe_key: string;
          issue_type: BillingReconciliationIssueType;
          severity: BillingReconciliationSeverity;
          user_id: string | null;
          provider_mode: string | null;
          detail: Json;
          occurrences: number;
          first_seen_at: string;
          last_seen_at: string;
          last_run_id: string | null;
          resolved_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /**
       * Phase 5. A reader supplies category, subject and description; the
       * routine supplies everything else. `authenticated` holds SELECT on their
       * own rows and no write privilege at all, so a client cannot set its own
       * status or forge the tier it was on.
       */
      support_tickets: {
        Row: {
          id: string;
          reference: string;
          user_id: string;
          category: SupportTicketCategory;
          subject: string;
          description: string;
          status: SupportTicketStatus;
          tier_snapshot: SubscriptionTier;
          status_changed_at: string;
          last_user_reply_at: string | null;
          last_admin_reply_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /** Phase 5. Filing one moves no money and withdraws no access. */
      refund_requests: {
        Row: {
          id: string;
          reference: string;
          user_id: string;
          invoice_ref: string | null;
          status: RefundRequestStatus;
          reason_category: RefundRequestReason;
          details: string;
          amount_minor: number | null;
          currency: string | null;
          tier_snapshot: SubscriptionTier;
          status_changed_at: string;
          decided_at: string | null;
          decided_by: string | null;
          refunded_at: string | null;
          refund_event_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /**
       * Phase 7. What a buyer accepted, immediately before a paid checkout.
       *
       * Readable by its own account and by nobody else. `Insert` and `Update`
       * are `never` on purpose: the only writer is `record_purchase_consent`,
       * and an immutability trigger refuses to let any existing row's account,
       * purchase shape, policy versions or original acceptance date be rewritten
       * — including by a trusted role.
       */
      purchase_consents: {
        Row: {
          id: string;
          user_id: string;
          plan_key: string;
          billing_interval: BillingInterval;
          payment_rail: BillingPaymentMethod;
          subscription_policy_version: string;
          refund_policy_version: string;
          /** The first time this exact agreement was given. Never moves. */
          accepted_at: string;
          last_accepted_at: string;
          acceptance_count: number;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /**
       * Phase 5. Tickets and refund requests share one thread. `is_internal`
       * marks the operator's private margin, and the reading policy hides those
       * rows from everybody who is not an administrator.
       */
      support_thread_messages: {
        Row: {
          id: string;
          ticket_id: string | null;
          refund_request_id: string | null;
          author_user_id: string | null;
          author_role: SupportAuthorRole;
          body: string;
          is_internal: boolean;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      support_attachments: {
        Row: {
          id: string;
          ticket_id: string | null;
          refund_request_id: string | null;
          message_id: string | null;
          uploaded_by: string | null;
          storage_bucket: string;
          storage_path: string;
          mime_type: SupportAttachmentMimeType;
          size_bytes: number;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      /** Phase 5. Append-only; a trigger refuses every UPDATE and DELETE. */
      support_audit_events: {
        Row: {
          id: number;
          ticket_id: string | null;
          refund_request_id: string | null;
          actor_user_id: string | null;
          actor_role: SupportAuthorRole;
          action: string;
          from_status: string | null;
          to_status: string | null;
          detail: Json;
          created_at: string;
        };
        Insert: never;
        Update: never;
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
          transfer_group_id: string | null; transfer_cost_basis_usd: string | null;
          transfer_acquired_at: string | null;
          transfer_source_name: string | null; transfer_destination_name: string | null;
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
          transfer_group_id?: string | null; transfer_cost_basis_usd?: string | null;
          transfer_acquired_at?: string | null;
          transfer_source_name?: string | null; transfer_destination_name?: string | null;
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
          transfer_group_id?: string | null; transfer_cost_basis_usd?: string | null;
          transfer_acquired_at?: string | null;
          transfer_source_name?: string | null; transfer_destination_name?: string | null;
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
      /**
       * วางแผนหุ้นรายตัว — one saved plan per row.
       *
       * `baseline_price` is absent from `Update` on purpose. The database refuses
       * to move it (a trigger raises `STOCK_PLAN_BASELINE_IMMUTABLE`), and leaving
       * it out of the type means a patch that tries to is a compile error rather
       * than a runtime one. `user_id` is out for the same reason.
       */
      stock_plans: {
        Row: {
          id: string; user_id: string; symbol: string;
          baseline_price: number; target_price: number; invalidation_price: number;
          horizon_date: string; archived_at: string | null; created_at: string; updated_at: string;
        };
        Insert: {
          id?: string; user_id: string; symbol: string;
          baseline_price: number; target_price: number; invalidation_price: number;
          horizon_date: string; archived_at?: string | null; created_at?: string; updated_at?: string;
        };
        Update: Partial<Pick<
          Database['public']['Tables']['stock_plans']['Insert'],
          'symbol' | 'target_price' | 'invalidation_price' | 'horizon_date' | 'archived_at' | 'updated_at'
        >>;
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
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
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
            | 'unknown_user' | 'identity_incomplete'
            | 'customer_mismatch' | 'subscription_mismatch'
            | 'provider_mode_downgrade'
            /**
             * Phase 5. A revocation is recorded against this subscription, and
             * this event would have asserted a granting status without money
             * behind it. Understood, recorded, and deliberately without effect.
             */
            | 'revoked_hold';
          applied_user_id: string | null;
        }>;
      };
      /**
       * Phase 4.4. Records a PromptPay invoice that is awaiting payment. Writes
       * no entitlement column — the tier still opens only from a paid invoice —
       * and is granted to neither `anon` nor `authenticated`.
       */
      record_pending_billing_payment: {
        Args: {
          input_user_id: string;
          input_provider: BillingProvider;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          input_payment_method: Extract<BillingPaymentMethod, 'promptpay'>;
          input_plan_key: BillingPlanKey;
          input_subscription_id: string;
          input_invoice_id: string | null;
          input_hosted_invoice_url: string | null;
          input_amount_baht: number;
          input_due_at: string | null;
        };
        Returns: 'recorded' | 'unknown_user' | 'already_subscribed' | 'pending_exists';
      };
      /**
       * Phase 4.4. Records which rail a subscription is billed on, and clears a
       * pending invoice that has been settled. Scoped to a subscription
       * identifier that must already match what is stored, and cannot grant.
       */
      apply_billing_payment_rail: {
        Args: {
          input_user_id: string;
          input_provider: BillingProvider;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          input_subscription_id: string;
          input_collection_method: BillingCollectionMethod | null;
          input_pending_settled: boolean;
        };
        Returns: Array<{ rail_updated: boolean; pending_cleared: boolean }>;
      };
      /**
       * Phase 4.4. Marks an unpaid invoice abandoned. Keeps the row so the next
       * attempt's idempotency key differs from the abandoned one.
       */
      cancel_pending_billing_payment: {
        Args: {
          input_user_id: string;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          input_subscription_id: string;
        };
        Returns: boolean;
      };
      /* --- Phase 5: billing operations (service role only) ----------------- */
      /** Upsert of what the provider billed. Never walks a refund back to paid. */
      record_billing_invoice: {
        Args: {
          input_user_id: string;
          input_provider: BillingProvider;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          input_invoice_id: string;
          input_subscription_id: string | null;
          input_plan_key: BillingPlanKey | null;
          input_status: 'open' | 'paid' | 'void' | 'uncollectible';
          input_amount_due_minor: number;
          input_amount_paid_minor: number;
          input_currency: string;
          input_period_start: string | null;
          input_period_end: string | null;
          input_issued_at: string | null;
          input_paid_at: string | null;
        };
        Returns: 'recorded' | 'ignored' | 'unknown_user';
      };
      /**
       * The one path a refund or a chargeback takes into entitlement.
       * Idempotent on the provider's event id, and constrained to the four
       * actions the pure classifier can produce.
       */
      apply_billing_refund_event: {
        Args: {
          input_provider: BillingProvider;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          input_event_id: string;
          input_event_type: string;
          input_kind: BillingRefundEventKind;
          input_action: BillingRefundEntitlementAction;
          input_occurred_at: string;
          input_user_id: string | null;
          input_subscription_id: string | null;
          input_invoice_id: string | null;
          input_charge_id: string | null;
          input_amount_minor: number;
          input_charge_amount_minor: number | null;
          input_currency: string;
          input_is_full: boolean;
          input_dispute_outcome: string | null;
        };
        Returns: Array<{
          outcome:
            | 'recorded' | 'duplicate' | 'unknown_user' | 'subscription_mismatch'
            | 'revoked' | 'suspended' | 'restored'
            | 'no_active_entitlement' | 'not_restorable';
          entitlement_changed: boolean;
          refund_event_id: string | null;
        }>;
      };
      /** Records one failed delivery and reports whether it has run out of attempts. */
      record_billing_webhook_attempt: {
        Args: {
          input_provider: BillingProvider;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          input_event_id: string;
          input_event_type: string;
          input_user_id: string | null;
          input_error_code: string | null;
          input_backoff_seconds: number;
          input_max_attempts: number;
        };
        Returns: Array<{
          attempt_count: number;
          status: BillingWebhookRetryStatus;
          next_attempt_at: string | null;
          newly_dead_lettered: boolean;
        }>;
      };
      resolve_billing_webhook_retry: {
        Args: {
          input_provider: BillingProvider;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          input_event_id: string;
        };
        Returns: boolean;
      };
      mark_billing_webhook_alerted: {
        Args: {
          input_provider: BillingProvider;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
          input_event_id: string;
        };
        Returns: boolean;
      };
      start_billing_reconciliation_run: {
        Args: {
          input_local_date: string;
          input_provider_mode: Exclude<BillingProviderMode, 'legacy_unknown'>;
        };
        Returns: Array<{ run_id: string; outcome: 'started' | 'resumed' | 'already_ran' }>;
      };
      record_billing_reconciliation_issue: {
        Args: {
          input_run_id: string;
          input_dedupe_key: string;
          input_issue_type: BillingReconciliationIssueType;
          input_severity: BillingReconciliationSeverity;
          input_user_id: string | null;
          input_provider_mode: string | null;
          input_detail: Json;
        };
        Returns: 'recorded' | 'updated';
      };
      complete_billing_reconciliation_run: {
        Args: {
          input_run_id: string;
          input_checked: number;
          input_issue_count: number;
          input_status: 'completed' | 'failed';
          input_error_code: string | null;
        };
        Returns: number;
      };
      record_support_attachment: {
        Args: {
          input_ticket_id: string | null;
          input_refund_request_id: string | null;
          input_uploaded_by: string;
          input_storage_bucket: string;
          input_storage_path: string;
          input_mime_type: SupportAttachmentMimeType;
          input_size_bytes: number;
        };
        Returns: Array<{
          attachment_id: string | null;
          outcome: 'recorded' | 'invalid_subject' | 'invalid_file' | 'not_found';
        }>;
      };
      /* --- Phase 5: what a reader may do ----------------------------------- */
      create_support_ticket: {
        Args: {
          input_category: SupportTicketCategory;
          input_subject: string;
          input_description: string;
        };
        Returns: Array<{
          ticket_id: string | null;
          reference: string | null;
          outcome: 'created' | 'invalid_category' | 'invalid_content' | 'too_soon' | 'rate_limited';
        }>;
      };
      reply_to_my_support_ticket: {
        Args: { input_ticket_id: string; input_body: string };
        Returns: Array<{
          message_id: string | null;
          outcome: 'replied' | 'invalid_content' | 'not_found' | 'closed' | 'too_soon' | 'rate_limited';
        }>;
      };
      /**
       * The reader's own purchases, by our uuid. No provider identifier is in
       * the projection, which is what makes "choose a purchase" safe to ask a
       * browser: the answer means nothing anywhere but this account's own rows.
       */
      list_my_billing_invoices: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          invoice_ref: string;
          plan_key: BillingPlanKey | null;
          status: BillingInvoiceStatus;
          amount_paid_minor: number;
          amount_refunded_minor: number;
          currency: string;
          period_start: string | null;
          period_end: string | null;
          issued_at: string | null;
          paid_at: string | null;
          refund_request_status: RefundRequestStatus | null;
          /**
           * Phase 7. `paid_at + 7 days`, derived inside the database. `null`
           * for an invoice with no confirmed payment. Judge it against
           * `database_now` and never against a client clock.
           */
          refund_deadline_at: string | null;
          database_now: string;
        }>;
      };
      /** Phase 7. The refund window for one payment timestamp. */
      refund_request_deadline: {
        Args: { input_paid_at: string | null };
        Returns: string | null;
      };
      /**
       * Phase 7. Write down what a buyer accepted, before a paid checkout.
       *
       * The account comes from the session. Idempotent: the same agreement
       * given twice reaffirms one row rather than filing a second.
       */
      record_purchase_consent: {
        Args: {
          input_plan_key: string;
          input_billing_interval: BillingInterval;
          input_payment_rail: BillingPaymentMethod;
          input_subscription_policy_version: string;
          input_refund_policy_version: string;
        };
        Returns: Array<{
          consent_id: string | null;
          outcome: 'recorded' | 'reaffirmed' | 'invalid';
        }>;
      };
      create_refund_request: {
        Args: {
          input_invoice_ref: string;
          input_reason_category: RefundRequestReason;
          input_details: string;
        };
        Returns: Array<{
          request_id: string | null;
          reference: string | null;
          outcome:
            | 'created' | 'invalid_reason' | 'invalid_content' | 'not_found'
            | 'not_refundable' | 'already_open' | 'already_refunded' | 'rate_limited'
            /** Phase 7. Past `paid_at + 7 days`, judged by the database clock. */
            | 'window_closed';
        }>;
      };
      cancel_my_refund_request: {
        Args: { input_request_id: string };
        Returns: 'canceled' | 'not_found' | 'not_cancelable';
      };
      reply_to_my_refund_request: {
        Args: { input_request_id: string; input_body: string };
        Returns: Array<{
          message_id: string | null;
          outcome: 'replied' | 'invalid_content' | 'not_found' | 'closed' | 'too_soon';
        }>;
      };
      /* --- Phase 5: what an operator may do -------------------------------- */
      is_platform_admin: {
        Args: { input_user_id: string };
        Returns: boolean;
      };
      admin_reply_support_ticket: {
        Args: { input_ticket_id: string; input_body: string; input_internal: boolean };
        Returns: Array<{
          message_id: string | null;
          outcome: 'replied' | 'noted' | 'invalid_content' | 'not_found';
        }>;
      };
      admin_set_support_ticket_status: {
        Args: { input_ticket_id: string; input_status: SupportTicketStatus };
        Returns: 'updated' | 'unchanged' | 'invalid_status' | 'not_found';
      };
      admin_reply_refund_request: {
        Args: { input_request_id: string; input_body: string; input_internal: boolean };
        Returns: Array<{
          message_id: string | null;
          outcome: 'replied' | 'noted' | 'invalid_content' | 'not_found';
        }>;
      };
      /**
       * Nothing reaches `refunded` here without a completion reference: approval
       * is a decision, and a claim that money moved has to name its evidence.
       */
      admin_set_refund_request_status: {
        Args: {
          input_request_id: string;
          input_status: Extract<RefundRequestStatus, 'reviewing' | 'approved' | 'rejected' | 'refunded'>;
          input_completion_reference: string | null;
        };
        Returns:
          | 'updated' | 'unchanged' | 'invalid_status' | 'not_found'
          | 'invalid_transition' | 'confirmation_required';
      };
      admin_search_accounts: {
        Args: { input_query: string; input_limit: number };
        Returns: Array<{
          user_id: string;
          email: string | null;
          full_name: string | null;
          role: UserRole;
          tier: SubscriptionTier;
          status: SubscriptionStatus;
          effective_tier: SubscriptionTier;
          billing_plan_key: BillingPlanKey | null;
          billing_interval: BillingInterval | null;
          billing_provider_mode: BillingProviderMode | null;
          billing_collection_method: BillingCollectionMethod | null;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          access_revoked_at: string | null;
          access_revoked_reason: AccessRevocationReason | null;
          open_ticket_count: number;
          open_refund_count: number;
          database_now: string;
        }>;
      };
      admin_account_invoices: {
        Args: { input_user_id: string };
        Returns: Array<{
          invoice_ref: string;
          plan_key: BillingPlanKey | null;
          status: BillingInvoiceStatus;
          amount_due_minor: number;
          amount_paid_minor: number;
          amount_refunded_minor: number;
          currency: string;
          period_start: string | null;
          period_end: string | null;
          issued_at: string | null;
          paid_at: string | null;
          refunded_at: string | null;
          disputed_at: string | null;
        }>;
      };
      admin_account_webhook_history: {
        Args: { input_user_id: string };
        Returns: Array<{
          event_type: string;
          status: BillingWebhookStatus;
          provider_mode: BillingProviderMode;
          error_code: string | null;
          occurred_at: string | null;
          received_at: string;
          processed_at: string | null;
        }>;
      };
      /**
       * The audit trail for one thread, for an operator.
       *  itself is granted to nobody; this is the only
       * read path, and it checks the role inside the database.
       */
      admin_thread_audit: {
        Args: {
          input_ticket_id: string | null;
          input_refund_request_id: string | null;
          input_limit: number;
        };
        Returns: Array<{
          event_id: number;
          actor_role: SupportAuthorRole;
          action: string;
          from_status: string | null;
          to_status: string | null;
          created_at: string;
        }>;
      };
      admin_open_billing_issues: {
        Args: { input_user_id: string | null; input_limit: number };
        Returns: Array<{
          issue_id: string;
          issue_type: BillingReconciliationIssueType;
          severity: BillingReconciliationSeverity;
          user_id: string | null;
          provider_mode: string | null;
          detail: Json;
          occurrences: number;
          first_seen_at: string;
          last_seen_at: string;
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
          /** `'active'` or `'deleting'`; anything else is treated as closing. */
          account_status: string;
          database_now: string;
        }>;
      };
      /**
       * The persistent trial ledger and the account-deletion pipeline.
       *
       * Every one of these is granted to `service_role` and to nothing else, so
       * they are only reachable through the server-only modules in
       * `src/lib/trial-identity` and `src/lib/account`. A browser holds no key
       * that can call them.
       */
      trial_identity_is_claimed: {
        Args: { input_identities: Array<{ type: string; hash: string; version: number }> };
        Returns: boolean;
      };
      /**
       * The claim check and the key-version check, in one round trip.
       *
       * `input_versions` is every version the caller holds a key for, and
       * `unsupported_versions` is any version the ledger stores that is not in that
       * list — which the caller treats as a refusal, because a miss under a key it
       * cannot compute proves nothing. Asked together on purpose: separately, a
       * miss and a version list could describe two different snapshots.
       */
      trial_identity_claim_status: {
        Args: {
          input_identities: Array<{ type: string; hash: string; version: number }>;
          input_versions: number[] | null;
        };
        Returns: Array<{ claimed: boolean; unsupported_versions: number[] | null }>;
      };
      start_elite_trial_with_identity: {
        Args: {
          input_user_id: string;
          input_identities: Array<{ type: string; hash: string; version: number }>;
        };
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
      retain_trial_identity_on_deletion: {
        Args: {
          input_user_id: string;
          input_identities: Array<{ type: string; hash: string; version: number }>;
          input_trial_used: boolean;
        };
        Returns: number;
      };
      /**
       * The database's own answer to "may this caller delete their account?",
       * asked immediately before the service-role pipeline runs.
       *
       * Deliberately argument-less: the subject is `auth.uid()`, so no caller can
       * name an account that is not theirs. Raises rather than returns on refusal
       * — `SECURITY_LOCKDOWN` while the incident switch is on,
       * `ACCOUNT_DELETION_UNAUTHENTICATED` for a session that resolves to nobody.
       */
      authorize_account_deletion: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      begin_account_deletion: {
        Args: { input_user_id: string };
        Returns: Array<{
          operation_id: string | null;
          stage: string | null;
          trial_used: boolean;
          resumed: boolean;
        }>;
      };
      advance_account_deletion: {
        Args: { input_user_id: string; input_stage: string };
        Returns: string;
      };
      cancel_account_deletion: {
        Args: { input_user_id: string };
        Returns: string;
      };
      purge_account_data: {
        Args: { input_user_id: string };
        Returns: undefined;
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
      /** Returns the moment the recovery window closes. */
      soft_delete_portfolio: { Args: { target_portfolio_id: string; input_expected_name: string }; Returns: string };
      /** Returns the name it came back under, renamed only on a collision. */
      restore_deleted_portfolio: { Args: { target_portfolio_id: string }; Returns: string };
      /**
       * Empties one portfolio without removing it: every ledger row, legacy
       * option position, option target and the goal go, and the row itself —
       * name, type, currency, legacy and archived state — stays. Returns what
       * was actually cleared, as one row.
       */
      reset_portfolio: {
        Args: { target_portfolio_id: string };
        Returns: {
          transactions_removed: number;
          option_positions_removed: number;
          option_targets_removed: number;
          goal_cleared: boolean;
        }[];
      };
      /**
       * One atomic asset move. `input_legs` carries amounts the server derived
       * from the ledger; `input_expected` is the position fingerprint the
       * database re-derives and compares before it writes anything.
       */
      transfer_portfolio_assets: {
        Args: {
          input_source_portfolio_id: string;
          input_destination_portfolio_id: string;
          input_group_id: string;
          input_legs: unknown;
          input_expected: unknown;
          input_occurred_at: string;
          input_note: string | null;
        };
        Returns: { transfer_group_id: string; legs_written: number; already_applied: boolean }[];
      };
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
      create_portfolio_option_purchase: {
        Args: {
          input_portfolio_id: string;
          input_underlying_symbol: string;
          input_contract_symbol: string;
          input_option_kind: 'call' | 'put';
          input_strike_price: string;
          input_expiration_date: string;
          input_contracts: number;
          input_purchase_price: string;
          input_occurred_at: string;
          input_quote_timestamp: string;
          input_idempotency_key: string;
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

      /*
       * Phase 6 — the operator dashboard, the controlled beta, and production
       * safety. Every `admin_*` routine below checks `is_platform_admin` inside
       * the database and raises `ADMIN_REQUIRED` otherwise; none of them is
       * reachable by a client holding an ordinary session.
       */

      /**
       * Whether *this* caller may start a new purchase. Takes no arguments: the
       * account, the stage and the clock are all read inside the database, so a
       * client cannot claim admission it does not have.
       */
      resolve_my_beta_access: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          stage: BetaStage;
          admitted: boolean;
          reason: BetaAccessReason;
          is_admin: boolean;
          /** `-1` means uncapped. */
          participant_cap: number;
          active_invites: number;
          database_now: string;
        }>;
      };
      admin_set_beta_stage: {
        Args: { input_stage: BetaStage; input_cap: number | null; input_request_id: string | null };
        Returns: 'updated' | 'unchanged' | 'invalid_stage' | 'cap_out_of_band' | 'not_found';
      };
      admin_add_beta_invite: {
        Args: { input_email: string; input_request_id: string | null };
        Returns: Array<{
          invite_id: string | null;
          outcome: 'invited' | 'already_invited' | 'cap_reached' | 'invalid_email';
          active_invites: number;
          participant_cap: number;
        }>;
      };
      admin_revoke_beta_invite: {
        Args: { input_invite_id: string; input_request_id: string | null };
        Returns: 'revoked' | 'unchanged' | 'not_found';
      };
      admin_beta_program_state: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          stage: BetaStage;
          participant_cap: number | null;
          effective_cap: number;
          active_invites: number;
          enforced_from: string;
          updated_at: string;
          database_now: string;
        }>;
      };
      admin_beta_invites: {
        Args: { input_query: string | null; input_limit: number; input_offset: number };
        Returns: Array<{
          invite_id: string;
          email: string;
          invited_at: string;
          revoked_at: string | null;
          has_account: boolean;
          has_paid: boolean;
          total_count: number;
        }>;
      };
      admin_beta_report: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          stage: BetaStage | 'unknown';
          invited: number;
          signed_up: number;
          paid: number;
          signup_completed: number;
          subscription_viewed: number;
          checkout_started: number;
          checkout_returned: number;
          checkout_canceled: number;
          payment_succeeded: number;
          paywall_blocked: number;
          promptpay_help_viewed: number;
          promptpay_renewal_paid: number;
          features_used_before_purchase: number;
        }>;
      };
      admin_beta_feature_report: {
        Args: { input_limit: number };
        Returns: Array<{
          event_key: BetaFunnelEventKey;
          feature_key: string;
          accounts: number;
          occurrences: number;
          last_seen_at: string;
        }>;
      };
      /**
       * The funnel writer. The account, the timestamp, the Bangkok date and the
       * beta stage are stamped inside the database — a caller supplies only the
       * approved key and the product-configuration labels.
       */
      record_beta_funnel_event: {
        Args: {
          input_event_key: BetaFunnelEventKey;
          input_plan_key: string | null;
          input_payment_rail: BillingPaymentMethod | null;
          input_feature_key: string | null;
          input_dedupe_scope: string;
        };
        Returns: 'recorded' | 'duplicate' | 'invalid_event' | 'invalid_rail'
          | 'invalid_plan' | 'invalid_feature' | 'invalid_scope';
      };
      admin_dashboard_overview: {
        Args: { input_from_date: string | null; input_to_date: string | null };
        Returns: Array<{
          basic_members: number;
          pro_members: number;
          elite_members: number;
          trial_members: number;
          promptpay_pending: number;
          past_due_members: number;
          new_members_today: number;
          new_members_7d: number;
          new_members_30d: number;
          /** Minor units. Confirmed money in, minus confirmed money back. */
          revenue_today_minor: number;
          revenue_month_minor: number;
          revenue_period_minor: number;
          refunds_period_minor: number;
          failed_webhooks: number;
          dead_letter_webhooks: number;
          open_reconciliation_issues: number;
          critical_reconciliation_issues: number;
          open_tickets: number;
          open_refund_requests: number;
          period_from: string;
          period_to: string;
          database_now: string;
          /** Accounts that exist right now. Never bounded by the selected period. */
          total_users: number;
        }>;
      };
      admin_recent_billing_activity: {
        Args: {
          input_kind: 'all' | 'payment' | 'cancellation' | 'refund' | 'dispute';
          input_query: string | null;
          input_limit: number;
          input_offset: number;
        };
        Returns: Array<{
          activity_kind: 'payment' | 'cancellation' | 'refund' | 'dispute';
          occurred_at: string;
          user_id: string | null;
          email: string | null;
          plan_key: BillingPlanKey | null;
          status: string;
          amount_minor: number;
          currency: string;
          payment_rail: BillingPaymentMethod | null;
          /**
           * The provider's own identifier, for building a server-side deep link
           * only. It is never rendered as text — the console shows a masked
           * label — and this projection is reachable only behind the operator gate.
           */
          provider_ref: string | null;
          total_count: number;
        }>;
      };
      admin_audit_feed: {
        Args: { input_limit: number; input_offset: number };
        Returns: Array<{
          source: 'admin' | 'support';
          action: string;
          target_type: string;
          target_ref: string | null;
          actor_user_id: string | null;
          before_summary: Json;
          after_summary: Json;
          request_id: string | null;
          created_at: string;
          total_count: number;
        }>;
      };
      consume_rate_limit: {
        Args: { input_bucket_key: string; input_limit: number; input_window_seconds: number };
        Returns: Array<{ allowed: boolean; remaining: number; retry_after_seconds: number }>;
      };
      /** Coarse by design: a word, never a timestamp, a count or an error. */
      platform_readiness: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{ database_ready: boolean; scheduler_status: SchedulerStatus }>;
      };

      /* ---------------------------------------------------------------------
       * Maintenance and release notes.
       * ------------------------------------------------------------------ */

      /**
       * The switch, plus whether *this* caller is an operator, in one round trip
       * because middleware runs this on every request during a maintenance
       * window. Granted to `anon`: a signed-out visitor must be able to read the
       * public notice, and `is_admin` is false for them by construction.
       */
      resolve_maintenance_state: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          maintenance_enabled: boolean;
          maintenance_message: string | null;
          expected_resume_at: string | null;
          maintenance_started_at: string | null;
          is_admin: boolean;
          database_now: string;
        }>;
      };
      /* ---------------------------------------------------------------------
       * Runtime posture: the maintenance switch and the security lockdown, read
       * together because middleware runs this on every request and a second
       * switch must not mean a second round trip. Granted to `anon` for the same
       * reason the maintenance read is; `is_admin` is false for them by
       * construction.
       * ------------------------------------------------------------------ */
      resolve_runtime_posture: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          maintenance_enabled: boolean;
          security_lockdown_enabled: boolean;
          is_admin: boolean;
          database_now: string;
        }>;
      };
      admin_security_posture: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          maintenance_enabled: boolean;
          security_lockdown_enabled: boolean;
          security_lockdown_reason: string | null;
          security_lockdown_started_at: string | null;
          security_lockdown_started_by: string | null;
          updated_at: string;
          updated_by: string | null;
          database_now: string;
        }>;
      };
      admin_set_security_lockdown: {
        Args: {
          input_enabled: boolean;
          input_reason: string | null;
          input_request_id: string | null;
        };
        Returns: 'enabled' | 'disabled' | 'unchanged' | 'invalid_state' | 'not_found';
      };
      /**
       * The security slice of the operator audit. Callable by any signed-in
       * account — a non-operator's denied attempt is exactly the event worth
       * keeping — and safe to be, because the actor is resolved from
       * `auth.uid()` inside the routine, the event vocabulary is a closed
       * allowlist, and the detail is assembled from two clamped scalars rather
       * than from anything the caller supplies.
       */
      record_security_event: {
        Args: {
          input_event_key: string;
          input_target_ref: string | null;
          input_observed_count: number | null;
          input_outcome: string | null;
          input_request_id: string | null;
        };
        Returns: 'recorded' | 'invalid_event';
      };
      admin_security_audit: {
        Args: { input_limit: number; input_offset: number };
        Returns: Array<{
          id: number;
          action: string;
          actor_user_id: string | null;
          actor_role: 'admin' | 'system';
          target_type: string;
          target_ref: string | null;
          after_summary: Json;
          request_id: string | null;
          created_at: string;
          total_count: number;
        }>;
      };
      admin_maintenance_state: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          maintenance_enabled: boolean;
          maintenance_message: string | null;
          expected_resume_at: string | null;
          maintenance_started_at: string | null;
          maintenance_started_by: string | null;
          updated_at: string;
          updated_by: string | null;
          database_now: string;
        }>;
      };
      admin_set_maintenance: {
        Args: {
          input_enabled: boolean;
          input_message: string | null;
          input_expected_resume_at: string | null;
          input_request_id: string | null;
        };
        Returns: 'enabled' | 'disabled' | 'unchanged' | 'invalid_state' | 'not_found';
      };
      admin_maintenance_audit: {
        Args: { input_limit: number };
        Returns: Array<{
          id: number;
          action: 'maintenance.enabled' | 'maintenance.disabled';
          actor_user_id: string | null;
          after_summary: Json;
          created_at: string;
        }>;
      };
      admin_save_release_note: {
        Args: {
          input_id: string | null;
          input_version: string | null;
          input_title: string;
          input_content: string;
          input_importance: ReleaseImportance;
          /** `null` leaves the publication state alone — the "save an edit" case. */
          input_publish: boolean | null;
          input_request_id: string | null;
        };
        Returns: Array<{
          release_id: string | null;
          outcome:
            | 'created' | 'created_published' | 'updated' | 'published' | 'unpublished'
            | 'not_found' | 'invalid_title' | 'invalid_content';
        }>;
      };
      admin_release_notes: {
        Args: { input_limit: number; input_offset: number };
        Returns: Array<{
          id: string;
          version: string | null;
          title: string;
          content: string;
          importance: ReleaseImportance;
          is_published: boolean;
          published_at: string | null;
          created_at: string;
          updated_at: string;
          total_count: number;
        }>;
      };
      /** At most one row: the newest published release this reader has not seen. */
      resolve_my_release_announcement: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          id: string;
          version: string | null;
          title: string;
          content: string;
          importance: ReleaseImportance;
          published_at: string;
        }>;
      };
      acknowledge_release_note: {
        Args: { input_release_id: string };
        Returns: 'acknowledged' | 'not_found' | 'invalid_release';
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
