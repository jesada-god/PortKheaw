begin;

create table public.analytics_valuation_inputs_lkg (
  scope text not null check (scope in ('company', 'market', 'peers')),
  owner_key text not null check (
    owner_key = upper(trim(owner_key))
    and char_length(owner_key) between 1 and 20
  ),
  metric text not null check (metric in (
    'beta',
    'risk-free-rate',
    'equity-risk-premium',
    'forward-eps',
    'forward-revenue',
    'peer-forward-pe',
    'peer-forward-ev-sales'
  )),
  period text not null check (char_length(trim(period)) > 0),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  source text not null check (char_length(trim(source)) > 0),
  origin text not null check (origin in ('provider', 'derived', 'gemini-grounded')),
  source_as_of timestamptz not null,
  fetched_at timestamptz not null,
  validated_at timestamptz not null,
  freshness text not null check (freshness in ('fresh', 'stale')),
  schema_version integer not null check (schema_version > 0),
  provenance jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (scope, owner_key, metric, period)
);

create or replace function public.set_analytics_valuation_inputs_lkg_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger analytics_valuation_inputs_lkg_set_updated_at
before update on public.analytics_valuation_inputs_lkg
for each row execute function public.set_analytics_valuation_inputs_lkg_updated_at();

alter table public.analytics_valuation_inputs_lkg enable row level security;
revoke all on public.analytics_valuation_inputs_lkg from public, anon, authenticated;
grant select, insert, update on public.analytics_valuation_inputs_lkg to service_role;
revoke all on function public.set_analytics_valuation_inputs_lkg_updated_at()
  from public, anon, authenticated;

commit;
