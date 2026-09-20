-- ============================================================================
-- A COMPANY PROFILE IS TRANSLATED ONCE, FOR EVERYBODY.
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
--   Observed locally: 9 columns, RLS on, one SELECT policy for `authenticated`,
--   INSERT/SELECT/UPDATE to `service_role` only, `target_language = 'fr'`
--   refused, and a re-translate upsert leaving ONE row carrying the new text.
--
begin;

-- ---------------------------------------------------------------------------
-- The Thai company profile, translated once for everybody
-- ---------------------------------------------------------------------------
--
-- WHAT THIS CLOSES
-- ==========================================================================
-- `/api/translate/company-profile` was an unauthenticated POST that reached
-- Gemini, and its only cache was a `Map` in one process. Two things followed
-- from that, and this table plus the route change address both:
--
--   1. Every cold start re-translated every profile a reader opened. The model
--      bill scaled with instance count and deploy frequency, not with the
--      number of companies.
--   2. The cache key was `sha256(sourceText)` where `sourceText` came from the
--      REQUEST BODY. A caller who changed one character got a new key, a
--      guaranteed miss, and another model call — so no cache, however durable,
--      could have bounded the spend. The route now reads the profile itself and
--      hashes what it read; this table can therefore actually hold.
--
-- WHY THE PRIMARY KEY DOES NOT INCLUDE THE HASH
-- ==========================================================================
-- One row per (symbol, language), with the hash as a COLUMN. A profile whose
-- description changed produces a different hash, the reader's row no longer
-- matches, it is re-translated and the row is overwritten.
--
-- Keying on the hash instead would keep every historical translation of every
-- company forever — a table that grows with provider churn and that nothing
-- ever reads the old rows of. Bounded by the instrument universe is the correct
-- size for a cache.
create table if not exists public.market_instrument_profile_translations (
  symbol text not null
    check (symbol = upper(trim(symbol)) and symbol ~ '^[A-Z0-9][A-Z0-9.:-]{0,31}$'),
  -- Matches `companyProfileTranslationRequestSchema`, which accepts Thai and
  -- nothing else. Written as a check rather than left open so a future language
  -- has to be added deliberately, in both places, instead of arriving as a
  -- free-form string from a request body.
  target_language text not null check (target_language in ('th')),
  -- sha256 of the canonical profile the server read — never of anything a
  -- caller sent. This is the column that makes the cache honest: it is what
  -- decides whether a stored translation still describes the current profile.
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  translated_text text not null check (char_length(translated_text) between 1 and 8000),
  provider text not null check (char_length(trim(provider)) > 0),
  -- The exact model that produced it, so a model change can be traced — and so
  -- a future migration can invalidate one model's output without touching the
  -- rest.
  model text not null check (char_length(trim(model)) > 0),
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (symbol, target_language)
);

create or replace function public.set_market_instrument_profile_translations_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists market_instrument_profile_translations_set_updated_at
  on public.market_instrument_profile_translations;
create trigger market_instrument_profile_translations_set_updated_at
before update on public.market_instrument_profile_translations
for each row execute function public.set_market_instrument_profile_translations_updated_at();

-- Same access shape as `market_instrument_profiles`: a shared cache of public
-- facts, read by a signed-in reader, written only by the server.
alter table public.market_instrument_profile_translations enable row level security;

drop policy if exists "Profile translations are readable by signed-in readers"
  on public.market_instrument_profile_translations;
create policy "Profile translations are readable by signed-in readers"
  on public.market_instrument_profile_translations
  for select to authenticated using (true);

revoke all on public.market_instrument_profile_translations from public, anon, authenticated;
grant select on public.market_instrument_profile_translations to authenticated;
grant select, insert, update on public.market_instrument_profile_translations to service_role;
revoke all on function public.set_market_instrument_profile_translations_updated_at()
  from public, anon, authenticated;

commit;
