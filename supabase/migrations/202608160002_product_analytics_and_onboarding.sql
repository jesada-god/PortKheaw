-- ---------------------------------------------------------------------------
-- Product analytics and progressive onboarding
-- ---------------------------------------------------------------------------
--
-- Two small additions, and deliberately no new tables.
--
--   1. Seven more approved keys on the funnel that already exists. The question
--      the rollout funnel answered was "did they pay?"; the question added here
--      is "which parts of the product does anybody actually use?". It is the
--      same table, the same routine, the same dedupe rule and the same refusal
--      to store free text — so the privacy properties are inherited rather than
--      re-argued, and there is no second telemetry system to keep honest.
--
--   2. Four columns on `user_settings`, which is already this product's
--      per-account preference store. Onboarding state is a preference: it says
--      what somebody chose to start with and whether they are done being helped.
--      A table of its own would be a second place to look for the same kind of
--      fact, and a second thing to remember to purge.
--
-- Nothing here stores a page, a message, an amount, a provider identifier, a
-- mailbox, an address or a user agent. The account id remains the only
-- identifier on a funnel row, and it is still cleared when the account is
-- deleted; the onboarding columns live on a row that is deleted outright with
-- the account.

-- ---------------------------------------------------------------------------
-- 1. The approved event keys
-- ---------------------------------------------------------------------------

alter table public.beta_funnel_events
  drop constraint if exists beta_funnel_events_key_check;

alter table public.beta_funnel_events
  add constraint beta_funnel_events_key_check check (event_key in (
    -- The rollout funnel, unchanged.
    'signup_completed',
    'subscription_viewed',
    'checkout_started',
    'checkout_returned',
    'checkout_canceled',
    'payment_succeeded',
    'paywall_blocked',
    'promptpay_renewal_help_viewed',
    'promptpay_renewal_paid',
    'feature_used_before_purchase',
    -- Product usage. `feature_key` carries a surface or tool identifier — our
    -- own configuration vocabulary, never a symbol, a value or anything typed.
    'landing_viewed',
    'trial_started',
    'portfolio_created',
    'stock_detail_viewed',
    'tool_opened',
    'feature_used',
    'onboarding_path_chosen'
  ));

-- The routine repeats the list because it refuses an unapproved key before it
-- ever reaches the constraint — a rejected event returns `invalid_event` rather
-- than raising, so telemetry can never fail the request it rode in on. Both
-- lists move together or the routine silently drops what the table would accept.
create or replace function public.record_beta_funnel_event(
  input_event_key text,
  input_plan_key text,
  input_payment_rail text,
  input_feature_key text,
  input_dedupe_scope text
)
returns text
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  observed timestamptz := statement_timestamp();
  bangkok_date date := (observed at time zone 'Asia/Bangkok')::date;
  current_stage text;
  plan text := nullif(btrim(coalesce(input_plan_key, '')), '');
  rail text := nullif(btrim(coalesce(input_payment_rail, '')), '');
  feature text := nullif(btrim(coalesce(input_feature_key, '')), '');
  scope text := nullif(btrim(coalesce(input_dedupe_scope, '')), '');
  composed_key text;
begin
  if input_event_key not in (
    'signup_completed', 'subscription_viewed', 'checkout_started', 'checkout_returned',
    'checkout_canceled', 'payment_succeeded', 'paywall_blocked',
    'promptpay_renewal_help_viewed', 'promptpay_renewal_paid', 'feature_used_before_purchase',
    'landing_viewed', 'trial_started', 'portfolio_created', 'stock_detail_viewed',
    'tool_opened', 'feature_used', 'onboarding_path_chosen'
  ) then
    return 'invalid_event';
  end if;

  if rail is not null and rail not in ('card', 'promptpay') then return 'invalid_rail'; end if;
  if plan is not null and char_length(plan) > 40 then return 'invalid_plan'; end if;
  if feature is not null and char_length(feature) > 60 then return 'invalid_feature'; end if;
  if scope is null or char_length(scope) > 120 then return 'invalid_scope'; end if;

  select state.stage into current_stage from public.beta_program_state as state where state.singleton;
  current_stage := coalesce(current_stage, 'unknown');

  -- The account is part of the key, so one reader's event can never collide with
  -- another's. A signed-out event is keyed by scope alone, which is why the
  -- scopes the application composes for anonymous events already carry a random
  -- component.
  composed_key := coalesce(requesting_user::text, 'anon') || ':' || input_event_key || ':' || scope;
  if char_length(composed_key) > 200 then return 'invalid_scope'; end if;

  insert into public.beta_funnel_events (
    user_id, event_key, plan_key, payment_rail, feature_key,
    beta_stage, local_date, occurred_at, dedupe_key
  ) values (
    requesting_user, input_event_key, plan, rail, feature,
    current_stage, bangkok_date, observed, composed_key
  )
  on conflict (dedupe_key) do nothing;

  if not found then return 'duplicate'; end if;
  return 'recorded';
end;
$$;

revoke all on function public.record_beta_funnel_event(text, text, text, text, text) from public;
grant execute on function public.record_beta_funnel_event(text, text, text, text, text)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Onboarding state, on the preference row that already exists
-- ---------------------------------------------------------------------------
--
-- Four nullable columns and no defaults that mean anything: a null path is "not
-- asked yet", which is the only state a brand-new account can be in. Existing
-- accounts therefore arrive as never-onboarded and are asked once, which is the
-- correct outcome for a feature that did not exist when they signed up.
alter table public.user_settings
  add column if not exists onboarding_path text,
  add column if not exists onboarding_chosen_at timestamptz,
  add column if not exists onboarding_dismissed_at timestamptz,
  -- The first contextual hint is finished — followed through or waved away. It
  -- is one timestamp rather than two because the product does the same thing in
  -- both cases: it stops asking, permanently.
  add column if not exists onboarding_hint_done_at timestamptz;

alter table public.user_settings
  drop constraint if exists user_settings_onboarding_path_check;

alter table public.user_settings
  add constraint user_settings_onboarding_path_check check (
    onboarding_path is null or onboarding_path in ('watchlist', 'portfolio', 'stock', 'options')
  );
