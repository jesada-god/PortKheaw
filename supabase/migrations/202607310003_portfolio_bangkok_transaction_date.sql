begin;

-- occurred_at is derived from occurred_at_time in Asia/Bangkok throughout the
-- ledger RPCs. Comparing that local date with PostgreSQL's session-dependent
-- current_date rejects valid transactions between midnight and 07:00 Bangkok
-- while the database session is still on the previous UTC date.
alter table public.portfolio_transactions
  drop constraint if exists portfolio_transactions_occurred_at_check;

alter table public.portfolio_transactions
  add constraint portfolio_transactions_occurred_at_check
  check (occurred_at <= (current_timestamp at time zone 'Asia/Bangkok')::date);

commit;
