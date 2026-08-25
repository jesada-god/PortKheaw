-- ---------------------------------------------------------------------------
-- One routine, one signature
-- ---------------------------------------------------------------------------
--
-- `apply_billing_subscription_event` has existed as two overloads since Phase
-- 4.2:
--
--   * the mode-scoped one (20 arguments, `input_provider_mode` second), which is
--     the real routine and the only thing that writes entitlement;
--   * a 19-argument compatibility stub added by `202608040002`, whose entire
--     body raises `BILLING_PROVIDER_MODE_REQUIRED`.
--
-- The stub was not dead code. It was deliberate: while deployments could still
-- be running pre-4.2 application code, a call that omitted the provider mode had
-- to fail loudly rather than resolve to something that would write an event with
-- no environment identity attached.
--
-- That window is long closed. `billing-repository.ts` — the only caller in the
-- product, reached only from the signature-verified webhook route — passes
-- `input_provider_mode`, so PostgREST has resolved to the mode-scoped overload
-- for every release since. Nothing else in the schema references the stub: no
-- routine calls it, no trigger or view depends on it, and `202608040002` already
-- revoked it from `public`, `anon` and `authenticated`.
--
-- What removing it buys is narrow and worth having anyway: with one signature
-- left, a caller that forgets `input_provider_mode` gets "no function matches"
-- from PostgREST instead of resolving to a second function and raising from
-- inside it. There is no overload left to resolve to by accident.
--
-- Reversible: re-running the stub block in `202608040002` restores it exactly.
--
-- The signature is written out in full so this can only ever match the stub. A
-- bare `drop function public.apply_billing_subscription_event` would be
-- ambiguous with two overloads present, and — worse — could take the wrong one
-- if it were ever run when only one remained.
drop function if exists public.apply_billing_subscription_event(
  text,        -- input_provider
  text,        -- input_event_id
  text,        -- input_event_type
  timestamptz, -- input_occurred_at
  text,        -- input_payload_digest
  uuid,        -- input_user_id
  text,        -- input_customer_id
  text,        -- input_subscription_id
  text,        -- input_plan_key
  text,        -- input_price_id
  text,        -- input_tier
  text,        -- input_status
  text,        -- input_interval
  timestamptz, -- input_period_start
  timestamptz, -- input_period_end
  boolean,     -- input_cancel_at_period_end
  text,        -- input_invoice_id
  text,        -- input_payment_status
  boolean      -- input_founder
);

-- The mode-scoped routine must survive this migration. If the drop above ever
-- matched the wrong overload, this fails the release instead of leaving the
-- product with no way to apply a billing event at all.
do $$
begin
  if not exists (
    select 1
    from pg_proc as routine
    join pg_namespace as space on space.oid = routine.pronamespace
    where space.nspname = 'public'
      and routine.proname = 'apply_billing_subscription_event'
      and routine.pronargs = 20
  ) then
    raise exception 'BILLING_APPLY_ROUTINE_MISSING';
  end if;
end;
$$;
