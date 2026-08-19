begin;

-- ===========================================================================
-- Earnings calendar — last known good date, one row per symbol
-- ===========================================================================
--
-- Read the reversal block at the bottom before touching this file.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
-- ---------------------------------------------------------------------------
-- The earnings date is the ONLY Options Signal input whose absence improves the
-- published numbers. Every scored factor that goes missing is dropped from both
-- the numerator and the denominator of the coverage fraction, so it costs
-- coverage and cannot flatter anything. Event risk is not a scored factor — it
-- is a penalty subtracted from confidence — so a calendar that fails to load
-- does not lower confidence, it RAISES it. A live card moved from 53 to 60 on a
-- symbol reporting in eight days, purely because a provider stopped answering.
--
-- It stopped answering for a mundane reason. Measured against the live
-- providers on 2026-08-19:
--
--   * Alpha Vantage answers EARNINGS_CALENDAR with HTTP 200 and a CSV body of
--     the real header followed by `I,n,f,o,r,m,a` — its JSON notice rendered one
--     character per field and truncated to the header width. The same key on
--     GLOBAL_QUOTE returns that notice in full: "our standard API rate limit is
--     25 requests per day". The documented `demo` key returns a real calendar
--     from the same endpoint, so the endpoint is entitled and the key is simply
--     exhausted — for every symbol, for the rest of the day.
--   * Financial Modeling Prep, the secondary, answers HTTP 402 "Premium Query
--     Parameter" for any symbol outside the free plan's coverage.
--
-- Behind those two there was only a process-local cache, which resets on every
-- deploy and every cold start. So the product could know a date on Tuesday and
-- not on Wednesday, and score the same chart higher for knowing less.
--
-- An earnings date changes about four times a year. This table is what stops it
-- being fetched more often than that, and what stops it being forgotten.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TABLE IS NOT
-- ---------------------------------------------------------------------------
-- It is not an earnings HISTORY and must not become one. One row per symbol,
-- overwritten: the only question it answers is "what is the next report date we
-- last saw for this symbol". Past results, EPS actuals and surprise figures
-- belong to the fundamentals path, which has its own table and its own review.
--
-- A stored date is never served once it is in the past. That rule lives in
-- `isUsableEarningsFallback`, not here, because it is a question about TODAY and
-- a table cannot ask it — but it is the reason this table needs no retention
-- sweep: a stale row is refused by the reader and replaced by the next
-- successful fetch.

create table if not exists public.analytics_earnings_calendar_lkg (
  /* The same symbol shape every other symbol column in this schema uses. */
  symbol text primary key
    check (symbol = upper(trim(symbol)) and symbol ~ '^[A-Z0-9][A-Z0-9.-]{0,19}$'),

  /* Exchange-local (America/New_York) report date, as the provider published it. */
  report_date date not null,

  /*
    Pre- or post-market, when the provider dates the session. Alpha Vantage does;
    Financial Modeling Prep does not, and its rows are honestly stored as
    'unknown' rather than guessed at.
  */
  time_of_day text not null default 'unknown'
    check (time_of_day in ('pre-market', 'post-market', 'unknown')),

  /* Consensus EPS estimate when the provider published one. Never derived. */
  eps_estimate double precision,

  /* Which provider actually answered. Checked, so a typo cannot become a source. */
  provider text not null
    check (provider in ('alpha-vantage', 'financial-modeling-prep')),

  /*
    When a provider last really answered with this row — NOT when the row was
    written. The 24-hour TTL is measured against this, so a value the in-process
    cache re-served from an old fetch cannot keep refreshing its own freshness.
  */
  fetched_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_analytics_earnings_calendar_lkg_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists analytics_earnings_calendar_lkg_set_updated_at
  on public.analytics_earnings_calendar_lkg;
create trigger analytics_earnings_calendar_lkg_set_updated_at
before update on public.analytics_earnings_calendar_lkg
for each row execute function public.set_analytics_earnings_calendar_lkg_updated_at();

comment on table public.analytics_earnings_calendar_lkg is
  'Last known good next-earnings date per symbol. Written and read by the server only; it exists so a rate-limited calendar provider cannot remove the Options Signal event-risk penalty and raise a confidence score by losing data.';

-- ---------------------------------------------------------------------------
-- Row level security — nothing reaches a client directly
-- ---------------------------------------------------------------------------
--
-- RLS on with NO policy, so `anon` and `authenticated` read and write nothing.
-- The date itself is public information on the company's own investor-relations
-- page; the table is nevertheless server-only because nothing in the product
-- asks a browser for it, and a policy is a capability, not a default.
alter table public.analytics_earnings_calendar_lkg enable row level security;

revoke all on table public.analytics_earnings_calendar_lkg from public, anon, authenticated;
grant select, insert, update on table public.analytics_earnings_calendar_lkg to service_role;
revoke all on function public.set_analytics_earnings_calendar_lkg_updated_at()
  from public, anon, authenticated;

commit;

-- ===========================================================================
-- Reversal
-- ===========================================================================
--
-- This migration adds one table and one trigger function and alters nothing that
-- already exists:
--
--   begin;
--   drop table if exists public.analytics_earnings_calendar_lkg;
--   drop function if exists public.set_analytics_earnings_calendar_lkg_updated_at();
--   commit;
--
-- Reversal is lossless in the sense that every row is refetchable — but it puts
-- the product back to fetching an earnings date on every card against a key
-- allowing 25 requests a day, and back to a confidence score that goes UP when
-- the calendar goes down. Drop it only together with the code that reads it.
