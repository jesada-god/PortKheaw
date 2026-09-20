-- ============================================================================
-- A COMPANY PROFILE IS FETCHED ONCE, NOT ONCE PER SERVER INSTANCE.
-- ============================================================================
--
-- STATUS: NOT YET APPLIED
-- VERIFIED: 2026-09-20, by applying this file to a throwaway Postgres and reading back its columns, RLS, policies, grants and check constraints.
--
-- The verification above is a LOCAL one and says nothing about either hosted
-- project: it proves the file applies, re-applies without error, and produces
-- the shape it claims. Neither Supabase project has been touched.
--
-- No QUEUE line, for the reason `202609200002` gives: the unapplied set is
-- contested while uncommitted migrations sit beside each other, and a queue
-- that disagrees with its neighbours is worse than no queue.
--   Observed locally: 8 columns, RLS on, one SELECT policy for `authenticated`,
--   INSERT/SELECT/UPDATE to `service_role` only, and a lowercase symbol refused
--   by the check constraint.
--
begin;

-- ---------------------------------------------------------------------------
-- The company profile, kept where every instance can read it
-- ---------------------------------------------------------------------------
--
-- WHAT THIS REPLACES
-- ==========================================================================
-- Until now a company profile lived in `SharedRequestCache`, which is a `Map`
-- inside one Node process. On Vercel that means each serverless instance holds
-- its own copy, a cold start begins with none, and a deploy throws all of them
-- away. The policy said `freshMs: 24h` and the product never got 24 hours: the
-- real shape was
--
--     instance A ──FMP──> profile        instance B ──FMP──> profile
--
-- one provider call per instance per cold start, for a fact that changes a few
-- times a year. This table makes it
--
--     FMP ──> market_instrument_profiles ──> every instance, every reader
--
-- THIS IS THE PATTERN ALREADY IN THIS SCHEMA
-- ==========================================================================
-- Deliberately not a new idea: `analytics_fundamentals_lkg` (symbol-keyed jsonb
-- snapshot + provider + fetched_at + schema_version + an updated_at trigger) and
-- `market_fx_rates` already do exactly this for two other provider-backed facts.
-- This table is that shape again so there is one way to cache a provider answer
-- in this product rather than three.
--
-- ADDITIVE ONLY
-- ==========================================================================
-- Nothing existing is altered or dropped. The profile service treats a missing
-- table as a missing cache and falls back to the provider chain unchanged, so
-- this migration can land before or after the deploy that reads it.
create table if not exists public.market_instrument_profiles (
  symbol text not null primary key
    check (symbol = upper(trim(symbol)) and symbol ~ '^[A-Z0-9][A-Z0-9.:-]{0,31}$'),
  -- The normalized `CompanyProfile`, exactly as `companyProfileSchema` parses
  -- it. Stored whole rather than as columns because the reader re-validates it
  -- against that schema on the way out: a column-per-field table would make the
  -- database a second, silently diverging copy of a shape TypeScript already
  -- owns.
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  -- Which provider (or provider pair, e.g. `fmp+alpha-vantage` when the logo
  -- came from the fallback) produced this row. Kept so a bad profile can be
  -- traced to its source without re-fetching it.
  provider text not null check (char_length(trim(provider)) > 0),
  -- sha256 of the canonical payload. The translation cache keys on it, so a
  -- profile whose description actually changed is re-translated and one that
  -- was merely re-fetched is not.
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  -- When the provider answered. This is what freshness is measured from —
  -- never `updated_at`, which moves on a no-op rewrite.
  fetched_at timestamptz not null,
  -- Bumped when `companyProfileSchema` changes shape, so a reader can refuse a
  -- row written by an older deploy instead of parsing it into a wrong object.
  schema_version integer not null check (schema_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Serving a stale row while a refresh runs is the whole point of the read-through,
-- and the sweep that retires rows nobody has asked for in months both need to
-- order by age.
create index if not exists market_instrument_profiles_fetched_at_idx
  on public.market_instrument_profiles (fetched_at);

create or replace function public.set_market_instrument_profiles_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists market_instrument_profiles_set_updated_at
  on public.market_instrument_profiles;
create trigger market_instrument_profiles_set_updated_at
before update on public.market_instrument_profiles
for each row execute function public.set_market_instrument_profiles_updated_at();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
--
-- A shared, non-personal cache of public company facts: readable by a signed-in
-- reader, writable only by the server.
--
-- `anon` is NOT granted select even though `/stock/{symbol}` is a public page.
-- That page reads the profile through the server, which uses the service role,
-- so anonymous browser access to this table would buy nothing and would hand an
-- unauthenticated caller a bulk-export of the cache via PostgREST.
alter table public.market_instrument_profiles enable row level security;

drop policy if exists "Instrument profiles are readable by signed-in readers"
  on public.market_instrument_profiles;
create policy "Instrument profiles are readable by signed-in readers"
  on public.market_instrument_profiles
  for select to authenticated using (true);

revoke all on public.market_instrument_profiles from public, anon, authenticated;
grant select on public.market_instrument_profiles to authenticated;
grant select, insert, update on public.market_instrument_profiles to service_role;
revoke all on function public.set_market_instrument_profiles_updated_at()
  from public, anon, authenticated;

commit;
