begin;

-- Phase 3 — the second layer in front of account deletion.
--
-- Additive and forward-only. One new routine; nothing existing is dropped,
-- replaced or re-granted.
--
-- The gap this closes:
--
--   Deleting an account is the one reader-initiated write in the product that
--   runs on the service-role client. Service role is not bounded by row-level
--   security and is not bounded by the lockdown triggers added in
--   `202608140001`, because those triggers sit on `user_roles` and
--   `admin_access_previews` — the tables where *privilege* lives — and deletion
--   touches neither. So every check in front of `deleteAccount` was an
--   application check, and the lockdown read in front of it fails *open* by
--   design (`lockdown-server.ts`): an unreadable switch means "not locked down",
--   which is right for a control that only ever takes privileges away, and wrong
--   for the single irreversible path in the product.
--
--   The result was one layer: if the server gate was wrong, mistaken, or simply
--   not consulted by some future caller, the service-role pipeline ran.
--
-- What this adds is a check the *database* makes, on the caller's own session,
-- immediately before the privileged pipeline starts:
--
--   * **It takes no arguments.** There is deliberately no user id to pass. The
--     subject is `auth.uid()` and nothing else, so no caller — including a
--     future one written by somebody who never read this file — can authorize
--     the deletion of an account that is not theirs by supplying an id. That is
--     the IDOR and the mass-assignment shape closed by construction rather than
--     by validation.
--   * **It is called on the reader's own client, not the admin client.** The
--     identity is the one in the session JWT, verified by the auth server. A
--     stale, forged, revoked or absent token resolves `auth.uid()` to null and
--     is refused here — which is why replay fails safely without a nonce, a
--     token table or any capability framework.
--   * **It fails closed.** Unlike the application's lockdown read, an error
--     from this routine is a refusal at the call site. The asymmetry is the
--     point: everywhere else a database blip must not take the product down,
--     and here a database blip must not delete an account.
--
-- It authorizes; it does not act. Nothing is written, and the routine grants no
-- ability the caller did not already have — a reader may always delete their own
-- account. So there is no new privileged operation reachable from a browser,
-- which is the property that would have been lost by exposing any part of the
-- service-role pipeline directly.
create or replace function public.authorize_account_deletion()
returns uuid
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  -- Read from the session. Never an argument; there is no argument.
  requesting_user uuid := (select auth.uid());
begin
  if requesting_user is null then
    raise exception 'ACCOUNT_DELETION_UNAUTHENTICATED' using errcode = '42501';
  end if;

  -- The incident switch, consulted in the database rather than trusted from the
  -- application. `is_security_locked_down()` is revoked from every client role,
  -- which is why this routine is `security definer`: the caller may not read the
  -- switch, and must still be bound by it.
  if public.is_security_locked_down() then
    raise exception 'SECURITY_LOCKDOWN' using errcode = '42501';
  end if;

  -- A session whose user has already been removed is not a caller with a
  -- deletable account; it is a token outliving its subject.
  if not exists (select 1 from auth.users as users where users.id = requesting_user) then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = '42501';
  end if;

  return requesting_user;
end;
$$;

revoke all on function public.authorize_account_deletion() from public, anon;
grant execute on function public.authorize_account_deletion() to authenticated;

commit;
