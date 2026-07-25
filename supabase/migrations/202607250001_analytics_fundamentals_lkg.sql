begin;

create table public.analytics_fundamentals_lkg (
  symbol text not null check (symbol = upper(trim(symbol)) and char_length(symbol) between 1 and 20),
  dataset text not null check (dataset = 'financial-statements'),
  financial_periods jsonb not null,
  snapshot jsonb not null,
  provider text not null check (char_length(trim(provider)) > 0),
  source_as_of date not null,
  fetched_at timestamptz not null,
  validated_at timestamptz not null,
  schema_version integer not null check (schema_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (symbol, dataset),
  check (jsonb_typeof(financial_periods) = 'array'),
  check (jsonb_array_length(financial_periods) > 0),
  check (jsonb_typeof(snapshot) = 'object')
);

create or replace function public.set_analytics_fundamentals_lkg_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger analytics_fundamentals_lkg_set_updated_at
before update on public.analytics_fundamentals_lkg
for each row execute function public.set_analytics_fundamentals_lkg_updated_at();

alter table public.analytics_fundamentals_lkg enable row level security;
revoke all on public.analytics_fundamentals_lkg from public, anon, authenticated;
grant select, insert, update on public.analytics_fundamentals_lkg to service_role;
revoke all on function public.set_analytics_fundamentals_lkg_updated_at()
  from public, anon, authenticated;

commit;
