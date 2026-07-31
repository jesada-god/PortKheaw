begin;

alter table public.market_instruments
  add column if not exists sector text,
  add column if not exists industry text,
  add column if not exists website_domain text,
  add column if not exists logo_url text,
  add column if not exists metadata_source text,
  add column if not exists metadata_updated_at timestamptz;

create index if not exists market_instruments_industry_active_idx
  on public.market_instruments (industry, symbol)
  where status = 'active' and industry is not null;

comment on column public.market_instruments.logo_url is
  'Provider-supplied company logo URL only; null falls back to a symbol monogram.';
comment on column public.market_instruments.metadata_source is
  'Provider identifier for sector, industry, website and logo metadata.';

commit;
