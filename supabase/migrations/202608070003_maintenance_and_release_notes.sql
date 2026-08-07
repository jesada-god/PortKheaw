begin;

-- Production maintenance, and the announcement that follows it.
--
-- Additive and forward-only. Nothing from an earlier phase is dropped, altered
-- or replaced. Two concerns live here, and they are deliberately *separate*:
--
--   1. **Maintenance** is runtime control. One singleton row says whether the
--      product is serving ordinary readers right now. It is read on the request
--      path, so it has to be one cheap row and one cheap routine.
--   2. **Release notes** are content and history. They are published on their
--      own schedule — a note can go out without a maintenance window ever
--      happening, and a maintenance window can end without a note.
--
-- Coupling them would mean a failure writing an announcement could keep the
-- product switched off, which is exactly the outage the switch exists to end.
--
-- The audit is NOT a new table. `admin_audit_events` (Phase 6) is already "the
-- general operator audit", append-only by trigger, and a maintenance toggle is
-- precisely the kind of operator mutation it was built for. A second audit table
-- would be a second answer to "what did operators do?".
--
-- One principle, unchanged from Phase 5 and 6: a client may describe, and may
-- never decide. Every routine that writes reads its caller from `auth.uid()`,
-- checks the role with `public.is_platform_admin`, and refuses on its own terms.
-- Nothing here is granted directly on a table.

-- ---------------------------------------------------------------------------
-- 1. Runtime settings — the maintenance switch
-- ---------------------------------------------------------------------------
--
-- A singleton, for the same reason `beta_program_state` is one: there is exactly
-- one running program, and a table that can hold two rows is a table that will
-- eventually disagree with itself about whether the site is up.
--
-- The message and the expected resume time are stored beside the flag rather
-- than in a separate content table because they are *part of the switch* — they
-- describe this outage, they are replaced by the next one, and they have no
-- history worth keeping outside the audit rows below.
create table if not exists public.app_runtime_settings (
  singleton boolean primary key default true,
  maintenance_enabled boolean not null default false,
  -- Shown verbatim on `/maintenance`. Plain text; the page renders it as text.
  maintenance_message text,
  expected_resume_at timestamptz,
  -- Stamped when the switch goes on, cleared when it goes off, so "how long has
  -- this been down?" is answerable without scanning the audit.
  maintenance_started_at timestamptz,
  maintenance_started_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint app_runtime_settings_singleton_check check (singleton),
  constraint app_runtime_settings_message_check check (
    maintenance_message is null or char_length(maintenance_message) <= 500
  )
);

alter table public.app_runtime_settings
  add column if not exists maintenance_enabled boolean not null default false,
  add column if not exists maintenance_message text,
  add column if not exists expected_resume_at timestamptz,
  add column if not exists maintenance_started_at timestamptz,
  add column if not exists maintenance_started_by uuid,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by uuid;

-- `do nothing` for the same reason the beta program row uses it: replaying this
-- migration is what a schema redeploy does, and a redeploy must not switch a
-- running product back on — or off — behind the operator who set it.
insert into public.app_runtime_settings (singleton) values (true)
  on conflict (singleton) do nothing;

alter table public.app_runtime_settings enable row level security;
revoke all on table public.app_runtime_settings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Reading the switch
-- ---------------------------------------------------------------------------
--
-- The one trusted read, and the only one. Middleware, the `/maintenance` page
-- and the recovery poller all call this, so there is a single answer to "is the
-- product up, and may *this* caller through?".
--
-- It returns `is_admin` in the same round trip on purpose. Middleware runs on
-- every request; asking twice — once for the flag, once for the role — would
-- double the latency of the gate at exactly the moment the site is fragile.
--
-- Granted to `anon` as well as `authenticated`: a signed-out visitor must be
-- able to see *why* the site is unavailable, and the row carries nothing but the
-- operator's own public notice. `is_admin` is false for anon by construction.
create or replace function public.resolve_maintenance_state()
returns table (
  maintenance_enabled boolean,
  maintenance_message text,
  expected_resume_at timestamptz,
  maintenance_started_at timestamptz,
  is_admin boolean,
  database_now timestamptz
)
language sql
stable
security definer set search_path = ''
as $$
  select
    settings.maintenance_enabled,
    case when settings.maintenance_enabled then settings.maintenance_message else null end,
    case when settings.maintenance_enabled then settings.expected_resume_at else null end,
    case when settings.maintenance_enabled then settings.maintenance_started_at else null end,
    coalesce(public.is_platform_admin((select auth.uid())), false),
    now()
  from public.app_runtime_settings as settings
  where settings.singleton
