begin;

-- Phase 5.2 — an operator projection for the audit trail.
--
-- `support_audit_events` is granted to nobody: not `anon`, not `authenticated`,
-- not even for their own rows. That is the right call — an audit log is evidence
-- about a record, not part of it — but the operator console was reading the
-- table directly through the operator's own session, which the grant refuses.
-- The result was a server error on the ticket and refund detail pages rather
-- than a permission message, so the whole page failed to render.
--
-- The fix follows the pattern every other operator read already uses: a
-- `security definer` projection that checks the role inside the database and
-- returns a narrow, sanitized shape. The table keeps its zero grants.
--
-- Additive: one new function. Nothing is dropped or altered.
create or replace function public.admin_thread_audit(
  input_ticket_id uuid,
  input_refund_request_id uuid,
  input_limit integer
)
returns table (
  event_id bigint,
  actor_role text,
  action text,
  from_status text,
  to_status text,
  created_at timestamptz
)
language plpgsql
security definer set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  row_limit integer := least(greatest(coalesce(input_limit, 50), 1), 200);
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not public.is_platform_admin(requesting_user) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  -- Exactly one thread, so this cannot be called with both null and asked to
  -- return the whole log.
  if (input_ticket_id is null) = (input_refund_request_id is null) then
    return;
  end if;

  return query
  select
    entry.id, entry.actor_role, entry.action,
    entry.from_status, entry.to_status, entry.created_at
  from public.support_audit_events as entry
  where (input_ticket_id is not null and entry.ticket_id = input_ticket_id)
     or (input_refund_request_id is not null and entry.refund_request_id = input_refund_request_id)
  order by entry.created_at desc
  limit row_limit;
end;
$$;

-- The actor's own id is deliberately not in the projection: the console needs to
-- know that an operator acted, not which mailbox to attribute it to on screen.
-- The full row, with the actor, stays in the table for a real investigation.
revoke all on function public.admin_thread_audit(uuid, uuid, integer) from public, anon;
grant execute on function public.admin_thread_audit(uuid, uuid, integer) to authenticated;

commit;
