begin;

-- ===========================================================================
-- Overview alert hits — what fired, when, and the reading that fired it
-- ===========================================================================
--
-- STATUS: APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
--
-- Evidence: `overview_alert_hits` resolves all eleven columns, and
-- `overview_alert_rules.last_fired_at` — the column this file adds to the table
-- `202608300001` created — resolves on that table. NOT covered: the widened
-- `overview_alert_rules_kind_check`, both indexes, the two RLS policies, and
-- `record_overview_alert_hit`. See `docs/operations/migration-state.md`.
--
-- Applied after `202608300001` and before `202608310002`, which is the order it
-- required.
--
-- ---------------------------------------------------------------------------
-- WHY THE FEATURE GREW A TABLE IT DID NOT HAVE
-- ---------------------------------------------------------------------------
-- `202608300001` states, at length, that this feature writes nothing: a hit was
-- a line on a page that existed while the condition was true and the reader was
-- looking. That was the right shape for a read-time section and it is the wrong
-- shape for a sweep. Nothing on a page can tell a reader about a level crossed
-- at 03:00; only a record can.
--
-- So the sweep records, and the moment it does, two things follow that the
-- read-time version genuinely did not need:
--
--   * a COOLDOWN, because a rule that matches for a week would otherwise write
--     a row every fifteen minutes — 672 rows saying one thing; and
--   * a STAMP on the rule, because a cooldown needs somewhere to read from.
--
-- The comment in `202608300001` about this table not existing is superseded by
-- this file rather than wrong: it described a feature that did not yet have a
-- scheduler.
--
-- ---------------------------------------------------------------------------
-- THIS IS STILL NOT `notifications`
-- ---------------------------------------------------------------------------
-- A hit is a RECORD THAT A RULE FIRED. It is not an inbox item, it is not
-- pushed, and it does not appear in the notification bell — `public.price_alerts`
-- and `public.notifications` are the system that does that, and the two remain
-- separate for the reason `202608300001` gives. What a hit buys is that the
-- Overview can show what happened while nobody was watching, and that the
-- cooldown has something to be measured against.

-- ---------------------------------------------------------------------------
-- The fifth kind
-- ---------------------------------------------------------------------------
--
-- `earnings` — "tell me when this reports within N days" — has the same shape as
-- the other four: one positive number, compared against one reading. What
-- differs is the unit, which is DAYS rather than a price or a percentage, and
-- `threshold > 0` already says everything the column needs to say about it.
--
-- Done as an ALTER rather than by editing `202608300001` in place. That file may
-- already have run somewhere this repository cannot see, and a migration whose
-- text changes after it has been applied is a migration nobody can reproduce
-- from. The cost is one extra statement; the alternative is a schema history
-- that is only true on the machine that last edited it.
alter table public.overview_alert_rules
  drop constraint if exists overview_alert_rules_kind_check;

alter table public.overview_alert_rules
  add constraint overview_alert_rules_kind_check
  check (kind in ('price_above', 'price_below', 'percent_up', 'percent_down', 'earnings'));

/*
  When this rule last fired.

  Null until it fires once, which is the absence of a previous hit rather than a
  very old one — `ovAlertCooledDown` reads null as "go ahead" for exactly that
  reason.

  Written ONLY by `record_overview_alert_hit` below, in the same statement that
  writes the hit. Nothing else may set it: a stamp without a hit hides an alert
  that never happened, and a hit without a stamp fires again on the next sweep,
  and the one after that.
*/
alter table public.overview_alert_rules
  add column if not exists last_fired_at timestamptz;