$$;

revoke all on function public.resolve_maintenance_state() from public;
grant execute on function public.resolve_maintenance_state() to anon, authenticated;

-- The operator's own view: the switch plus who last moved it. Separate from the
-- read above because "who turned this off" is an operator fact, not a public one.
create or replace function public.admin_maintenance_state()
returns table (
  maintenance_enabled boolean,
  maintenance_message text,
  expected_resume_at timestamptz,
  maintenance_started_at timestamptz,
  maintenance_started_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  database_now timestamptz
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null or not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query
    select
      settings.maintenance_enabled,
      settings.maintenance_message,
      settings.expected_resume_at,
      settings.maintenance_started_at,
      settings.maintenance_started_by,
      settings.updated_at,
      settings.updated_by,
      now()
    from public.app_runtime_settings as settings
    where settings.singleton;
end;
$$;

revoke all on function public.admin_maintenance_state() from public, anon;
grant execute on function public.admin_maintenance_state() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Moving the switch
-- ---------------------------------------------------------------------------
--
-- The audit row is written in the same transaction as the flag. "The site went
-- down and nobody recorded who" is not a state this can reach.
--
-- `maintenance_started_at` is stamped only on the transition into maintenance,
-- never re-stamped by an operator editing the message mid-window — otherwise the
-- duration of an outage would reset every time somebody fixed a typo in it.
create or replace function public.admin_set_maintenance(
  input_enabled boolean,
  input_message text,
  input_expected_resume_at timestamptz,
  input_request_id text
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  settings public.app_runtime_settings%rowtype;
  next_message text;
  turning_on boolean;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if input_enabled is null then
    return 'invalid_state';
  end if;

  next_message := left(nullif(btrim(coalesce(input_message, '')), ''), 500);

  select * into settings from public.app_runtime_settings where singleton for update;
  if not found then return 'not_found'; end if;

  if settings.maintenance_enabled = input_enabled
    and settings.maintenance_message is not distinct from (case when input_enabled then next_message else null end)
    and settings.expected_resume_at is not distinct from (case when input_enabled then input_expected_resume_at else null end)
  then
    return 'unchanged';
  end if;

  turning_on := input_enabled and not settings.maintenance_enabled;

  update public.app_runtime_settings set
    maintenance_enabled = input_enabled,
    maintenance_message = case when input_enabled then next_message else null end,
    expected_resume_at = case when input_enabled then input_expected_resume_at else null end,
    maintenance_started_at = case
      when not input_enabled then null
      when turning_on then statement_timestamp()
      else settings.maintenance_started_at
    end,
    maintenance_started_by = case
      when not input_enabled then null
      when turning_on then requesting_user
      else settings.maintenance_started_by
    end,
    updated_at = statement_timestamp(),
    updated_by = requesting_user
  where singleton;

  perform public.record_admin_audit_event(
    requesting_user,
    case when input_enabled then 'maintenance.enabled' else 'maintenance.disabled' end,
    'runtime_settings',
    'maintenance',
    jsonb_build_object(
      'maintenance_enabled', settings.maintenance_enabled,
      'expected_resume_at', settings.expected_resume_at
    ),
    jsonb_build_object(
      'maintenance_enabled', input_enabled,
      -- The notice is the operator's own public copy, so it is safe to keep as
      -- evidence of what readers were told. Nothing else about the row is.
      'maintenance_message', case when input_enabled then next_message else null end,
      'expected_resume_at', case when input_enabled then input_expected_resume_at else null end
    ),
    input_request_id
  );

  return case when input_enabled then 'enabled' else 'disabled' end;
end;
$$;

revoke all on function public.admin_set_maintenance(boolean, text, timestamptz, text) from public, anon;
grant execute on function public.admin_set_maintenance(boolean, text, timestamptz, text) to authenticated;

-- The compact history the console shows. Reads the shared operator audit rather
-- than a maintenance-specific log, so there is one place this evidence lives.
create or replace function public.admin_maintenance_audit(input_limit integer)
returns table (
  id bigint,
  action text,
  actor_user_id uuid,
  after_summary jsonb,
  created_at timestamptz
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null or not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query
    select
      events.id, events.action, events.actor_user_id, events.after_summary, events.created_at
    from public.admin_audit_events as events
    where events.target_type = 'runtime_settings' and events.target_ref = 'maintenance'
    order by events.created_at desc, events.id desc
    limit greatest(1, least(coalesce(input_limit, 10), 50));
end;
$$;

revoke all on function public.admin_maintenance_audit(integer) from public, anon;
grant execute on function public.admin_maintenance_audit(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Release notes
-- ---------------------------------------------------------------------------
--
-- `content` is **plain text**, and that is a security decision, not a shortcut.
-- Every reader of this column renders it as text — bullets are recognised from
-- line prefixes by a pure function on the way out, never by embedding markup. A
-- rich body would mean an operator account could inject script into every
-- reader's session, and the announcement popup is shown to everybody.
--
-- The check constraint below refuses angle brackets outright. It is redundant
-- with the escaping React already does, and it stays anyway: the value of a
-- second, independent refusal is that it survives a future renderer that forgets.
create table if not exists public.app_release_notes (
  id uuid primary key default gen_random_uuid(),
  version text,
  title text not null,
  content text not null,
  importance text not null default 'normal',
  is_published boolean not null default false,
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint app_release_notes_version_check check (
    version is null or char_length(version) between 1 and 40
  ),
  constraint app_release_notes_title_check check (char_length(title) between 1 and 120),
  constraint app_release_notes_content_check check (char_length(content) between 1 and 4000),
  constraint app_release_notes_importance_check check (importance in ('normal', 'important')),
  -- Published means dated. A published row with no instant could never be
  -- ordered against the others, and ordering is what "the latest release" means.
  constraint app_release_notes_published_check check (
    (is_published and published_at is not null) or (not is_published)
  ),
  constraint app_release_notes_no_markup_check check (
    content !~ '[<>]' and title !~ '[<>]' and (version is null or version !~ '[<>]')
  )
);

-- The index the announcement read uses on every authenticated page view.
create index if not exists app_release_notes_published_idx
  on public.app_release_notes (published_at desc, id desc)
  where is_published;
create index if not exists app_release_notes_created_idx
  on public.app_release_notes (created_at desc);

alter table public.app_release_notes enable row level security;
revoke all on table public.app_release_notes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Per-account acknowledgement
-- ---------------------------------------------------------------------------
--
-- Server-side, so dismissing the popup on a phone also dismisses it on a laptop.
-- `localStorage` would have made "seen" a per-browser fact and shown the same
-- announcement again on every new device.
--
-- Both the id and the instant are stored. The id answers "was it this one?"; the
-- instant answers "was it this one *or anything older*?" — which is what makes a
-- reader who missed four releases see one popup rather than four.
create table if not exists public.user_release_note_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_release_id uuid references public.app_release_notes(id) on delete set null,
  last_seen_published_at timestamptz,
  seen_at timestamptz not null default now()
);

alter table public.user_release_note_state enable row level security;
revoke all on table public.user_release_note_state from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Operator routines for release notes
-- ---------------------------------------------------------------------------
--
-- One routine creates, edits and publishes, because they are the same write to
-- the same row and splitting them would mean three chances for the role check to
-- be forgotten. `input_publish` is deliberately tri-state:
--
--   true   publish (stamping `published_at` the first time only)
--   false  return to draft
--   null   leave the publication state exactly as it is — the "save an edit"
--          case, which must not silently publish a draft.
create or replace function public.admin_save_release_note(
  input_id uuid,
  input_version text,
  input_title text,
  input_content text,
  input_importance text,
  input_publish boolean,
  input_request_id text
)
returns table (release_id uuid, outcome text)
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  existing public.app_release_notes%rowtype;
  clean_title text;
  clean_content text;
  clean_version text;
  clean_importance text;
  next_published boolean;
  next_published_at timestamptz;
  next_published_by uuid;
  saved public.app_release_notes%rowtype;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  clean_title := left(nullif(btrim(coalesce(input_title, '')), ''), 120);
  clean_content := left(nullif(btrim(coalesce(input_content, '')), ''), 4000);
  clean_version := left(nullif(btrim(coalesce(input_version, '')), ''), 40);
  clean_importance := case when input_importance = 'important' then 'important' else 'normal' end;

  if clean_title is null then return query select null::uuid, 'invalid_title'::text; return; end if;
  if clean_content is null then return query select null::uuid, 'invalid_content'::text; return; end if;
  -- The same refusal the constraint makes, returned as an outcome the console can
  -- explain instead of a raw constraint violation.
  if clean_title ~ '[<>]' or clean_content ~ '[<>]' or (clean_version is not null and clean_version ~ '[<>]') then
    return query select null::uuid, 'invalid_content'::text; return;
  end if;

  if input_id is null then
    next_published := coalesce(input_publish, false);
    insert into public.app_release_notes (
      version, title, content, importance,
      is_published, published_at, published_by,
      created_by, updated_by
    ) values (
      clean_version, clean_title, clean_content, clean_importance,
      next_published,
      case when next_published then statement_timestamp() else null end,
      case when next_published then requesting_user else null end,
      requesting_user, requesting_user
    )
    returning * into saved;
  else
    select * into existing from public.app_release_notes where id = input_id for update;
    if not found then return query select null::uuid, 'not_found'::text; return; end if;

    next_published := coalesce(input_publish, existing.is_published);
    if next_published then
      -- Re-publishing an already published note keeps its original instant, so
      -- an operator fixing a typo does not re-announce it to everyone.
      next_published_at := coalesce(existing.published_at, statement_timestamp());
      next_published_by := coalesce(existing.published_by, requesting_user);
    else
      next_published_at := null;
      next_published_by := null;
    end if;

    update public.app_release_notes set
      version = clean_version,
      title = clean_title,
      content = clean_content,
      importance = clean_importance,
      is_published = next_published,
      published_at = next_published_at,
      published_by = next_published_by,
      updated_at = statement_timestamp(),
      updated_by = requesting_user
    where id = input_id
    returning * into saved;
  end if;

  perform public.record_admin_audit_event(
    requesting_user,
    case
      when input_id is null then 'release_note.created'
      when next_published and not coalesce(existing.is_published, false) then 'release_note.published'
      when not next_published and coalesce(existing.is_published, false) then 'release_note.unpublished'
      else 'release_note.updated'
    end,
    'release_note',
    saved.id::text,
    case when input_id is null then '{}'::jsonb else jsonb_build_object(
      'is_published', existing.is_published, 'importance', existing.importance
    ) end,
    jsonb_build_object(
      'is_published', saved.is_published, 'importance', saved.importance, 'version', saved.version
    ),
    input_request_id
  );

  return query select saved.id, case
    when input_id is null and saved.is_published then 'created_published'::text
    when input_id is null then 'created'::text
    when saved.is_published and not coalesce(existing.is_published, false) then 'published'::text
    when not saved.is_published and coalesce(existing.is_published, false) then 'unpublished'::text
    else 'updated'::text
  end;
end;
$$;

revoke all on function public.admin_save_release_note(uuid, text, text, text, text, boolean, text)
  from public, anon;
grant execute on function public.admin_save_release_note(uuid, text, text, text, text, boolean, text)
  to authenticated;

-- The console's history list. Drafts included — this is the only surface that
-- may see one.
create or replace function public.admin_release_notes(input_limit integer, input_offset integer)
returns table (
  id uuid,
  version text,
  title text,
  content text,
  importance text,
  is_published boolean,
  published_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null or not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query
    select
      notes.id, notes.version, notes.title, notes.content, notes.importance,
      notes.is_published, notes.published_at, notes.created_at, notes.updated_at,
      count(*) over ()
    from public.app_release_notes as notes
    order by coalesce(notes.published_at, notes.created_at) desc, notes.created_at desc
    limit greatest(1, least(coalesce(input_limit, 20), 100))
    offset greatest(0, coalesce(input_offset, 0));
end;
$$;

revoke all on function public.admin_release_notes(integer, integer) from public, anon;
grant execute on function public.admin_release_notes(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Reader routines
-- ---------------------------------------------------------------------------
--
-- The announcement this caller has not seen, or nothing.
--
-- Exactly one row, ever. A reader who missed four releases gets the newest one,
-- because four stacked modals is not an announcement, it is an obstacle. The
-- older three are marked seen by the same acknowledgement, via the timestamp.
--
-- A draft can never be returned: the `where is_published` is inside the routine,
-- and the table grants nothing to any client role, so there is no other path.
create or replace function public.resolve_my_release_announcement()
returns table (
  id uuid,
  version text,
  title text,
  content text,
  importance text,
  published_at timestamptz
)
language sql
stable
security definer set search_path = ''
as $$
  with latest as (
    select notes.*
    from public.app_release_notes as notes
    where notes.is_published and notes.published_at is not null
    order by notes.published_at desc, notes.id desc
    limit 1
  ), seen as (
    select state.* from public.user_release_note_state as state
    where state.user_id = (select auth.uid())
  )
  select latest.id, latest.version, latest.title, latest.content,
         latest.importance, latest.published_at
  from latest
  where (select auth.uid()) is not null
    and not exists (
      select 1 from seen
      where seen.last_seen_release_id = latest.id
         or (seen.last_seen_published_at is not null
             and seen.last_seen_published_at >= latest.published_at)
    )
$$;

revoke all on function public.resolve_my_release_announcement() from public, anon;
grant execute on function public.resolve_my_release_announcement() to authenticated;

-- Acknowledge one announcement.
--
-- The account is `auth.uid()` and nothing else — there is no argument for it, so
-- there is no way to mark somebody else's announcement seen. Idempotent: pressing
-- X twice, or on two devices, is one row either way.
--
-- Moving the marker *backwards* is refused. Otherwise acknowledging an old note
-- would un-see a newer one and the popup would return.
create or replace function public.acknowledge_release_note(input_release_id uuid)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  note public.app_release_notes%rowtype;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if input_release_id is null then return 'invalid_release'; end if;

  select * into note from public.app_release_notes
  where id = input_release_id and is_published and published_at is not null;
  if not found then return 'not_found'; end if;

  insert into public.user_release_note_state (
    user_id, last_seen_release_id, last_seen_published_at, seen_at
  ) values (
    requesting_user, note.id, note.published_at, statement_timestamp()
  )
  on conflict (user_id) do update set
    last_seen_release_id = case
      when public.user_release_note_state.last_seen_published_at is null
        or excluded.last_seen_published_at >= public.user_release_note_state.last_seen_published_at
      then excluded.last_seen_release_id
      else public.user_release_note_state.last_seen_release_id
    end,
    last_seen_published_at = greatest(
      coalesce(public.user_release_note_state.last_seen_published_at, excluded.last_seen_published_at),
      excluded.last_seen_published_at
    ),
    seen_at = statement_timestamp();

  return 'acknowledged';
end;
$$;

revoke all on function public.acknowledge_release_note(uuid) from public, anon;
grant execute on function public.acknowledge_release_note(uuid) to authenticated;

commit;
