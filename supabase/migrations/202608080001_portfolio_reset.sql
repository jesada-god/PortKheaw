begin;

-- ===========================================================================
-- Emptying a portfolio without losing it
-- ===========================================================================
--
-- The product could delete a portfolio and it could archive one. Neither is
-- what somebody means by "start this portfolio over": a deletion takes the name,
-- the type and the place in the list with it, and an archive keeps every number
-- on the screen and only stops new rows arriving. What was missing is the third
-- thing — the portfolio stays exactly where it is, and its money goes to zero.
--
-- Two things this is deliberately *not*:
--
--   * It is not a sell. Closing the positions by writing disposals would invent
--     a realized gain that never happened and leave the cash it "raised" behind.
--     A reset is a purge of this portfolio's own records, not a trade.
--   * It is not a new way to compute a total. Nothing in the valuation or P&L
--     path is touched here, because every figure the page shows — value, cash,
--     cost basis, realized and unrealized P&L, today's change, holdings, open
--     option positions — is derived from `portfolio_transactions` on read. There
--     is no stored total and no snapshot table to invalidate: empty the ledger
--     and every one of those derivations answers zero, on this request and on
--     every reload after it.
--
-- What it deletes is exactly what `purge_deleted_portfolios` deletes, minus the
-- portfolio row itself — the same three children, in the same order, for the
-- same foreign-key reasons. That correspondence is the point: there is one
-- account of what belongs to a portfolio, and both routines read from it.
--
-- What it must not touch is the other side of a transfer. A `transfer_in` in a
-- *surviving* portfolio is that portfolio's own ledger row; deleting it would
-- silently remove shares somebody still holds. Those rows are left completely
-- alone — including their `counterparty_portfolio_id`, which the purge has to
-- null only because there the portfolio row itself disappears. Here it does not,
-- so the link stays valid and the destination still reads "รับโอนจาก <name>",
-- which is true: that transfer did happen, and this portfolio's own record of it
-- is simply gone.

create or replace function public.reset_portfolio(target_portfolio_id uuid)
returns table (
  transactions_removed integer,
  option_positions_removed integer,
  option_targets_removed integer,
  goal_cleared boolean
)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  owned_portfolio public.portfolios%rowtype;
  removed_transactions integer := 0;
  removed_positions integer := 0;
  removed_targets integer := 0;
  had_goal boolean := false;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  /*
   * Ownership is decided here, from auth.uid(), and the id from the client is
   * only ever a filter. A portfolio somebody else owns does not match, and the
   * answer is the same 'Portfolio not found' a missing id gets — a caller
   * probing ids must not be able to tell the two apart.
   *
   * `for update` holds the row for the rest of the statement, so a concurrent
   * second submission of the same reset waits and then finds nothing to delete
   * rather than interleaving with the first.
   */
  select portfolio.* into owned_portfolio
  from public.portfolios as portfolio
  where portfolio.id = target_portfolio_id and portfolio.user_id = requesting_user
  for update;
  if not found then raise exception 'Portfolio not found' using errcode = '42501'; end if;

  -- A deleted portfolio is not on any surface to reset, and resetting one would
  -- quietly destroy the ledger its seven-day restore exists to hand back.
  if owned_portfolio.deleted_at is not null then
    raise exception 'PORTFOLIO_ALREADY_DELETED' using errcode = 'P0001';
  end if;

  -- The same entitlement gate every portfolio write goes through. A read-only
  -- portfolio cannot be emptied any more than it can be added to.
  perform public.assert_portfolio_writable(target_portfolio_id);

  had_goal := owned_portfolio.target_value_usd is not null
    or owned_portfolio.target_date is not null;

  delete from public.portfolio_transactions where portfolio_id = target_portfolio_id;
  get diagnostics removed_transactions = row_count;

  delete from public.portfolio_option_positions where portfolio_id = target_portfolio_id;
  get diagnostics removed_positions = row_count;

  delete from public.portfolio_option_targets where portfolio_id = target_portfolio_id;
  get diagnostics removed_targets = row_count;

  /*
   * The goal goes too. A target of $50,000 left standing over an empty ledger
   * reports 0% forever and describes a plan the reader has just abandoned.
   *
   * Only these two columns move: name, type, base currency, legacy flag,
   * archived state and the row's identity are what "the portfolio stays" means.
   * The update touches no column the portfolio-limit trigger watches, so
   * emptying a portfolio can never fail on somebody else's plan limit.
   */
  update public.portfolios
  set target_value_usd = null, target_date = null, updated_at = now()
  where id = target_portfolio_id;

  /*
   * The invariant checker every ledger write already ends with, run on the way
   * out. An empty ledger trivially satisfies it — which is the assertion: if a
   * future change ever left a row behind, this is where the whole reset rolls
   * back rather than where a half-emptied portfolio is committed.
   */
  perform public.assert_portfolio_ledger_valid(target_portfolio_id);

  return query select removed_transactions, removed_positions, removed_targets, had_goal;
end;
$$;

revoke all on function public.reset_portfolio(uuid) from public, anon;
grant execute on function public.reset_portfolio(uuid) to authenticated;

commit;
