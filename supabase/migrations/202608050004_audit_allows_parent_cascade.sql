begin;

-- Phase 5.1 — the append-only audit must not block deleting an account.
--
-- `support_audit_events` refuses UPDATE and DELETE through a trigger, which is
-- the right guarantee and was tested as such. What the test did not cover is
-- that the refusal also fires for a **referential** delete: removing an account
-- cascades `auth.users` → `support_tickets` / `refund_requests` →
-- `support_audit_events`, the trigger raises `AUDIT_APPEND_ONLY`, and the whole
-- deletion fails. That breaks `delete_own_account`, which is a shipped feature
-- and, for a product handling personal data, one that has to keep working.
--
-- The corrected rule keeps the guarantee where it matters and yields where it
-- does not:
--
--   * UPDATE is refused unconditionally. An audit row is never edited.
--   * DELETE is refused while the record it describes still exists — which is
--     every direct `delete from support_audit_events`, including one issued by
--     a trusted role with a bug.
--   * DELETE is allowed once the parent has already gone, which happens only
--     inside a cascade. An audit trail for a ticket that no longer exists
--     protects nobody, and keeping it would leave rows referring to a deleted
--     account, which is the opposite of what a privacy request asks for.
--
-- Nothing else changes: same function name, same signature, same trigger. No
-- table, column, policy, grant or row is dropped.
create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    /*
     * Postgres applies the parent's delete before firing the cascade that
     * reaches this row, so "the parent is already gone" is precisely the test
     * for "this delete is a cascade" — and it is a test a direct delete can
     * never pass, because a direct delete leaves the parent in place.
     */
    if old.ticket_id is not null
       and not exists (
         select 1 from public.support_tickets as parent where parent.id = old.ticket_id
       ) then
      return old;
    end if;

    if old.refund_request_id is not null
       and not exists (
         select 1 from public.refund_requests as parent where parent.id = old.refund_request_id
       ) then
      return old;
    end if;
  end if;

  raise exception 'AUDIT_APPEND_ONLY' using errcode = '42501';
end;
$$;

revoke all on function public.reject_audit_mutation() from public, anon, authenticated;

commit;
