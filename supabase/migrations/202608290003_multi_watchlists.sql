begin;

-- ===========================================================================
-- More than one watchlist per user
-- ===========================================================================
--
-- STATUS: APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
--
-- Evidence: `watchlist_items.pinned` and `user_settings.overview_watchlist_id`
-- both resolve and both answer 200.
--
-- This is the file where what the probe CANNOT see matters most, so it is worth
-- naming: whether `watchlists_one_per_user` is actually gone, and whether the
-- seven functions below are the versions written here, are both invisible to
-- PostgREST — it reports relations and columns and nothing else. The only
-- read-only check of the constraint is whether an account can hold a second
-- list, and that was not performed. See `docs/operations/migration-state.md`.
--
-- The header this replaces claimed the file had never been run. It said so while
-- the columns were live. Read the reversal section at the bottom before changing
-- anything here.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT HAVE TO DO
-- ---------------------------------------------------------------------------
-- `202607180003_phase_3_watchlist.sql` already modelled this correctly and then
-- forbade it: `watchlist_items` has always pointed at a `watchlist_id`, and the
-- only thing standing between one list and several was a single constraint,
--
--     constraint watchlists_one_per_user unique (user_id)
--
-- So NO ITEM MOVES. There is no re-parenting step, no copy, no temporary table,
-- and no window in which a row belongs to nothing. Every existing list keeps its
-- id, its name and its rows, and becomes the user's first list rather than their
-- only one. That is the whole of the data migration, and its being this small is
-- a property of the original schema rather than luck.
--
-- What DOES have to change is every place that constraint was load-bearing.
-- Three functions upsert with `on conflict (user_id)`, which is not merely
-- redundant once the unique index is gone — it is a syntax error at runtime,
-- because `on conflict` needs an index to arbitrate against. Those are rewritten
-- below. Missing one would break signup, which is why they are enumerated here
-- rather than found later:
--
--     public.handle_new_user()                  -- the signup trigger
--     public.get_or_create_default_watchlist()  -- what every reader calls today
--
-- ---------------------------------------------------------------------------
-- WHY THE RULES LIVE IN FUNCTIONS AND NOT IN THE ACTIONS
-- ---------------------------------------------------------------------------
-- "Do not delete the last list" and "names are unique per user" are invariants
-- about the DATA, and a rule enforced only in a server action holds exactly
-- until something else writes the table — a second action, a backfill script, a
-- support tool run from the SQL editor. Both are enforced here: the name by a
-- unique index the database checks on every path, the last-list rule by the
-- delete function taking a lock and counting before it commits, so two parallel
-- deletes cannot each observe two lists and both proceed.
alter table public.watchlists
  drop constraint if exists watchlists_one_per_user;

/*
  Names, per user, case- and whitespace-insensitively unique.

  `lower(btrim(name))` rather than `name`, matching
  `portfolios_owner_type_normalized_name_key`: "ระยะยาว" and "ระยะยาว " are the
  same list to the person who typed them, and a product that accepted both would
  be showing a reader two tabs they cannot tell apart. The length and non-empty
  rules already exist on the table as `char_length(trim(name)) between 1 and 80`
  and are left alone.

  A unique INDEX rather than a constraint because a constraint cannot be
  expressed over an expression.
*/
create unique index if not exists watchlists_owner_normalized_name_key
  on public.watchlists (user_id, lower(btrim(name)));

create index if not exists watchlists_owner_created_idx
  on public.watchlists (user_id, created_at);

/*
  WHICH ROWS THE OVERVIEW PREVIEW SHOWS FIRST.

  The preview shows five of a list that may hold far more, so something has to
  choose, and the rule the product refuses is "the most interesting five" — an
  ordering nobody can predict, explain, or reproduce, which is the same
  objection that keeps a confidence percentage off the trend column.

  So the reader chooses, and `pinned` is that choice. When nobody has chosen,
  the fallback is stated in `overviewPreview` and is deterministic: oldest first,
  ties by symbol. Boring and explicable beats clever and unaccountable.

  Defaults to false, so every existing row is unpinned and every existing
  account keeps exactly the preview it has today.
*/
alter table public.watchlist_items
  add column if not exists pinned boolean not null default false;

create index if not exists watchlist_items_pinned_idx
  on public.watchlist_items (watchlist_id, created_at)
  where pinned;