create table if not exists public.overview_alert_hits (
  id uuid primary key default gen_random_uuid(),
  /*
    The rule that fired, and the reader who owns it.

    `user_id` is denormalized off the rule deliberately. RLS on this table has to
    answer "is this yours" on every row read, and deriving it through a join to
    `overview_alert_rules` would make the policy a subquery on the hot path of a
    list nobody is allowed to see partially. `record_overview_alert_hit` is the
    only writer and it takes the value from the rule, so the two cannot drift.
  */
  rule_id uuid not null references public.overview_alert_rules(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  /*
    The symbol and kind AS THEY WERE when the rule fired.

    Copied rather than joined. A reader may retune a rule from $150 to $200
    afterwards, and a hit that read its threshold through the rule would then
    describe an event that never happened. A record of the past has to be
    readable without the present.
  */
  symbol text not null check (
    symbol = upper(trim(symbol))
    and char_length(symbol) between 1 and 20
    and symbol ~ '^(\^[A-Z0-9]+|[A-Z0-9][A-Z0-9.-]*)$'
  ),
  kind text not null check (kind in ('price_above', 'price_below', 'percent_up', 'percent_down', 'earnings')),
  /* The price the match was decided on. Never re-read afterwards. */
  observed_price numeric not null check (observed_price > 0),
  /* Today's move. Null for the kinds that do not consult it — never zero. */
  observed_change_percent numeric,
  /* Whole days to the report. Null for every non-earnings kind. */
  observed_earnings_days integer check (observed_earnings_days is null or observed_earnings_days >= 0),
  /*
    The Thai sentence, stored rather than rebuilt at read time.

    Same reason as `symbol` and `kind`: it quotes the threshold the rule had when
    it fired. Rebuilding it later from the current rule would silently rewrite
    history every time somebody edited a number.
  */
  value_text text not null check (char_length(value_text) between 1 and 300),
  /* The instant the sweep observed the match. Not the insert time. */
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

/*
  The read the Overview performs: this reader's recent hits, newest first.

  On `(user_id, observed_at desc)` and not on `rule_id`, because nobody asks
  "when did THIS rule fire" — they ask "what fired". The rule-scoped read that
  does exist is the cooldown, and that is answered from
  `overview_alert_rules.last_fired_at` without touching this table at all.
*/
create index if not exists overview_alert_hits_owner_recent_idx
  on public.overview_alert_hits (user_id, observed_at desc);

/*
  One hit per rule per observation instant.

  The sweep runs every fifteen minutes and the cooldown is measured in hours, so
  this should never fire — which is the point. If a retry, a double-invoked cron
  or a clock adjustment presents the same observation twice, the second one is
  refused by the database rather than becoming a duplicate line in front of a
  reader.
*/
create unique index if not exists overview_alert_hits_rule_observed_key
  on public.overview_alert_hits (rule_id, observed_at);

-- ---------------------------------------------------------------------------
-- Writing a hit and stamping the rule, in ONE transaction
-- ---------------------------------------------------------------------------
--
-- These two writes must not be separable, and PostgREST gives a client no way to
-- wrap two calls in a transaction. So they live in one function body:
--
--   * hit written, stamp missing  → the rule is permanently out of cooldown and
--     fires again on the next sweep, and the one after that, forever;
--   * stamp written, hit missing  → the reader is told nothing and the rule goes
--     quiet for four hours, which is an alert silently lost.
--
-- The second is the worse failure and the harder one to notice, which is why
-- this is a function rather than "the client will call them in order".
--
-- Ownership is derived from the RULE, never passed in: the caller supplies a
-- rule id, and a rule that is not theirs simply does not match the predicate.
create or replace function public.record_overview_alert_hit(
  target_rule_id uuid,
  input_symbol text,
  input_kind text,
  input_observed_price numeric,
  input_observed_change_percent numeric,
  input_observed_earnings_days integer,
  input_value_text text,
  input_observed_at timestamptz
)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  owner_id uuid;
  result_id uuid;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  /*
    The lock is what makes the pair atomic against a second sweep of the same
    reader — two cron invocations overlapping, or a manual run beside a
    scheduled one. Without it both read a stale `last_fired_at`, both pass the
    cooldown, and both write.
  */
  perform pg_advisory_xact_lock(hashtextextended(target_rule_id::text || ':overview-alert-hit', 0));

  select user_id into owner_id
  from public.overview_alert_rules
  where id = target_rule_id and user_id = requesting_user;

  if owner_id is null then
    -- Not found and not yours are one answer, so the id's existence is not leaked.
    raise exception 'Alert rule not found' using errcode = '42501';
  end if;

  insert into public.overview_alert_hits (
    rule_id, user_id, symbol, kind,
    observed_price, observed_change_percent, observed_earnings_days,
    value_text, observed_at
  )
  values (
    target_rule_id, owner_id, upper(btrim(input_symbol)), input_kind,
    input_observed_price, input_observed_change_percent, input_observed_earnings_days,
    input_value_text, input_observed_at
  )
  returning id into result_id;

  /*
    Same statement block, so there is no window in which the hit exists and the
    stamp does not. `greatest` because a sweep replaying an older observation
    must not move the cooldown backwards and let the rule fire again sooner.
  */
  update public.overview_alert_rules
  set last_fired_at = greatest(coalesce(last_fired_at, input_observed_at), input_observed_at),
      updated_at = now()
  where id = target_rule_id and user_id = requesting_user;

  return result_id;
end;
$$;

revoke all on function public.record_overview_alert_hit(
  uuid, text, text, numeric, numeric, integer, text, timestamptz
) from public, anon;
grant execute on function public.record_overview_alert_hit(
  uuid, text, text, numeric, numeric, integer, text, timestamptz
) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Readable and deletable by the owner; NOT insertable and NOT updatable by
-- anybody. A hit is a record of something that happened, and a client that could
-- write one could tell a reader an alert fired when it did not. The only writer
-- is `record_overview_alert_hit`, which is `security definer` and derives
-- ownership from the rule.
--
-- Delete is allowed because these are the reader's own rows and a list they
-- cannot clear is a list that grows forever in front of them.
alter table public.overview_alert_hits enable row level security;

drop policy if exists "Users can read own overview alert hits" on public.overview_alert_hits;
create policy "Users can read own overview alert hits" on public.overview_alert_hits
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own overview alert hits" on public.overview_alert_hits;
create policy "Users can delete own overview alert hits" on public.overview_alert_hits
  for delete to authenticated using ((select auth.uid()) = user_id);

comment on table public.overview_alert_hits is
  'A record that an overview alert rule fired: the reading that satisfied it and the sentence shown. Written only by public.record_overview_alert_hit, which also stamps the rule - see that function for why the two are inseparable. This is NOT public.notifications and nothing here is pushed.';

comment on column public.overview_alert_rules.last_fired_at is
  'When this rule last fired. Read by the cooldown, written only by public.record_overview_alert_hit in the same transaction as the hit. Null means it has never fired, which the cooldown reads as ready.';

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- Reversible, and destructive only of hits recorded after it was applied. The
-- rules themselves survive; they simply lose their history and their stamp,
-- which puts every rule back to "has never fired".
--
--   begin;
--   drop function if exists public.record_overview_alert_hit(
--     uuid, text, text, numeric, numeric, integer, text, timestamptz);
--   drop table if exists public.overview_alert_hits;
--   alter table public.overview_alert_rules drop column if exists last_fired_at;
--   -- Fails loudly if any rule is already an earnings rule. Deliberately:
--   -- deciding which of a reader's alerts to destroy is not a decision a
--   -- rollback script gets to make silently.
--   do $$
--   begin
--     if exists (select 1 from public.overview_alert_rules where kind = 'earnings') then
--       raise exception 'Some rules are earnings rules; resolve them before reverting';
--     end if;
--   end $$;
--   alter table public.overview_alert_rules drop constraint if exists overview_alert_rules_kind_check;
--   alter table public.overview_alert_rules add constraint overview_alert_rules_kind_check
--     check (kind in ('price_above', 'price_below', 'percent_up', 'percent_down'));
--   commit;
--
-- Dropping `last_fired_at` makes every rule eligible to fire on the next sweep,
-- which is one duplicate line per matching rule and no worse. That is the right
-- direction for the error to fall in: a rollback that silenced somebody's alerts
-- would be discovered much later, and by its absence.
