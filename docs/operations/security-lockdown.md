# Security lockdown

The switch you throw when you no longer trust this product's privileged paths.

It is **not** maintenance mode, and the difference is the whole reason it exists
separately. Read this before you need it; the middle of an incident is a bad time
to discover what a control does.

| | Maintenance | Lockdown |
|---|---|---|
| Answers | *Is the product serving readers?* | *Do we trust our own privileged paths?* |
| Ordinary readers | Redirected to a notice | **Unaffected** — they keep using the product |
| Operators | Keep the whole product | **Refused hardest of all** |
| Announced | Yes, with a public message | No. Silent to readers |
| Typical cause | A planned deploy or migration | A suspected compromise |

Both can be on at once, and during a real incident they usually should be.

---

## What it refuses

Everything below is blocked while the switch is engaged, for *everybody*,
including the operator who threw it.

- Every operator console mutation — beta stage, invites, refunds, ticket state,
  release notes.
- Role changes. Granting or revoking `admin`, at the database level.
- Access previews. An operator cannot start, change or end one.
- Account deletion. The one reader-facing path that row-level security does not
  bound, because it runs as `service_role`.

**What stays open, deliberately:**

- **This page** (`/admin/security`). A control that cannot be released while
  engaged is a lockout, not a control.
- **Maintenance.** Taking the product offline is an incident-response action.
- **The Stripe webhook.** A refused delivery is a retry storm and eventually a
  paid subscription that silently did not renew — a worse outcome than the
  override it would have caught.
- **Sign-in, the auth callback, and the schedulers.** You have to be able to sign
  in to end the incident.
- **Every read**, everywhere. You cannot investigate what you cannot see.
- **Ordinary reader writes.** A portfolio edit is already confined by RLS to rows
  the caller owns, so refusing it costs every paying customer their product and
  contains nothing. If you want a genuinely read-only product, engage maintenance
  as well — that is what it is for.

## Where it is enforced

Three independent layers. None is trusted to be the only one.

1. **Edge middleware** refuses a mutation aimed at `/admin/*` or `/api/admin/*`
   with `423 Locked`, before a renderer or route handler exists.
2. **The server gate** — `requireAdminMutation()`, which every operator mutation
   in the product already passes through. It defaults to the blocked class, so an
   action added next month is behind the switch without anyone remembering.
3. **The database** — triggers on `user_roles` and `admin_access_previews`. These
   hold when the application is not the caller: a `service_role` script or a
   routine written later is refused by the row's own table.

## Engaging it

1. Go to **/admin/security**. You need a second factor at `aal2`; the console
   requires that on every page but this one, and this action requires it too.
2. Write the reason. It is stored in the audit trail for the next operator and is
   never shown to readers. 300 characters.
3. Press **เปิดโหมดล็อกดาวน์** and confirm.

The confirmation is checked on the server, not only in the dialog.

## Releasing it

Same page, **ปลดล็อกดาวน์**. Both transitions write an audit row in the same
transaction as the flag — "the product was locked and nobody recorded who" is not
a state this can reach.

## If you are locked out

The switch is released by an operator with a second factor, from `/admin/security`.
If no such person is available, the state lives in one row and can be cleared
directly:

```sql
update public.app_runtime_settings
   set security_lockdown_enabled = false,
       security_lockdown_reason = null,
       security_lockdown_started_at = null,
       security_lockdown_started_by = null
 where singleton;
```

That path is deliberately not exposed anywhere in the product. Using it leaves no
audit row, so record what you did and why by hand.

## Reading the evidence

Security events land in `admin_audit_events`, which is append-only by trigger and
readable only through operator routines:

```sql
select * from public.admin_security_audit(50, 0);
```

The events recorded, and what each means, are in
[`src/lib/security/security-events.ts`](../../src/lib/security/security-events.ts).
The conditions that escalate to a monitoring report — and the thresholds — are in
the same file.

**What is never recorded:** passwords, tokens, API keys, cookies, request bodies,
mailboxes, client addresses. The actor is resolved from `auth.uid()` inside the
database, so a caller cannot record an event as somebody else, and the event
vocabulary is a closed allowlist so the log cannot be filled with attacker-chosen
strings.

## Related

- [`admin-mfa.md`](./admin-mfa.md) — the second factor this control depends on.
- [`edge-abuse-protection.md`](./edge-abuse-protection.md) — the rate limits and
  the Vercel WAF rules that see the fleet.
- [`secret-rotation.md`](./secret-rotation.md) — what to rotate if the incident
  turns out to involve a credential.