/*
  WHICH LIST the Overview draws from, once there is more than one to draw from.

  On `user_settings` beside the other per-reader preferences rather than as a
  flag on `watchlists`, for the reason the portfolio migration gives for the
  same shape: a "this one is selected" boolean on the rows themselves has no
  way to enforce that exactly one is set, so it drifts into two selected lists
  or none, and every reader of the table has to decide which it prefers.

  `on delete set null` and not `cascade` — deleting the list somebody had chosen
  must return them to the default, never delete their settings row. Null means
  "not chosen", which is the state every existing account is in and which
  `resolveOverviewWatchlist` answers deterministically.
*/
alter table public.user_settings
  add column if not exists overview_watchlist_id uuid
    references public.watchlists(id) on delete set null;

-- ---------------------------------------------------------------------------
-- How many lists one account may have
-- ---------------------------------------------------------------------------
--
-- A cap exists because "create" with no ceiling is an unbounded write loop
-- behind one authenticated session, and every list is a fan-out of quote and
-- signal work when the Overview or the page loads it. Twenty is far above what
-- the feature is for and far below what would hurt.
--
-- Enforced in `create_watchlist` under the same advisory lock the count is
-- taken in, so two parallel creates cannot both see nineteen.
create or replace function public.create_watchlist(input_name text)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  normalized_name text := btrim(input_name);
  existing_count integer;
  result_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if char_length(normalized_name) not between 1 and 80 then
    raise exception 'Watchlist name must be 1-80 characters' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(requesting_user::text || ':watchlists', 0));

  select count(*) into existing_count
  from public.watchlists where user_id = requesting_user;
  if existing_count >= 20 then
    raise exception 'Watchlist limit reached' using errcode = '54000';
  end if;

  /*
    No `on conflict`. A duplicate name must REACH the caller as 23505 so the
    action can say "ชื่อนี้มีอยู่แล้ว"; swallowing it would silently hand back
    somebody else's list id, or nothing at all.
  */
  insert into public.watchlists (user_id, name)
  values (requesting_user, normalized_name)
  returning id into result_id;

  return result_id;
end;
$$;

create or replace function public.rename_watchlist(target_watchlist_id uuid, input_name text)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  normalized_name text := btrim(input_name);
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if char_length(normalized_name) not between 1 and 80 then
    raise exception 'Watchlist name must be 1-80 characters' using errcode = '22023';
  end if;

  /*
    Ownership is checked by the UPDATE's own predicate rather than by a prior
    SELECT, so there is no gap between the two in which the row could change
    hands. A row that is not the caller's simply does not match, and the
    not-found branch below reports it without revealing that the id exists.
  */
  update public.watchlists
  set name = normalized_name, updated_at = now()
  where id = target_watchlist_id and user_id = requesting_user;

  if not found then
    raise exception 'Watchlist not found' using errcode = '42501';
  end if;
end;
$$;

/*
  Delete one list, unless it is the only one left.

  THE LAST LIST IS NOT DELETABLE, and the rule is here rather than in the UI
  because it is about the data: every reader — the page, the Overview preview,
  `get_or_create_default_watchlist` — is written against "a signed-in user has
  at least one list". An account at zero would have to be repaired by whichever
  of them noticed first, which is how two of them come to disagree about what a
  fresh list is called.

  The advisory lock is what makes the count trustworthy. Without it two parallel
  deletes of a two-list account both count 2, both pass, and the account lands
  on zero — the exact failure the rule is for, reachable by double-clicking.
*/
create or replace function public.delete_watchlist(target_watchlist_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  remaining integer;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(requesting_user::text || ':watchlists', 0));

  if not exists (
    select 1 from public.watchlists
    where id = target_watchlist_id and user_id = requesting_user
  ) then
    raise exception 'Watchlist not found' using errcode = '42501';
  end if;

  select count(*) into remaining
  from public.watchlists where user_id = requesting_user;
  if remaining <= 1 then
    raise exception 'Cannot delete the only watchlist' using errcode = '23514';
  end if;

  -- Items go with it through `watchlist_items.watchlist_id`'s own cascade, and
  -- a settings row pointing here is reset to null by the reference above.
  delete from public.watchlists
  where id = target_watchlist_id and user_id = requesting_user;
end;
$$;

