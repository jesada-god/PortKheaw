begin;

-- ---------------------------------------------------------------------------
-- วางแผนหุ้นรายตัว (Stock Planner) — saved plans
-- ---------------------------------------------------------------------------
--
-- One row is one plan a reader stated about one symbol: where the price was when
-- they made it, where they think it is going, the level at which they would
-- accept it did not work out, and by when.
--
-- What is deliberately NOT stored: upside, downside and the reward:risk ratio.
-- All three are pure functions of the four values below, so storing them would
-- create a second copy that can disagree with the first — and the copy would be
-- the one on screen. They are derived on read, every time.
--
-- `baseline_price` is the canonical accepted price at the moment the plan was
-- created, and it is IMMUTABLE (see the trigger below). That is the whole point
-- of the column: a plan's percentages are measured from where the price actually
-- was when the reader committed to it, so letting an edit move the baseline would
-- silently rewrite the plan's own history and make every past percentage wrong.
-- Editing a target, a level or a horizon is a change of plan; editing the
-- baseline would be a change of the past.

create table if not exists public.stock_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null check (symbol = upper(trim(symbol)) and symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,19}$'),
  baseline_price numeric(20, 6) not null check (baseline_price > 0),
  target_price numeric(20, 6) not null check (target_price > 0),
  invalidation_price numeric(20, 6) not null check (invalidation_price > 0),
  horizon_date date not null,
  /*
    Archive rather than erase, so "delete" from the reader's point of view can be
    undone by the operator and never loses a plan to a mis-tap. The API's delete
    sets this; nothing in the product hard-deletes a plan.
  */
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  /*
    v1 is long-only, and the database says so too. The API validates this before
    it ever writes, but a constraint is what makes it true of every row rather
    than of every row that went through today's code path: an inverted plan would
    compute a negative "upside" and print it with a plus sign.
  */
  constraint stock_plans_target_above_baseline check (target_price > baseline_price),
  constraint stock_plans_invalidation_below_baseline check (invalidation_price < baseline_price)
);

-- The list reads newest-first and is filtered to the live plans, which is exactly
-- this index; the symbol index serves the per-symbol lookup the Stock Detail CTA
-- lands on.
create index if not exists stock_plans_user_active_idx
  on public.stock_plans (user_id, created_at desc) where archived_at is null;
create index if not exists stock_plans_user_symbol_idx
  on public.stock_plans (user_id, symbol);

-- ---------------------------------------------------------------------------
-- The baseline cannot move
-- ---------------------------------------------------------------------------
--
-- Enforced here rather than only in the repository because "the API never sends
-- it" is a statement about one caller, and this is a statement about the column.
-- A future route, a psql session or a mistaken patch all meet the same refusal.
create or replace function public.stock_plans_freeze_baseline()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if new.baseline_price is distinct from old.baseline_price then
    raise exception 'STOCK_PLAN_BASELINE_IMMUTABLE' using errcode = '42501';
  end if;
  -- The owner cannot move either: a plan may not be handed to another account.
  if new.user_id is distinct from old.user_id then
    raise exception 'STOCK_PLAN_OWNER_IMMUTABLE' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.stock_plans_freeze_baseline() from public, anon, authenticated;

drop trigger if exists stock_plans_freeze_baseline on public.stock_plans;
create trigger stock_plans_freeze_baseline
  before update on public.stock_plans
  for each row execute function public.stock_plans_freeze_baseline();

-- ---------------------------------------------------------------------------
-- Row level security — owner only
-- ---------------------------------------------------------------------------
--
-- Four policies, all comparing the row to `auth.uid()` and nothing else. There is
-- no service-role path in the product for this table: every read and every write
-- travels on the reader's own session, so a plan is unreachable to anyone but the
-- account that wrote it even if a route forgot its own filter.
--
-- Note what is NOT here: no policy mentions a subscription tier. A reader whose
-- plan lapses from Pro back to Basic keeps every plan they saved — the entitlement
-- gate stops them *writing* new ones and opening the tool, and it is deliberately
-- not able to make their existing data unreadable or delete it. Downgrade must
-- never destroy what somebody already stored.

alter table public.stock_plans enable row level security;

drop policy if exists "Users can read own stock plans" on public.stock_plans;
create policy "Users can read own stock plans" on public.stock_plans for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Users can create own stock plans" on public.stock_plans;
create policy "Users can create own stock plans" on public.stock_plans for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own stock plans" on public.stock_plans;
create policy "Users can update own stock plans" on public.stock_plans for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete own stock plans" on public.stock_plans;
create policy "Users can delete own stock plans" on public.stock_plans for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- An account that is closing cannot write plans
-- ---------------------------------------------------------------------------
--
-- The same guard every other user-owned table carries, applied to this one. It is
-- attached here, in the table's own migration, rather than by editing the account
-- deletion migration.
--
-- On erasure: this table is removed with the account by its `on delete cascade`
-- foreign key to `auth.users`. It is deliberately NOT added to
-- `purge_account_data`'s explicit list, because that list is paired with
-- `account_residual_data_count` — the completeness proof the reconciler requires
-- before it will delete the auth user — and a table added to one but not the other
-- would either leave rows behind or block the pipeline forever. Changing that
-- matched pair belongs to the account-deletion migration, not to this one.
do $$
begin
  if to_regclass('public.stock_plans') is not null
     and to_regprocedure('public.reject_write_from_deleting_account()') is not null then
    drop trigger if exists reject_write_from_deleting_account on public.stock_plans;
    create trigger reject_write_from_deleting_account
      before insert or update or delete on public.stock_plans
      for each row execute function public.reject_write_from_deleting_account();
  end if;
end;
$$;

commit;