/*
  Which list the Overview draws from. Null clears the choice.

  Validated against ownership rather than trusted: without the check any
  authenticated caller could point their own settings row at somebody else's
  list id, and the Overview loader — which reads the id from settings and then
  reads that list — would serve them its contents. RLS on `watchlists` would not
  catch it, because the read would be performed as the OWNER of the settings row
  against a list they do not own.
*/
create or replace function public.set_overview_watchlist(target_watchlist_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if target_watchlist_id is not null and not exists (
    select 1 from public.watchlists
    where id = target_watchlist_id and user_id = requesting_user
  ) then
    raise exception 'Watchlist not found' using errcode = '42501';
  end if;

  insert into public.user_settings (user_id, overview_watchlist_id)
  values (requesting_user, target_watchlist_id)
  on conflict (user_id) do update set overview_watchlist_id = excluded.overview_watchlist_id;
end;
$$;

/*
  Pin or unpin one symbol for the Overview preview.

  Ownership travels through the parent, the same derivation `watchlist_items`'
  RLS policies already use, so a pin cannot be written into a list the caller
  does not own.
*/
create or replace function public.set_watchlist_item_pinned(
  target_watchlist_id uuid, input_symbol text, input_pinned boolean
)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  update public.watchlist_items as item
  set pinned = input_pinned
  where item.watchlist_id = target_watchlist_id
    and item.symbol = upper(btrim(input_symbol))
    and exists (
      select 1 from public.watchlists as list
      where list.id = item.watchlist_id and list.user_id = requesting_user
    );

  if not found then
    raise exception 'Watchlist item not found' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The two functions the dropped constraint took with it
-- ---------------------------------------------------------------------------
--
-- `get_or_create_default_watchlist` keeps its name and its contract — "give me
-- this user's list, making one if there is none" — because every existing
-- caller depends on it and this migration is not the place to rewrite them. Its
-- BODY changes, because `on conflict (user_id)` has no index to arbitrate
-- against any more.
--
-- "Default" now means, in order: the list the reader chose for the Overview, if
-- they chose one and still own it; otherwise their OLDEST list. Oldest rather
-- than newest, so that creating a second list never silently moves the page a
-- reader was already using — and deterministic either way, with `id` breaking
-- the tie in the event two rows share a `created_at`.
create or replace function public.get_or_create_default_watchlist()
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  result_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required';
  end if;

  select settings.overview_watchlist_id into result_id
  from public.user_settings as settings
  join public.watchlists as list on list.id = settings.overview_watchlist_id
  where settings.user_id = requesting_user and list.user_id = requesting_user;
  if result_id is not null then
    return result_id;
  end if;

  select id into result_id from public.watchlists
  where user_id = requesting_user
  order by created_at, id
  limit 1;
  if result_id is not null then
    return result_id;
  end if;

  /*
    None yet. The lock makes the create-if-absent safe against two concurrent
    first page loads, which without it would both find nothing and both insert —
    and the second would now succeed, where the old unique constraint used to
    absorb it.
  */
  perform pg_advisory_xact_lock(hashtextextended(requesting_user::text || ':watchlists', 0));
  select id into result_id from public.watchlists
  where user_id = requesting_user
  order by created_at, id
  limit 1;
  if result_id is not null then
    return result_id;
  end if;

  insert into public.watchlists (user_id, name)
  values (requesting_user, 'รายการโปรด')
  returning id into result_id;
  return result_id;
end;
$$;

/*
  The signup trigger, reproduced from `202608030002_admin_role_and_access_preview`
  with ONE line changed: the watchlist insert can no longer say
  `on conflict (user_id) do nothing`.

  Everything else is byte-identical on purpose. This is a trigger on user
  creation and a subtle edit here fails signup for everybody, so the diff is
  kept to the single statement that has to move.

  `not exists` rather than an upsert, because with the constraint gone there is
  nothing to conflict ON — and the guard still matters: the trigger must stay
  idempotent for the same reason it always was, so a replayed insert cannot give
  one account two identical starter lists.
*/
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.watchlists (user_id, name)
  select new.id, 'รายการโปรด'
  where not exists (select 1 from public.watchlists where user_id = new.id);

  begin
    insert into public.user_subscriptions (user_id) values (new.id)
    on conflict (user_id) do nothing;
  exception when others then
    raise warning 'Could not initialize subscription for auth user %: %', new.id, sqlerrm;
  end;

  begin
    insert into public.user_roles (user_id) values (new.id)
    on conflict (user_id) do nothing;
  exception when others then
    raise warning 'Could not initialize role for auth user %: %', new.id, sqlerrm;
  end;

  insert into public.portfolios (user_id, name, portfolio_type, is_legacy)
  values (new.id, 'Default / Legacy', 'LEGACY', true)
  on conflict (user_id) where is_legacy do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------
--
-- These are `security definer`, which means they run as their owner and RLS
-- does not apply inside them. Every one therefore resolves `auth.uid()` itself
-- and filters on it, and none takes a `user_id` argument — an id passed in is an
-- id that can be substituted.
--
-- `anon` is revoked from all of them. A signed-out caller has no lists, and a
-- function that would have raised 'Authentication required' anyway is still one
-- fewer reachable entry point.
revoke all on function public.create_watchlist(text) from public, anon;
revoke all on function public.rename_watchlist(uuid, text) from public, anon;
revoke all on function public.delete_watchlist(uuid) from public, anon;
revoke all on function public.set_overview_watchlist(uuid) from public, anon;
revoke all on function public.set_watchlist_item_pinned(uuid, text, boolean) from public, anon;
revoke all on function public.get_or_create_default_watchlist() from public, anon;

grant execute on function public.create_watchlist(text) to authenticated;
grant execute on function public.rename_watchlist(uuid, text) to authenticated;
grant execute on function public.delete_watchlist(uuid) to authenticated;
grant execute on function public.set_overview_watchlist(uuid) to authenticated;
grant execute on function public.set_watchlist_item_pinned(uuid, text, boolean) to authenticated;
grant execute on function public.get_or_create_default_watchlist() to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- UNCHANGED, and that is the point worth stating rather than passing over.
--
-- `watchlists` has been `user_id`-bound since phase 3 and `watchlist_items`
-- derives ownership from its parent on all four operations. Those policies were
-- never written against "one list", so several lists per user need no new
-- policy and — more importantly — no new WAY of deciding ownership. The one
-- reachable new hole was a settings row pointing at somebody else's list, which
-- is why `set_overview_watchlist` validates ownership rather than trusting its
-- argument.
--
-- This is deliberately NOT the `label_history` / `daily_snapshot` shape. Those
-- are service-role only, with RLS on and no policy at all, because no client
-- may reach them. A watchlist is the reader's own data and they reach it
-- directly with their own session, so it is policy-bound to `user_id` instead.
-- The two models are not interchangeable and mixing them up in either direction
-- is how a table ends up either unreachable or public.

comment on table public.watchlists is
  'A reader''s watchlists, several per account since 202608290003. Name is unique per user, case- and whitespace-insensitively. The last one cannot be deleted - see public.delete_watchlist. RLS-bound to user_id; the reader reaches this with their own session.';

comment on column public.watchlist_items.pinned is
  'Chosen by the reader for the Overview preview. When nothing is pinned the preview falls back to a stated deterministic order - never to a ranking.';

comment on column public.user_settings.overview_watchlist_id is
  'Which watchlist the Overview preview draws from. Null means not chosen, which resolves to the oldest list. Set only through public.set_overview_watchlist, which checks ownership.';

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- Reversible, with one condition that has to be met FIRST and cannot be met by
-- this script: the unique constraint cannot come back while any account still
-- holds more than one list.
--
--   begin;
--   -- Fails loudly if any account has a second list. Deliberately: choosing
--   -- which of a reader's lists to destroy is not a decision a rollback script
--   -- gets to make silently.
--   do $$
--   begin
--     if exists (select 1 from public.watchlists group by user_id having count(*) > 1) then
--       raise exception 'Some accounts hold several watchlists; resolve them before reverting';
--     end if;
--   end $$;
--
--   alter table public.user_settings drop column if exists overview_watchlist_id;
--   alter table public.watchlist_items drop column if exists pinned;
--   drop index if exists public.watchlists_owner_normalized_name_key;
--   drop index if exists public.watchlists_owner_created_idx;
--   drop index if exists public.watchlist_items_pinned_idx;
--   drop function if exists public.create_watchlist(text);
--   drop function if exists public.rename_watchlist(uuid, text);
--   drop function if exists public.delete_watchlist(uuid);
--   drop function if exists public.set_overview_watchlist(uuid);
--   drop function if exists public.set_watchlist_item_pinned(uuid, text, boolean);
--   alter table public.watchlists add constraint watchlists_one_per_user unique (user_id);
--   commit;
--
-- `get_or_create_default_watchlist` and `handle_new_user` must then be restored
-- from `202607180003` and `202608030002` respectively — their `on conflict
-- (user_id)` forms work again only once the constraint above is back, and in
-- that order. Reverting the constraint without them leaves signup working but
-- the default-list lookup reading the oldest row, which is correct behaviour
-- against a one-row table and therefore harmless if it is missed.
--
-- No item is touched by either direction. A reversal loses the pins, the
-- Overview selection, and any list beyond the first — never a watched symbol.
